import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { User } from "../models/User";
import { ListingOption } from "../models/ListingOption";
import { Notification } from "../models/Notification";

jest.mock("../socket", () => ({ getIO: () => ({ to: () => ({ emit: jest.fn() }) }) }));

let mongo: MongoMemoryServer | null = null;
const PASSWORD = "StrongPassw0rd!";

describe("listing options + expert contact privacy", () => {
  let app: import("express").Express;
  let recordVendorListingValues: typeof import("../services/listingOptionsService").recordVendorListingValues;
  let invalidate: typeof import("../services/listingOptionsService").invalidateListingOptionsCache;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    process.env.NODE_ENV = "test";
    process.env.MONGO_URI = mongo.getUri();
    process.env.FRONTEND_URL = "http://localhost:3000";
    process.env.JWT_ACCESS_SECRET = "test_access_secret";
    process.env.OAUTH_STATE_SECRET = "test_oauth_state_secret";
    await mongoose.connect(process.env.MONGO_URI);
    await ListingOption.syncIndexes();
    const { createApp } = require("../app") as typeof import("../app");
    app = createApp();
    ({ recordVendorListingValues, invalidateListingOptionsCache: invalidate } = require("../services/listingOptionsService"));
  }, 30_000);

  afterAll(async () => {
    await mongoose.disconnect();
    if (mongo) await mongo.stop();
  }, 30_000);

  async function login(email: string, role: "customer" | "vendor" | "admin" | "mechanic", extra: Record<string, unknown> = {}) {
    const { hashPassword } = require("../utils/password") as typeof import("../utils/password");
    const user = await User.create({
      email,
      passwordHash: await hashPassword(PASSWORD),
      role,
      name: "Test",
      isEmailVerified: true,
      ...extra,
    });
    const res = await request(app).post("/api/v1/auth/login").send({ email, password: PASSWORD });
    return { id: String(user._id), token: res.body.data?.accessToken as string };
  }

  describe("public list", () => {
    it("seeds the starting list and returns it in the apps' JSON shape", async () => {
      const res = await request(app).get("/api/v1/listing-options");
      expect(res.status).toBe(200);
      expect(res.body.data.vehicleMakes[0]).toBe("Toyota");
      expect(res.body.data.vehicleModels.Toyota).toContain("Camry");
      expect(res.body.data.colors).toContainEqual({ name: "Black", hex: "#111111" });
      expect(res.body.data.partSpecValues["Part Number"]).toEqual([]);
      expect(res.headers["cache-control"]).toMatch(/max-age/);
    });
  });

  describe("vendor suggestions -> admin review", () => {
    let admin: { id: string; token: string };
    let vendor: { id: string; token: string };

    beforeAll(async () => {
      admin = await login("admin-lo@example.com", "admin");
      vendor = await login("vendor-lo@example.com", "vendor", { companyName: "LO Motors" });
    });

    it("queues only genuinely new values and notifies admins once, in-app", async () => {
      const product = {
        _id: "p1",
        category: "vehicle",
        name: "2024 Toyota Grand Highlander Platinum",
        make: "Toyota",
        color: { name: "Celestial Silver", hex: "#C2C6CC" },
        specs: { transmission: "Automatic", origin: "Foreign Used", vin: "X", "Fuel Type": "Petrol", "Seat Material": "Leather" },
      };
      expect(await recordVendorListingValues(product, vendor.id)).toBe(3);

      const pending = await ListingOption.find({ status: "pending" }).lean();
      expect(pending.map((p) => `${p.kind}:${p.value}`).sort()).toEqual([
        "color:Celestial Silver",
        "model:Grand Highlander Platinum",
        "vehicleSpecKey:Seat Material",
      ]);
      expect(pending.find((p) => p.kind === "color")?.hex).toBe("#c2c6cc");

      // Same values again: counted, but no new notification.
      expect(await recordVendorListingValues(product, vendor.id)).toBe(0);
      expect((await ListingOption.findOne({ value: "Seat Material" }))?.suggestionCount).toBe(2);
      expect(await Notification.countDocuments({ recipientId: admin.id, type: "listing_option" })).toBe(1);
    });

    it("treats a trim of a known model as known", async () => {
      expect(
        await recordVendorListingValues({ category: "vehicle", name: "2019 Toyota Camry XSE", make: "Toyota", specs: {} }, vendor.id),
      ).toBe(0);
    });

    it("only admins can see and review the queue", async () => {
      const asVendor = await request(app).get("/api/v1/admin/listing-options").set("Authorization", `Bearer ${vendor.token}`);
      expect(asVendor.status).toBe(403);

      const list = await request(app).get("/api/v1/admin/listing-options?status=pending").set("Authorization", `Bearer ${admin.token}`);
      expect(list.status).toBe(200);
      expect(list.body.data.counts.pending).toBe(3);
      expect(list.body.data.options[0].suggestedBy[0].companyName).toBe("LO Motors");

      const count = await request(app).get("/api/v1/admin/listing-options/pending-count").set("Authorization", `Bearer ${admin.token}`);
      expect(count.body.data.pending).toBe(3);
    });

    it("approving (with an edit) publishes the value; rejecting keeps it out", async () => {
      const model = await ListingOption.findOne({ kind: "model", value: "Grand Highlander Platinum" });
      const approve = await request(app)
        .patch(`/api/v1/admin/listing-options/${model!._id}`)
        .set("Authorization", `Bearer ${admin.token}`)
        .send({ status: "approved", value: "Grand Highlander" });
      expect(approve.status).toBe(200);
      expect(approve.body.data.option.value).toBe("Grand Highlander");

      const seat = await ListingOption.findOne({ value: "Seat Material" });
      await request(app)
        .patch(`/api/v1/admin/listing-options/${seat!._id}`)
        .set("Authorization", `Bearer ${admin.token}`)
        .send({ status: "rejected" })
        .expect(200);

      invalidate();
      const pub = await request(app).get("/api/v1/listing-options");
      expect(pub.body.data.vehicleModels.Toyota).toContain("Grand Highlander");
      expect(Object.keys(pub.body.data.vehicleSpecValues)).not.toContain("Seat Material");

      // A rejected value used again stays rejected and silent.
      expect(
        await recordVendorListingValues({ category: "vehicle", make: "Toyota", specs: { "Seat Material": "Cloth" } }, vendor.id),
      ).toBe(0);
      expect((await ListingOption.findById(seat!._id))?.status).toBe("rejected");
    });

    it("approving an edit that matches an existing option merges into it", async () => {
      const dup = await ListingOption.create({
        kind: "make", value: "Toyotaa", valueKey: "toyotaa", parentKey: "", status: "pending", source: "vendor",
      });
      const res = await request(app)
        .patch(`/api/v1/admin/listing-options/${dup._id}`)
        .set("Authorization", `Bearer ${admin.token}`)
        .send({ status: "approved", value: "Toyota" });
      expect(res.status).toBe(200);
      expect(res.body.data.mergedFrom).toBe(String(dup._id));
      expect((await ListingOption.findById(dup._id))?.status).toBe("rejected");
      expect(await ListingOption.countDocuments({ kind: "make", valueKey: "toyota" })).toBe(1);
    });

    it("lets admins add values directly, and validates colours", async () => {
      const bad = await request(app)
        .post("/api/v1/admin/listing-options")
        .set("Authorization", `Bearer ${admin.token}`)
        .send({ kind: "color", value: "Sunset Orange", hex: "orange" });
      expect(bad.status).toBe(400);

      const ok = await request(app)
        .post("/api/v1/admin/listing-options")
        .set("Authorization", `Bearer ${admin.token}`)
        .send({ kind: "vehicleSpecValue", value: "Hydrogen", parent: "Fuel Type" });
      expect(ok.status).toBe(201);
      invalidate();
      const pub = await request(app).get("/api/v1/listing-options");
      expect(pub.body.data.vehicleSpecValues["Fuel Type"]).toContain("Hydrogen");
    });
  });

  describe("GET /experts", () => {
    beforeAll(async () => {
      await User.create({
        email: "mech@example.com",
        passwordHash: "x",
        role: "mechanic",
        name: "Ace Garage",
        phone: "+2348000000000",
        isEmailVerified: true,
      });
    });

    it("hides phone and email from guests", async () => {
      const res = await request(app).get("/api/v1/experts");
      expect(res.status).toBe(200);
      expect(res.body.data.contactHidden).toBe(true);
      const ace = res.body.data.experts.find((e: { name: string }) => e.name === "Ace Garage");
      expect(ace.phone).toBeNull();
      expect(ace.email).toBeNull();
      expect(JSON.stringify(res.body)).not.toContain("+2348000000000");
    });

    it("shows them to signed-in users", async () => {
      const buyer = await login("buyer-exp@example.com", "customer");
      const res = await request(app).get("/api/v1/experts").set("Authorization", `Bearer ${buyer.token}`);
      expect(res.body.data.contactHidden).toBe(false);
      const ace = res.body.data.experts.find((e: { name: string }) => e.name === "Ace Garage");
      expect(ace.phone).toBe("+2348000000000");
      expect(ace.email).toBe("mech@example.com");
    });

    it("treats an invalid token as a guest", async () => {
      const res = await request(app).get("/api/v1/experts").set("Authorization", "Bearer not-a-token");
      expect(res.body.data.contactHidden).toBe(true);
    });
  });
});

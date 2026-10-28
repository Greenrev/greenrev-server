import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { User } from "../models/User";

jest.mock("../utils/cloudinary", () => ({
  uploadFile: jest.fn(async () => "https://res.cloudinary.com/test/image.jpg"),
  uploadImage: jest.fn(async () => "https://res.cloudinary.com/test/image.jpg"),
}));

let mongo: MongoMemoryServer | null = null;
const PASSWORD = "StrongPassw0rd!";

describe("critical security fixes", () => {
  let app: import("express").Express;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    process.env.NODE_ENV = "test";
    process.env.MONGO_URI = mongo.getUri();
    process.env.FRONTEND_URL = "http://localhost:3000";
    process.env.JWT_ACCESS_SECRET = "test_access_secret";
    process.env.OAUTH_STATE_SECRET = "test_oauth_state_secret";
    process.env.GOOGLE_CLIENT_ID = "test-client";
    process.env.GOOGLE_REDIRECT_URI = "http://localhost:4000/api/v1/auth/google/callback";
    await mongoose.connect(process.env.MONGO_URI);
    const { createApp } = require("../app") as typeof import("../app");
    app = createApp();
  }, 30_000);

  afterAll(async () => {
    await mongoose.disconnect();
    if (mongo) await mongo.stop();
  }, 30_000);

  afterEach(() => {
    delete process.env.ADMIN_ACTIVATION_CODE;
  });

  async function tokenFor(email: string, role: "customer" | "vendor") {
    const { hashPassword } = require("../utils/password") as typeof import("../utils/password");
    await User.create({
      email,
      passwordHash: await hashPassword(PASSWORD),
      role,
      name: "Test",
      companyName: role === "vendor" ? "Test Motors" : null,
      isEmailVerified: true,
    });
    const login = await request(app).post("/api/v1/auth/login").send({ email, password: PASSWORD });
    return login.body.data.accessToken as string;
  }

  describe("admin creation", () => {
    it("rejects role=admin on normal registration", async () => {
      const res = await request(app)
        .post("/api/v1/auth/register")
        .send({ email: "sneaky@example.com", password: PASSWORD, role: "admin", name: "Sneaky" });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("INVALID_ROLE");
      expect(await User.countDocuments({ email: "sneaky@example.com" })).toBe(0);
    });

    it("still allows customer, vendor and mechanic registration", async () => {
      const ok = await request(app)
        .post("/api/v1/auth/register")
        .send({ email: "client@example.com", password: PASSWORD, role: "customer", name: "Client" });
      expect(ok.status).toBe(201);
    });

    it("disables admin sign-up when ADMIN_ACTIVATION_CODE is not set, even with the old code", async () => {
      const res = await request(app)
        .post("/api/v1/auth/admin-register")
        .send({ email: "a1@example.com", password: PASSWORD, name: "A", activationCode: "GREENREV" });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("ADMIN_REGISTRATION_DISABLED");
    });

    it("rejects a wrong activation code and accepts the configured one", async () => {
      process.env.ADMIN_ACTIVATION_CODE = "a-long-random-secret-code";
      const wrong = await request(app)
        .post("/api/v1/auth/admin-register")
        .send({ email: "a2@example.com", password: PASSWORD, name: "A", activationCode: "GREENREV" });
      expect(wrong.status).toBe(403);
      expect(wrong.body.error.code).toBe("INVALID_ACTIVATION_CODE");

      const right = await request(app)
        .post("/api/v1/auth/admin-register")
        .send({ email: "a3@example.com", password: PASSWORD, name: "A", activationCode: "a-long-random-secret-code" });
      expect(right.status).toBe(201);
      expect((await User.findOne({ email: "a3@example.com" }).lean())?.role).toBe("admin");
    });

    it("rejects role=admin when starting Google sign-in", async () => {
      const admin = await request(app).get("/api/v1/auth/google?role=admin");
      expect(admin.status).toBe(400);
      expect(admin.body.error.code).toBe("INVALID_ROLE");

      const vendor = await request(app).get("/api/v1/auth/google?role=vendor");
      expect(vendor.status).toBe(302);
    });
  });

  describe("upload", () => {
    it("rejects anonymous uploads before reading files", async () => {
      const res = await request(app)
        .post("/api/v1/upload")
        .attach("files", Buffer.from("x"), { filename: "car.jpg", contentType: "image/jpeg" });
      expect(res.status).toBe(401);
    });

    it("rejects customers", async () => {
      const token = await tokenFor("buyer@example.com", "customer");
      const res = await request(app)
        .post("/api/v1/upload")
        .set("Authorization", `Bearer ${token}`)
        .attach("files", Buffer.from("x"), { filename: "car.jpg", contentType: "image/jpeg" });
      expect(res.status).toBe(403);
    });

    it("rejects disallowed file types and accepts images for vendors", async () => {
      const token = await tokenFor("seller@example.com", "vendor");

      const bad = await request(app)
        .post("/api/v1/upload")
        .set("Authorization", `Bearer ${token}`)
        .attach("files", Buffer.from("MZ"), { filename: "virus.exe", contentType: "application/octet-stream" });
      expect(bad.status).toBe(400);
      expect(bad.body.error.code).toBe("UNSUPPORTED_FILE_TYPE");

      const good = await request(app)
        .post("/api/v1/upload")
        .set("Authorization", `Bearer ${token}`)
        .attach("files", Buffer.from([0xff, 0xd8, 0xff]), { filename: "car.jpg", contentType: "image/jpeg" })
        .attach("files", Buffer.from("glTF"), { filename: "car.glb", contentType: "model/gltf-binary" });
      expect(good.status).toBe(200);
      expect(good.body.data.urls).toHaveLength(2);
    });
  });
});

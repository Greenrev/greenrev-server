import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { User } from "../models/User";
import { Product } from "../models/Product";
import { DailyActivity } from "../models/DailyActivity";
import { AiUsage } from "../models/AiUsage";

const PASSWORD = "StrongPassw0rd!";
const BROWSER = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15";

describe("analytics: DAU / WAU / MAU and admin overview", () => {
  let mongo: MongoMemoryServer;
  let app: import("express").Express;
  let svc: typeof import("../services/analyticsService");
  let adminAuth = "";
  let customerAuth = "";

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    Object.assign(process.env, {
      NODE_ENV: "test",
      MONGO_URI: mongo.getUri(),
      FRONTEND_URL: "http://localhost:3000",
      JWT_ACCESS_SECRET: "test_access_secret",
      OAUTH_STATE_SECRET: "test_oauth_state_secret",
    });
    await mongoose.connect(mongo.getUri());
    await DailyActivity.syncIndexes();
    app = (require("../app") as typeof import("../app")).createApp();
    svc = require("../services/analyticsService");
    const { hashPassword } = require("../utils/password") as typeof import("../utils/password");
    for (const role of ["admin", "customer"] as const) {
      await User.create({ email: `${role}@an.test`, passwordHash: await hashPassword(PASSWORD), role, name: role, isEmailVerified: true });
      const res = await request(app).post("/api/v1/auth/login").send({ email: `${role}@an.test`, password: PASSWORD });
      if (role === "admin") adminAuth = `Bearer ${res.body.data.accessToken}`;
      else customerAuth = `Bearer ${res.body.data.accessToken}`;
    }
  }, 30_000);

  afterAll(async () => {
    await mongoose.disconnect();
    await mongo.stop();
  }, 30_000);

  const visit = (body: object, opts: { ua?: string; auth?: string } = {}) => {
    const r = request(app).post("/api/v1/analytics/visit").set("User-Agent", opts.ua ?? BROWSER).send(body);
    return opts.auth ? r.set("Authorization", opts.auth) : r;
  };

  it("uses Lagos days", () => {
    // 23:30 UTC on 4 Nov is 00:30 on 5 Nov in Lagos.
    expect(svc.lagosDay(Date.parse("2026-11-04T23:30:00Z"))).toBe("2026-11-05");
    expect(svc.dayMinus("2026-03-01", 1)).toBe("2026-02-28");
  });

  it("records one row per visitor per day, upgrading to signed-in, and ignores bots", async () => {
    await visit({ visitorId: "device-aaaa-1111", platform: "web" }).expect(200);
    await visit({ visitorId: "device-aaaa-1111", platform: "web" }, { auth: customerAuth }).expect(200);
    await visit({ visitorId: "device-bbbb-2222", platform: "ios" }, { ua: "Googlebot/2.1" }).expect(200);

    const rows = await DailyActivity.find({}).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ visitorId: "device-aaaa-1111", platform: "web", hits: 2, role: "customer" });
    expect(rows[0].userId).not.toBeNull();
  });

  it("validates input", async () => {
    await visit({ visitorId: "x", platform: "web" }).expect(400);
    await visit({ visitorId: "device-cccc-3333", platform: "windows" }).expect(400);
  });

  it("counts distinct visitors per day, week and month", async () => {
    await DailyActivity.deleteMany({});
    const today = svc.lagosDay();
    const day = (n: number) => svc.dayMinus(today, n);
    const uid = new mongoose.Types.ObjectId();
    await DailyActivity.insertMany([
      // today: 3 visitors (1 signed in)
      { day: day(0), visitorId: "v-today-1", platform: "web", userId: uid },
      { day: day(0), visitorId: "v-today-2", platform: "android" },
      { day: day(0), visitorId: "v-repeat", platform: "ios" },
      // yesterday: 2 visitors, one of them comes back today — counted once in WAU/MAU
      { day: day(1), visitorId: "v-repeat", platform: "ios" },
      { day: day(1), visitorId: "v-yday", platform: "web" },
      // 10 days ago: in MAU, not WAU
      { day: day(10), visitorId: "v-ten", platform: "web" },
      // 40 days ago: outside everything current
      { day: day(40), visitorId: "v-old", platform: "web" },
    ]);

    const a = await svc.activeUsers(today);
    expect(a.dau).toMatchObject({ visitors: 3, signedIn: 1, previous: 2 });
    expect(a.wau.visitors).toBe(4); // today-1, today-2, repeat, yday
    expect(a.mau.visitors).toBe(5); // + ten
    expect(a.mau.previous).toBe(1); // v-old, in the 30 days before that
    expect(a.stickiness).toBe(60); // 3 / 5
    expect(a.byPlatform).toEqual({ web: 3, ios: 1, android: 1 });
    expect(a.daily).toHaveLength(30);
    expect(a.daily[29]).toEqual({ day: today, visitors: 3, signedIn: 1 });
    expect(a.daily[28]).toEqual({ day: day(1), visitors: 2, signedIn: 0 });
  });

  it("serves the overview to admins only, with real totals", async () => {
    const vendor = await User.create({ email: "v@an.test", passwordHash: "x", role: "vendor", name: "V", isEmailVerified: true });
    await Product.create([
      { name: "Camry", make: "Toyota", category: "vehicle", price: "₦1", image: "x", vendorId: vendor._id, vendorName: "V" },
      { name: "Pads", make: "Bosch", category: "part", price: "₦1", image: "x", vendorId: vendor._id, vendorName: "V" },
    ]);
    await AiUsage.create([
      { feature: "concierge", status: "ok", costUsd: 0.002 },
      { feature: "listing_extract", status: "error", errorCode: "AI_FAILED" },
    ]);

    await request(app).get("/api/v1/admin/analytics/overview").set("Authorization", customerAuth).expect(403);
    await request(app).get("/api/v1/admin/analytics/overview").expect(401);

    const res = await request(app).get("/api/v1/admin/analytics/overview").set("Authorization", adminAuth).expect(200);
    const d = res.body.data;
    expect(d.activeUsers.dau.visitors).toBe(3);
    expect(d.users).toMatchObject({ total: 3, byRole: { admin: 1, customer: 1, vendor: 1 }, new7d: 3 });
    expect(d.listings).toMatchObject({ total: 2, byCategory: { vehicle: 1, part: 1 }, new30d: 2 });
    expect(d.ai).toMatchObject({ requests30d: 2, errors30d: 1, costUsd30d: 0.002 });
    expect(d.support).toEqual({ openTickets: 0, newInquiries: 0 });
  });
});

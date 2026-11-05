import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { User } from "../models/User";

const PASSWORD = "StrongPassw0rd!";

// Every request here comes from one IP — like customers behind a Nigerian mobile
// network's shared address. Limits must not make them throttle each other.
// Password hashing makes each login slow on purpose.
jest.setTimeout(60_000);

describe("rate limits on a shared IP", () => {
  let mongo: MongoMemoryServer;
  let app: import("express").Express;

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
    app = (require("../app") as typeof import("../app")).createApp();
    const { hashPassword } = require("../utils/password") as typeof import("../utils/password");
    const hash = await hashPassword(PASSWORD);
    await User.insertMany(
      Array.from({ length: 16 }, (_, i) => ({ email: `user${i}@shared.test`, passwordHash: hash, role: "customer", name: `U${i}`, isEmailVerified: true })),
    );
  }, 30_000);

  afterAll(async () => {
    await mongoose.disconnect();
    await mongo.stop();
  }, 30_000);

  it("lets 15 different people sign in from the same IP within a minute", async () => {
    for (let i = 0; i < 15; i++) {
      const res = await request(app).post("/api/v1/auth/login").send({ email: `user${i}@shared.test`, password: PASSWORD });
      expect(res.status).toBe(200);
    }
  });

  it("lets a signed-in user browse quickly without being treated as signed out", async () => {
    const login = await request(app).post("/api/v1/auth/login").send({ email: "user15@shared.test", password: PASSWORD });
    const auth = `Bearer ${login.body.data.accessToken}`;
    for (let i = 0; i < 40; i++) {
      expect((await request(app).get("/api/v1/auth/me").set("Authorization", auth)).status).toBe(200);
    }
  });

  it("still stops password guessing against one email", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      statuses.push((await request(app).post("/api/v1/auth/login").send({ email: "user3@shared.test", password: `wrong-${i}` })).status);
    }
    // user3 already signed in once above, so 9 more attempts are allowed before the block.
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
    expect(statuses.slice(0, 5).every((s) => s === 401)).toBe(true);
  });
});

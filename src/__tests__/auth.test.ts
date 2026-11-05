import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { sha256Base64Url } from "../utils/crypto";
import { AuthToken } from "../models/AuthToken";
import { User } from "../models/User";

let mongo: MongoMemoryServer | null = null;

function cookieValue(
  setCookieHeader: string[] | undefined,
  name: string,
): string | undefined {
  if (!setCookieHeader) return undefined;
  const hit = setCookieHeader.find((c) => c.startsWith(`${name}=`));
  if (!hit) return undefined;
  return hit.split(";")[0].slice(name.length + 1);
}

describe("auth", () => {
  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    process.env.NODE_ENV = "test";
    process.env.MONGO_URI = mongo.getUri();
    process.env.FRONTEND_URL = "http://localhost:3000";
    process.env.JWT_ACCESS_SECRET = "test_access_secret";
    process.env.OAUTH_STATE_SECRET = "test_oauth_state_secret";
    await mongoose.connect(process.env.MONGO_URI);
  }, 30_000);

  afterAll(async () => {
    await mongoose.disconnect();
    if (mongo) await mongo.stop();
  }, 30_000);

  it("register -> verify email -> login -> me -> refresh", async () => {
    const { createApp } = require("../app") as typeof import("../app");
    const app = createApp();

    const email = "test@example.com";
    const password = "StrongPassw0rd!";

    const reg = await request(app)
      .post("/api/v1/auth/register")
      .send({ email, password, role: "customer", name: "Test User" });

    expect(reg.status).toBe(201);
    expect(reg.body.success).toBe(true);

    const user = await User.findOne({ email }).lean();
    expect(user).toBeTruthy();

    // Verification is a 6-digit PIN emailed to the user, checked together with the email.
    const knownToken = "482913";
    await AuthToken.deleteMany({ userId: user!._id, type: "email_verify" });
    await AuthToken.create({
      userId: user!._id,
      type: "email_verify",
      tokenHash: sha256Base64Url(knownToken),
      expiresAt: new Date(Date.now() + 60_000),
    });

    const verify = await request(app)
      .post("/api/v1/auth/email/verify")
      .send({ pin: knownToken, email });
    expect(verify.status).toBe(200);
    expect(verify.body.success).toBe(true);

    const login = await request(app)
      .post("/api/v1/auth/login")
      .send({ email, password });
    expect(login.status).toBe(200);
    expect(login.body.success).toBe(true);

    const rawSetCookie = login.headers["set-cookie"] as unknown;
    const setCookie = Array.isArray(rawSetCookie)
      ? (rawSetCookie as string[])
      : typeof rawSetCookie === "string"
        ? [rawSetCookie]
        : undefined;
    const access = cookieValue(setCookie, "access_token");
    const refresh = cookieValue(setCookie, "refresh_token");
    const csrf = cookieValue(setCookie, "csrf_token");
    expect(access).toBeTruthy();
    expect(refresh).toBeTruthy();
    expect(csrf).toBeTruthy();

    const me = await request(app)
      .get("/api/v1/auth/me")
      .set("Cookie", [`access_token=${access}`]);
    expect(me.status).toBe(200);
    expect(me.body.success).toBe(true);

    const refreshed = await request(app)
      .post("/api/v1/auth/refresh")
      .set("Cookie", [`refresh_token=${refresh}`, `csrf_token=${csrf}`])
      .set("X-CSRF-Token", csrf!);

    expect(refreshed.status).toBe(200);
    expect(refreshed.body.success).toBe(true);

    const rawSetCookie2 = refreshed.headers["set-cookie"] as unknown;
    const setCookie2 = Array.isArray(rawSetCookie2)
      ? (rawSetCookie2 as string[])
      : typeof rawSetCookie2 === "string"
        ? [rawSetCookie2]
        : undefined;
    const refresh2 = cookieValue(setCookie2, "refresh_token");
    const csrf2 = cookieValue(setCookie2, "csrf_token");
    expect(refresh2).toBeTruthy();
    expect(csrf2).toBeTruthy();
  });
});

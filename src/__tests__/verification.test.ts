import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { User } from "../models/User";
import { VerificationRequest } from "../models/VerificationRequest";

let mongo: MongoMemoryServer | null = null;

describe("KYC verification", () => {
  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    process.env.NODE_ENV = "test";
    process.env.MONGO_URI = mongo.getUri();
    process.env.FRONTEND_URL = "http://localhost:3000";
    process.env.JWT_ACCESS_SECRET = "test_access_secret";
    process.env.OAUTH_STATE_SECRET = "test_oauth_state_secret";
    process.env.SMILE_USE_MOCK = "true";
    await mongoose.connect(process.env.MONGO_URI);
  }, 30_000);

  afterAll(async () => {
    await mongoose.disconnect();
    if (mongo) await mongo.stop();
  }, 30_000);

  async function createVerifiedEmailUser(email: string, password: string) {
    const { hashPassword } = require("../utils/password") as typeof import("../utils/password");
    return User.create({
      email,
      passwordHash: await hashPassword(password),
      role: "customer",
      name: "KYC Tester",
      isEmailVerified: true,
    });
  }

  it("keeps KYC status after logging out and back in, and blocks a second submission", async () => {
    const { createApp } = require("../app") as typeof import("../app");
    const app = createApp();
    const email = "kyc@example.com";
    const password = "StrongPassw0rd!";
    await createVerifiedEmailUser(email, password);

    const login1 = await request(app).post("/api/v1/auth/login").send({ email, password });
    expect(login1.status).toBe(200);
    expect(login1.body.data.user.verificationStatus).toBe("unverified");
    const token1 = login1.body.data.accessToken as string;

    const submit = await request(app)
      .post("/api/v1/verification/individual")
      .set("Authorization", `Bearer ${token1}`)
      .send({ documentType: "NIN", documentNumber: "12345678901", selfieUrl: "test" });
    expect(submit.status).toBe(201);

    await request(app).post("/api/v1/auth/logout").set("Authorization", `Bearer ${token1}`);

    // The bug: the login response omitted verificationStatus, so the web app showed the KYC form again.
    const login2 = await request(app).post("/api/v1/auth/login").send({ email, password });
    expect(login2.status).toBe(200);
    expect(login2.body.data.user.verificationStatus).toBe("verified");
    expect(login2.body.data.user.verificationLevel).toBe("individual");

    const again = await request(app)
      .post("/api/v1/verification/individual")
      .set("Authorization", `Bearer ${login2.body.data.accessToken}`)
      .send({ documentType: "NIN", documentNumber: "12345678901", selfieUrl: "test" });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("ALREADY_VERIFIED");
    expect(await VerificationRequest.countDocuments({ status: "approved" })).toBe(1);
  });

  it("webhook verifies on a match and rejects (without verifying) on a mismatch", async () => {
    const { createApp } = require("../app") as typeof import("../app");
    const app = createApp();

    const passUser = await createVerifiedEmailUser("pass@example.com", "StrongPassw0rd!");
    const failUser = await createVerifiedEmailUser("fail@example.com", "StrongPassw0rd!");
    for (const [u, job] of [[passUser, "job-pass"], [failUser, "job-fail"]] as const) {
      await User.findByIdAndUpdate(u._id, { verificationStatus: "pending" });
      await VerificationRequest.create({ user: u._id, levelRequested: "individual", status: "pending", smileJobId: job });
    }

    const send = (userId: string, jobId: string, code: string) =>
      request(app)
        .post("/api/v1/verification/webhook")
        .send({ ResultCode: code, ResultText: "test", PartnerParams: { user_id: userId, job_id: jobId, job_type: 1 } });

    await send(String(passUser._id), "job-pass", "1010");
    await send(String(failUser._id), "job-fail", "1012");
    await new Promise((r) => setTimeout(r, 300)); // handler acknowledges before processing

    const passed = await User.findById(passUser._id).lean();
    const failed = await User.findById(failUser._id).lean();
    expect(passed?.verificationStatus).toBe("verified");
    expect(passed?.verificationLevel).toBe("individual");
    expect(failed?.verificationStatus).toBe("rejected");
    expect((await VerificationRequest.findOne({ smileJobId: "job-pass" }))?.status).toBe("approved");
    expect((await VerificationRequest.findOne({ smileJobId: "job-fail" }))?.status).toBe("rejected");
  });
});

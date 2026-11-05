import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { User } from "../models/User";
import { Product } from "../models/Product";
import { AcquisitionRequest } from "../models/AcquisitionRequest";

jest.mock("../services/emailService", () => ({ sendEmail: jest.fn(async () => {}) }));

// On a replica set (e.g. Atlas) the same code runs inside real transactions.
describe("acquisition requests on a replica set", () => {
  let rs: MongoMemoryReplSet;
  let app: import("express").Express;

  beforeAll(async () => {
    rs = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    Object.assign(process.env, {
      NODE_ENV: "test",
      MONGO_URI: rs.getUri(),
      FRONTEND_URL: "http://localhost:3000",
      JWT_ACCESS_SECRET: "test_access_secret",
      OAUTH_STATE_SECRET: "test_oauth_state_secret",
    });
    await mongoose.connect(rs.getUri());
    // Collections must exist before use inside a transaction.
    await Promise.all([AcquisitionRequest.createCollection(), require("../models/AcquisitionEvent").AcquisitionEvent.createCollection()]);
    require("../utils/transaction").resetTransactionSupportCache();
    app = (require("../app") as typeof import("../app")).createApp();
  }, 60_000);

  afterAll(async () => {
    await mongoose.disconnect();
    await rs.stop();
  }, 30_000);

  it("uses transactions and creates the request", async () => {
    const { transactionsSupported } = require("../utils/transaction") as typeof import("../utils/transaction");
    expect(await transactionsSupported()).toBe(true);

    const { hashPassword } = require("../utils/password") as typeof import("../utils/password");
    const vendor = await User.create({ email: "rs-v@example.com", passwordHash: "x", role: "vendor", name: "V", isEmailVerified: true });
    await User.create({ email: "rs-c@example.com", passwordHash: await hashPassword("StrongPassw0rd!"), role: "customer", name: "C", isEmailVerified: true });
    const product = await Product.create({ name: "BYD Song L", make: "BYD", category: "vehicle", price: "₦80,000,000", image: "https://x/s.jpg", vendorId: vendor._id, vendorName: "V" });
    const login = await request(app).post("/api/v1/auth/login").send({ email: "rs-c@example.com", password: "StrongPassw0rd!" });

    const res = await request(app)
      .post("/api/v1/acquisition-requests")
      .set("Authorization", `Bearer ${login.body.data.accessToken}`)
      .send({ productId: String(product._id), message: "Hi is this available" });
    expect(res.status).toBe(201);
  });
});

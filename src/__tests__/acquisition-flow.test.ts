import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { User } from "../models/User";
import { Product } from "../models/Product";
import { AcquisitionEvent } from "../models/AcquisitionEvent";

jest.mock("../services/emailService", () => ({ sendEmail: jest.fn(async () => {}) }));
jest.mock("../utils/cloudinary", () => ({
  uploadFile: jest.fn(async () => "https://res.cloudinary.com/test/receipt.jpg"),
  uploadImage: jest.fn(async () => "https://res.cloudinary.com/test/receipt.jpg"),
}));

const PASSWORD = "StrongPassw0rd!";

// MongoMemoryServer is a standalone server — like a single self-hosted MongoDB, it has no
// transaction support. The whole acquisition flow must still work there.
describe("acquisition flow on a standalone MongoDB", () => {
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
    require("../utils/transaction").resetTransactionSupportCache();
    app = (require("../app") as typeof import("../app")).createApp();
  }, 30_000);

  afterAll(async () => {
    await mongoose.disconnect();
    await mongo.stop();
  }, 30_000);

  async function login(email: string, role: "customer" | "vendor" | "admin") {
    const { hashPassword } = require("../utils/password") as typeof import("../utils/password");
    const user = await User.create({ email, passwordHash: await hashPassword(PASSWORD), role, name: role, isEmailVerified: true });
    const res = await request(app).post("/api/v1/auth/login").send({ email, password: PASSWORD });
    return { id: user._id, auth: `Bearer ${res.body.data.accessToken}` };
  }

  it("reports that transactions aren't available", async () => {
    const { transactionsSupported } = require("../utils/transaction") as typeof import("../utils/transaction");
    expect(await transactionsSupported()).toBe(false);
  });

  it("runs request -> accept -> receipt -> payment -> complete, with an event per step", async () => {
    const vendor = await login("acq-vendor@example.com", "vendor");
    const customer = await login("acq-customer@example.com", "customer");
    const product = await Product.create({
      name: "BYD Han", make: "BYD", category: "vehicle", price: "₦80,000,000",
      image: "https://x/han.jpg", vendorId: vendor.id, vendorName: "vendor",
    });

    const created = await request(app)
      .post("/api/v1/acquisition-requests")
      .set("Authorization", customer.auth)
      .send({ productId: String(product._id), message: "Hi is this available" });
    expect(created.status).toBe(201);
    const id = created.body.data.request._id;

    // A second active request for the same vehicle is refused, not a 500.
    const dup = await request(app)
      .post("/api/v1/acquisition-requests")
      .set("Authorization", customer.auth)
      .send({ productId: String(product._id) });
    expect(dup.status).toBe(409);

    const accepted = await request(app).patch(`/api/v1/acquisition-requests/${id}/vendor/accept`).set("Authorization", vendor.auth);
    expect(accepted.status).toBe(200);
    expect(accepted.body.data.request.status).toBe("accepted");

    // Accepting twice hits the status guard.
    const again = await request(app).patch(`/api/v1/acquisition-requests/${id}/vendor/accept`).set("Authorization", vendor.auth);
    expect(again.status).toBe(400);

    const receipt = await request(app)
      .post(`/api/v1/acquisition-requests/${id}/receipt`)
      .set("Authorization", customer.auth)
      .send({ receiptImageBase64: "data:image/png;base64,iVBORw0KGgo=" });
    expect(receipt.status).toBe(200);

    const paid = await request(app)
      .post(`/api/v1/acquisition-requests/${id}/vendor/confirm-payment`)
      .set("Authorization", vendor.auth)
      .send({ amount: 80_000_000 });
    expect(paid.status).toBe(200);

    const done = await request(app)
      .post(`/api/v1/acquisition-requests/${id}/client/confirm-completed`)
      .set("Authorization", customer.auth);
    expect(done.status).toBe(200);
    expect(done.body.data.request.status).toBe("completed");

    const events = await AcquisitionEvent.find({ requestId: id }).sort({ createdAt: 1 }).lean();
    expect(events.map((e) => e.toStatus)).toEqual(["pending", "accepted", "receipt_uploaded", "payment_confirmed", "completed"]);
  });
});

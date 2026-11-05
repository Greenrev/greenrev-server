/**
 * End-to-end audit: every user type exercises the features they should have, and is
 * refused the ones they shouldn't. External services (Cloudinary, email, OpenRouter)
 * are mocked; everything else — routing, auth, validation, DB — is real.
 *
 * Run before every release: `npx jest src/__tests__/platform-audit.test.ts`
 */
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { User } from "../models/User";

jest.mock("../services/emailService", () => ({ sendEmail: jest.fn(async () => {}) }));
jest.mock("../utils/cloudinary", () => ({
  uploadFile: jest.fn(async () => "https://res.cloudinary.com/test/file.jpg"),
  uploadImage: jest.fn(async () => "https://res.cloudinary.com/test/image.jpg"),
}));

const PASSWORD = "StrongPassw0rd!";
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const PNG = Buffer.from(PNG_B64, "base64");

type Role = "guest" | "customer" | "vendor" | "mechanic" | "admin";

jest.setTimeout(30_000);

describe("platform audit — every user type", () => {
  let mongo: MongoMemoryServer;
  let app: import("express").Express;
  const auth: Record<Exclude<Role, "guest">, string> = { customer: "", vendor: "", mechanic: "", admin: "" };
  const ids: Record<string, string> = {};
  const realFetch = global.fetch;

  const as = (role: Role) => {
    const wrap = (r: request.Test) => (role === "guest" ? r : r.set("Authorization", auth[role]));
    return {
      get: (p: string) => wrap(request(app).get(p)),
      post: (p: string, body?: object) => wrap(request(app).post(p)).send(body ?? {}),
      put: (p: string, body?: object) => wrap(request(app).put(p)).send(body ?? {}),
      patch: (p: string, body?: object) => wrap(request(app).patch(p)).send(body ?? {}),
      delete: (p: string, body?: object) => wrap(request(app).delete(p)).send(body ?? {}),
      upload: (p: string) => wrap(request(app).post(p)),
    };
  };

  /** Asserts the status and, on mismatch, shows the server's error body. */
  async function expectStatus(res: request.Test | Promise<request.Response>, status: number) {
    const r = await res;
    if (r.status !== status) throw new Error(`Expected ${status}, got ${r.status}: ${JSON.stringify(r.body).slice(0, 300)}`);
    return r;
  }

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    Object.assign(process.env, {
      NODE_ENV: "test",
      MONGO_URI: mongo.getUri(),
      FRONTEND_URL: "http://localhost:3000",
      JWT_ACCESS_SECRET: "test_access_secret",
      OAUTH_STATE_SECRET: "test_oauth_state_secret",
      OPENROUTER_API_KEY: "test-key",
      AI_CONCIERGE_BURST_PER_MINUTE: "1000",
    });
    await mongoose.connect(mongo.getUri());
    app = (require("../app") as typeof import("../app")).createApp();

    // Real sign-up for the self-service roles; admins can't self-register.
    for (const role of ["customer", "vendor", "mechanic"] as const) {
      const email = `${role}@audit.test`;
      await expectStatus(
        request(app).post("/api/v1/auth/register").send({
          email, password: PASSWORD, role, name: `Audit ${role}`,
          companyName: role === "vendor" ? "Audit Motors" : undefined,
          garageName: role === "mechanic" ? "Audit Garage" : undefined,
        }),
        201,
      );
      await User.updateOne({ email }, { isEmailVerified: true, phone: "+2348000000001" });
    }
    const { hashPassword } = require("../utils/password") as typeof import("../utils/password");
    await User.create({ email: "admin@audit.test", passwordHash: await hashPassword(PASSWORD), role: "admin", name: "Audit Admin", isEmailVerified: true });

    for (const role of ["customer", "vendor", "mechanic", "admin"] as const) {
      const res = await expectStatus(request(app).post("/api/v1/auth/login").send({ email: `${role}@audit.test`, password: PASSWORD }), 200);
      auth[role] = `Bearer ${res.body.data.accessToken}`;
      ids[role] = String(res.body.data.user.id ?? res.body.data.user._id);
    }
    await User.updateOne({ email: "mechanic@audit.test" }, { lat: 6.44, lng: 3.47, city: "Lagos", country: "Nigeria" });
  }, 60_000);

  afterAll(async () => {
    global.fetch = realFetch;
    await mongoose.disconnect();
    await mongo.stop();
  }, 30_000);

  // ---------------------------------------------------------------- guests

  describe("guest (not signed in)", () => {
    it("can browse public pages and data", async () => {
      await expectStatus(as("guest").get("/api/v1/health"), 200);
      await expectStatus(as("guest").get("/api/v1/products"), 200);
      await expectStatus(as("guest").get("/api/v1/listing-options"), 200);
      const experts = await expectStatus(as("guest").get("/api/v1/experts"), 200);
      expect(experts.body.data.contactHidden).toBe(true);
      await expectStatus(as("guest").get("/api/v1/ai/status"), 200);
      await expectStatus(as("guest").get(`/api/v1/experts/${ids.mechanic}/reviews`), 200);
      await expectStatus(as("guest").get(`/api/v1/reviews/vendor/${ids.vendor}`), 200);
      await expectStatus(as("guest").post("/api/v1/inquiries", { name: "Guest", email: "guest@audit.test", message: "Do you deliver to Abuja?" }), 201);
    });

    it("is asked to sign in for account features", async () => {
      for (const [method, path] of [
        ["get", "/api/v1/profile"],
        ["get", "/api/v1/auth/me"],
        ["post", "/api/v1/acquisition-requests"],
        ["post", "/api/v1/bookings"],
        ["post", "/api/v1/products"],
        ["post", "/api/v1/upload"],
        ["get", "/api/v1/notifications"],
        ["post", "/api/v1/support"],
        ["get", "/api/v1/admin/users"],
        ["get", "/api/v1/mechanic/profile"],
        ["post", "/api/v1/ai/listing-extract"],
      ] as const) {
        const res = await (as("guest") as Record<string, (p: string) => request.Test>)[method](path);
        expect([401]).toContain(res.status);
      }
    });
  });

  // ---------------------------------------------------------------- vendor

  describe("vendor", () => {
    it("manages listings, uploads and AI assist", async () => {
      const v = as("vendor");
      await expectStatus(v.get("/api/v1/auth/me"), 200);
      await expectStatus(v.upload("/api/v1/upload").attach("files", PNG, { filename: "car.png", contentType: "image/png" }), 200);

      const created = await expectStatus(
        v.post("/api/v1/products", {
          name: "2021 Toyota Camry XSE", make: "Toyota", category: "vehicle", price: "₦25,000,000", priceValue: 25000000,
          year: 2021, image: "https://res.cloudinary.com/test/file.jpg", images: ["https://res.cloudinary.com/test/file.jpg"],
          specs: { transmission: "Automatic", origin: "Foreign Used", vin: "1M8GDM9AXKP042788" }, stockQuantity: 1,
        }),
        201,
      );
      ids.product = String(created.body.data._id);
      const part = await expectStatus(
        v.post("/api/v1/products", { name: "Brake Pads", make: "Bosch", category: "part", price: "₦45,000", image: "https://x/p.jpg" }),
        201,
      );
      ids.part = String(part.body.data._id);

      await expectStatus(v.get("/api/v1/products/vendor"), 200);
      await expectStatus(v.put(`/api/v1/products/${ids.product}`, { price: "₦24,500,000" }), 200);
      await expectStatus(as("guest").get(`/api/v1/products/${ids.product}`), 200);
      await expectStatus(v.get("/api/v1/acquisition-requests/vendor"), 200);
      await expectStatus(v.get("/api/v1/acquisition-requests/vendor/count"), 200);
      await expectStatus(v.get("/api/v1/vendor/messages"), 200);
      await expectStatus(v.get("/api/v1/verification/status"), 200);

      global.fetch = jest.fn(async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: '{"fields":{"make":"Toyota"},"warnings":[]}' } }] }), { status: 200 }),
      ) as unknown as typeof fetch;
      const ai = await expectStatus(
        v.upload("/api/v1/ai/listing-extract").field("category", "vehicle").attach("images", PNG, { filename: "c.png", contentType: "image/png" }),
        200,
      );
      expect(ai.body.data.fields.make).toBe("Toyota");
      global.fetch = realFetch;
    });

    it("can't use customer, expert or admin features", async () => {
      const v = as("vendor");
      await expectStatus(v.post("/api/v1/acquisition-requests", { productId: ids.product }), 403);
      await expectStatus(v.get("/api/v1/mechanic/profile"), 403);
      await expectStatus(v.get("/api/v1/admin/users"), 403);
      await expectStatus(v.get("/api/v1/bookings/mechanic"), 403);
    });
  });

  // ---------------------------------------------------------------- customer

  describe("customer", () => {
    it("runs the full purchase journey with the vendor", async () => {
      const c = as("customer");
      const v = as("vendor");
      await expectStatus(c.get("/api/v1/profile"), 200);
      await expectStatus(c.put("/api/v1/profile", { name: "Audit Customer", phone: "+2348000000002" }), 200);

      const req = await expectStatus(c.post("/api/v1/acquisition-requests", { productId: ids.product, message: "Is this available?" }), 201);
      const id = req.body.data.request._id;
      await expectStatus(c.get("/api/v1/acquisition-requests"), 200);
      await expectStatus(c.post(`/api/v1/acquisition-requests/${id}/messages`, { text: "Can I inspect it Saturday?" }), 201);
      await expectStatus(v.get(`/api/v1/acquisition-requests/${id}/messages`), 200);
      await expectStatus(v.patch(`/api/v1/acquisition-requests/${id}/vendor/accept`), 200);
      await expectStatus(c.post(`/api/v1/acquisition-requests/${id}/receipt`, { receiptImageBase64: `data:image/png;base64,${PNG_B64}` }), 200);
      await expectStatus(v.post(`/api/v1/acquisition-requests/${id}/vendor/confirm-payment`, { amount: 24500000 }), 200);
      await expectStatus(c.post(`/api/v1/acquisition-requests/${id}/client/confirm-completed`), 200);
      await expectStatus(c.post(`/api/v1/acquisition-requests/${id}/review`, { rating: 5, comment: "Smooth purchase" }), 201);
      ids.acquisition = id;

      await expectStatus(c.post(`/api/v1/products/${ids.part}/reviews`, { rating: 4, comment: "Good pads" }), 201);
      await expectStatus(as("guest").get(`/api/v1/products/${ids.part}/reviews`), 200);
      await expectStatus(c.post(`/api/v1/vendors/${ids.vendor}/messages`, { message: "Do you have more Camrys?", productId: ids.product }), 201);
    });

    it("books and messages an expert", async () => {
      const c = as("customer");
      const experts = await expectStatus(c.get("/api/v1/experts"), 200);
      expect(experts.body.data.contactHidden).toBe(false);
      const booking = await expectStatus(
        c.post("/api/v1/bookings", {
          mechanicId: ids.mechanic,
          vehicleDetails: { make: "Toyota", model: "Camry", year: 2021 },
          issueDescription: "Brake noise when stopping",
          requestedDate: new Date(Date.now() + 2 * 86400_000).toISOString(),
        }),
        201,
      );
      ids.booking = String(booking.body.data.booking?._id ?? booking.body.data._id);
      await expectStatus(c.get("/api/v1/bookings/my"), 200);
      await expectStatus(c.post(`/api/v1/experts/${ids.mechanic}/messages`, { message: "Are you open Sunday?" }), 201);
      await expectStatus(c.post(`/api/v1/experts/${ids.mechanic}/reviews`, { rating: 5, comment: "Great work" }), 200);
    });

    it("gets support, notifications and the AI concierge", async () => {
      const c = as("customer");
      const ticket = await expectStatus(c.post("/api/v1/support", { subject: "Payment question", initialMessage: "How do I pay?" }), 201);
      ids.ticket = String(ticket.body.data.ticket?._id ?? ticket.body.data._id);
      await expectStatus(c.get("/api/v1/support/me"), 200);
      await expectStatus(c.post(`/api/v1/support/${ids.ticket}/reply`, { content: "Any update?" }), 200);
      await expectStatus(c.get("/api/v1/notifications"), 200);
      await expectStatus(c.post("/api/v1/notifications/read", {}), 200);
      await expectStatus(c.get("/api/v1/profile/messages"), 200);

      global.fetch = jest.fn(async () =>
        new Response(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "Hello" } }] })}\n\ndata: [DONE]\n\n`), { status: 200 }),
      ) as unknown as typeof fetch;
      const chat = await expectStatus(c.post("/api/v1/ai/concierge", { messages: [{ role: "user", content: "Hi" }], compareIds: [ids.product] }), 200);
      expect(chat.text).toContain('"text":"Hello"');
      global.fetch = realFetch;
    });

    it("can't use vendor, expert or admin features", async () => {
      const c = as("customer");
      await expectStatus(c.post("/api/v1/products", { name: "x", make: "x", category: "part", price: "1", image: "x" }), 403);
      await expectStatus(c.put(`/api/v1/products/${ids.product}`, { price: "₦1" }), 403);
      await expectStatus(c.upload("/api/v1/upload").attach("files", PNG, { filename: "x.png", contentType: "image/png" }), 403);
      await expectStatus(c.get("/api/v1/mechanic/profile"), 403);
      await expectStatus(c.get("/api/v1/vendor/messages"), 403);
      await expectStatus(c.get("/api/v1/admin/users"), 403);
      await expectStatus(c.upload("/api/v1/ai/listing-extract").attach("images", PNG, { filename: "x.png", contentType: "image/png" }), 403);
    });
  });

  // ---------------------------------------------------------------- mechanic

  describe("mechanic (expert)", () => {
    it("manages profile, location, bookings and messages", async () => {
      const m = as("mechanic");
      await expectStatus(m.get("/api/v1/mechanic/profile"), 200);
      await expectStatus(m.patch("/api/v1/mechanic/profile", { bio: "Toyota specialist", specialization: ["Brakes", "AC"], hourlyRate: 15000 }), 200);
      await expectStatus(
        m.patch("/api/v1/mechanic/location", { lat: 6.4474, lng: 3.4723, address: "12 Admiralty Way", city: "Lagos", country: "Nigeria" }),
        200,
      );
      const bookings = await expectStatus(m.get("/api/v1/bookings/mechanic"), 200);
      expect(JSON.stringify(bookings.body)).toContain(ids.booking);
      await expectStatus(m.patch(`/api/v1/bookings/${ids.booking}/status`, { status: "CONFIRMED" }), 200);
      const msgs = await expectStatus(m.get("/api/v1/mechanic/messages"), 200);
      const first = msgs.body.data.messages[0];
      await expectStatus(m.patch(`/api/v1/mechanic/messages/${first._id}/reply`, { reply: "Yes, 9am to 2pm." }), 200);
    });

    it("can't use vendor or admin features", async () => {
      const m = as("mechanic");
      await expectStatus(m.post("/api/v1/products", { name: "x", make: "x", category: "part", price: "1", image: "x" }), 403);
      await expectStatus(m.get("/api/v1/admin/users"), 403);
      await expectStatus(m.get("/api/v1/vendor/messages"), 403);
    });
  });

  // ---------------------------------------------------------------- admin

  describe("admin", () => {
    it("can see and moderate everything", async () => {
      const a = as("admin");
      await expectStatus(a.get("/api/v1/admin/ping"), 200);
      const users = await expectStatus(a.get("/api/v1/admin/users"), 200);
      expect(JSON.stringify(users.body)).toContain("customer@audit.test");
      await expectStatus(a.get("/api/v1/admin/transactions"), 200);
      await expectStatus(a.get("/api/v1/admin/roles"), 200);
      await expectStatus(a.get("/api/v1/admin/audit-logs"), 200);
      await expectStatus(a.get("/api/v1/admin/bookings"), 200);
      await expectStatus(a.get("/api/v1/admin/verifications"), 200);
      await expectStatus(a.get("/api/v1/admin/acquisition-requests"), 200);
      await expectStatus(a.get(`/api/v1/admin/acquisition-requests/${ids.acquisition}/events`), 200);
      await expectStatus(a.get("/api/v1/admin/listing-options"), 200);
      await expectStatus(a.get("/api/v1/admin/listing-options/pending-count"), 200);

      const inquiries = await expectStatus(a.get("/api/v1/admin/inquiries"), 200);
      await expectStatus(a.patch(`/api/v1/admin/inquiries/${inquiries.body.data.inquiries[0]._id}/status`, { status: "READ" }), 200);
      await expectStatus(a.get("/api/v1/admin/support"), 200);
      await expectStatus(a.patch(`/api/v1/admin/support/${ids.ticket}/status`, { status: "RESOLVED" }), 200);
      await expectStatus(a.patch(`/api/v1/admin/support/${ids.ticket}/status`, { status: "resolved" }), 400);

      const reviews = await expectStatus(a.get("/api/v1/admin/reviews"), 200);
      expect(reviews.body.data.length).toBeGreaterThan(0);

      await expectStatus(a.patch(`/api/v1/admin/users/${ids.vendor}/tier`, { verificationLevel: "business" }), 200);
      await expectStatus(a.patch(`/api/v1/admin/users/${ids.mechanic}/status`, { status: "active" }), 200);
    });
  });

  // ---------------------------------------------------------------- account lifecycle

  describe("account lifecycle", () => {
    it("lets a customer delete their own account", async () => {
      await expectStatus(as("customer").delete("/api/v1/profile"), 200);
      await expectStatus(as("customer").get("/api/v1/profile"), 401);
    });

    it("takes a vendor's listings down when they delete their account", async () => {
      await expectStatus(as("vendor").delete("/api/v1/profile"), 200);
      await expectStatus(as("guest").get(`/api/v1/products/${ids.part}`), 404);
      const all = await expectStatus(as("guest").get("/api/v1/products"), 200);
      expect(JSON.stringify(all.body)).not.toContain(ids.part);
    });
  });
});

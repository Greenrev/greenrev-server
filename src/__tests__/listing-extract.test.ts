import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { User } from "../models/User";

let mongo: MongoMemoryServer | null = null;
const PASSWORD = "StrongPassw0rd!";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

describe("listing extraction sanitiser", () => {
  // Required lazily: importing it loads env config, which needs the vars set in the HTTP suite below.
  let sanitizeExtraction: typeof import("../services/listingExtractService").sanitizeExtraction;
  let vinCheckDigitValid: typeof import("../services/listingExtractService").vinCheckDigitValid;
  beforeAll(() => {
    process.env.MONGO_URI ??= "mongodb://unused";
    process.env.FRONTEND_URL ??= "http://localhost:3000";
    process.env.JWT_ACCESS_SECRET ??= "test_access_secret";
    process.env.OAUTH_STATE_SECRET ??= "test_oauth_state_secret";
    ({ sanitizeExtraction, vinCheckDigitValid } = require("../services/listingExtractService"));
  });

  it("validates VIN check digits", () => {
    expect(vinCheckDigitValid("1M8GDM9AXKP042788")).toBe(true);
    expect(vinCheckDigitValid("1M8GDM9A1KP042788")).toBe(false);
    expect(vinCheckDigitValid("1M8GDM9AXKP04278")).toBe(false);
  });

  it("keeps known vehicle fields, coerces types and drops junk", () => {
    const { fields, warnings, transcript } = sanitizeExtraction(
      {
        transcript: "  2019 Toyota Camry  ",
        fields: {
          name: "2019 Toyota Camry XSE",
          make: "Toyota",
          year: "2019",
          horsepower: "301 hp",
          colorHex: "#ABCDEF",
          vin: "1m8gdm9axkp042788",
          bogus: "ignored",
          extraSpecs: [
            { key: "Fuel Type", value: "Petrol" },
            { key: "fuel type", value: "duplicate" },
            { key: "", value: "no key" },
          ],
        },
        warnings: ["Odometer unit unclear"],
      },
      "vehicle",
    );
    expect(fields).toEqual({
      name: "2019 Toyota Camry XSE",
      make: "Toyota",
      year: 2019,
      horsepower: 301,
      colorHex: "#abcdef",
      vin: "1M8GDM9AXKP042788",
      extraSpecs: [{ key: "Fuel Type", value: "Petrol" }],
    });
    expect(transcript).toBe("2019 Toyota Camry");
    expect(warnings).toEqual(["Odometer unit unclear"]);
  });

  it("rejects malformed VINs with a warning instead of filling them", () => {
    const { fields, warnings } = sanitizeExtraction({ fields: { vin: "WDB12345OIQ" } }, "vehicle");
    expect(fields.vin).toBeUndefined();
    expect(warnings[0]).toMatch(/isn't a valid 17-character VIN/);
  });

  it("ignores vehicle-only fields for parts", () => {
    const { fields } = sanitizeExtraction(
      { fields: { name: "Brake Pads", make: "Bosch", vin: "1M8GDM9AXKP042788", year: 2020 } },
      "part",
    );
    expect(fields).toEqual({ name: "Brake Pads", make: "Bosch" });
  });

  it("survives non-object model output", () => {
    expect(sanitizeExtraction("nonsense", "vehicle")).toEqual({ fields: {}, transcript: undefined, warnings: [] });
  });
});

describe("POST /api/v1/ai/listing-extract", () => {
  let app: import("express").Express;
  const realFetch = global.fetch;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    process.env.NODE_ENV = "test";
    process.env.MONGO_URI = mongo.getUri();
    process.env.FRONTEND_URL = "http://localhost:3000";
    process.env.JWT_ACCESS_SECRET = "test_access_secret";
    process.env.OAUTH_STATE_SECRET = "test_oauth_state_secret";
    process.env.OPENROUTER_API_KEY = "test-key";
    await mongoose.connect(process.env.MONGO_URI);
    const { createApp } = require("../app") as typeof import("../app");
    app = createApp();
  }, 30_000);

  afterAll(async () => {
    global.fetch = realFetch;
    delete process.env.OPENROUTER_API_KEY;
    await mongoose.disconnect();
    if (mongo) await mongo.stop();
  }, 30_000);

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

  it("requires a signed-in vendor", async () => {
    const anon = await request(app).post("/api/v1/ai/listing-extract");
    expect(anon.status).toBe(401);

    const customer = await tokenFor("buyer-ai@example.com", "customer");
    const res = await request(app)
      .post("/api/v1/ai/listing-extract")
      .set("Authorization", `Bearer ${customer}`)
      .attach("images", PNG, { filename: "car.png", contentType: "image/png" });
    expect(res.status).toBe(403);
  });

  it("rejects requests with no photo or audio, and unsupported audio", async () => {
    const vendor = await tokenFor("vendor-ai@example.com", "vendor");
    const empty = await request(app)
      .post("/api/v1/ai/listing-extract")
      .set("Authorization", `Bearer ${vendor}`)
      .field("category", "vehicle");
    expect(empty.status).toBe(400);
    expect(empty.body.error.code).toBe("NO_INPUT");

    const webm = await request(app)
      .post("/api/v1/ai/listing-extract")
      .set("Authorization", `Bearer ${vendor}`)
      .attach("audio", Buffer.from("x"), { filename: "note.webm", contentType: "audio/webm" });
    expect(webm.status).toBe(400);
    expect(webm.body.error.code).toBe("UNSUPPORTED_FILE_TYPE");
  });

  it("returns sanitised fields from the model", async () => {
    const fetchMock = jest.fn(async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '```json\n{"transcript":"Toyota Camry 2019","fields":{"make":"Toyota","year":2019},"warnings":[]}\n```' } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const vendor = await tokenFor("vendor-ai2@example.com", "vendor");
    const res = await request(app)
      .post("/api/v1/ai/listing-extract")
      .set("Authorization", `Bearer ${vendor}`)
      .field("category", "vehicle")
      .attach("images", PNG, { filename: "car.png", contentType: "image/png" })
      .attach("audio", Buffer.from("RIFF"), { filename: "note.wav", contentType: "audio/wav" });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      fields: { make: "Toyota", year: 2019 },
      transcript: "Toyota Camry 2019",
      warnings: [],
    });

    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    const parts = body.messages[1].content.map((c: { type: string }) => c.type);
    expect(parts).toEqual(["text", "image_url", "input_audio"]);
    expect(body.messages[1].content[2].input_audio.format).toBe("wav");
  });
});

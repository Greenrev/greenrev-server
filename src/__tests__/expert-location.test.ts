import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { User } from "../models/User";

let mongo: MongoMemoryServer | null = null;
const PASSWORD = "StrongPassw0rd!";

describe("expert location", () => {
  let app: import("express").Express;
  let geo: typeof import("../services/geoService");
  const realFetch = global.fetch;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    process.env.NODE_ENV = "test";
    process.env.MONGO_URI = mongo.getUri();
    process.env.FRONTEND_URL = "http://localhost:3000";
    process.env.JWT_ACCESS_SECRET = "test_access_secret";
    process.env.OAUTH_STATE_SECRET = "test_oauth_state_secret";
    delete process.env.GOOGLE_MAPS_SERVER_KEY;
    await mongoose.connect(process.env.MONGO_URI);
    const { createApp } = require("../app") as typeof import("../app");
    app = createApp();
    geo = require("../services/geoService");
  }, 30_000);

  afterEach(() => {
    global.fetch = realFetch;
  });

  afterAll(async () => {
    await mongoose.disconnect();
    if (mongo) await mongo.stop();
  }, 30_000);

  async function login(email: string, role: "customer" | "mechanic") {
    const { hashPassword } = require("../utils/password") as typeof import("../utils/password");
    const user = await User.create({ email, passwordHash: await hashPassword(PASSWORD), role, name: "Ace Garage", isEmailVerified: true });
    const res = await request(app).post("/api/v1/auth/login").send({ email, password: PASSWORD });
    return { id: String(user._id), token: res.body.data.accessToken as string };
  }

  describe("PATCH /mechanic/location", () => {
    let mech: { id: string; token: string };
    beforeAll(async () => {
      mech = await login("loc-mech@example.com", "mechanic");
    });
    const patch = (body: object) =>
      request(app).patch("/api/v1/mechanic/location").set("Authorization", `Bearer ${mech.token}`).send(body);

    it("saves the pin, address, state, radius and privacy", async () => {
      const res = await patch({
        lat: 6.4412345678, lng: 3.4712, address: " 12  Admiralty Way ", city: "Lekki", state: "Lagos", country: "Nigeria",
        serviceRadiusKm: 10, locationPrivacy: "approximate",
      });
      expect(res.status).toBe(200);
      expect(res.body.data.location).toEqual({
        address: "12 Admiralty Way", city: "Lekki", state: "Lagos", country: "Nigeria",
        lat: 6.441235, lng: 3.4712, serviceRadiusKm: 10, locationPrivacy: "approximate",
      });
      const profile = await request(app).get("/api/v1/mechanic/profile").set("Authorization", `Bearer ${mech.token}`);
      expect(profile.body.data.profile).toMatchObject({ state: "Lagos", serviceRadiusKm: 10, locationPrivacy: "approximate" });
    });

    it.each([
      [{ lat: 95, lng: 3 }, /Latitude/],
      [{ lat: 6, lng: "east" }, /Longitude/],
      [{ lng: 3 }, /Latitude/],
      [{ lat: 0, lng: 0 }, /Drop the pin/],
      [{ lat: 6, lng: 3, serviceRadiusKm: 30 }, /Service radius/],
      [{ lat: 6, lng: 3, locationPrivacy: "hidden" }, /locationPrivacy/],
      [{ lat: 6, lng: 3, city: "x".repeat(81) }, /too long/],
    ])("rejects %j", async (body, message) => {
      const res = await patch(body);
      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(message);
    });
  });

  describe("GET /experts with approximate privacy", () => {
    it("blurs the pin to ~1 km and hides the street address", async () => {
      await User.create({
        email: "approx@example.com", passwordHash: "x", role: "mechanic", name: "Hidden Hands", isEmailVerified: true,
        lat: 6.441234, lng: 3.471234, address: "Secret Close", state: "Lagos", serviceRadiusKm: 50, locationPrivacy: "approximate",
      });
      await User.create({
        email: "exact@example.com", passwordHash: "x", role: "mechanic", name: "Open Garage", isEmailVerified: true,
        lat: 6.5, lng: 3.3, address: "1 Open Road",
      });
      const res = await request(app).get("/api/v1/experts");
      const hidden = res.body.data.experts.find((e: { name: string }) => e.name === "Hidden Hands");
      expect(hidden).toMatchObject({ lat: 6.44, lng: 3.47, address: "", approximateLocation: true, serviceRadiusKm: 50, state: "Lagos" });
      expect(JSON.stringify(res.body)).not.toContain("Secret Close");
      const open = res.body.data.experts.find((e: { name: string }) => e.name === "Open Garage");
      expect(open).toMatchObject({ lat: 6.5, lng: 3.3, address: "1 Open Road", approximateLocation: false, serviceRadiusKm: 25 });
    });
  });

  describe("geocoding", () => {
    it("parses Google and OpenStreetMap results into the same shape", () => {
      expect(
        geo.fromGoogle({
          formatted_address: "12 Admiralty Way, Lekki Phase 1, Lagos, Nigeria",
          address_components: [
            { long_name: "12", types: ["street_number"] },
            { long_name: "Admiralty Way", types: ["route"] },
            { long_name: "Lekki", types: ["locality", "political"] },
            { long_name: "Lagos", types: ["administrative_area_level_1"] },
            { long_name: "Nigeria", types: ["country"] },
          ],
          geometry: { location: { lat: 6.44, lng: 3.47 } },
        }),
      ).toEqual({ label: "12 Admiralty Way, Lekki Phase 1, Lagos, Nigeria", address: "12 Admiralty Way", city: "Lekki", state: "Lagos", country: "Nigeria", lat: 6.44, lng: 3.47 });

      expect(
        geo.fromNominatim({
          display_name: "Admiralty Way, Lekki, Lagos, Nigeria",
          lat: "6.44",
          lon: "3.47",
          address: { road: "Admiralty Way", town: "Lekki", state: "Lagos", country: "Nigeria" },
        }),
      ).toEqual({ label: "Admiralty Way, Lekki, Lagos, Nigeria", address: "Admiralty Way", city: "Lekki", state: "Lagos", country: "Nigeria", lat: 6.44, lng: 3.47 });
    });

    it("only experts can use the lookup, and reverse keeps the chosen pin", async () => {
      const buyer = await login("geo-buyer@example.com", "customer");
      const denied = await request(app).get("/api/v1/geo/search?q=Lekki").set("Authorization", `Bearer ${buyer.token}`);
      expect(denied.status).toBe(403);

      const mech = await login("geo-mech@example.com", "mechanic");
      const calls: string[] = [];
      global.fetch = jest.fn(async (url: string | URL | Request) => {
        calls.push(String(url));
        return new Response(
          JSON.stringify({ display_name: "Admiralty Way, Lekki", lat: "6.4401", lon: "3.4702", address: { road: "Admiralty Way", town: "Lekki", country: "Nigeria" } }),
          { status: 200 },
        );
      }) as unknown as typeof fetch;

      const res = await request(app).get("/api/v1/geo/reverse?lat=6.441234&lng=3.471234").set("Authorization", `Bearer ${mech.token}`);
      expect(res.status).toBe(200);
      expect(res.body.data.place).toMatchObject({ address: "Admiralty Way", city: "Lekki", lat: 6.441234, lng: 3.471234 });
      expect(calls[0]).toContain("nominatim.openstreetmap.org/reverse");

      // Same spot again is served from cache.
      await request(app).get("/api/v1/geo/reverse?lat=6.44124&lng=3.47124").set("Authorization", `Bearer ${mech.token}`);
      expect(calls).toHaveLength(1);

      const bad = await request(app).get("/api/v1/geo/reverse?lat=abc&lng=3").set("Authorization", `Bearer ${mech.token}`);
      expect(bad.status).toBe(400);
    });
  });
});

// Identity checks must never be quietly simulated in production.
describe("Smile ID configuration in production", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
    jest.resetModules();
  });

  function load(env: Record<string, string | undefined>) {
    Object.assign(process.env, { NODE_ENV: "production", SMILE_PARTNER_ID: undefined, SMILE_API_KEY: undefined, SMILE_USE_MOCK: undefined, ...env });
    for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k];
    let svc!: typeof import("../services/SmileIdentityService").SmileIdentityService;
    jest.isolateModules(() => {
      svc = require("../services/SmileIdentityService").SmileIdentityService;
    });
    return svc;
  }

  it("refuses (503) instead of approving when keys are missing", async () => {
    const svc = load({ SMILE_PARTNER_ID: undefined, SMILE_API_KEY: undefined, SMILE_USE_MOCK: undefined });
    expect(svc.isMockMode).toBe(false);
    await expect(svc.verifyBusiness("RC-1234567", "u1")).rejects.toMatchObject({ status: 503, code: "VERIFICATION_UNAVAILABLE" });
  });

  it("ignores a stray SMILE_USE_MOCK value that isn't exactly true", async () => {
    const svc = load({ SMILE_USE_MOCK: "False ", SMILE_PARTNER_ID: undefined, SMILE_API_KEY: undefined });
    expect(svc.isMockMode).toBe(false);
  });

  it("simulates only when explicitly told to", async () => {
    const svc = load({ SMILE_USE_MOCK: "true" });
    expect(svc.isMockMode).toBe(true);
    await expect(svc.verifyBusiness("RC-1234567", "u1")).resolves.toMatchObject({ success: expect.any(Boolean) });
  });
});

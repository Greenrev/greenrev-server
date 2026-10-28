import { ApiError } from "../utils/errors";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new ApiError(500, "CONFIG_MISSING", `${name} is not set`);
  }
  return value;
}

function optional(name: string): string | undefined {
  return process.env[name];
}

function toInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export const env = {
  nodeEnv: optional("NODE_ENV") ?? "development",
  port: toInt(optional("PORT"), 4000),
  mongoUri: required("MONGO_URI"),
  frontendUrl: required("FRONTEND_URL"),
  accessTokenSecret: required("JWT_ACCESS_SECRET"),
  accessTokenTtlSeconds: toInt(optional("JWT_ACCESS_TTL_SECONDS"), 900),
  refreshTokenTtlDays: toInt(optional("REFRESH_TOKEN_TTL_DAYS"), 7),
  bcryptSaltRounds: toInt(optional("BCRYPT_SALT_ROUNDS"), 12),
  cookieDomain: optional("COOKIE_DOMAIN"),
  cookieSameSite: (optional("COOKIE_SAMESITE") ?? "lax") as
    | "lax"
    | "strict"
    | "none",
  oauthStateSecret: required("OAUTH_STATE_SECRET"),
  googleClientId: optional("GOOGLE_CLIENT_ID"),
  googleClientSecret: optional("GOOGLE_CLIENT_SECRET"),
  googleRedirectUri: optional("GOOGLE_REDIRECT_URI"),
  emailFrom: optional("EMAIL_FROM") ?? optional("SMTP_FROM"),
  resendApiKey: optional("RESEND_API_KEY"),
  // AI listing assistant (photo / voice -> listing fields). Leave unset to disable.
  get openRouterApiKey(): string | undefined {
    return optional("OPENROUTER_API_KEY") || undefined;
  },
  // Server-side Google Geocoding key (no referrer restriction). Unset = OpenStreetMap's free geocoder.
  get googleMapsServerKey(): string | undefined {
    return optional("GOOGLE_MAPS_SERVER_KEY") || undefined;
  },
  get listingModel(): string {
    return optional("OPENROUTER_LISTING_MODEL") || "google/gemini-2.5-flash";
  },
  // Shared secret for /auth/admin-register. Leave unset to disable admin self-registration.
  get adminActivationCode(): string | undefined {
    return optional("ADMIN_ACTIVATION_CODE") || undefined;
  },
};

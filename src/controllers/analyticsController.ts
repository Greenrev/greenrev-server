import type { Response } from "express";
import type { CustomReq } from "../types/auth";
import { sendSuccess } from "../utils/apiResponse";
import { ApiError } from "../utils/errors";
import { analyticsOverview, isBot, recordVisit } from "../services/analyticsService";

const VISITOR_ID = /^[A-Za-z0-9_-]{8,64}$/;
const PLATFORMS = new Set(["web", "ios", "android"]);

/**
 * POST /analytics/visit — the apps call this once per day per device (and again when the
 * visitor signs in). The visitor ID is a random device ID, not personal data.
 */
export async function trackVisit(req: CustomReq, res: Response) {
  const { visitorId, platform } = (req.body ?? {}) as { visitorId?: unknown; platform?: unknown };
  if (typeof visitorId !== "string" || !VISITOR_ID.test(visitorId)) {
    throw new ApiError(400, "VALIDATION_ERROR", "visitorId is required");
  }
  if (typeof platform !== "string" || !PLATFORMS.has(platform)) {
    throw new ApiError(400, "VALIDATION_ERROR", "platform must be web, ios or android");
  }
  if (!isBot(req.headers["user-agent"])) {
    await recordVisit({
      visitorId,
      platform: platform as "web" | "ios" | "android",
      userId: req.user?.id ?? null,
      role: req.user?.role ?? null,
    });
  }
  return sendSuccess(res, 200, { ok: true });
}

/** GET /admin/analytics/overview */
export async function getAnalyticsOverview(_req: CustomReq, res: Response) {
  return sendSuccess(res, 200, await analyticsOverview());
}

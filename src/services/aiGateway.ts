import { env } from "../config/env";
import { AiUsage } from "../models/AiUsage";
import { ApiError } from "../utils/errors";

export const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

export type AiFeature = "concierge" | "listing_extract";
export type AiUnavailableReason = "not_configured" | "invalid_key" | "no_credit";

/**
 * User-facing messages, with codes the apps can react to. The admin-facing detail
 * (what to fix) goes to the server log.
 */
const UNAVAILABLE: Record<AiUnavailableReason, { code: string; message: string; log: string }> = {
  not_configured: {
    code: "AI_NOT_CONFIGURED",
    message: "AI features aren't switched on yet.",
    log: "OPENROUTER_API_KEY is not set on the server.",
  },
  invalid_key: {
    code: "AI_KEY_INVALID",
    message: "The AI service is unavailable right now. Our team has been alerted.",
    log: "OpenRouter rejected OPENROUTER_API_KEY (401). Create a new key at openrouter.ai/keys and update the server env.",
  },
  no_credit: {
    code: "AI_OUT_OF_CREDIT",
    message: "The AI service is unavailable right now. Our team has been alerted.",
    log: "OpenRouter account is out of credit or the key hit its spending limit (402). Top up at openrouter.ai/credits.",
  },
};

export function unavailableError(reason: AiUnavailableReason) {
  const u = UNAVAILABLE[reason];
  console.error(`[AI] ${u.log}`);
  markStatus({ available: false, reason });
  return new ApiError(503, u.code, u.message, { reason });
}

/** Turns a non-OK OpenRouter response into the right ApiError. */
export function upstreamError(status: number, body: string): ApiError {
  if (status === 401 || status === 403) return unavailableError("invalid_key");
  if (status === 402) return unavailableError("no_credit");
  if (status === 429) return new ApiError(503, "AI_BUSY", "The AI is busy right now. Please try again in a minute.");
  console.error(`[AI] OpenRouter request failed (${status}):`, body.slice(0, 500));
  return new ApiError(502, "AI_FAILED", "The AI couldn't answer that. Please try again.");
}

export function requireKey(): string {
  if (!env.openRouterApiKey) throw unavailableError("not_configured");
  return env.openRouterApiKey;
}

export function openRouterHeaders(key: string, title: string) {
  return {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    "HTTP-Referer": env.frontendUrl,
    "X-Title": title,
  };
}

// ---------------------------------------------------------------------------
// Health status — lets the apps say "AI offline" up front instead of failing later.
// ---------------------------------------------------------------------------

type Status = { available: boolean; reason: AiUnavailableReason | null };
let cachedStatus: { at: number; value: Status } | null = null;
const STATUS_TTL_MS = 5 * 60 * 1000;

function markStatus(value: Status) {
  cachedStatus = { at: Date.now(), value };
}

export function resetAiStatusCache() {
  cachedStatus = null;
}

export async function getAiStatus(): Promise<Status> {
  if (!env.openRouterApiKey) return { available: false, reason: "not_configured" };
  if (cachedStatus && Date.now() - cachedStatus.at < STATUS_TTL_MS) return cachedStatus.value;
  try {
    // Free metadata call: validates the key and reports remaining credit, no AI tokens used.
    const res = await fetch(`${OPENROUTER_BASE}/key`, {
      headers: { Authorization: `Bearer ${env.openRouterApiKey}` },
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 401 || res.status === 403) {
      markStatus({ available: false, reason: "invalid_key" });
    } else if (res.ok) {
      const json = (await res.json()) as { data?: { limit_remaining?: number | null } };
      const remaining = json.data?.limit_remaining;
      markStatus(remaining != null && remaining <= 0 ? { available: false, reason: "no_credit" } : { available: true, reason: null });
    } else {
      // OpenRouter hiccup: don't block the apps, and re-check soon.
      return { available: true, reason: null };
    }
  } catch {
    return { available: true, reason: null };
  }
  return cachedStatus!.value;
}

// ---------------------------------------------------------------------------
// Usage logging and limits
// ---------------------------------------------------------------------------

export type Caller = { userId: string | null; ip: string; visitorId?: string | null };

export async function startUsage(feature: AiFeature, caller: Caller, modelId: string) {
  const row = await AiUsage.create({
    feature,
    userId: caller.userId,
    ip: caller.ip,
    visitorId: caller.userId ? null : (caller.visitorId ?? null),
    model: modelId,
  });
  const started = Date.now();
  return {
    async finish(result: { ok: boolean; errorCode?: string; usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number } }) {
      await AiUsage.updateOne(
        { _id: row._id },
        {
          $set: {
            status: result.ok ? "ok" : "error",
            errorCode: result.errorCode ?? null,
            promptTokens: result.usage?.prompt_tokens ?? 0,
            completionTokens: result.usage?.completion_tokens ?? 0,
            costUsd: result.usage?.cost ?? 0,
            durationMs: Date.now() - started,
          },
        },
      ).catch((err) => console.error("[AI] Failed to record usage:", err));
    },
  };
}

export type Quota = { perHour: number; perDay: number };

/**
 * Counts this caller's recent requests. Signed-in users are counted by account. Guests are
 * counted by their device's visitor ID when the app sends one — many Nigerian mobile users
 * share an IP — with a higher per-IP ceiling (`ipPerHour`) so rotating IDs can't be abused.
 */
export async function enforceQuota(feature: AiFeature, caller: Caller, quota: Quota & { ipPerHour?: number }) {
  const now = Date.now();
  const hourAgo = new Date(now - 3600_000);
  const who = caller.userId
    ? { userId: caller.userId }
    : caller.visitorId
      ? { userId: null, visitorId: caller.visitorId }
      : { userId: null, ip: caller.ip };
  const [hour, day, ipHour] = await Promise.all([
    AiUsage.countDocuments({ feature, ...who, createdAt: { $gte: hourAgo } }),
    AiUsage.countDocuments({ feature, ...who, createdAt: { $gte: new Date(now - 86400_000) } }),
    !caller.userId && caller.visitorId && quota.ipPerHour
      ? AiUsage.countDocuments({ feature, userId: null, ip: caller.ip, createdAt: { $gte: hourAgo } })
      : Promise.resolve(0),
  ]);
  if (quota.ipPerHour && ipHour >= quota.ipPerHour) {
    throw new ApiError(429, "AI_LIMIT_REACHED", "The concierge is very busy on your network. Sign in to keep chatting.", {
      signedIn: false,
      window: "hour",
    });
  }
  if (hour >= quota.perHour || day >= quota.perDay) {
    const daily = day >= quota.perDay;
    throw new ApiError(
      429,
      "AI_LIMIT_REACHED",
      caller.userId
        ? `You've reached the concierge limit for ${daily ? "today" : "this hour"}. Please try again later.`
        : `You've reached the guest limit for ${daily ? "today" : "this hour"}. Sign in to keep chatting.`,
      { signedIn: Boolean(caller.userId), window: daily ? "day" : "hour" },
    );
  }
}

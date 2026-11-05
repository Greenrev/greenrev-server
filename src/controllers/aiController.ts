import type { Response } from "express";
import type { CustomReq } from "../types/auth";
import { sendSuccess } from "../utils/apiResponse";
import { ApiError } from "../utils/errors";
import { env } from "../config/env";
import { extractListing, type ListingCategory } from "../services/listingExtractService";
import { enforceQuota, getAiStatus, requireKey, startUsage, type Caller } from "../services/aiGateway";
import { openConciergeStream, readDeltas, sanitizeCompareIds, sanitizeHistory } from "../services/conciergeService";

function callerOf(req: CustomReq): Caller {
  const visitorId = req.body?.visitorId;
  return {
    userId: req.user?.id ?? null,
    ip: req.ip ?? "unknown",
    visitorId: typeof visitorId === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(visitorId) ? visitorId : null,
  };
}

const AUDIO_FORMATS: Record<string, string> = {
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/m4a": "m4a",
  "audio/aac": "aac",
  "audio/ogg": "ogg",
  "audio/flac": "flac",
};

export function audioFormatFor(mimetype: string): string | undefined {
  return AUDIO_FORMATS[mimetype.toLowerCase().split(";")[0].trim()];
}

/** POST /ai/listing-extract — photos and/or a voice note in, suggested listing fields out. */
export async function extractListingFields(req: CustomReq, res: Response) {
  const files = (req.files ?? {}) as Record<string, Express.Multer.File[] | undefined>;
  const images = files.images ?? [];
  const audioFile = files.audio?.[0];
  const category: ListingCategory = req.body?.category === "part" ? "part" : "vehicle";

  if (images.length === 0 && !audioFile) {
    throw new ApiError(400, "NO_INPUT", "Add at least one photo or a voice note");
  }

  requireKey();
  const usage = await startUsage("listing_extract", callerOf(req), env.listingModel);
  try {
    const { usage: tokens, ...result } = await extractListing({
      category,
      images: images.map((f) => ({ buffer: f.buffer, mimetype: f.mimetype })),
      audio: audioFile ? { buffer: audioFile.buffer, format: audioFormatFor(audioFile.mimetype)! } : undefined,
    });
    await usage.finish({ ok: true, usage: tokens });
    return sendSuccess(res, 200, result);
  } catch (err) {
    await usage.finish({ ok: false, errorCode: (err as ApiError).code ?? "AI_FAILED" });
    throw err;
  }
}

/** GET /ai/status — whether AI features can be used right now, so apps can say so up front. */
export async function aiStatus(_req: CustomReq, res: Response) {
  return sendSuccess(res, 200, await getAiStatus());
}

/**
 * POST /ai/concierge — streams the AI concierge's reply as server-sent events:
 *   data: {"type":"delta","text":"..."}   (repeated)
 *   data: {"type":"done"}
 *   data: {"type":"error","code":"...","message":"..."}   (if it fails mid-stream)
 * Errors before streaming starts (bad input, limits, AI offline) are normal JSON errors.
 */
export async function conciergeChat(req: CustomReq, res: Response) {
  const caller = callerOf(req);
  const messages = sanitizeHistory(req.body?.messages);
  const compareIds = sanitizeCompareIds(req.body?.compareIds);
  requireKey();
  await enforceQuota("concierge", caller, caller.userId ? env.conciergeUserQuota : env.conciergeGuestQuota);

  const usage = await startUsage("concierge", caller, env.conciergeModel);
  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) controller.abort(); // the user closed the chat
  });
  const timeout = setTimeout(() => controller.abort(), 90_000);

  let body: ReadableStream<Uint8Array>;
  try {
    body = await openConciergeStream(messages, compareIds, controller.signal);
  } catch (err) {
    clearTimeout(timeout);
    await usage.finish({ ok: false, errorCode: (err as ApiError).code ?? "AI_FAILED" });
    throw err;
  }

  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  const send = (event: object) => res.write(`data: ${JSON.stringify(event)}\n\n`);

  try {
    const deltas = readDeltas(body);
    let step = await deltas.next();
    while (!step.done) {
      send({ type: "delta", text: step.value });
      step = await deltas.next();
    }
    send({ type: "done" });
    await usage.finish({ ok: true, usage: step.value });
  } catch (err) {
    const aborted = controller.signal.aborted;
    const code = err instanceof ApiError ? err.code : aborted ? "AI_TIMEOUT" : "AI_FAILED";
    if (!res.writableEnded && !res.destroyed) {
      send({
        type: "error",
        code,
        message: err instanceof ApiError ? err.message : "The AI stopped responding. Please try again.",
      });
    }
    await usage.finish({ ok: false, errorCode: code });
  } finally {
    clearTimeout(timeout);
    res.end();
  }
}

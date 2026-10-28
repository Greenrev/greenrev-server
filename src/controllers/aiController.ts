import type { Response } from "express";
import type { CustomReq } from "../types/auth";
import { sendSuccess } from "../utils/apiResponse";
import { ApiError } from "../utils/errors";
import { extractListing, type ListingCategory } from "../services/listingExtractService";

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

  const result = await extractListing({
    category,
    images: images.map((f) => ({ buffer: f.buffer, mimetype: f.mimetype })),
    audio: audioFile ? { buffer: audioFile.buffer, format: audioFormatFor(audioFile.mimetype)! } : undefined,
  });

  return sendSuccess(res, 200, result);
}

import { Schema, model, type InferSchemaType } from "mongoose";

/** One row per AI request — used for per-user/IP limits and spend tracking. */
const aiUsageSchema = new Schema(
  {
    feature: { type: String, required: true, enum: ["concierge", "listing_extract"] },
    userId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    ip: { type: String, default: null },
    visitorId: { type: String, default: null }, // guests: the app's anonymous device ID
    model: { type: String, default: null },
    status: { type: String, required: true, enum: ["started", "ok", "error"], default: "started" },
    errorCode: { type: String, default: null },
    promptTokens: { type: Number, default: 0 },
    completionTokens: { type: Number, default: 0 },
    costUsd: { type: Number, default: 0 },
    durationMs: { type: Number, default: null },
  },
  { timestamps: true },
);

aiUsageSchema.index({ feature: 1, userId: 1, createdAt: -1 });
aiUsageSchema.index({ feature: 1, ip: 1, createdAt: -1 });
aiUsageSchema.index({ feature: 1, visitorId: 1, createdAt: -1 });
// Keep six months of history.
aiUsageSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 183 });

export type AiUsageDocument = InferSchemaType<typeof aiUsageSchema>;

export const AiUsage = model("AiUsage", aiUsageSchema);

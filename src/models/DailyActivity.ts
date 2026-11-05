import { Schema, model, type InferSchemaType } from "mongoose";

/**
 * One row per visitor per day (Lagos time). Visitors are anonymous device IDs generated
 * by the apps; signed-in visits also carry the user. Powers DAU / WAU / MAU.
 */
const dailyActivitySchema = new Schema(
  {
    day: { type: String, required: true }, // "YYYY-MM-DD", Africa/Lagos
    visitorId: { type: String, required: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    role: { type: String, default: null },
    platform: { type: String, required: true, enum: ["web", "ios", "android"] },
    hits: { type: Number, default: 1 },
    lastSeenAt: { type: Date, default: Date.now },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

dailyActivitySchema.index({ day: 1, visitorId: 1 }, { unique: true });
dailyActivitySchema.index({ day: 1, userId: 1 });
// Keep about 13 months so month-over-month comparisons stay possible.
dailyActivitySchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 400 });

export type DailyActivityDocument = InferSchemaType<typeof dailyActivitySchema>;

export const DailyActivity = model("DailyActivity", dailyActivitySchema);

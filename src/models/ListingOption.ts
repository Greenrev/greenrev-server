import { Schema, model, type InferSchemaType } from "mongoose";

export const LISTING_OPTION_KINDS = [
  "make",
  "model",
  "transmission",
  "condition",
  "color",
  "vehicleSpecKey",
  "vehicleSpecValue",
  "partBrand",
  "partName",
  "partSpecKey",
  "partSpecValue",
] as const;
export type ListingOptionKind = (typeof LISTING_OPTION_KINDS)[number];

/** Kinds whose options belong to a parent: models to a make, spec values to a spec key. */
export const PARENT_KIND: Partial<Record<ListingOptionKind, ListingOptionKind>> = {
  model: "make",
  vehicleSpecValue: "vehicleSpecKey",
  partSpecValue: "partSpecKey",
};

const listingOptionSchema = new Schema(
  {
    kind: { type: String, required: true, enum: LISTING_OPTION_KINDS },
    value: { type: String, required: true, trim: true },
    valueKey: { type: String, required: true }, // lower-cased, for matching
    parent: { type: String, default: null }, // make for models, spec key for spec values
    parentKey: { type: String, default: "" },
    hex: { type: String, default: null }, // colours only
    status: { type: String, required: true, enum: ["approved", "pending", "rejected"], index: true },
    source: { type: String, required: true, enum: ["seed", "vendor", "admin"] },
    sortOrder: { type: Number, default: 1_000_000 },
    // Vendor suggestions
    suggestedBy: [{ type: Schema.Types.ObjectId, ref: "User" }],
    suggestionCount: { type: Number, default: 0 },
    lastSuggestedAt: { type: Date, default: null },
    exampleProductId: { type: String, default: null },
    // Review
    reviewedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    reviewedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

listingOptionSchema.index({ kind: 1, parentKey: 1, valueKey: 1 }, { unique: true });

export type ListingOptionDocument = InferSchemaType<typeof listingOptionSchema> & { _id: unknown };

export const ListingOption = model("ListingOption", listingOptionSchema);

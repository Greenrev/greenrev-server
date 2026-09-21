import { Schema, model, type InferSchemaType, Types } from "mongoose";

const verificationRequestSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    levelRequested: { type: String, required: true, enum: ["individual", "business"] },
    status: { type: String, required: true, enum: ["pending", "approved", "rejected", "info_requested"], default: "pending" },
    
    // Level 2 (Individual)
    documentType: { type: String, enum: ["NIN", "PASSPORT", "DRIVERS_LICENSE"], required: false },
    documentNumber: { type: String, required: false },
    nin: { type: String, required: false }, // Legacy
    selfieUrl: { type: String, required: false },
    
    // Level 3 (Business)
    cacNumber: { type: String, required: false },
    cacDocumentUrl: { type: String, required: false },
    directorIdUrl: { type: String, required: false },
    businessAddress: { type: String, required: false },
    bankAccountNumber: { type: String, required: false },
    bankCode: { type: String, required: false },
    
    // Admin fields
    reviewedBy: { type: Schema.Types.ObjectId, ref: "User", required: false },
    adminNotes: { type: String, required: false },
  },
  { timestamps: true },
);

export type VerificationRequestDocument = InferSchemaType<typeof verificationRequestSchema> & { _id: Types.ObjectId };

export const VerificationRequest = model("VerificationRequest", verificationRequestSchema);

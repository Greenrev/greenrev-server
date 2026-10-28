import { Schema, model, type InferSchemaType } from "mongoose";
import type { UserRole } from "../types/auth";

const userSchema = new Schema(
  {
    email: { type: String, required: true, lowercase: true, trim: true, index: true, unique: true },
    name: { type: String, required: false, trim: true, default: null },
    role: { type: String, required: true, enum: ["customer", "vendor", "mechanic", "admin"] satisfies UserRole[] },
    companyName: { type: String, required: false, trim: true, default: null },
    garageName: { type: String, required: false, trim: true, default: null },
    phone: { type: String, required: false, trim: true, default: null },
    bio: { type: String, required: false, trim: true, default: null },
    profileImage: { type: String, required: false, default: null },
    passwordHash: { type: String, required: false, default: null },
    googleId: { type: String, required: false, default: null, index: true },
    isEmailVerified: { type: Boolean, required: true, default: false },
    isPhoneVerified: { type: Boolean, required: true, default: false },
    verificationLevel: { type: String, required: true, enum: ["basic", "individual", "business"], default: "basic" },
    verificationStatus: { type: String, required: true, enum: ["unverified", "pending", "verified", "rejected"], default: "unverified" },
    status: { type: String, required: true, enum: ["active", "suspended"], default: "active", index: true },
    
    // RBAC and Security
    assignedRole: { type: Schema.Types.ObjectId, ref: "Role", required: false, default: null },
    customPermissions: [{ type: Schema.Types.ObjectId, ref: "Permission" }],
    mfaEnabled: { type: Boolean, required: true, default: false },
    mfaSecret: { type: String, required: false, default: null },
    sessionVersion: { type: Number, required: true, default: 0 },
    lastLoginIp: { type: String, required: false, default: null },

    // Fields for Mechanics / Experts
    city: { type: String, required: false, default: null },
    country: { type: String, required: false, default: null },
    address: { type: String, required: false, default: null },
    lat: { type: Number, required: false, default: null },
    lng: { type: Number, required: false, default: null },
    specialization: { type: [String], required: false, default: [] },
    hourlyRate: { type: Number, required: false, default: null },
    availability: {
      type: {
        monday:    { available: Boolean, start: String, end: String },
        tuesday:   { available: Boolean, start: String, end: String },
        wednesday: { available: Boolean, start: String, end: String },
        thursday:  { available: Boolean, start: String, end: String },
        friday:    { available: Boolean, start: String, end: String },
        saturday:  { available: Boolean, start: String, end: String },
        sunday:    { available: Boolean, start: String, end: String },
      },
      required: false,
      default: null,
      _id: false,
    },
  },
  { timestamps: true },
);

import { Product } from "./Product";

userSchema.post("findOneAndDelete", async function (doc) {
  if (doc) {
    // Delete all products associated with this user
    await Product.deleteMany({ vendorId: doc._id });
  }
});

export type UserDocument = InferSchemaType<typeof userSchema> & { _id: unknown };

export const User = model("User", userSchema);

import { Schema, model, type InferSchemaType } from "mongoose";

const productSpecsSchema = new Schema(
  {
    horsepower: { type: Number },
    torque: { type: String },
    transmission: { type: String },
    topSpeed: { type: String },
    acceleration: { type: Number },
    range: { type: String },
    battery: { type: String },
    charging: { type: String },
    compatibility: { type: String },
    warranty: { type: String },
    origin: { type: String },
    vin: { type: String },
  },
  { _id: false, strict: false },
);

const productColorSchema = new Schema(
  {
    name: { type: String, required: true },
    hex: { type: String, required: true },
  },
  { _id: false },
);

const productSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    make: { type: String, required: true, trim: true },
    category: {
      type: String,
      required: true,
      enum: ["vehicle", "part"],
      index: true,
    },
    price: { type: String, required: true },
    priceValue: { type: Number },
    year: { type: Number },
    mileage: { type: String },
    color: { type: productColorSchema },
    image: { type: String, required: true },
    images: [{ type: String }],
    specs: { type: productSpecsSchema },
    description: { type: String },
    inStock: { type: Boolean, default: true },
    stockQuantity: { type: Number, default: 1 },
    vendorId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    vendorName: { type: String },
  },
  {
    timestamps: true,
  },
);

productSchema.index({ name: "text", make: "text", description: "text" });
productSchema.index({ createdAt: -1 });

export type ProductDocument = InferSchemaType<typeof productSchema> & {
  _id: unknown;
};

export const Product = model("Product", productSchema);

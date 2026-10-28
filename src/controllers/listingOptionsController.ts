import type { Request, Response } from "express";
import { AuditLog } from "../models/AuditLog";
import { ListingOption, LISTING_OPTION_KINDS, PARENT_KIND, type ListingOptionKind } from "../models/ListingOption";
import type { CustomReq } from "../types/auth";
import { sendSuccess } from "../utils/apiResponse";
import { ApiError } from "../utils/errors";
import {
  ensureListingOptionsSeeded,
  getPublicListingOptions,
  invalidateListingOptionsCache,
  normalizeOptionValue,
} from "../services/listingOptionsService";

const key = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

/** GET /listing-options — approved dropdown values for the vendor listing form. */
export async function getListingOptions(_req: Request, res: Response) {
  const data = await getPublicListingOptions();
  res.setHeader("Cache-Control", "public, max-age=300");
  return sendSuccess(res, 200, data);
}

/** GET /admin/listing-options?status=pending&kind=make */
export async function adminListListingOptions(req: CustomReq, res: Response) {
  await ensureListingOptionsSeeded();
  const status = ["pending", "approved", "rejected"].includes(String(req.query.status)) ? String(req.query.status) : "pending";
  const filter: Record<string, unknown> = { status };
  if (LISTING_OPTION_KINDS.includes(req.query.kind as ListingOptionKind)) filter.kind = req.query.kind;

  const [options, counts] = await Promise.all([
    ListingOption.find(filter)
      .sort(status === "pending" ? { suggestionCount: -1, lastSuggestedAt: -1 } : { kind: 1, parentKey: 1, sortOrder: 1, value: 1 })
      .limit(status === "approved" ? 5000 : 500)
      .populate("suggestedBy", "name companyName email")
      .lean(),
    ListingOption.aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }]),
  ]);

  return sendSuccess(res, 200, {
    options,
    counts: Object.fromEntries(counts.map((c) => [c._id, c.n])),
  });
}

/** GET /admin/listing-options/pending-count — for the admin nav badge. */
export async function adminPendingListingOptionCount(_req: CustomReq, res: Response) {
  const pending = await ListingOption.countDocuments({ status: "pending" });
  return sendSuccess(res, 200, { pending });
}

async function audit(req: CustomReq, action: string, targetId: string, previousState: unknown, newState: unknown) {
  await AuditLog.create({
    adminId: req.user!.id,
    adminEmail: req.user!.email,
    action,
    module: "Listing Options",
    targetModel: "ListingOption",
    targetId,
    previousState,
    newState,
    ipAddress: req.ip ?? null,
    userAgent: req.headers["user-agent"] ?? null,
  });
}

function snapshot(o: { status: string; value: string; parent?: string | null; hex?: string | null }) {
  return { status: o.status, value: o.value, parent: o.parent ?? null, hex: o.hex ?? null };
}

/**
 * PATCH /admin/listing-options/:id
 * body: { status: "approved" | "rejected", value?, parent?, hex? }
 * Approving with an edited value that matches an existing option merges into it.
 */
export async function adminUpdateListingOption(req: CustomReq, res: Response) {
  const option = await ListingOption.findById(req.params.id);
  if (!option) throw new ApiError(404, "NOT_FOUND", "Listing option not found");

  const status = req.body?.status;
  if (status !== "approved" && status !== "rejected") {
    throw new ApiError(400, "VALIDATION_ERROR", 'status must be "approved" or "rejected"');
  }
  const before = snapshot(option);

  if (status === "approved") {
    const value = req.body.value !== undefined ? normalizeOptionValue(req.body.value) : option.value;
    if (!value) throw new ApiError(400, "VALIDATION_ERROR", "Enter a value between 2 and 60 characters");
    const needsParent = Boolean(PARENT_KIND[option.kind as ListingOptionKind]);
    const parent = needsParent ? (req.body.parent !== undefined ? normalizeOptionValue(req.body.parent) : option.parent) : null;
    if (needsParent && !parent) throw new ApiError(400, "VALIDATION_ERROR", "This option needs a parent value");
    const hex = option.kind === "color" ? (req.body.hex ?? option.hex) : null;
    if (option.kind === "color" && (!hex || !/^#[0-9a-f]{6}$/i.test(hex))) {
      throw new ApiError(400, "VALIDATION_ERROR", "Colours need a hex code like #1a2b3c");
    }

    const clash = await ListingOption.findOne({
      _id: { $ne: option._id },
      kind: option.kind,
      parentKey: key(parent),
      valueKey: key(value),
    });
    if (clash) {
      // Merge: keep the existing option, approve it, and retire this duplicate.
      clash.status = "approved";
      clash.reviewedBy = req.user!.id as never;
      clash.reviewedAt = new Date();
      await clash.save();
      option.status = "rejected";
      option.reviewedBy = req.user!.id as never;
      option.reviewedAt = new Date();
      await option.save();
      await audit(req, "listing_option.merge", String(option._id), before, { mergedInto: String(clash._id) });
      invalidateListingOptionsCache();
      return sendSuccess(res, 200, { option: clash, mergedFrom: String(option._id) });
    }

    option.value = value;
    option.valueKey = key(value);
    option.parent = parent ?? null;
    option.parentKey = key(parent);
    option.hex = hex ? hex.toLowerCase() : null;
  }

  option.status = status;
  option.reviewedBy = req.user!.id as never;
  option.reviewedAt = new Date();
  await option.save();
  await audit(req, `listing_option.${status === "approved" ? "approve" : "reject"}`, String(option._id), before, snapshot(option));
  invalidateListingOptionsCache();
  return sendSuccess(res, 200, { option });
}

/** POST /admin/listing-options — admin adds a value directly. body: { kind, value, parent?, hex? } */
export async function adminCreateListingOption(req: CustomReq, res: Response) {
  const kind = req.body?.kind as ListingOptionKind;
  if (!LISTING_OPTION_KINDS.includes(kind)) throw new ApiError(400, "VALIDATION_ERROR", "Unknown option type");
  const value = normalizeOptionValue(req.body.value);
  if (!value) throw new ApiError(400, "VALIDATION_ERROR", "Enter a value between 2 and 60 characters");
  const needsParent = Boolean(PARENT_KIND[kind]);
  const parent = needsParent ? normalizeOptionValue(req.body.parent) : null;
  if (needsParent && !parent) throw new ApiError(400, "VALIDATION_ERROR", "Choose what this option belongs to");
  const hex = kind === "color" ? String(req.body.hex ?? "") : null;
  if (kind === "color" && !/^#[0-9a-f]{6}$/i.test(hex!)) throw new ApiError(400, "VALIDATION_ERROR", "Colours need a hex code like #1a2b3c");

  await ensureListingOptionsSeeded();
  const option = await ListingOption.findOneAndUpdate(
    { kind, parentKey: key(parent), valueKey: key(value) },
    {
      $set: { status: "approved", reviewedBy: req.user!.id, reviewedAt: new Date(), value, hex: hex?.toLowerCase() ?? null, parent },
      $setOnInsert: { kind, valueKey: key(value), parentKey: key(parent), source: "admin" },
    },
    { upsert: true, new: true },
  );
  await audit(req, "listing_option.create", String(option._id), null, snapshot(option));
  invalidateListingOptionsCache();
  return sendSuccess(res, 201, { option });
}

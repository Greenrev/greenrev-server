import { DEFAULT_LISTING_OPTIONS } from "../data/defaultListingOptions";
import { ListingOption, PARENT_KIND, type ListingOptionKind } from "../models/ListingOption";
import { User } from "../models/User";
import { NotificationService } from "./NotificationService";

/** Same shape as the apps' bundled listingOptions.json, so clients can swap one for the other. */
export type PublicListingOptions = {
  vehicleMakes: string[];
  vehicleModels: Record<string, string[]>;
  transmissions: string[];
  conditions: string[];
  colors: { name: string; hex: string }[];
  vehicleSpecValues: Record<string, string[]>;
  partBrands: string[];
  partNames: string[];
  partSpecValues: Record<string, string[]>;
};

export function normalizeOptionValue(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().replace(/\s+/g, " ");
  if (v.length < 2 || v.length > 60 || !/[a-z]/i.test(v)) return null;
  return v;
}

const key = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

type SeedRow = { kind: ListingOptionKind; value: string; parent?: string; hex?: string };

function seedRows(): SeedRow[] {
  const d = DEFAULT_LISTING_OPTIONS;
  const rows: SeedRow[] = [];
  d.vehicleMakes.forEach((value) => rows.push({ kind: "make", value }));
  Object.entries(d.vehicleModels).forEach(([make, models]) =>
    models.forEach((value) => rows.push({ kind: "model", value, parent: make })),
  );
  d.transmissions.forEach((value) => rows.push({ kind: "transmission", value }));
  d.conditions.forEach((value) => rows.push({ kind: "condition", value }));
  d.colors.forEach((c) => rows.push({ kind: "color", value: c.name, hex: c.hex }));
  Object.entries(d.vehicleSpecValues).forEach(([k, values]) => {
    rows.push({ kind: "vehicleSpecKey", value: k });
    values.forEach((value) => rows.push({ kind: "vehicleSpecValue", value, parent: k }));
  });
  d.partBrands.forEach((value) => rows.push({ kind: "partBrand", value }));
  d.partNames.forEach((value) => rows.push({ kind: "partName", value }));
  Object.entries(d.partSpecValues).forEach(([k, values]) => {
    rows.push({ kind: "partSpecKey", value: k });
    values.forEach((value) => rows.push({ kind: "partSpecValue", value, parent: k }));
  });
  return rows;
}

let seeding: Promise<void> | null = null;

/** Loads the starting list once. Safe to call concurrently and on every request. */
export function ensureListingOptionsSeeded(): Promise<void> {
  seeding ??= (async () => {
    if (await ListingOption.exists({ source: "seed" })) return;
    const docs = seedRows().map((r, i) => ({
      kind: r.kind,
      value: r.value,
      valueKey: key(r.value),
      parent: r.parent ?? null,
      parentKey: key(r.parent),
      hex: r.hex ?? null,
      status: "approved",
      source: "seed",
      sortOrder: i,
    }));
    try {
      await ListingOption.insertMany(docs, { ordered: false });
    } catch (err) {
      // Duplicate keys mean another instance seeded concurrently — fine.
      if ((err as { code?: number })?.code !== 11000 && !String(err).includes("E11000")) throw err;
    }
  })().catch((err) => {
    seeding = null;
    throw err;
  });
  return seeding;
}

// ---------------------------------------------------------------------------
// Public list (cached)
// ---------------------------------------------------------------------------

let cache: { at: number; data: PublicListingOptions } | null = null;
const CACHE_MS = 60_000;

export function invalidateListingOptionsCache() {
  cache = null;
}

export async function getPublicListingOptions(): Promise<PublicListingOptions> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.data;
  await ensureListingOptionsSeeded();

  const rows = await ListingOption.find({ status: "approved" })
    .sort({ sortOrder: 1, value: 1 })
    .select("kind value parent hex")
    .lean();

  const data: PublicListingOptions = {
    vehicleMakes: [],
    vehicleModels: {},
    transmissions: [],
    conditions: [],
    colors: [],
    vehicleSpecValues: {},
    partBrands: [],
    partNames: [],
    partSpecValues: {},
  };
  // Children of a removed parent (e.g. models of a rejected make) are dropped.
  const approvedParents = {
    make: new Map<string, string>(),
    vehicleSpecKey: new Map<string, string>(),
    partSpecKey: new Map<string, string>(),
  };
  for (const r of rows) {
    if (r.kind === "make") approvedParents.make.set(key(r.value), r.value);
    if (r.kind === "vehicleSpecKey") approvedParents.vehicleSpecKey.set(key(r.value), r.value);
    if (r.kind === "partSpecKey") approvedParents.partSpecKey.set(key(r.value), r.value);
  }
  for (const k of approvedParents.vehicleSpecKey.values()) data.vehicleSpecValues[k] = [];
  for (const k of approvedParents.partSpecKey.values()) data.partSpecValues[k] = [];

  for (const r of rows) {
    switch (r.kind) {
      case "make":
        data.vehicleMakes.push(r.value);
        break;
      case "model": {
        const make = approvedParents.make.get(key(r.parent));
        if (make) (data.vehicleModels[make] ??= []).push(r.value);
        break;
      }
      case "transmission":
        data.transmissions.push(r.value);
        break;
      case "condition":
        data.conditions.push(r.value);
        break;
      case "color":
        data.colors.push({ name: r.value, hex: r.hex || "#000000" });
        break;
      case "vehicleSpecValue": {
        const k = approvedParents.vehicleSpecKey.get(key(r.parent));
        if (k) data.vehicleSpecValues[k].push(r.value);
        break;
      }
      case "partBrand":
        data.partBrands.push(r.value);
        break;
      case "partName":
        data.partNames.push(r.value);
        break;
      case "partSpecValue": {
        const k = approvedParents.partSpecKey.get(key(r.parent));
        if (k) data.partSpecValues[k].push(r.value);
        break;
      }
      default:
        break;
    }
  }

  cache = { at: Date.now(), data };
  return data;
}

// ---------------------------------------------------------------------------
// Capturing new vendor entries
// ---------------------------------------------------------------------------

// Spec keys the listing form already has dedicated fields for.
const BUILT_IN_SPEC_KEYS = new Set([
  "horsepower", "torque", "transmission", "topspeed", "origin", "vin", "acceleration",
  "range", "battery", "charging",
]);

type Candidate = { kind: ListingOptionKind; value: string; parent?: string; hex?: string };

type ProductLike = {
  _id?: unknown;
  category?: string;
  name?: string;
  make?: string;
  color?: { name?: string; hex?: string } | null;
  specs?: Record<string, unknown> | null;
};

/** Works out which values in a saved listing aren't approved in the managed list. */
export async function findNewListingValues(product: ProductLike): Promise<Candidate[]> {
  await ensureListingOptionsSeeded();
  const known = await ListingOption.find({}).select("kind valueKey parentKey status value").lean();
  // Pending and rejected values still pass through, so repeat use is counted for admins.
  const has = (kind: string, value: string, parent?: string) =>
    known.some((k) => k.kind === kind && k.valueKey === key(value) && k.parentKey === key(parent) && k.status === "approved");
  const approved = (kind: string, value: string) =>
    known.find((k) => k.kind === kind && k.valueKey === key(value) && k.status === "approved");

  const out: Candidate[] = [];
  const push = (c: Candidate) => {
    if (!has(c.kind, c.value, c.parent) && !out.some((o) => o.kind === c.kind && key(o.value) === key(c.value) && key(o.parent) === key(c.parent))) {
      out.push(c);
    }
  };

  const specs = product.specs ?? {};
  const isVehicle = product.category === "vehicle";
  const make = normalizeOptionValue(product.make);

  if (isVehicle) {
    if (make) push({ kind: "make", value: make });

    // Model = listing name minus a leading year and the make, e.g. "2019 Toyota Camry XSE" -> "Camry XSE".
    const approvedMake = make ? approved("make", make) : undefined;
    if (approvedMake && typeof product.name === "string") {
      let rest = product.name.trim().replace(/^(19|20)\d{2}\s+/, "");
      if (rest.toLowerCase().startsWith(approvedMake.value.toLowerCase())) rest = rest.slice(approvedMake.value.length);
      const model = normalizeOptionValue(rest);
      const knownModels = known.filter((k) => k.kind === "model" && k.parentKey === approvedMake.valueKey);
      // "Camry XSE" is just a trim of the known "Camry" — not a new model.
      const isTrimOfKnown = model && knownModels.some((m) => key(model) === m.valueKey || key(model).startsWith(`${m.valueKey} `));
      if (model && !isTrimOfKnown && model.split(" ").length <= 4) {
        push({ kind: "model", value: model, parent: approvedMake.value });
      }
    }

    const transmission = normalizeOptionValue(specs.transmission);
    if (transmission) push({ kind: "transmission", value: transmission });
    const condition = normalizeOptionValue(specs.origin);
    if (condition) push({ kind: "condition", value: condition });
    const color = normalizeOptionValue(product.color?.name);
    if (color) push({ kind: "color", value: color, hex: product.color?.hex });
  } else {
    if (make) push({ kind: "partBrand", value: make });
    const name = normalizeOptionValue(product.name);
    if (name && name.split(" ").length <= 5) push({ kind: "partName", value: name });
  }

  const keyKind: ListingOptionKind = isVehicle ? "vehicleSpecKey" : "partSpecKey";
  const valueKind: ListingOptionKind = isVehicle ? "vehicleSpecValue" : "partSpecValue";
  for (const [rawKey, rawValue] of Object.entries(specs)) {
    if (BUILT_IN_SPEC_KEYS.has(rawKey.toLowerCase())) continue;
    const specKey = normalizeOptionValue(rawKey);
    if (!specKey) continue;
    const approvedKey = approved(keyKind, specKey);
    if (!approvedKey) {
      push({ kind: keyKind, value: specKey });
      continue;
    }
    // Only suggest values for keys that have a pick-list (not free text like "Part Number").
    const hasList = known.some((k) => k.kind === valueKind && k.parentKey === approvedKey.valueKey && k.status === "approved");
    const value = normalizeOptionValue(rawValue);
    if (hasList && value) push({ kind: valueKind, value, parent: approvedKey.value });
  }
  return out;
}

/**
 * Records values a vendor used that aren't in the managed list as pending suggestions,
 * and tells admins about the brand-new ones. Rejected values stay rejected quietly.
 */
export async function recordVendorListingValues(product: ProductLike, vendorId: string): Promise<number> {
  const candidates = await findNewListingValues(product);
  const created: Candidate[] = [];

  for (const c of candidates) {
    const res = await ListingOption.findOneAndUpdate(
      { kind: c.kind, parentKey: key(c.parent), valueKey: key(c.value) },
      {
        $setOnInsert: {
          kind: c.kind,
          value: c.value,
          valueKey: key(c.value),
          parent: c.parent ?? null,
          parentKey: key(c.parent),
          hex: c.kind === "color" && c.hex && /^#[0-9a-f]{6}$/i.test(c.hex) ? c.hex.toLowerCase() : null,
          status: "pending",
          source: "vendor",
          exampleProductId: product._id ? String(product._id) : null,
        },
        $addToSet: { suggestedBy: vendorId },
        $inc: { suggestionCount: 1 },
        $set: { lastSuggestedAt: new Date() },
      },
      { upsert: true, includeResultMetadata: true },
    );
    if (!res.lastErrorObject?.updatedExisting) created.push(c);
  }

  if (created.length > 0) await notifyAdmins(created);
  return created.length;
}

const KIND_LABELS: Record<ListingOptionKind, string> = {
  make: "make",
  model: "model",
  transmission: "transmission",
  condition: "condition",
  color: "colour",
  vehicleSpecKey: "vehicle detail",
  vehicleSpecValue: "vehicle detail value",
  partBrand: "part brand",
  partName: "part name",
  partSpecKey: "part detail",
  partSpecValue: "part detail value",
};

export function describeOption(c: { kind: string; value: string; parent?: string | null }) {
  const label = KIND_LABELS[c.kind as ListingOptionKind] ?? c.kind;
  return `${label} "${c.value}"${c.parent ? ` (${PARENT_KIND[c.kind as ListingOptionKind] === "make" ? "" : "for "}${c.parent})` : ""}`;
}

async function notifyAdmins(created: Candidate[]) {
  const admins = await User.find({ role: "admin", status: "active" }).select("_id").lean();
  const summary =
    created.length === 1
      ? `A vendor used a new ${describeOption(created[0])}.`
      : `Vendors used ${created.length} new values, including ${describeOption(created[0])}.`;
  await Promise.all(
    admins.map((a) =>
      NotificationService.dispatchNotification({
        recipientId: String(a._id),
        title: "New listing options to review",
        message: `${summary} Approve or reject them in Admin → Listing Options.`,
        type: "listing_option",
        sendEmail: false,
      }),
    ),
  );
}

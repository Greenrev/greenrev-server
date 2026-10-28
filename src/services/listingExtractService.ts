import { env } from "../config/env";
import { ApiError } from "../utils/errors";

export type ListingCategory = "vehicle" | "part";

export type ListingImage = { buffer: Buffer; mimetype: string };
export type ListingAudio = { buffer: Buffer; format: string };

/** Every field is optional: the model only returns what it can actually see or hear. */
export type ExtractedListing = {
  name?: string;
  make?: string;
  price?: string;
  year?: number;
  mileage?: string;
  colorName?: string;
  colorHex?: string;
  description?: string;
  transmission?: string;
  origin?: string;
  vin?: string;
  horsepower?: number;
  torque?: string;
  topSpeed?: string;
  acceleration?: number;
  stockQuantity?: number;
  extraSpecs?: { key: string; value: string }[];
};

export type ExtractionResult = {
  fields: ExtractedListing;
  transcript?: string;
  warnings: string[];
};

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

const VEHICLE_FIELDS = `
- name: listing title, e.g. "2019 Toyota Camry XSE" (make + model + trim; include year if known)
- make: manufacturer, e.g. "Toyota"
- price: asking price exactly as the vendor stated it, formatted like "₦18,000,000". ONLY if the vendor says or shows a price. Never estimate.
- year: model year (number)
- mileage: e.g. "45,000 km" (keep the unit stated; read odometers in photos)
- colorName: exterior colour name, e.g. "Midnight Black"
- colorHex: closest hex for that colour, e.g. "#111111"
- transmission: e.g. "Automatic", "Manual", "CVT", "8-Speed Automatic"
- origin: one of "Brand New", "Foreign Used", "Nigerian Used" — only if stated or clearly documented (e.g. customs papers => "Foreign Used")
- vin: 17-character VIN exactly as printed (letters I, O, Q never appear in VINs)
- horsepower: number
- torque: e.g. "400 Nm"
- topSpeed: e.g. "220 km/h"
- acceleration: 0-100 km/h seconds (number)
- stockQuantity: number of units, only if stated
- description: 2-4 sentence buyer-facing description using ONLY facts present in the input
- extraSpecs: array of {key, value} for other facts, preferring keys: "Fuel Type", "Drivetrain", "Body Style", "Engine Size", "Trim Level", "Number of Doors", "Interior", "Features"`;

const PART_FIELDS = `
- name: part name, e.g. "Front Brake Pads (Ceramic)"
- make: brand/manufacturer of the part, e.g. "Bosch"
- price: asking price exactly as stated, formatted like "₦45,000". ONLY if the vendor says or shows a price. Never estimate.
- stockQuantity: number of units, only if stated
- description: 2-4 sentence buyer-facing description using ONLY facts present in the input
- extraSpecs: array of {key, value}, preferring keys: "Compatibility" (vehicle makes/models/years), "Part Number", "Condition" (New / Used / Refurbished), "Warranty", "Material", "Position" (e.g. Front Left)`;

function systemPrompt(category: ListingCategory, hasImages: boolean, hasAudio: boolean) {
  const sources = [
    hasImages && "photos (of the item itself, its documents, labels, VIN plate, odometer or a spec sheet)",
    hasAudio && "a voice note from the vendor describing it",
  ]
    .filter(Boolean)
    .join(" and ");

  return `You help automotive vendors in Nigeria create marketplace listings on GreenRev.
You are given ${sources} for a ${category === "vehicle" ? "VEHICLE" : "CAR PART / ACCESSORY"} listing.

Extract listing fields. Respond with ONE JSON object only, no prose, shaped as:
{"transcript": string|null, "fields": {...}, "warnings": string[]}

"transcript": verbatim transcript of the voice note, or null if there is no audio.
"fields": include ONLY keys you are confident about from the input. Omit anything unknown — do not guess, do not fill defaults.
Allowed keys:${category === "vehicle" ? VEHICLE_FIELDS : PART_FIELDS}

"warnings": short notes for the vendor about anything uncertain, e.g. "VIN partly obscured — check the 9th character", "Odometer unit unclear (km or miles?)".
Nigerian usage: "tokunbo" means "Foreign Used"; "naija used" / "locally used" means "Nigerian Used"; "18 million" / "18m" means ₦18,000,000.`;
}

// ---------------------------------------------------------------------------
// Sanitising the model output — never trust it to follow the schema.
// ---------------------------------------------------------------------------

const VIN_TRANSLIT: Record<string, number> = {
  A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8, J: 1, K: 2, L: 3, M: 4, N: 5,
  P: 7, R: 9, S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9,
};
const VIN_WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];

/** ISO 3779 check digit. Only North American VINs are required to pass it, so a failure is a warning, not an error. */
export function vinCheckDigitValid(vin: string): boolean {
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) return false;
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    const c = vin[i];
    const v = /\d/.test(c) ? Number(c) : VIN_TRANSLIT[c];
    sum += v * VIN_WEIGHTS[i];
  }
  const check = sum % 11;
  return vin[8] === (check === 10 ? "X" : String(check));
}

function str(v: unknown, max = 200): string | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v !== "string") return undefined;
  const s = v.trim().replace(/\s+/g, " ");
  return s ? s.slice(0, max) : undefined;
}

function num(v: unknown, min: number, max: number): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.replace(/[^0-9.]/g, "")) : NaN;
  return Number.isFinite(n) && n >= min && n <= max ? n : undefined;
}

export function sanitizeExtraction(raw: unknown, category: ListingCategory): ExtractionResult {
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const f = (obj.fields && typeof obj.fields === "object" ? obj.fields : {}) as Record<string, unknown>;
  const warnings = Array.isArray(obj.warnings)
    ? obj.warnings.map((w) => str(w, 240)).filter((w): w is string => Boolean(w)).slice(0, 6)
    : [];

  const fields: ExtractedListing = {
    name: str(f.name, 120),
    make: str(f.make, 60),
    price: str(f.price, 40),
    description: typeof f.description === "string" ? f.description.trim().slice(0, 1200) || undefined : undefined,
    stockQuantity: num(f.stockQuantity, 0, 100_000),
  };

  if (category === "vehicle") {
    const thisYear = new Date().getFullYear();
    fields.year = num(f.year, 1900, thisYear + 1);
    fields.mileage = str(f.mileage, 40);
    fields.colorName = str(f.colorName, 40);
    const hex = str(f.colorHex, 7);
    fields.colorHex = hex && /^#[0-9a-fA-F]{6}$/.test(hex) ? hex.toLowerCase() : undefined;
    fields.transmission = str(f.transmission, 60);
    fields.origin = str(f.origin, 40);
    fields.horsepower = num(f.horsepower, 1, 3000);
    fields.torque = str(f.torque, 40);
    fields.topSpeed = str(f.topSpeed, 40);
    fields.acceleration = num(f.acceleration, 1, 60);

    const vin = str(f.vin, 30)?.toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (vin) {
      if (vin.length !== 17 || /[IOQ]/.test(vin)) {
        warnings.push(`The VIN read as "${vin}" isn't a valid 17-character VIN — please type it in yourself.`);
      } else {
        fields.vin = vin;
        if (!vinCheckDigitValid(vin)) {
          warnings.push("Double-check the VIN against the vehicle — its check digit doesn't match (normal for some non-US vehicles).");
        }
      }
    }
  }

  if (Array.isArray(f.extraSpecs)) {
    const seen = new Set<string>();
    fields.extraSpecs = f.extraSpecs
      .map((s) => {
        const o = (s && typeof s === "object" ? s : {}) as Record<string, unknown>;
        return { key: str(o.key, 40), value: str(o.value, 200) };
      })
      .filter((s): s is { key: string; value: string } => {
        if (!s.key || !s.value || seen.has(s.key.toLowerCase())) return false;
        seen.add(s.key.toLowerCase());
        return true;
      })
      .slice(0, 12);
    if (fields.extraSpecs.length === 0) delete fields.extraSpecs;
  }

  for (const k of Object.keys(fields) as (keyof ExtractedListing)[]) {
    if (fields[k] === undefined) delete fields[k];
  }

  const transcript = str(obj.transcript, 4000);
  return { fields, transcript, warnings };
}

function parseJsonLoose(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Some models wrap JSON in prose or code fences.
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
    throw new Error("Model did not return JSON");
  }
}

export async function extractListing(input: {
  category: ListingCategory;
  images: ListingImage[];
  audio?: ListingAudio;
}): Promise<ExtractionResult> {
  if (!env.openRouterApiKey) {
    throw new ApiError(503, "AI_UNAVAILABLE", "AI listing assistant is not configured");
  }

  const content: unknown[] = [
    {
      type: "text",
      text: input.audio
        ? "Here is my voice note describing the listing" + (input.images.length ? ", plus photos." : ".")
        : "Here are the photos for the listing.",
    },
  ];
  for (const img of input.images) {
    content.push({
      type: "image_url",
      image_url: { url: `data:${img.mimetype};base64,${img.buffer.toString("base64")}` },
    });
  }
  if (input.audio) {
    content.push({
      type: "input_audio",
      input_audio: { data: input.audio.buffer.toString("base64"), format: input.audio.format },
    });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  let res: globalThis.Response;
  try {
    res = await fetch(OPENROUTER_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${env.openRouterApiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": env.frontendUrl,
        "X-Title": "GreenRev Listing Assistant",
      },
      body: JSON.stringify({
        model: env.listingModel,
        temperature: 0.1,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt(input.category, input.images.length > 0, Boolean(input.audio)) },
          { role: "user", content },
        ],
      }),
    });
  } catch (err) {
    const aborted = (err as Error)?.name === "AbortError";
    throw new ApiError(504, "AI_TIMEOUT", aborted ? "The AI took too long to respond. Please try again." : "Could not reach the AI service");
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error("OpenRouter listing extract failed:", res.status, body.slice(0, 500));
    throw new ApiError(502, "AI_FAILED", "The AI couldn't read that. Please try again.");
  }

  const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const text = json.choices?.[0]?.message?.content ?? "";
  let parsed: unknown;
  try {
    parsed = parseJsonLoose(text);
  } catch {
    console.error("OpenRouter listing extract returned non-JSON:", text.slice(0, 500));
    throw new ApiError(502, "AI_FAILED", "The AI couldn't read that. Please try again.");
  }
  return sanitizeExtraction(parsed, input.category);
}

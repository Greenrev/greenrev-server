import mongoose from "mongoose";
import { env } from "../config/env";
import { Product } from "../models/Product";
import { ApiError } from "../utils/errors";
import { OPENROUTER_BASE, openRouterHeaders, requireKey, upstreamError } from "./aiGateway";

export type ChatMessage = { role: "user" | "assistant"; content: string };

const MAX_MESSAGES = 12;
const MAX_MESSAGE_CHARS = 2000;
const MAX_TOTAL_CHARS = 12_000;
const MAX_COMPARE = 3;

/**
 * Keeps only what the client is allowed to send: recent user/assistant turns of bounded
 * size. "system" (or any other role) is dropped so callers can't rewrite the instructions.
 */
export function sanitizeHistory(raw: unknown): ChatMessage[] {
  if (!Array.isArray(raw)) throw new ApiError(400, "VALIDATION_ERROR", "messages must be a list");
  const turns: ChatMessage[] = [];
  for (const m of raw) {
    const role = (m as { role?: unknown })?.role;
    const content = (m as { content?: unknown })?.content;
    if ((role !== "user" && role !== "assistant") || typeof content !== "string") continue;
    const text = content.trim().slice(0, MAX_MESSAGE_CHARS);
    if (text) turns.push({ role, content: text });
  }
  let recent = turns.slice(-MAX_MESSAGES);
  while (recent.length > 1 && recent.reduce((n, m) => n + m.content.length, 0) > MAX_TOTAL_CHARS) {
    recent = recent.slice(1);
  }
  // The model must answer a user turn, and a conversation shouldn't open with the assistant.
  while (recent.length && recent[0].role !== "user") recent = recent.slice(1);
  if (!recent.length || recent[recent.length - 1].role !== "user") {
    throw new ApiError(400, "VALIDATION_ERROR", "Send a message to the concierge");
  }
  return recent;
}

export function sanitizeCompareIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((id): id is string => typeof id === "string" && mongoose.isValidObjectId(id)))].slice(0, MAX_COMPARE);
}

type VehicleSummary = { name: string; make: string; price: string; specs: Record<string, unknown> };

function summarize(p: { name?: string; make?: string; price?: string; priceValue?: number | null; year?: number | null; specs?: Record<string, unknown> | null }): VehicleSummary {
  const s = p.specs ?? {};
  return {
    name: p.name ?? "",
    make: p.make ?? "",
    price: p.price || (p.priceValue ? `₦${p.priceValue.toLocaleString("en-NG")}` : "Price on request"),
    specs: {
      year: p.year ?? undefined,
      horsepower: s.horsepower ?? "N/A",
      torque: s.torque ?? "N/A",
      topSpeed: s.topSpeed ?? "N/A",
      "0_100": s.acceleration ?? s["0_100"] ?? "N/A",
      transmission: s.transmission ?? undefined,
    },
  };
}

let inventoryCache: { at: number; value: VehicleSummary[] } | null = null;

async function inventory(): Promise<VehicleSummary[]> {
  if (inventoryCache && Date.now() - inventoryCache.at < 60_000) return inventoryCache.value;
  const rows = await Product.find({ category: "vehicle", inStock: { $ne: false } })
    .sort({ createdAt: -1 })
    .limit(80)
    .select("name make price priceValue year specs")
    .lean();
  inventoryCache = { at: Date.now(), value: rows.map(summarize) };
  return inventoryCache.value;
}

export async function buildSystemPrompt(compareIds: string[]): Promise<string> {
  const [stock, compared] = await Promise.all([
    inventory(),
    compareIds.length
      ? Product.find({ _id: { $in: compareIds } }).select("name make price priceValue year specs").lean()
      : Promise.resolve([]),
  ]);

  const compareContext = compared.length
    ? `\n\n## Currently Comparing\nThe user is comparing these specific vehicles:\n${JSON.stringify(compared.map(summarize), null, 2)}\nAnswer all questions using this data as the primary reference.`
    : "";
  const inventoryContext = stock.length
    ? `\n\n## GreenRev Showroom Inventory (${stock.length} vehicles available)\n${JSON.stringify(stock, null, 2)}\n\nWhen suggesting alternatives or similar vehicles, ONLY reference cars from this list.`
    : "";

  return `You are the GreenRev Moto AI Concierge, a world-class automotive expert for a premium Nigerian car marketplace called GreenRev.${compareContext}${inventoryContext}

## Guidelines
- Be sophisticated, professional, and conversational — like a luxury car consultant.
- Use markdown for readability: **bold** for key specs, bullet lists for comparisons.
- Give definitive, opinionated recommendations when asked.
- When suggesting similar or alternative vehicles, ONLY recommend cars from the GreenRev Showroom Inventory above.
- If a requested car type isn't in the inventory, say so honestly and suggest the closest match from inventory.
- Never invent prices. Always use prices from the inventory data above.
- Stay on automotive topics. Politely decline unrelated requests.`;
}

/**
 * Opens a streaming completion. Resolves once OpenRouter has accepted the request, so
 * errors (bad key, no credit) surface as normal JSON errors before any streaming starts.
 */
export async function openConciergeStream(messages: ChatMessage[], compareIds: string[], signal: AbortSignal) {
  const key = requireKey();
  const system = await buildSystemPrompt(compareIds);
  let res: globalThis.Response;
  try {
    res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
      method: "POST",
      signal,
      headers: openRouterHeaders(key, "GreenRev Concierge"),
      body: JSON.stringify({
        model: env.conciergeModel,
        stream: true,
        temperature: 0.6,
        max_tokens: 900,
        usage: { include: true },
        messages: [{ role: "system", content: system }, ...messages],
      }),
    });
  } catch (err) {
    if ((err as Error)?.name === "AbortError") throw err;
    throw new ApiError(504, "AI_TIMEOUT", "The AI took too long to respond. Please try again.");
  }
  if (!res.ok || !res.body) throw upstreamError(res.status, await res.text().catch(() => ""));
  return res.body;
}

export type StreamUsage = { prompt_tokens?: number; completion_tokens?: number; cost?: number };

/** Reads OpenRouter's SSE stream, yielding text deltas; returns token/cost usage at the end. */
export async function* readDeltas(body: ReadableStream<Uint8Array>): AsyncGenerator<string, StreamUsage | undefined> {
  const decoder = new TextDecoder();
  let buffer = "";
  let usage: StreamUsage | undefined;
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue; // ":" lines are keep-alive comments
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      let json: { choices?: { delta?: { content?: string } }[]; usage?: StreamUsage; error?: { message?: string } };
      try {
        json = JSON.parse(data);
      } catch {
        continue;
      }
      if (json.error) throw new ApiError(502, "AI_FAILED", "The AI couldn't answer that. Please try again.");
      const text = json.choices?.[0]?.delta?.content;
      if (text) yield text;
      if (json.usage) usage = json.usage;
    }
  }
  return usage;
}

import { DailyActivity } from "../models/DailyActivity";
import { User } from "../models/User";
import { Product } from "../models/Product";
import { AcquisitionRequest } from "../models/AcquisitionRequest";
import { Booking } from "../models/Booking";
import { Ticket } from "../models/Ticket";
import { Inquiry } from "../models/Inquiry";
import { AiUsage } from "../models/AiUsage";

/** Days are counted in Lagos time (UTC+1, no daylight saving) so "today" matches the business day. */
const LAGOS_OFFSET_MS = 60 * 60 * 1000;

export function lagosDay(at: Date | number = Date.now()): string {
  return new Date(new Date(at).getTime() + LAGOS_OFFSET_MS).toISOString().slice(0, 10);
}

/** Day key `n` days before `day`. */
export function dayMinus(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

const BOT_UA = /bot|crawl|spider|slurp|headless|lighthouse|pingdom|uptime|monitor|curl|wget|python-requests|axios\/|node-fetch/i;

export function isBot(userAgent: string | undefined) {
  return !userAgent || BOT_UA.test(userAgent);
}

export async function recordVisit(input: {
  visitorId: string;
  platform: "web" | "ios" | "android";
  userId?: string | null;
  role?: string | null;
}) {
  const day = lagosDay();
  await DailyActivity.updateOne(
    { day, visitorId: input.visitorId },
    {
      $setOnInsert: { day, visitorId: input.visitorId, platform: input.platform },
      $inc: { hits: 1 },
      // Once a visitor signs in during the day, the whole day counts as signed-in.
      $set: { lastSeenAt: new Date(), ...(input.userId ? { userId: input.userId, role: input.role ?? null } : {}) },
    },
    { upsert: true },
  );
}

/** Distinct visitors (and distinct signed-in accounts) over the `days` days ending `end`. */
async function activeOver(end: string, days: number) {
  const start = dayMinus(end, days - 1);
  const [row] = await DailyActivity.aggregate([
    { $match: { day: { $gte: start, $lte: end } } },
    { $group: { _id: null, visitors: { $addToSet: "$visitorId" }, users: { $addToSet: "$userId" } } },
    {
      $project: {
        visitors: { $size: "$visitors" },
        signedIn: { $size: { $filter: { input: "$users", cond: { $ne: ["$$this", null] } } } },
      },
    },
  ]);
  return { visitors: row?.visitors ?? 0, signedIn: row?.signedIn ?? 0 };
}

export async function activeUsers(today = lagosDay()) {
  const [dau, wau, mau, prevDau, prevWau, prevMau, daily, platforms] = await Promise.all([
    activeOver(today, 1),
    activeOver(today, 7),
    activeOver(today, 30),
    activeOver(dayMinus(today, 1), 1),
    activeOver(dayMinus(today, 7), 7),
    activeOver(dayMinus(today, 30), 30),
    DailyActivity.aggregate([
      { $match: { day: { $gte: dayMinus(today, 29), $lte: today } } },
      { $group: { _id: "$day", visitors: { $sum: 1 }, signedIn: { $sum: { $cond: [{ $ne: ["$userId", null] }, 1, 0] } } } },
    ]),
    DailyActivity.aggregate([
      { $match: { day: { $gte: dayMinus(today, 29), $lte: today } } },
      { $group: { _id: "$platform", visitors: { $addToSet: "$visitorId" } } },
      { $project: { visitors: { $size: "$visitors" } } },
    ]),
  ]);

  const byDay = new Map(daily.map((d) => [d._id as string, d]));
  return {
    today,
    dau: { ...dau, previous: prevDau.visitors },
    wau: { ...wau, previous: prevWau.visitors },
    mau: { ...mau, previous: prevMau.visitors },
    // Share of monthly visitors who come back on a given day.
    stickiness: mau.visitors ? Math.round((dau.visitors / mau.visitors) * 1000) / 10 : 0,
    byPlatform: Object.fromEntries(["web", "ios", "android"].map((p) => [p, platforms.find((x) => x._id === p)?.visitors ?? 0])),
    daily: Array.from({ length: 30 }, (_, i) => {
      const day = dayMinus(today, 29 - i);
      const d = byDay.get(day);
      return { day, visitors: d?.visitors ?? 0, signedIn: d?.signedIn ?? 0 };
    }),
  };
}

const countBy = async (model: { aggregate: (p: object[]) => Promise<{ _id: string; n: number }[]> }, field: string, match: object = {}) =>
  Object.fromEntries((await model.aggregate([{ $match: match }, { $group: { _id: `$${field}`, n: { $sum: 1 } } }])).map((r) => [r._id ?? "unknown", r.n]));

/** Everything the admin analytics page shows, in one call. */
export async function analyticsOverview() {
  const now = Date.now();
  const since7 = new Date(now - 7 * 86400_000);
  const since30 = new Date(now - 30 * 86400_000);
  const [
    active,
    usersByRole,
    newUsers7,
    newUsers30,
    productsByCategory,
    newListings30,
    acquisitionsByStatus,
    sales30,
    bookingsByStatus,
    openTickets,
    newInquiries,
    ai,
  ] = await Promise.all([
    activeUsers(),
    countBy(User as never, "role"),
    User.countDocuments({ createdAt: { $gte: since7 } }),
    User.countDocuments({ createdAt: { $gte: since30 } }),
    countBy(Product as never, "category"),
    Product.countDocuments({ createdAt: { $gte: since30 } }),
    countBy(AcquisitionRequest as never, "status"),
    AcquisitionRequest.aggregate([
      { $match: { status: { $in: ["payment_confirmed", "completed"] }, vendorPaymentConfirmedAt: { $gte: since30 } } },
      { $group: { _id: null, count: { $sum: 1 }, value: { $sum: { $ifNull: ["$vendorPaymentAmount", 0] } } } },
    ]),
    countBy(Booking as never, "status"),
    Ticket.countDocuments({ status: { $nin: ["RESOLVED", "CLOSED"] } }),
    Inquiry.countDocuments({ status: "NEW" }),
    AiUsage.aggregate([
      { $match: { createdAt: { $gte: since30 } } },
      {
        $group: {
          _id: "$feature",
          requests: { $sum: 1 },
          errors: { $sum: { $cond: [{ $eq: ["$status", "error"] }, 1, 0] } },
          costUsd: { $sum: "$costUsd" },
        },
      },
    ]),
  ]);

  const sum = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);
  return {
    activeUsers: active,
    users: { total: sum(usersByRole), byRole: usersByRole, new7d: newUsers7, new30d: newUsers30 },
    listings: { total: sum(productsByCategory), byCategory: productsByCategory, new30d: newListings30 },
    acquisitions: {
      total: sum(acquisitionsByStatus),
      byStatus: acquisitionsByStatus,
      paid30d: sales30[0]?.count ?? 0,
      paidValue30d: sales30[0]?.value ?? 0,
    },
    bookings: { total: sum(bookingsByStatus), byStatus: bookingsByStatus },
    support: { openTickets, newInquiries },
    ai: {
      requests30d: ai.reduce((n, r) => n + r.requests, 0),
      errors30d: ai.reduce((n, r) => n + r.errors, 0),
      costUsd30d: Math.round(ai.reduce((n, r) => n + r.costUsd, 0) * 10000) / 10000,
      byFeature: Object.fromEntries(ai.map((r) => [r._id, { requests: r.requests, errors: r.errors, costUsd: r.costUsd }])),
    },
  };
}

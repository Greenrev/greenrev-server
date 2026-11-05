import type { Request } from "express";

/**
 * Rate-limit key: the signed-in account when there is one, else the client IP.
 *
 * Many Nigerian mobile users share one public IP (carrier-grade NAT), so IP-only limits
 * make strangers throttle each other. The JWT subject is read without verifying — a
 * forged token only buys its own bucket and is still rejected by requireAuth.
 */
export function userOrIp(req: Request): string {
  const header = req.headers.authorization;
  const token = header?.toLowerCase().startsWith("bearer ") ? header.slice(7) : (req.cookies?.access_token as string | undefined);
  if (token) {
    try {
      const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as { sub?: unknown };
      if (typeof payload.sub === "string" && payload.sub) return `u:${payload.sub}`;
    } catch {
      // not a JWT — fall back to IP
    }
  }
  return `ip:${req.ip ?? "unknown"}`;
}

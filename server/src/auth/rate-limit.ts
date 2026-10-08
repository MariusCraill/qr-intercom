import type { Request, Response, NextFunction } from "express";

/**
 * In-memory fixed-window rate limiter for the login endpoints.
 *
 * The Tailscale funnel puts this server on the public internet, so both login
 * routes are brute-forceable without this. State is intentionally in-process:
 * a single instance, and losing the counters on restart is an acceptable
 * trade for not adding a store. If this ever runs multi-instance, move to a
 * shared store.
 */

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();
const lastSweep = new Map<string, number>();

/**
 * Derives the rate-limit key from the real client address.
 *
 * Everything arriving through the Tailscale funnel has a loopback socket peer,
 * so keying on req.socket.remoteAddress alone would put every visitor in the
 * world into one shared bucket - and a single attacker could lock out all
 * residents with a handful of bad passwords.
 *
 * X-Forwarded-For is only honoured when the TCP peer is genuinely loopback
 * (i.e. the local Tailscale proxy). Tailscale appends the true client address
 * as the last entry, so we read the RIGHTMOST one. A client that sets its own
 * X-Forwarded-For can only prepend to that list, so the value we read cannot
 * be spoofed - and a machine on the LAN hitting the port directly cannot spoof
 * it at all, because its peer address is not loopback.
 */
function clientKey(req: Request): string {
  const peer = req.socket.remoteAddress ?? "";
  const isLoopback =
    peer === "127.0.0.1" ||
    peer === "::1" ||
    peer === "::ffff:127.0.0.1";

  if (isLoopback) {
    const header = req.headers["x-forwarded-for"];
    const raw = Array.isArray(header) ? header.join(",") : header;
    if (raw) {
      const parts = raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (parts.length > 0) return parts[parts.length - 1];
    }
  }
  return peer || "unknown";
}

function sweep(now: number): void {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
  for (const [key, seen] of lastSweep) {
    if (now - seen > 60_000) lastSweep.delete(key);
  }
}

export function loginRateLimit(opts: {
  max: number;
  windowMs: number;
  message?: string;
}) {
  const { max, windowMs } = opts;
  const message = opts.message ?? "Too many attempts. Try again later.";

  return (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now();
    const key = clientKey(req);
    if (now - (lastSweep.get(key) ?? 0) > 60_000) {
      lastSweep.set(key, now);
      sweep(now);
    }

    let bucket = buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }

    bucket.count += 1;

    const remaining = Math.max(0, max - bucket.count);
    res.setHeader("X-RateLimit-Limit", String(max));
    res.setHeader("X-RateLimit-Remaining", String(remaining));
    res.setHeader("Retry-After", String(Math.ceil((bucket.resetAt - now) / 1000)));

    if (bucket.count > max) {
      res.status(429).json({ error: message });
      return;
    }
    next();
  };
}

/**
 * Clears the counter after a successful login, so a legitimate user who
 * mistyped a few times is not left rate-limited.
 */
export function clearRateLimit(req: Request): void {
  buckets.delete(clientKey(req));
}

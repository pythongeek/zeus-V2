/**
 * F1: in-memory rate limiting + spin pacing (single-process deployment).
 *
 * Sliding-window counters keyed by caller identity. State is process
 * local by design: the VPS runs exactly one zeus-slot process, and a
 * restart resetting the windows is acceptable (limits are abuse
 * brakes, not accounting).
 */

type Bucket = { hits: number[] };
const buckets = new Map<string, Bucket>();
const lastSpinAt = new Map<number, number>();

const MAX_BUCKETS = 50_000;

export function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return req.headers.get("x-real-ip") || "unknown";
}

/** Returns true when the hit is ALLOWED (and records it). */
export function rateLimit(
  key: string,
  limit: number,
  windowMs: number,
  now: number = Date.now(),
): boolean {
  if (buckets.size > MAX_BUCKETS) buckets.clear();
  let b = buckets.get(key);
  if (!b) {
    b = { hits: [] };
    buckets.set(key, b);
  }
  const cutoff = now - windowMs;
  while (b.hits.length && b.hits[0] <= cutoff) b.hits.shift();
  if (b.hits.length >= limit) return false;
  b.hits.push(now);
  return true;
}

/**
 * Spin pacing per user: a minimum interval between spins plus a burst
 * cap. Turbo play cycles at ~700ms at the fastest, so a 300ms floor
 * and 90 spins/minute never touch a human — they stop scripted play.
 */
export function checkSpinPace(
  userId: number,
  now: number = Date.now(),
): boolean {
  if (process.env.NODE_ENV === "test") return true;
  const last = lastSpinAt.get(userId) ?? 0;
  if (now - last < 300) return false;
  if (!rateLimit(`spin:${userId}`, 90, 60_000, now)) return false;
  lastSpinAt.set(userId, now);
  return true;
}

const BOT_UA = /bot|crawler|spider|curl|wget|python-requests|python-urllib|headless|scrapy|httpclient/i;

/** Basic bot shield for account creation: real browsers only. */
export function looksLikeBot(req: Request): boolean {
  const ua = req.headers.get("user-agent") || "";
  if (!ua) return true;
  return BOT_UA.test(ua);
}

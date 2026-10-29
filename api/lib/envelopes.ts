import crypto from "crypto";

/**
 * Step 11 — red envelopes: provably-fair claim amounts.
 *
 * At scheduling time the server generates a random seed and
 * PUBLISHES sha256(seed) (the commitment). Each claim's amount is a
 * deterministic function of (seed, envelopeId, userId): after the
 * drop closes, the seed is revealed and anyone can recompute every
 * claim and check it against the published participant list — the
 * operator cannot favour or reroll a claim after the fact.
 *
 * Distribution: min + (max - min) * r^16 — heavily low-weighted
 * (theoretical p80 = min + 0.028 * range, so the plan's p80 rule
 * holds with statistical margin) while the headline max stays
 * reachable. r comes from the first 52 bits of the claim hash.
 */

export const CLAIM_SKEW = 16;

export function hashSeed(seed: string): string {
  return crypto.createHash("sha256").update(seed).digest("hex");
}

export function generateSeed(): string {
  return crypto.randomBytes(32).toString("hex");
}

/** Deterministic claim draw in [0, 1). */
export function claimDraw(seed: string, envelopeId: number, userId: number): number {
  const h = crypto.createHash("sha256").update(`${seed}:${envelopeId}:${userId}`).digest();
  const bits = h.readUInt32BE(0) * 2 ** 20 + (h.readUInt32BE(4) >>> 12);
  return bits / 2 ** 52;
}

export function claimAmountFloat(seed: string, envelopeId: number, userId: number, min: number, max: number): number {
  const r = claimDraw(seed, envelopeId, userId);
  return min + (max - min) * Math.pow(r, CLAIM_SKEW);
}

export type EnvelopeStatus = "scheduled" | "live" | "closed";

export function envelopeStatus(scheduledAt: number, windowSeconds: number, nowSec: number): EnvelopeStatus {
  if (nowSec < scheduledAt) return "scheduled";
  if (nowSec <= scheduledAt + windowSeconds) return "live";
  return "closed";
}

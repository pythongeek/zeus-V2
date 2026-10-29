import { z } from "zod";
import { createRouter, publicQuery, authedQuery } from "../middleware";
import { getSqliteClient } from "../queries/connection";
import { getSetting } from "../lib/settings";
import { fmtMoney, parseMoney } from "../lib/money";
import { claimAmountFloat, envelopeStatus } from "../lib/envelopes";
import { activeOffers, type ReloadOffer } from "../lib/reload";
import { maskName } from "./social";

/**
 * Step 11 — red envelopes (player/public surface). Scheduling and
 * the daily-budget rule live in the admin router. Claims credit a
 * 1x-wagering, 24h-expiry bonus through the Step 4 engine rails.
 */

function windowSeconds(): number {
  return Number(getSetting<number>("red_envelope_window_seconds") ?? 300);
}

function publicShape(env: any, nowSec: number) {
  return {
    id: env.id,
    scheduledAt: env.scheduled_at,
    currency: env.currency,
    poolAmount: env.pool_amount,
    claimedTotal: env.claimed_total,
    maxClaims: env.max_claims,
    claimsCount: env.claims_count,
    seedHash: env.seed_hash,
    status: envelopeStatus(env.scheduled_at, windowSeconds(), nowSec),
    windowSeconds: windowSeconds(),
    minClaim: Number(getSetting<number>("red_envelope_min_claim") ?? 18),
    maxClaim: Number(getSetting<number>("red_envelope_max_claim") ?? 888),
  };
}

export const promoRouter = createRouter({
  activeEnvelope: publicQuery.query(async () => {
    if (getSetting<boolean>("red_envelope_enabled") === false) return { envelope: null };
    const nowSec = Math.floor(Date.now() / 1000);
    const env = getSqliteClient()
      .prepare(
        "SELECT * FROM red_envelopes WHERE scheduled_at + ? >= ? ORDER BY scheduled_at ASC LIMIT 1",
      )
      .get(windowSeconds(), nowSec) as any;
    return { envelope: env ? publicShape(env, nowSec) : null };
  }),

  myClaim: authedQuery
    .input(z.object({ envelopeId: z.number() }))
    .query(async ({ ctx, input }) => {
      const row = getSqliteClient()
        .prepare("SELECT amount, created_at FROM red_envelope_claims WHERE envelope_id = ? AND user_id = ?")
        .get(input.envelopeId, ctx.user.id) as any;
      return { claim: row ? { amount: row.amount, createdAt: row.created_at } : null };
    }),

  claim: authedQuery
    .input(z.object({ envelopeId: z.number() }))
    .mutation(async ({ ctx, input }) => {
      if (getSetting<boolean>("red_envelope_enabled") === false) {
        throw new Error("Red envelopes are disabled");
      }
      const client = getSqliteClient();
      const nowSec = Math.floor(Date.now() / 1000);
      const minClaim = Number(getSetting<number>("red_envelope_min_claim") ?? 18);
      const maxClaim = Number(getSetting<number>("red_envelope_max_claim") ?? 888);

      const run = client.transaction(() => {
        const env = client
          .prepare("SELECT * FROM red_envelopes WHERE id = ?")
          .get(input.envelopeId) as any;
        if (!env) throw new Error("Envelope not found");
        if (envelopeStatus(env.scheduled_at, windowSeconds(), nowSec) !== "live") {
          throw new Error("Envelope is not live");
        }
        const existing = client
          .prepare("SELECT id FROM red_envelope_claims WHERE envelope_id = ? AND user_id = ?")
          .get(env.id, ctx.user.id);
        if (existing) throw new Error("Already claimed");
        if (env.claims_count >= env.max_claims) throw new Error("Envelope fully claimed");

        const poolMicro = parseMoney(env.pool_amount);
        const claimedMicro = parseMoney(env.claimed_total);
        const remaining = poolMicro - claimedMicro;
        if (remaining <= 0n) throw new Error("Envelope pool exhausted");

        let amountMicro = BigInt(Math.round(claimAmountFloat(env.seed, env.id, ctx.user.id, minClaim, maxClaim) * 1e8));
        if (amountMicro > remaining) amountMicro = remaining;
        if (amountMicro <= 0n) throw new Error("Envelope pool exhausted");

        client
          .prepare("INSERT INTO red_envelope_claims (envelope_id, user_id, amount, created_at) VALUES (?, ?, ?, ?)")
          .run(env.id, ctx.user.id, fmtMoney(amountMicro), nowSec);
        const upd = client
          .prepare(
            "UPDATE red_envelopes SET claimed_total = ?, claims_count = claims_count + 1 WHERE id = ? AND claims_count < max_claims",
          )
          .run(fmtMoney(claimedMicro + amountMicro), env.id);
        if (Number((upd as any).changes) !== 1) throw new Error("Envelope fully claimed");

        // Bonus credit: 1x wagering, 24h expiry (Step 4 engine rails).
        const brow = client
          .prepare("SELECT bonus FROM balances WHERE user_id = ? AND currency = ?")
          .get(ctx.user.id, env.currency) as any;
        const newBonus = (brow ? parseMoney(brow.bonus || "0") : 0n) + amountMicro;
        if (brow) {
          client
            .prepare("UPDATE balances SET bonus = ? WHERE user_id = ? AND currency = ?")
            .run(fmtMoney(newBonus), ctx.user.id, env.currency);
        } else {
          client
            .prepare("INSERT INTO balances (user_id, currency, available, locked, bonus) VALUES (?, ?, '0', '0', ?)")
            .run(ctx.user.id, env.currency, fmtMoney(newBonus));
        }
        client
          .prepare(
            "INSERT INTO bonus_ledger (user_id, kind, currency, amount, remaining, wagering_multiplier, wagered, status, ref_tx_id, expires_at) VALUES (?, 'red_envelope', ?, ?, ?, 1, '0', 'active', NULL, ?)",
          )
          .run(ctx.user.id, env.currency, fmtMoney(amountMicro), fmtMoney(amountMicro), nowSec + 86400);
        client
          .prepare(
            "INSERT INTO ledger_entries (user_id, kind, currency, amount, balance_after, bucket) VALUES (?, 'bonus_credit', ?, ?, ?, 'bonus')",
          )
          .run(ctx.user.id, env.currency, fmtMoney(amountMicro), fmtMoney(newBonus));

        return { amount: fmtMoney(amountMicro), currency: env.currency };
      });
      return run();
    }),

  /* ===== Step 12: reload bonus ===== */
  listReloadOffers: publicQuery.query(async () => {
    if (getSetting<boolean>("reload_enabled") === false) return { offers: [] as ReloadOffer[] };
    return { offers: activeOffers(getSetting("reload_offers")) };
  }),

  myReloadOptin: authedQuery.query(async ({ ctx }) => {
    const nowSec = Math.floor(Date.now() / 1000);
    const row = getSqliteClient()
      .prepare(
        "SELECT * FROM reload_optins WHERE user_id = ? AND status = 'armed' AND expires_at > ? ORDER BY id DESC LIMIT 1",
      )
      .get(ctx.user.id, nowSec) as any;
    return {
      optin: row ? { id: row.id, offerId: row.offer_id, expiresAt: row.expires_at } : null,
    };
  }),

  optInReload: authedQuery
    .input(z.object({ offerId: z.string().min(1).max(64) }))
    .mutation(async ({ ctx, input }) => {
      if (getSetting<boolean>("reload_enabled") === false) {
        throw new Error("Reload bonus is disabled");
      }
      const offer = activeOffers(getSetting("reload_offers")).find((o) => o.id === input.offerId);
      if (!offer) throw new Error("Offer not available");
      const client = getSqliteClient();
      const nowSec = Math.floor(Date.now() / 1000);
      const days = Number(getSetting<number>("reload_optin_days") ?? 7);
      const run = client.transaction(() => {
        // One armed opt-in per player: a fresh opt-in replaces it.
        client
          .prepare("UPDATE reload_optins SET status = 'expired' WHERE user_id = ? AND status = 'armed'")
          .run(ctx.user.id);
        const info = client
          .prepare(
            "INSERT INTO reload_optins (user_id, offer_id, status, created_at, expires_at) VALUES (?, ?, 'armed', ?, ?)",
          )
          .run(ctx.user.id, offer.id, nowSec, nowSec + days * 86400);
        return { optinId: Number(info.lastInsertRowid), expiresAt: nowSec + days * 86400 };
      });
      return run();
    }),

  envelopeResult: publicQuery
    .input(z.object({ envelopeId: z.number() }))
    .query(async ({ input }) => {
      const client = getSqliteClient();
      const nowSec = Math.floor(Date.now() / 1000);
      const env = client.prepare("SELECT * FROM red_envelopes WHERE id = ?").get(input.envelopeId) as any;
      if (!env) throw new Error("Envelope not found");
      const status = envelopeStatus(env.scheduled_at, windowSeconds(), nowSec);
      if (status !== "closed") {
        // The seed stays secret until the drop closes — that is the
        // whole point of the commitment.
        return { status, seed: null, seedHash: env.seed_hash, claims: [] };
      }
      const claims = client
        .prepare(
          `SELECT c.amount, c.created_at, u.name, u.email FROM red_envelope_claims c
           JOIN users u ON u.id = c.user_id WHERE c.envelope_id = ? ORDER BY c.id ASC`,
        )
        .all(env.id) as Array<{ amount: string; created_at: number; name: string | null; email: string | null }>;
      return {
        status,
        seed: env.seed,
        seedHash: env.seed_hash,
        claims: claims.map((c) => ({
          maskedName: maskName(c.name, c.email),
          amount: c.amount,
          createdAt: c.created_at,
        })),
      };
    }),
});

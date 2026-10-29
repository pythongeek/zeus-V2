import { z } from "zod";
import { createRouter, publicQuery, authedQuery } from "../middleware";
import { getSqliteClient } from "../queries/connection";
import { getSetting } from "../lib/settings";
import { fmtMoney, parseMoney } from "../lib/money";
import { claimAmountFloat, envelopeStatus } from "../lib/envelopes";
import { activeOffers, type ReloadOffer } from "../lib/reload";
import {
  saneTiers, tierFor, nextTier, lifetimeTurnoverBdt, ensureLevelGrants,
  sanePrizes, drawPrize, ensureWeeklyEntitlement, availableWheelSpins,
  addFreeSpinTokens, freeSpinTokenBalance,
} from "../lib/vip";
import { grantBonusCredit } from "../lib/settlement";
import { encodeReferralCode, decodeReferralCode } from "../lib/referral";
import { tsSec } from "../lib/limits";
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

  /* ===== Step 13: VIP + rakeback status ===== */
  getVipStatus: authedQuery.query(async ({ ctx }) => {
    const client = getSqliteClient();
    const nowSec = Math.floor(Date.now() / 1000);
    const tiers = saneTiers(getSetting("vip_tiers"));
    const justGranted = ensureLevelGrants(client, ctx.user.id, tiers, nowSec);
    const turnoverBdt = lifetimeTurnoverBdt(client, ctx.user.id);
    const tier = tierFor(turnoverBdt, tiers);
    const next = nextTier(turnoverBdt, tiers);
    return {
      turnoverBdt,
      tier,
      nextTier: next,
      progressPct: next && tier
        ? Math.min(100, Math.max(0, ((turnoverBdt - tier.thresholdBdt) / (next.thresholdBdt - tier.thresholdBdt)) * 100))
        : 100,
      justGranted,
      tiers,
    };
  }),

  /* ===== Step 13: lucky wheel ===== */
  getWheel: authedQuery.query(async ({ ctx }) => {
    const client = getSqliteClient();
    const enabled = getSetting<boolean>("wheel_enabled") !== false;
    if (enabled) ensureWeeklyEntitlement(client, ctx.user.id, Math.floor(Date.now() / 1000));
    const history = client
      .prepare(
        "SELECT prize_label, prize_kind, prize_amount, used_at, roll_nonce FROM wheel_entitlements WHERE user_id = ? AND used_at IS NOT NULL ORDER BY used_at DESC LIMIT 10",
      )
      .all(ctx.user.id);
    return {
      enabled,
      availableSpins: enabled ? availableWheelSpins(client, ctx.user.id) : 0,
      prizes: sanePrizes(getSetting("wheel_prizes")),
      tokenBalance: freeSpinTokenBalance(client, ctx.user.id),
      tokenBetBdt: Number(getSetting<number>("wheel_token_bet_bdt") ?? 10),
      history,
    };
  }),

  spinWheel: authedQuery.mutation(async ({ ctx }) => {
    if (getSetting<boolean>("wheel_enabled") === false) throw new Error("The wheel is disabled");
    const client = getSqliteClient();
    const nowSec = Math.floor(Date.now() / 1000);
    ensureWeeklyEntitlement(client, ctx.user.id, nowSec);
    const prizes = sanePrizes(getSetting("wheel_prizes"));
    if (prizes.length === 0) throw new Error("No wheel prizes configured");
    const run = client.transaction(() => {
      const ent = client
        .prepare(
          "SELECT * FROM wheel_entitlements WHERE user_id = ? AND used_at IS NULL ORDER BY id ASC LIMIT 1",
        )
        .get(ctx.user.id) as any;
      if (!ent) throw new Error("No wheel spins available — one free spin arrives every Monday");
      const prize = drawPrize(ent.roll_nonce, prizes)!;
      const prizeAmount = prize.kind === "bonus" ? String(prize.amount ?? 0) : String(prize.spins ?? 0);
      client
        .prepare("UPDATE wheel_entitlements SET used_at = ?, prize_label = ?, prize_kind = ?, prize_amount = ? WHERE id = ?")
        .run(nowSec, prize.labelEn, prize.kind, prizeAmount, ent.id);
      if (prize.kind === "bonus" && (prize.amount ?? 0) > 0) {
        grantBonusCredit(client, {
          userId: ctx.user.id,
          currency: "BDT",
          amountMicro: BigInt(Math.round((prize.amount ?? 0) * 1e8)),
          kind: "wheel",
          wageringMultiplier: 1,
          expiresAt: nowSec + 7 * 86400,
          nowSec,
        });
      } else if (prize.kind === "freespins" && (prize.spins ?? 0) > 0) {
        addFreeSpinTokens(client, ctx.user.id, prize.spins ?? 0, nowSec);
      }
      return {
        prize: { labelEn: prize.labelEn, labelBn: prize.labelBn, kind: prize.kind, amount: prize.amount, spins: prize.spins },
        remaining: availableWheelSpins(client, ctx.user.id),
        tokenBalance: freeSpinTokenBalance(client, ctx.user.id),
      };
    });
    return run();
  }),

  /* ===== Step 14: referral ===== */
  getReferral: authedQuery.query(async ({ ctx }) => {
    const client = getSqliteClient();
    const nowSec = Math.floor(Date.now() / 1000);
    const code = encodeReferralCode(ctx.user.id);
    client
      .prepare("UPDATE users SET referral_code = ? WHERE id = ? AND (referral_code IS NULL OR referral_code != ?)")
      .run(code, ctx.user.id, code);
    const myBind = client
      .prepare("SELECT referrer_id, bound_at FROM referrals WHERE referee_id = ?")
      .get(ctx.user.id) as any;
    const createdSec = client
      .prepare(`SELECT ${tsSec('"createdAt"')} AS sec FROM users WHERE id = ?`)
      .get(ctx.user.id) as any;
    const ageSec = nowSec - Number(createdSec?.sec ?? nowSec);
    const referees = client
      .prepare(
        `SELECT r.referee_id, r.bound_at, r.expires_at, u.name, u.email
         FROM referrals r JOIN users u ON u.id = r.referee_id
         WHERE r.referrer_id = ? ORDER BY r.bound_at DESC`,
      )
      .all(ctx.user.id) as Array<any>;
    const earnedRows = client
      .prepare("SELECT currency, SUM(CAST(amount AS REAL)) AS total FROM referral_earnings WHERE referrer_id = ? GROUP BY currency")
      .all(ctx.user.id) as Array<any>;
    const pending = client
      .prepare("SELECT currency, pending FROM referral_pending WHERE referrer_id = ? AND pending != '0'")
      .all(ctx.user.id) as Array<any>;
    const paidRows = client
      .prepare("SELECT currency, SUM(CAST(amount AS REAL)) AS total FROM promo_settlements WHERE user_id = ? AND kind = 'referral' GROUP BY currency")
      .all(ctx.user.id) as Array<any>;
    return {
      enabled: getSetting<boolean>("referral_enabled") !== false,
      code,
      boundReferrerId: myBind?.referrer_id ?? null,
      canBind: !myBind && ageSec <= 86400,
      accountAgeSeconds: ageSec,
      referees: referees.map((r) => ({
        maskedName: maskName(r.name, r.email),
        boundAt: r.bound_at,
        expiresAt: r.expires_at,
      })),
      earned: earnedRows.map((e) => ({ currency: e.currency, total: String(e.total) })),
      pending: pending.map((p) => ({ currency: p.currency, amount: p.pending })),
      paid: paidRows.map((p) => ({ currency: p.currency, total: String(p.total) })),
      terms: {
        pct: Number(getSetting<number>("referral_pct") ?? 10),
        windowDays: Number(getSetting<number>("referral_window_days") ?? 90),
        capBdt: Number(getSetting<number>("referral_cap_bdt") ?? 5000),
        vestMinBdt: Number(getSetting<number>("referral_vest_min_bdt") ?? 50),
      },
    };
  }),

  bindReferral: authedQuery
    .input(z.object({ code: z.string().min(8).max(8) }))
    .mutation(async ({ ctx, input }) => {
      if (getSetting<boolean>("referral_enabled") === false) throw new Error("Referral programme is disabled");
      const referrerId = decodeReferralCode(input.code);
      if (referrerId === null) throw new Error("Invalid referral code");
      if (referrerId === ctx.user.id) throw new Error("You cannot refer yourself");
      const client = getSqliteClient();
      const nowSec = Math.floor(Date.now() / 1000);
      const referrer = client.prepare("SELECT id FROM users WHERE id = ?").get(referrerId);
      if (!referrer) throw new Error("Referral code not recognised");
      const existing = client.prepare("SELECT id FROM referrals WHERE referee_id = ?").get(ctx.user.id);
      if (existing) throw new Error("This account already has a referrer");
      const created = client
        .prepare(
          `SELECT ${tsSec('"createdAt"')} AS sec FROM users WHERE id = ?`,
        )
        .get(ctx.user.id) as any;
      if (nowSec - Number(created?.sec ?? nowSec) > 86400) {
        throw new Error("Referral codes can only be applied within 24 hours of sign-up");
      }
      const days = Number(getSetting<number>("referral_window_days") ?? 90);
      const ip = (ctx.req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || null;
      client
        .prepare(
          "INSERT INTO referrals (referrer_id, referee_id, code, bound_at, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(referrerId, ctx.user.id, input.code.toUpperCase(), nowSec, nowSec + days * 86400, ip, ctx.req.headers.get("user-agent"));
      return { bound: true, referrerId, expiresAt: nowSec + days * 86400 };
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

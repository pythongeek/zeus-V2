import { getSetting } from "./settings";
import { fmtMoney, parseMoney } from "./money";
import { tsSec, toUsdt } from "./limits";
import { saneTiers, tierFor, lifetimeTurnoverBdt } from "./vip";

/**
 * Weekly settlement engine (Steps 10/13/14 share the rails).
 *
 * Cashback (Step 10, playbook §4.3): 5% of the previous complete
 * week's NET LOSS, wagering-free — granted as a bonus-ledger grant
 * with multiplier 0 that converts to cash in the same transaction,
 * so the player sees one clean "cashback" credit. Week = Monday
 * 00:00 Asia/Dhaka (UTC+6, no DST) to the next Monday.
 *
 * Idempotent: promo_settlements has a unique (kind, user, currency,
 * period_start) row per payout; re-running a period pays nothing
 * twice. All money moves carry ledger legs so reconciliation chains
 * stay exact.
 */

type SqliteDb = {
  prepare: (sql: string) => any;
  transaction: (fn: (...args: any[]) => any) => any;
};

export const DHAKA_OFFSET_SEC = 6 * 3600;
const WEEK_SEC = 7 * 86400;

/** Monday 00:00 Asia/Dhaka (unix seconds) of the week containing `sec`. */
export function dhakaWeekStart(sec: number): number {
  const localDay = Math.floor((sec + DHAKA_OFFSET_SEC) / 86400);
  const mon0 = (((localDay % 7) + 3) % 7 + 7) % 7; // 1970-01-01 was a Thursday
  return (localDay - mon0) * 86400 - DHAKA_OFFSET_SEC;
}

/** 00:00 Asia/Dhaka (unix seconds) of the day containing `sec`. */
export function dhakaDayStart(sec: number): number {
  return Math.floor((sec + DHAKA_OFFSET_SEC) / 86400) * 86400 - DHAKA_OFFSET_SEC;
}

/** The last complete Dhaka week [start, end) relative to `nowSec`. */
export function previousWeekPeriod(nowSec: number): { start: number; end: number } {
  const end = dhakaWeekStart(nowSec);
  return { start: end - WEEK_SEC, end };
}

export interface CashbackGrant {
  userId: number;
  currency: string;
  wageredMicro: string;
  wonMicro: string;
  netLossMicro: string;
  amountMicro: string;
}

/**
 * Credit a wagering-free promo amount (cashback / rakeback /
 * referral vesting all use this shape): bonus grant + immediate
 * conversion, one transaction, full ledger legs, one history row.
 * Caller guarantees idempotency (promo_settlements) and runs INSIDE
 * no other transaction — this opens its own.
 */
export function creditWageringFree(
  client: SqliteDb,
  args: {
    userId: number;
    currency: string;
    amountMicro: bigint;
    kind: "cashback" | "rakeback" | "referral";
    periodStart: number;
    periodEnd: number;
    basis: string;
    nowSec: number;
  },
): { txId: number } | null {
  if (args.amountMicro <= 0n) return null;
  const run = client.transaction(() => {
    const existing = client
      .prepare(
        "SELECT id FROM promo_settlements WHERE kind = ? AND user_id = ? AND currency = ? AND period_start = ?",
      )
      .get(args.kind, args.userId, args.currency, args.periodStart);
    if (existing) return null;

    const bal = client
      .prepare("SELECT available, bonus FROM balances WHERE user_id = ? AND currency = ?")
      .get(args.userId, args.currency) as { available: string; bonus: string } | undefined;
    const avail0 = parseMoney(bal?.available ?? "0");
    const bonus0 = parseMoney(bal?.bonus ?? "0");
    const amt = args.amountMicro;

    const txInfo = client
      .prepare(
        `INSERT INTO transactions (user_id, type, currency, amount, status, to_address, payout_ref, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'completed', 'internal', ?, ?, ?)`,
      )
      .run(args.userId, args.kind, args.currency, fmtMoney(amt), `${args.kind}:${args.periodStart}`, args.nowSec, args.nowSec);
    const txId = Number(txInfo.lastInsertRowid);

    client
      .prepare(
        `INSERT INTO bonus_ledger (user_id, currency, kind, amount, remaining, wagering_multiplier, wagered, status, ref_tx_id, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, '0', '0', '0', 'completed', ?, NULL, ?, ?)`,
      )
      .run(args.userId, args.currency, args.kind, fmtMoney(amt), txId, args.nowSec, args.nowSec);

    // House convention: non-spin legs carry no spin/tx reference —
    // kind + user + insertion order thread the reconciliation chain;
    // the bonus_ledger row above carries ref_tx_id.
    const insLeg = client.prepare(
      `INSERT INTO ledger_entries (user_id, kind, currency, amount, balance_after, bucket)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    insLeg.run(args.userId, "bonus_credit", args.currency, fmtMoney(amt), fmtMoney(bonus0 + amt), "bonus");
    insLeg.run(args.userId, "bonus_convert", args.currency, fmtMoney(-amt), fmtMoney(bonus0), "bonus");
    insLeg.run(args.userId, "bonus_convert", args.currency, fmtMoney(amt), fmtMoney(avail0 + amt), "available");

    if (bal) {
      client
        .prepare("UPDATE balances SET available = ?, updated_at = ? WHERE user_id = ? AND currency = ?")
        .run(fmtMoney(avail0 + amt), args.nowSec, args.userId, args.currency);
    } else {
      client
        .prepare(
          "INSERT INTO balances (user_id, currency, available, locked, bonus, updated_at) VALUES (?, ?, ?, '0', '0', ?)",
        )
        .run(args.userId, args.currency, fmtMoney(amt), args.nowSec);
    }

    client
      .prepare(
        `INSERT INTO promo_settlements (kind, user_id, currency, period_start, period_end, amount, basis, tx_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(args.kind, args.userId, args.currency, args.periodStart, args.periodEnd, fmtMoney(amt), args.basis, txId, args.nowSec);
    return { txId };
  });
  return run();
}

/** Run cashback for the previous complete Dhaka week. */
export function runCashback(
  client: SqliteDb,
  opts: { nowSec?: number; periodStart?: number; periodEnd?: number } = {},
): { periodStart: number; periodEnd: number; grants: CashbackGrant[]; totalByCurrency: Record<string, string> } {
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const period =
    opts.periodStart !== undefined && opts.periodEnd !== undefined
      ? { start: opts.periodStart, end: opts.periodEnd }
      : previousWeekPeriod(nowSec);
  const grants: CashbackGrant[] = [];
  const totalByCurrency: Record<string, bigint> = {};
  if (getSetting<boolean>("cashback_enabled") === false) {
    return { periodStart: period.start, periodEnd: period.end, grants, totalByCurrency: {} };
  }
  const pct = Number(getSetting<number>("cashback_pct") ?? 5);
  const pctHundredths = BigInt(Math.round(pct * 100));

  const wagered = client
    .prepare(
      `SELECT user_id, currency, SUM(CAST(bet_amount AS REAL)) AS total FROM spins
       WHERE is_free_spin = 0 AND ${tsSec("created_at")} >= ? AND ${tsSec("created_at")} < ?
       GROUP BY user_id, currency`,
    )
    .all(period.start, period.end) as Array<{ user_id: number; currency: string; total: number }>;
  const won = client
    .prepare(
      `SELECT user_id, currency, SUM(CAST(win_amount AS REAL)) AS total FROM spins
       WHERE ${tsSec("created_at")} >= ? AND ${tsSec("created_at")} < ?
       GROUP BY user_id, currency`,
    )
    .all(period.start, period.end) as Array<{ user_id: number; currency: string; total: number }>;
  const wonByKey = new Map(won.map((r) => [`${r.user_id}:${r.currency}`, r.total]));

  for (const w of wagered) {
    const key = `${w.user_id}:${w.currency}`;
    const wonTotal = wonByKey.get(key) ?? 0;
    const netLoss = w.total - wonTotal;
    if (!(netLoss > 0)) continue;
    const netLossMicro = BigInt(Math.round(netLoss * 1e8));
    const amountMicro = (netLossMicro * pctHundredths) / 10000n;
    if (amountMicro <= 0n) continue;
    const credited = creditWageringFree(client, {
      userId: w.user_id,
      currency: w.currency,
      amountMicro,
      kind: "cashback",
      periodStart: period.start,
      periodEnd: period.end,
      basis: `wagered ${w.total.toFixed(8)} won ${wonTotal.toFixed(8)} netLoss ${netLoss.toFixed(8)} pct ${pct}`,
      nowSec,
    });
    if (credited) {
      grants.push({
        userId: w.user_id,
        currency: w.currency,
        wageredMicro: String(BigInt(Math.round(w.total * 1e8))),
        wonMicro: String(BigInt(Math.round(wonTotal * 1e8))),
        netLossMicro: String(netLossMicro),
        amountMicro: String(amountMicro),
      });
      totalByCurrency[w.currency] = (totalByCurrency[w.currency] ?? 0n) + amountMicro;
    }
  }
  return {
    periodStart: period.start,
    periodEnd: period.end,
    grants,
    totalByCurrency: Object.fromEntries(Object.entries(totalByCurrency).map(([k, v]) => [k, fmtMoney(v)])),
  };
}

/**
 * Grant a wagering bonus on the Step 4 rails (bonus bucket +
 * bonus_ledger row + bonus_credit leg), inside the CALLER's
 * transaction context — this helper does raw inserts only, no
 * transaction of its own, mirroring the deposit-boost grant shape.
 */
export function grantBonusCredit(
  client: SqliteDb,
  args: {
    userId: number;
    currency: string;
    amountMicro: bigint;
    kind: string;
    wageringMultiplier: number;
    expiresAt: number | null;
    nowSec: number;
  },
): void {
  if (args.amountMicro <= 0n) return;
  const bal = client
    .prepare("SELECT bonus FROM balances WHERE user_id = ? AND currency = ?")
    .get(args.userId, args.currency) as { bonus: string } | undefined;
  const bonus0 = parseMoney(bal?.bonus ?? "0");
  const newBonus = bonus0 + args.amountMicro;
  if (bal) {
    client
      .prepare("UPDATE balances SET bonus = ? WHERE user_id = ? AND currency = ?")
      .run(fmtMoney(newBonus), args.userId, args.currency);
  } else {
    client
      .prepare("INSERT INTO balances (user_id, currency, available, locked, bonus) VALUES (?, ?, '0', '0', ?)")
      .run(args.userId, args.currency, fmtMoney(newBonus));
  }
  client
    .prepare(
      `INSERT INTO bonus_ledger (user_id, currency, kind, amount, remaining, wagering_multiplier, wagered, status, ref_tx_id, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, '0', 'active', NULL, ?, ?, ?)`,
    )
    .run(
      args.userId,
      args.currency,
      args.kind,
      fmtMoney(args.amountMicro),
      fmtMoney(args.amountMicro),
      args.wageringMultiplier,
      args.expiresAt,
      args.nowSec,
      args.nowSec,
    );
  client
    .prepare(
      `INSERT INTO ledger_entries (user_id, kind, currency, amount, balance_after, bucket)
       VALUES (?, 'bonus_credit', ?, ?, ?, 'bonus')`,
    )
    .run(args.userId, args.currency, fmtMoney(args.amountMicro), fmtMoney(newBonus));
}

/**
 * Weekly rakeback (Step 13): tier% of THEORETICAL loss for the
 * week — wagered x (1 - declared RTP) — credited wagering-free on
 * the settlement rails. Tier comes from lifetime turnover.
 */
export function runRakeback(
  client: SqliteDb,
  opts: { nowSec?: number; periodStart?: number; periodEnd?: number } = {},
): { periodStart: number; periodEnd: number; grants: Array<{ userId: number; currency: string; amountMicro: string; tier: string }> } {
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const period =
    opts.periodStart !== undefined && opts.periodEnd !== undefined
      ? { start: opts.periodStart, end: opts.periodEnd }
      : previousWeekPeriod(nowSec);
  const grants: Array<{ userId: number; currency: string; amountMicro: string; tier: string }> = [];
  const tiers = saneTiers(getSetting("vip_tiers"));
  const declaredRtp = Number(getSetting<number>("rtp_declared") ?? 95.95);
  const theoLossFrac = Math.max(0, 1 - declaredRtp / 100);
  if (theoLossFrac <= 0) return { periodStart: period.start, periodEnd: period.end, grants };

  const wagered = client
    .prepare(
      `SELECT user_id, currency, SUM(CAST(bet_amount AS REAL)) AS total FROM spins
       WHERE is_free_spin = 0 AND ${tsSec("created_at")} >= ? AND ${tsSec("created_at")} < ?
       GROUP BY user_id, currency`,
    )
    .all(period.start, period.end) as Array<{ user_id: number; currency: string; total: number }>;

  for (const w of wagered) {
    if (!(w.total > 0)) continue;
    const turnover = lifetimeTurnoverBdt(client, w.user_id);
    const tier = tierFor(turnover, tiers);
    if (!tier || tier.rakebackPct <= 0) continue;
    const amountMicro = BigInt(Math.round(w.total * theoLossFrac * (tier.rakebackPct / 100) * 1e8));
    if (amountMicro <= 0n) continue;
    const credited = creditWageringFree(client, {
      userId: w.user_id,
      currency: w.currency,
      amountMicro,
      kind: "rakeback",
      periodStart: period.start,
      periodEnd: period.end,
      basis: `wagered ${w.total.toFixed(8)} theoLossFrac ${theoLossFrac} tier ${tier.id} ${tier.rakebackPct}%`,
      nowSec,
    });
    if (credited) grants.push({ userId: w.user_id, currency: w.currency, amountMicro: String(amountMicro), tier: tier.id });
  }
  return { periodStart: period.start, periodEnd: period.end, grants };
}

/**
 * Weekly referral settlement (Step 14, playbook §4.3): the
 * referrer earns referral_pct (10%) of each referee's GGR —
 * wagered minus won over the week, floored at zero per
 * referee/currency — for referral_window_days (90) from binding.
 * Guards: the referee must first reach a lifetime-wagered
 * threshold (minimum activity), and lifetime earnings per referee
 * are capped (BDT equivalent). Earnings accrue to
 * referral_pending and VEST to cash once they reach
 * referral_vest_min_bdt (BDT equivalent), via creditWageringFree.
 * Idempotent at every layer (unique accrual rows + settlement
 * rows), so re-running a period changes nothing.
 */
export function runReferral(
  client: SqliteDb,
  opts: { nowSec?: number; periodStart?: number; periodEnd?: number } = {},
): { periodStart: number; periodEnd: number; accrued: number; vested: number } {
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const period =
    opts.periodStart !== undefined && opts.periodEnd !== undefined
      ? { start: opts.periodStart, end: opts.periodEnd }
      : previousWeekPeriod(nowSec);
  let accrued = 0;
  let vested = 0;
  if (getSetting<boolean>("referral_enabled") === false) {
    return { periodStart: period.start, periodEnd: period.end, accrued, vested };
  }
  const pct = Number(getSetting<number>("referral_pct") ?? 10);
  const capBdt = Number(getSetting<number>("referral_cap_bdt") ?? 5000);
  const minWageredBdt = Number(getSetting<number>("referral_min_wagered_bdt") ?? 1000);
  const vestMinBdt = Number(getSetting<number>("referral_vest_min_bdt") ?? 50);

  const binds = client
    .prepare("SELECT * FROM referrals WHERE expires_at > ?")
    .all(period.start) as Array<any>;

  for (const bind of binds) {
    const winStart = Math.max(period.start, bind.bound_at);
    const winEnd = Math.min(period.end, bind.expires_at);
    if (winEnd <= winStart) continue;
    // Minimum-activity gate: lifetime wagered (BDT eq) by period end.
    const lifeRows = client
      .prepare(
        `SELECT currency, SUM(CAST(bet_amount AS REAL)) AS total FROM spins
         WHERE user_id = ? AND is_free_spin = 0 AND ${tsSec("created_at")} < ? GROUP BY currency`,
      )
      .all(bind.referee_id, period.end) as Array<{ currency: string; total: number }>;
    const lifeBdt = lifeRows.reduce((a, r) => a + toUsdt(r.total, r.currency) * 110, 0);
    if (lifeBdt < minWageredBdt) continue;

    const wagered = client
      .prepare(
        `SELECT currency, SUM(CAST(bet_amount AS REAL)) AS total FROM spins
         WHERE user_id = ? AND is_free_spin = 0 AND ${tsSec("created_at")} >= ? AND ${tsSec("created_at")} < ?
         GROUP BY currency`,
      )
      .all(bind.referee_id, winStart, winEnd) as Array<{ currency: string; total: number }>;
    const won = client
      .prepare(
        `SELECT currency, SUM(CAST(win_amount AS REAL)) AS total FROM spins
         WHERE user_id = ? AND ${tsSec("created_at")} >= ? AND ${tsSec("created_at")} < ?
         GROUP BY currency`,
      )
      .all(bind.referee_id, winStart, winEnd) as Array<{ currency: string; total: number }>;
    const wonByCur = new Map(won.map((r) => [r.currency, r.total]));

    // Lifetime accrued (BDT eq) for the per-referee cap.
    const prior = client
      .prepare("SELECT currency, amount FROM referral_earnings WHERE referee_id = ?")
      .all(bind.referee_id) as Array<{ currency: string; amount: string }>;
    let accruedBdt = prior.reduce((a, r) => a + toUsdt(parseFloat(r.amount), r.currency) * 110, 0);

    for (const w of wagered) {
      const ggr = w.total - (wonByCur.get(w.currency) ?? 0);
      if (!(ggr > 0)) continue;
      let earnMicro = BigInt(Math.round(ggr * (pct / 100) * 1e8));
      if (earnMicro <= 0n) continue;
      const earnBdt = toUsdt(Number(earnMicro) / 1e8, w.currency) * 110;
      if (accruedBdt + earnBdt > capBdt) {
        const remaining = capBdt - accruedBdt;
        if (remaining <= 0) continue;
        earnMicro = BigInt(Math.floor(Number(earnMicro) * (remaining / earnBdt)));
        if (earnMicro <= 0n) continue;
      }
      const ins = client
        .prepare(
          `INSERT OR IGNORE INTO referral_earnings (referrer_id, referee_id, currency, period_start, amount, ggr, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(bind.referrer_id, bind.referee_id, w.currency, period.start, fmtMoney(earnMicro), ggr.toFixed(8), nowSec);
      if (Number((ins as any).changes) === 1) {
        accrued += 1;
        accruedBdt += toUsdt(Number(earnMicro) / 1e8, w.currency) * 110;
        client
          .prepare(
            `INSERT INTO referral_pending (referrer_id, currency, pending, updated_at) VALUES (?, ?, ?, ?)
             ON CONFLICT(referrer_id, currency) DO UPDATE SET pending = ?, updated_at = excluded.updated_at`,
          )
          .run(
            bind.referrer_id,
            w.currency,
            fmtMoney(earnMicro),
            nowSec,
            fmtMoney(parseMoney(
              (client.prepare("SELECT pending FROM referral_pending WHERE referrer_id = ? AND currency = ?").get(bind.referrer_id, w.currency) as any)?.pending ?? "0",
            ) + earnMicro),
          );
      }
    }
  }

  // Vesting: pending balances at/above the threshold pay out.
  const pendings = client.prepare("SELECT * FROM referral_pending WHERE pending != '0'").all() as Array<any>;
  for (const p of pendings) {
    const pendingMicro = parseMoney(p.pending);
    if (pendingMicro <= 0n) continue;
    const bdtEq = toUsdt(Number(pendingMicro) / 1e8, p.currency) * 110;
    if (bdtEq < vestMinBdt) continue;
    const credited = creditWageringFree(client, {
      userId: p.referrer_id,
      currency: p.currency,
      amountMicro: pendingMicro,
      kind: "referral",
      periodStart: period.start,
      periodEnd: period.end,
      basis: `vested referral earnings (${bdtEq.toFixed(2)} BDT eq)`,
      nowSec,
    });
    if (credited) {
      client
        .prepare("UPDATE referral_pending SET pending = '0', updated_at = ? WHERE referrer_id = ? AND currency = ?")
        .run(nowSec, p.referrer_id, p.currency);
      vested += 1;
    }
  }
  return { periodStart: period.start, periodEnd: period.end, accrued, vested };
}

/**
 * Turnover rebate conversion check (Step 10): pending rebate in a
 * currency converts to cash once its BDT equivalent reaches the
 * threshold. BDT equivalent uses the BASE rate (110 BDT/USDT list
 * rate), not the display premium — settlement never pays a premium.
 */
export function rebateBdtEquivalent(pendingMicro: bigint, currency: string): number {
  const usdt = toUsdt(Number(pendingMicro) / 1e8, currency);
  return usdt * 110;
}

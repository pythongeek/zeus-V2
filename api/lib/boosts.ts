import { parseMoney, fmtMoney, mulDivRound } from "./money";
import { getSetting } from "./settings";

/**
 * Step 4 (BD production plan): the shared bonus engine.
 *
 * One bonus_ledger + wagering model reused by every bonus kind
 * (deposit_boost now; cashback, reload, red envelope, referral and
 * the VIP wheel later). Money lives in a dedicated `bonus` bucket
 * on balances; every bucket movement writes a ledger leg with
 * bucket='bonus' so reconciliation can verify the bonus chain
 * separately from the available chain.
 *
 * The spin-side logic is a PURE planner: it takes the player's
 * active grants and returns every leg intent (with the bonus
 * chain's balance_after values threaded) plus the grant row
 * updates to persist. The caller (the atomic spin transaction)
 * writes the legs in chain order and applies the updates, so a
 * rolled-back spin leaves no trace.
 */

export interface ActiveGrant {
  id: number;
  amount: string;
  remaining: string;
  wageringMultiplier: number;
  wagered: string;
  expiresAt: number | null;
}

export interface BonusLegIntent {
  kind: "bonus_expire" | "bonus_debit" | "bonus_convert";
  amountMicro: bigint; // signed
  balanceAfter: bigint; // bonus bucket after this leg
}

export interface GrantUpdate {
  id: number;
  remaining: string;
  wagered: string;
  status: "active" | "completed" | "expired";
}

export interface SpinBonusPlan {
  /** Bonus forfeited by expiry at plan time (legs included). */
  expiryLegs: BonusLegIntent[];
  /** Bet funded from the bonus bucket / from available. */
  bonusPart: bigint;
  cashPart: bigint;
  /** The bonus_debit leg, when bonusPart > 0. */
  debitLeg: BonusLegIntent | null;
  /** Conversion at wagering completion, when it happens. */
  conversion: { grantId: number; amountMicro: bigint; leg: BonusLegIntent } | null;
  /** Final bonus bucket after expiry + debit + conversion. */
  finalBonusMicro: bigint;
  grantUpdates: GrantUpdate[];
}

const SCALE = 100_000_000n;

/** Exact boost amount: amount × pct / 100, rounded to the nearest micro. */
export function computeBoostMicro(amountMicro: bigint, pct: number): bigint {
  if (!(pct > 0)) return 0n;
  return mulDivRound(amountMicro, parseMoney(String(pct)), 100n * SCALE);
}

/**
 * Plan everything bonus-related for one PAID spin.
 *
 * Rules (per the plan): bets consume bonus funds first; the full
 * bet counts as wagering, attributed to the OLDEST active grant;
 * consumption of grant remainders is FIFO; when the oldest grant's
 * wagered total reaches amount × multiplier it completes and any
 * remainder converts to available (the caller writes that leg on
 * the available chain). Expired grants forfeit their remainder.
 */
export function planSpinBonus(args: {
  grants: ActiveGrant[];
  betMicro: bigint;
  bonusMicro: bigint;
  nowSec: number;
}): SpinBonusPlan {
  const { betMicro, nowSec } = args;
  let bonus = args.bonusMicro;
  const expiryLegs: BonusLegIntent[] = [];
  const updates = new Map<number, GrantUpdate>();
  const live: ActiveGrant[] = [];

  const pushUpdate = (g: ActiveGrant, remaining: bigint, wagered: bigint, status: GrantUpdate["status"]) => {
    updates.set(g.id, {
      id: g.id,
      remaining: fmtMoney(remaining),
      wagered: fmtMoney(wagered),
      status,
    });
  };

  // 1) Expiry: forfeit remainders of grants whose time has run out.
  for (const g of args.grants) {
    const remaining = parseMoney(g.remaining);
    if (g.expiresAt !== null && g.expiresAt <= nowSec) {
      if (remaining > 0n) {
        bonus -= remaining;
        expiryLegs.push({
          kind: "bonus_expire",
          amountMicro: -remaining,
          balanceAfter: bonus,
        });
      }
      pushUpdate(g, 0n, parseMoney(g.wagered), "expired");
    } else {
      live.push(g);
    }
  }

  // 2) Funding split: bonus first, cash for the rest.
  const bonusPart = bonus < betMicro ? bonus : betMicro;
  const cashPart = betMicro - bonusPart;
  let debitLeg: BonusLegIntent | null = null;
  if (bonusPart > 0n) {
    bonus -= bonusPart;
    debitLeg = {
      kind: "bonus_debit",
      amountMicro: -bonusPart,
      balanceAfter: bonus,
    };
  }

  // 3) FIFO consumption of remainders by the bonus-funded part.
  let consumeLeft = bonusPart;
  const remainingAfter = new Map<number, bigint>();
  for (const g of live) {
    let remaining = parseMoney(g.remaining);
    if (consumeLeft > 0n && remaining > 0n) {
      const take = remaining < consumeLeft ? remaining : consumeLeft;
      remaining -= take;
      consumeLeft -= take;
    }
    remainingAfter.set(g.id, remaining);
  }

  // 4) Wagering on the oldest live grant + completion conversion.
  let conversion: SpinBonusPlan["conversion"] = null;
  live.forEach((g, idx) => {
    const remaining = remainingAfter.get(g.id)!;
    let wagered = parseMoney(g.wagered);
    let status: GrantUpdate["status"] = "active";
    let finalRemaining = remaining;
    if (idx === 0) {
      wagered += betMicro;
      const required = parseMoney(g.amount) * BigInt(g.wageringMultiplier);
      if (wagered >= required) {
        status = "completed";
        if (remaining > 0n) {
          bonus -= remaining;
          conversion = {
            grantId: g.id,
            amountMicro: remaining,
            leg: {
              kind: "bonus_convert",
              amountMicro: -remaining,
              balanceAfter: bonus,
            },
          };
          finalRemaining = 0n;
        }
      }
    }
    // Only persist rows that actually changed.
    if (
      finalRemaining !== parseMoney(g.remaining) ||
      wagered !== parseMoney(g.wagered) ||
      status !== "active"
    ) {
      pushUpdate(g, finalRemaining, wagered, status);
    }
  });

  return {
    expiryLegs,
    bonusPart,
    cashPart,
    debitLeg,
    conversion,
    finalBonusMicro: bonus,
    grantUpdates: [...updates.values()],
  };
}

/** Deposit-boost configuration, resolved from admin settings. */
export interface DepositBoostConfig {
  pct: number;
  wageringMultiplier: number;
  expiryDays: number;
}

export function depositBoostFor(currency: string, amountMicro: bigint): DepositBoostConfig | null {
  if (!getSetting<boolean>("deposit_boost_enabled")) return null;
  const boostCurrency = getSetting<string>("deposit_boost_currency") || "USDT";
  if (currency !== boostCurrency) return null;
  const min = parseMoney(getSetting<string>("deposit_boost_min_amount") || "0");
  if (amountMicro < min) return null;
  const pct = getSetting<number>("deposit_boost_pct") || 0;
  if (!(pct > 0)) return null;
  return {
    pct,
    wageringMultiplier: Math.max(0, Math.floor(getSetting<number>("deposit_boost_wagering") || 1)),
    expiryDays: Math.max(1, Math.floor(getSetting<number>("deposit_boost_expiry_days") || 30)),
  };
}

/**
 * Materialise grant expiries outside the spin path (used by
 * balance.get so the wallet never displays a bonus whose time has
 * run out). Writes the bonus_expire legs and bucket updates in one
 * transaction. The spin path does the same job through the pure
 * planner; both keep bucket == sum of active grants' remainders.
 */
export function materialiseExpiries(
  client: any,
  userId: number,
  nowSec: number,
): void {
  const grants = client
    .prepare(
      "SELECT id, currency, remaining FROM bonus_ledger WHERE user_id = ? AND status = 'active' AND expires_at IS NOT NULL AND expires_at <= ? ORDER BY id",
    )
    .all(userId, nowSec) as any[];
  if (grants.length === 0) return;
  const run = client.transaction(() => {
    const running = new Map<string, bigint>();
    const bonusOf = (currency: string): bigint => {
      if (!running.has(currency)) {
        const row = client
          .prepare("SELECT bonus FROM balances WHERE user_id = ? AND currency = ?")
          .get(userId, currency) as any;
        running.set(currency, row ? parseMoney(row.bonus || "0") : 0n);
      }
      return running.get(currency)!;
    };
    for (const g of grants) {
      const remaining = parseMoney(g.remaining);
      if (remaining > 0n) {
        const bonus = bonusOf(g.currency) - remaining;
        running.set(g.currency, bonus);
        client
          .prepare(
            "INSERT INTO ledger_entries (user_id, kind, currency, amount, balance_after, bucket) VALUES (?, 'bonus_expire', ?, ?, ?, 'bonus')",
          )
          .run(userId, g.currency, fmtMoney(-remaining), fmtMoney(bonus));
        client
          .prepare("UPDATE balances SET bonus = ? WHERE user_id = ? AND currency = ?")
          .run(fmtMoney(bonus), userId, g.currency);
      }
      client
        .prepare(
          "UPDATE bonus_ledger SET remaining = '0', status = 'expired', updated_at = ? WHERE id = ?",
        )
        .run(nowSec, g.id);
    }
  });
  run();
}

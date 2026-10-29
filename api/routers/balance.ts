import { z } from "zod";
import { createRouter, authedQuery } from "../middleware";
import { getDb, getSqliteClient } from "../queries/connection";
import { materialiseExpiries } from "../lib/boosts";
import { balances, transactions } from "../../db/schema";
import { parseMoney, fmtMoney, canonicalMoney } from "../lib/money";
import { getSetting } from "../lib/settings";
import { eq, and, desc } from "drizzle-orm";

// BDT conversion rates (mock - in production, fetch from CoinGecko)
const BDT_RATES: Record<string, number> = {
  BTC: 11000000, // ~1 BTC = 11,000,000 BDT
  ETH: 550000,   // ~1 ETH = 550,000 BDT
  USDT: 110,     // ~1 USDT = 110 BDT
};

// B2: FX rates come from admin settings (fx_rates); BDT_RATES remains
// the shipped fallback for any currency the setting does not mention.
export function getFxRates(): Record<string, number> {
  const cfg = getSetting<Record<string, number>>("fx_rates");
  return { ...BDT_RATES, ...(cfg && typeof cfg === "object" ? cfg : {}) };
}

// Step 4: display-only premium on the USDT→BDT rate (the premium
// USDT rate players see). Money itself never converts at this rate
// — deposits and withdrawals settle 1:1 in their own currency, and
// RG/limit maths keeps the base rate.
export function displayFxRates(): Record<string, number> {
  const rates = getFxRates();
  const premium = getSetting<number>("usdt_bdt_premium") || 0;
  if (premium) rates.USDT = (rates.USDT || 110) + premium;
  return rates;
}

function assertCurrencyEnabled(currency: string) {
  const enabled = getSetting<string[]>("currencies_enabled");
  if (Array.isArray(enabled) && !enabled.includes(currency)) {
    throw new Error("Currency not enabled");
  }
}

export const balanceRouter = createRouter({
  get: authedQuery.query(async ({ ctx }) => {
    const currencies = ["BTC", "ETH", "USDT", "BDT"] as const;

    try {
      const db = getDb();
      // Step 4: never display a bonus whose time has run out.
      try {
        materialiseExpiries(getSqliteClient(), ctx.user.id, Math.floor(Date.now() / 1000));
      } catch {
        // Expiry display must never break the balance read itself.
      }
      let userBalances = await db.select()
        .from(balances)
        .where(eq(balances.userId, ctx.user.id));

      // Seed zero balances for missing currencies so the UI has a row per
      // currency. Real money only arrives via confirmed deposits or admin
      // adjustment — no free demo funds.
      for (const currency of currencies) {
        const existing = userBalances.find(b => b.currency === currency);
        if (!existing) {
          await db.insert(balances).values({
            userId: ctx.user.id,
            currency: currency as any,
            available: "0",
            locked: "0",
          });
        }
      }

      // Re-fetch updated balances
      userBalances = await db.select()
        .from(balances)
        .where(eq(balances.userId, ctx.user.id));

      // Step 10: accrued turnover rebate still below the conversion
      // threshold (shown so players can watch it build).
      const rebateRows = getSqliteClient()
        .prepare("SELECT currency, pending FROM rebate_balances WHERE user_id = ?")
        .all(ctx.user.id) as Array<{ currency: string; pending: string }>;
      const rebateByCur = new Map(rebateRows.map((r) => [r.currency, parseFloat(r.pending) || 0]));

      return currencies.map((currency) => {
        const existing = userBalances.find(b => b.currency === currency);
        const avail = existing ? parseFloat(existing.available) : 0;
        const locked = existing ? parseFloat(existing.locked) : 0;
        const bonus = existing ? parseFloat((existing as any).bonus || "0") : 0;
        const cryptoRate = displayFxRates()[currency] || 1;
        const rebatePending = rebateByCur.get(currency) ?? 0;
        return {
          currency,
          available: avail,
          locked: locked,
          bonus,
          rebatePending,
          rebatePendingBdt: rebatePending * cryptoRate,
          bdtEquivalent: avail * cryptoRate,
        };
      });
    } catch (e) {
      // Fail loudly: returning fabricated balances would misrepresent money.
      console.error("[balance.get] DB unavailable", e);
      throw new Error("Balance service temporarily unavailable");
    }
  }),

  // ===== F3: responsible-gaming limits =====

  getLimits: authedQuery.query(async ({ ctx }) => {
    const { getLimits, getUsage } = await import("../lib/limits");
    return { limits: getLimits(ctx.user.id), usage: getUsage(ctx.user.id) };
  }),

  updateLimits: authedQuery
    .input(
      z.object({
        depositLimitDaily: z.string().regex(/^\d+\.?\d*$/).nullable().optional(),
        depositLimitWeekly: z.string().regex(/^\d+\.?\d*$/).nullable().optional(),
        depositLimitMonthly: z.string().regex(/^\d+\.?\d*$/).nullable().optional(),
        lossLimitDaily: z.string().regex(/^\d+\.?\d*$/).nullable().optional(),
        sessionLimitMinutes: z.number().int().min(5).max(1440).nullable().optional(),
        selfExcludeDays: z.number().int().min(1).max(3650).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { setLimits } = await import("../lib/limits");
      const patch: Record<string, unknown> = {};
      if (input.depositLimitDaily !== undefined) patch.depositLimitDaily = input.depositLimitDaily;
      if (input.depositLimitWeekly !== undefined) patch.depositLimitWeekly = input.depositLimitWeekly;
      if (input.depositLimitMonthly !== undefined) patch.depositLimitMonthly = input.depositLimitMonthly;
      if (input.lossLimitDaily !== undefined) patch.lossLimitDaily = input.lossLimitDaily;
      if (input.sessionLimitMinutes !== undefined) patch.sessionLimitMinutes = input.sessionLimitMinutes;
      if (input.selfExcludeDays !== undefined) {
        patch.selfExcludedUntil = Math.floor(Date.now() / 1000) + input.selfExcludeDays * 86400;
      }
      return setLimits(ctx.user.id, patch as any);
    }),

  // F4: deposits run on the Binance PayID rail (owner decision,
  // same rail as Golden Toss). The player sends to the operator's
  // PayID and submits the Binance reference; an admin verifies it in
  // Binance and approves, which credits the balance. The previous
  // flow generated a random mock address — funds sent there would
  // have been lost; it is removed entirely.
  deposit: authedQuery
    .input(z.object({
      currency: z.enum(["BTC", "ETH", "USDT", "BDT"]),
      amount: z.string().regex(/^\d+\.?\d*$/),
      reference: z.string().min(4).max(64),
    }))
    .mutation(async ({ ctx, input }) => {
      assertCurrencyEnabled(input.currency);
      const db = getDb();
      const amount = parseFloat(input.amount);

      if (amount <= 0) throw new Error("Invalid amount");

      // D2: operator deposit bounds from admin settings.
      const minCfg = getSetting<Record<string, string>>("deposit_min");
      const maxCfg = getSetting<Record<string, string>>("deposit_max");
      const amountMicro = parseMoney(input.amount);
      if (minCfg?.[input.currency] && amountMicro < parseMoney(minCfg[input.currency])) {
        throw new Error("Deposit below minimum");
      }
      if (maxCfg?.[input.currency] && amountMicro > parseMoney(maxCfg[input.currency])) {
        throw new Error("Deposit above maximum");
      }

      // F3: self-exclusion + daily deposit limit gate every deposit.
      const { assertDepositAllowed, todaysDepositsUsdt, toUsdt } = await import("../lib/limits");
      assertDepositAllowed(ctx.user.id, input.currency, amount);

      // D2: operator daily cap (USDT terms) across today's
      // pending + confirmed deposits.
      const dailyCap = getSetting<number>("deposit_daily_cap_usdt") ?? 0;
      if (dailyCap > 0 && todaysDepositsUsdt(ctx.user.id) + toUsdt(amount, input.currency) > dailyCap) {
        throw new Error("Daily deposit limit reached");
      }

      if (input.currency !== "USDT" && input.currency !== "BDT") {
        throw new Error("Deposits are via Binance PayID only (USDT or BDT)");
      }
      const payId = getSetting<string>("binance_pay_id");
      if (!payId) {
        throw new Error("Deposits are not available yet — please contact support");
      }
      const payName = getSetting<string>("binance_pay_name");

      const [tx] = await db.insert(transactions).values({
        userId: ctx.user.id,
        type: "deposit",
        currency: input.currency,
        amount: canonicalMoney(input.amount),
        toAddress: payId,
        txHash: input.reference,
        status: "pending",
      }).returning();

      return {
        txId: tx.id,
        payId,
        payName: payName || null,
        amount: input.amount,
        currency: input.currency,
        status: "pending",
      };
    }),

  withdraw: authedQuery
    .input(z.object({
      currency: z.enum(["BTC", "ETH", "USDT", "BDT"]),
      amount: z.string().regex(/^\d+\.?\d*$/),
      toAddress: z.string().min(8).max(128),
    }))
    .mutation(async ({ ctx, input }) => {
      assertCurrencyEnabled(input.currency);
      const db = getDb();
      const amountMicro = parseMoney(input.amount);

      if (amountMicro <= 0n) throw new Error("Invalid amount");

      // B2: per-currency withdrawal limits from admin settings.
      const minCfg = getSetting<Record<string, string>>("withdraw_min");
      const maxCfg = getSetting<Record<string, string>>("withdraw_max");
      if (minCfg?.[input.currency] && amountMicro < parseMoney(minCfg[input.currency])) {
        throw new Error("Withdrawal below minimum");
      }
      if (maxCfg?.[input.currency] && amountMicro > parseMoney(maxCfg[input.currency])) {
        throw new Error("Withdrawal above maximum");
      }

      // D4: operator daily withdrawal cap + auto-hold when a
      // withdrawal dwarfs the player's lifetime deposits.
      const { toUsdt, dhakaDayStartSec, tsSec } = await import("../lib/limits");
      const { getSqliteClient } = await import("../queries/connection");
      const sqlite = getSqliteClient();
      const amountUsdt = toUsdt(parseFloat(input.amount), input.currency);

      // Step 17: KYC gate — cumulative withdrawals above the BDT
      // threshold require a verified kyc_status.
      {
        const thresholdBdt = getSetting<number>("kyc_withdrawal_threshold_bdt") ?? 10000;
        const prior = sqlite
          .prepare(
            `SELECT currency, SUM(CAST(amount AS REAL)) AS total FROM transactions
             WHERE user_id = ? AND type = 'withdrawal' AND status NOT IN ('pending', 'failed', 'cancelled', 'rejected')
             GROUP BY currency`,
          )
          .all(ctx.user.id) as Array<{ currency: string; total: number }>;
        const priorBdt = prior.reduce((a, r) => a + toUsdt(r.total || 0, r.currency) * 110, 0);
        const me = sqlite.prepare("SELECT kyc_status FROM users WHERE id = ?").get(ctx.user.id) as any;
        if (priorBdt + amountUsdt * 110 > thresholdBdt && (me?.kyc_status ?? "none") !== "verified") {
          throw new Error(
            "KYC verification is required for withdrawals above ৳10,000 cumulative — please contact support to verify your account",
          );
        }
      }
      const dailyCapW = getSetting<number>("withdrawal_daily_cap_usdt") ?? 0;
      if (dailyCapW > 0) {
        const rows = sqlite
          .prepare(
            `SELECT currency, SUM(CAST(amount AS REAL)) AS total FROM transactions
             WHERE user_id = ? AND type = 'withdrawal' AND status IN ('pending', 'confirming', 'confirmed')
               AND ${tsSec("created_at")} >= ?
             GROUP BY currency`,
          )
          .all(ctx.user.id, dhakaDayStartSec()) as any[];
        const usedToday = rows.reduce((sum, r) => sum + toUsdt(r.total || 0, r.currency), 0);
        if (usedToday + amountUsdt > dailyCapW) {
          throw new Error("Daily withdrawal limit reached");
        }
      }
      let holdReason: string | null = null;
      const holdFactor = getSetting<number>("withdrawal_autohold_factor") ?? 0;
      if (holdFactor > 0) {
        const depRows = sqlite
          .prepare(
            `SELECT currency, SUM(CAST(amount AS REAL)) AS total FROM transactions
             WHERE user_id = ? AND type = 'deposit' AND status = 'confirmed'
             GROUP BY currency`,
          )
          .all(ctx.user.id) as any[];
        const lifetimeDeposits = depRows.reduce((sum, r) => sum + toUsdt(r.total || 0, r.currency), 0);
        if (amountUsdt > holdFactor * lifetimeDeposits) {
          holdReason = `Auto-hold: withdrawal $${amountUsdt.toFixed(2)} exceeds ${holdFactor}× lifetime deposits $${lifetimeDeposits.toFixed(2)}`;
        }
      }

      // Check balance
      const balance = await db.select().from(balances)
        .where(and(
          eq(balances.userId, ctx.user.id),
          eq(balances.currency, input.currency)
        ))
        .then(rows => rows[0]);

      if (!balance || parseMoney(balance.available) < amountMicro) {
        throw new Error("Insufficient balance");
      }

      // Lock the amount
      await db.update(balances)
        .set({
          available: fmtMoney(parseMoney(balance.available) - amountMicro),
          locked: fmtMoney(parseMoney(balance.locked || "0") + amountMicro),
        })
        .where(eq(balances.id, balance.id));

      // Create withdrawal transaction (fee from admin settings — B2)
      const feeCfg = getSetting<Record<string, string>>("withdraw_fees");
      const fee = parseFloat(
        canonicalMoney(feeCfg?.[input.currency] ?? (input.currency === "BTC" ? "0.0001" : input.currency === "ETH" ? "0.001" : "1")),
      );
      const [tx] = await db.insert(transactions).values({
        userId: ctx.user.id,
        type: "withdrawal",
        currency: input.currency,
        amount: fmtMoney(amountMicro),
        fee: String(fee),
        toAddress: input.toAddress,
        status: "pending",
        holdReason,
      }).returning();

      // G1: the lock moves available balance — write the ledger leg
      // so the chain stays complete.
      sqlite
        .prepare(
          "INSERT INTO ledger_entries (user_id, kind, currency, amount, balance_after) VALUES (?, 'withdrawal_lock', ?, ?, ?)",
        )
        .run(
          ctx.user.id,
          input.currency,
          fmtMoney(-amountMicro),
          fmtMoney(parseMoney(balance.available) - amountMicro),
        );

      // G2: large withdrawal requests raise an inbox alert.
      const bigWdThreshold = getSetting<number>("alert_big_withdrawal_usdt") ?? 1000;
      if (bigWdThreshold > 0 && amountUsdt >= bigWdThreshold) {
        sqlite
          .prepare(
            "INSERT INTO admin_alerts (kind, severity, title, details, ref_user_id, ref_id) VALUES ('big_withdrawal', 'warning', ?, ?, ?, ?)",
          )
          .run(
            `Large withdrawal request: ${fmtMoney(amountMicro)} ${input.currency} (~$${amountUsdt.toFixed(2)})`,
            JSON.stringify({ txId: tx.id, amount: fmtMoney(amountMicro), currency: input.currency, usdtEq: amountUsdt, toAddress: input.toAddress }),
            ctx.user.id,
            String(tx.id),
          );
      }

      return {
        txId: tx.id,
        amount: input.amount,
        currency: input.currency,
        fee: String(fee),
        toAddress: input.toAddress,
        status: "pending",
        held: holdReason !== null,
      };
    }),

  getHistory: authedQuery
    .input(z.object({
      limit: z.number().min(1).max(100).default(20),
      offset: z.number().default(0),
      type: z.enum(["deposit", "withdrawal"]).optional(),
    }))
    .query(async ({ ctx, input }) => {
      const db = getDb();
      const conditions = [eq(transactions.userId, ctx.user.id)];
      if (input.type) {
        conditions.push(eq(transactions.type, input.type));
      }
      return db.select()
        .from(transactions)
        .where(and(...conditions))
        .orderBy(desc(transactions.createdAt))
        .limit(input.limit)
        .offset(input.offset);
    }),
});

export { BDT_RATES };

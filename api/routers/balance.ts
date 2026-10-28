import { z } from "zod";
import { createRouter, authedQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { balances, transactions } from "../../db/schema";
import { parseMoney, fmtMoney, canonicalMoney } from "../lib/money";
import { getSetting } from "../lib/settings";
import { eq, and, desc } from "drizzle-orm";
import crypto from "crypto";

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

      return currencies.map((currency) => {
        const existing = userBalances.find(b => b.currency === currency);
        const avail = existing ? parseFloat(existing.available) : 0;
        const locked = existing ? parseFloat(existing.locked) : 0;
        const cryptoRate = getFxRates()[currency] || 1;
        return {
          currency,
          available: avail,
          locked: locked,
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
        lossLimitDaily: z.string().regex(/^\d+\.?\d*$/).nullable().optional(),
        sessionLimitMinutes: z.number().int().min(5).max(1440).nullable().optional(),
        selfExcludeDays: z.number().int().min(1).max(3650).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { setLimits } = await import("../lib/limits");
      const patch: Record<string, unknown> = {};
      if (input.depositLimitDaily !== undefined) patch.depositLimitDaily = input.depositLimitDaily;
      if (input.lossLimitDaily !== undefined) patch.lossLimitDaily = input.lossLimitDaily;
      if (input.sessionLimitMinutes !== undefined) patch.sessionLimitMinutes = input.sessionLimitMinutes;
      if (input.selfExcludeDays !== undefined) {
        patch.selfExcludedUntil = Math.floor(Date.now() / 1000) + input.selfExcludeDays * 86400;
      }
      return setLimits(ctx.user.id, patch as any);
    }),

  deposit: authedQuery
    .input(z.object({
      currency: z.enum(["BTC", "ETH", "USDT", "BDT"]),
      amount: z.string().regex(/^\d+\.?\d*$/),
    }))
    .mutation(async ({ ctx, input }) => {
      assertCurrencyEnabled(input.currency);
      const db = getDb();
      const amount = parseFloat(input.amount);

      if (amount <= 0) throw new Error("Invalid amount");

      // F3: self-exclusion + daily deposit limit gate every deposit.
      const { assertDepositAllowed } = await import("../lib/limits");
      assertDepositAllowed(ctx.user.id, input.currency, amount);

      // Generate deposit address (mock - in production, derive from HD wallet)
      const address = `0x${crypto.randomBytes(20).toString("hex")}`;

      // Create pending transaction
      const [tx] = await db.insert(transactions).values({
        userId: ctx.user.id,
        type: "deposit",
        currency: input.currency,
        amount: canonicalMoney(input.amount),
        toAddress: address,
        status: "pending",
      }).returning();

      return {
        txId: tx.id,
        depositAddress: address,
        amount: input.amount,
        currency: input.currency,
        status: "pending",
        minConfirmations: input.currency === "BTC" ? 3 : 12,
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
      }).returning();

      return {
        txId: tx.id,
        amount: input.amount,
        currency: input.currency,
        fee: String(fee),
        toAddress: input.toAddress,
        status: "pending",
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

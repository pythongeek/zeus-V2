import { z } from "zod";
import { createRouter, authedQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { balances, transactions } from "../../db/schema";
import { eq, and, desc } from "drizzle-orm";
import crypto from "crypto";

// BDT conversion rates (mock - in production, fetch from CoinGecko)
const BDT_RATES: Record<string, number> = {
  BTC: 11000000, // ~1 BTC = 11,000,000 BDT
  ETH: 550000,   // ~1 ETH = 550,000 BDT
  USDT: 110,     // ~1 USDT = 110 BDT
};

export const balanceRouter = createRouter({
  get: authedQuery.query(async ({ ctx }) => {
    const db = getDb();
    const userBalances = await db.select()
      .from(balances)
      .where(eq(balances.userId, ctx.user.id));

    // Ensure all currencies exist
    const currencies = ["BTC", "ETH", "USDT", "BDT"] as const;
    const result = currencies.map((currency) => {
      const existing = userBalances.find(b => b.currency === currency);
      if (existing) {
        const cryptoRate = BDT_RATES[currency] || 1;
        return {
          currency,
          available: parseFloat(existing.available),
          locked: parseFloat(existing.locked),
          bdtEquivalent: parseFloat(existing.available) * cryptoRate,
        };
      }
      return {
        currency,
        available: 1000, // Demo balance
        locked: 0,
        bdtEquivalent: currency === "BDT" ? 1000 : 1000 * (BDT_RATES[currency] || 1),
      };
    });

    return result;
  }),

  deposit: authedQuery
    .input(z.object({
      currency: z.enum(["BTC", "ETH", "USDT"]),
      amount: z.string().regex(/^\d+\.?\d*$/),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const amount = parseFloat(input.amount);

      if (amount <= 0) throw new Error("Invalid amount");

      // Generate deposit address (mock - in production, derive from HD wallet)
      const address = `0x${crypto.randomBytes(20).toString("hex")}`;

      // Create pending transaction
      const [tx] = await db.insert(transactions).values({
        userId: ctx.user.id,
        type: "deposit",
        currency: input.currency,
        amount: String(amount),
        toAddress: address,
        status: "pending",
      }).$returningId();

      return {
        txId: tx.id,
        depositAddress: address,
        amount: input.amount,
        currency: input.currency,
        status: "pending",
        minConfirmations: input.currency === "BTC" ? 3 : 12,
      };
    }),

  confirmDeposit: authedQuery
    .input(z.object({ txId: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();

      const tx = await db.select().from(transactions)
        .where(and(
          eq(transactions.id, input.txId),
          eq(transactions.userId, ctx.user.id)
        ))
        .then(rows => rows[0]);

      if (!tx || tx.status !== "pending") throw new Error("Transaction not found or already processed");

      // Update transaction
      await db.update(transactions)
        .set({ status: "confirmed", processedAt: new Date() })
        .where(eq(transactions.id, input.txId));

      // Update balance
      const amount = parseFloat(tx.amount);
      const existingBalance = await db.select().from(balances)
        .where(and(
          eq(balances.userId, ctx.user.id),
          eq(balances.currency, tx.currency)
        ))
        .then(rows => rows[0]);

      if (existingBalance) {
        await db.update(balances)
          .set({
            available: String(parseFloat(existingBalance.available) + amount),
            totalDeposited: String(parseFloat(existingBalance.totalDeposited) + amount),
          })
          .where(eq(balances.id, existingBalance.id));
      } else {
        await db.insert(balances).values({
          userId: ctx.user.id,
          currency: tx.currency,
          available: String(amount),
          totalDeposited: String(amount),
        });
      }

      return { success: true, amount: tx.amount, currency: tx.currency };
    }),

  withdraw: authedQuery
    .input(z.object({
      currency: z.enum(["BTC", "ETH", "USDT"]),
      amount: z.string().regex(/^\d+\.?\d*$/),
      toAddress: z.string().min(26).max(64),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const amount = parseFloat(input.amount);

      if (amount <= 0) throw new Error("Invalid amount");

      // Check balance
      const balance = await db.select().from(balances)
        .where(and(
          eq(balances.userId, ctx.user.id),
          eq(balances.currency, input.currency)
        ))
        .then(rows => rows[0]);

      if (!balance || parseFloat(balance.available) < amount) {
        throw new Error("Insufficient balance");
      }

      // Lock the amount
      await db.update(balances)
        .set({
          available: String(parseFloat(balance.available) - amount),
          locked: String(parseFloat(balance.locked || "0") + amount),
        })
        .where(eq(balances.id, balance.id));

      // Create withdrawal transaction
      const fee = input.currency === "BTC" ? 0.0001 : input.currency === "ETH" ? 0.001 : 1;
      const [tx] = await db.insert(transactions).values({
        userId: ctx.user.id,
        type: "withdrawal",
        currency: input.currency,
        amount: String(amount),
        fee: String(fee),
        toAddress: input.toAddress,
        status: "pending",
      }).$returningId();

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
      let query = db.select()
        .from(transactions)
        .where(eq(transactions.userId, ctx.user.id))
        .orderBy(desc(transactions.createdAt))
        .limit(input.limit)
        .offset(input.offset);

      return query;
    }),
});

export { BDT_RATES };

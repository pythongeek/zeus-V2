import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { jackpotPool, spins, users } from "../../db/schema";
import { desc, eq } from "drizzle-orm";
import { BDT_RATES, getFxRates } from "./balance";

export const jackpotRouter = createRouter({
  getPools: publicQuery.query(async () => {
    const defaultPools = [
      { tier: "mega" as const, amount: 0, bdtEquivalent: 0, seedAmount: 100, contributionRate: 0.002, hitCount: 0, currency: "USDT" },
      { tier: "major" as const, amount: 0, bdtEquivalent: 0, seedAmount: 25, contributionRate: 0.003, hitCount: 0, currency: "USDT" },
      { tier: "mini" as const, amount: 0, bdtEquivalent: 0, seedAmount: 5, contributionRate: 0.005, hitCount: 0, currency: "USDT" },
    ];

    try {
      const db = getDb();
      const pools = await db.select().from(jackpotPool);

      // Ensure pools exist (seed if empty)
      if (pools.length === 0) {
        const defaults = [
          { tier: "mini" as const, seedAmount: "5", currentAmount: "5", contributionRate: "0.005" },
          { tier: "major" as const, seedAmount: "25", currentAmount: "25", contributionRate: "0.003" },
          { tier: "mega" as const, seedAmount: "100", currentAmount: "100", contributionRate: "0.002" },
        ];

        for (const def of defaults) {
          await db.insert(jackpotPool).values({
            tier: def.tier,
            seedAmount: def.seedAmount,
            currentAmount: def.currentAmount,
            contributionRate: def.contributionRate,
            hitCount: 0,
          });
        }

        const newPools = await db.select().from(jackpotPool);
        return newPools.map(p => ({
          tier: p.tier,
          amount: parseFloat(p.currentAmount),
          // A6: pools are USDT — the BDT figure uses the USDT rate (this
          // previously multiplied by the BTC rate, showing ৳117 million).
          bdtEquivalent: parseFloat(p.currentAmount) * (getFxRates().USDT || 1),
          seedAmount: parseFloat(p.seedAmount),
          contributionRate: parseFloat(p.contributionRate),
          hitCount: p.hitCount,
          currency: "USDT",
        }));
      }

      return pools.map(p => ({
        tier: p.tier,
        amount: parseFloat(p.currentAmount),
        bdtEquivalent: parseFloat(p.currentAmount) * (getFxRates().USDT || 1),
        seedAmount: parseFloat(p.seedAmount),
        contributionRate: parseFloat(p.contributionRate),
        hitCount: p.hitCount,
        currency: "USDT",
      }));
    } catch {
      // Fallback: return default seed pools when DB is unavailable
      return defaultPools;
    }
  }),

  getHistory: publicQuery.query(async () => {
    const db = getDb();
    const recentWins = await db.select({
      id: spins.id,
      winAmount: spins.winAmount,
      currency: spins.currency,
      isJackpot: spins.isJackpot,
      createdAt: spins.createdAt,
      userId: spins.userId,
    })
      .from(spins)
      .where(eq(spins.isJackpot, true))
      .orderBy(desc(spins.createdAt))
      .limit(10);

    // Anonymize usernames
    const results = [];
    for (const win of recentWins) {
      const user = win.userId ? await db.select({ name: users.name }).from(users).where(eq(users.id, win.userId)).then(rows => rows[0]) : null;
      const name = user?.name || "Anonymous";
      const masked = name.length > 2 ? name.substring(0, 2) + "***" : "***";
      results.push({
        ...win,
        username: masked,
        bdtEquivalent: parseFloat(win.winAmount) * (getFxRates()[win.currency] || BDT_RATES[win.currency as keyof typeof BDT_RATES] || 1),
      });
    }

    return results;
  }),
});

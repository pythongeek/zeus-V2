import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { jackpotPool, spins, users } from "../../db/schema";
import { desc, eq } from "drizzle-orm";
import { BDT_RATES } from "./balance";

export const jackpotRouter = createRouter({
  getPools: publicQuery.query(async () => {
    const db = getDb();
    const pools = await db.select().from(jackpotPool);

    // Ensure pools exist (seed if empty)
    if (pools.length === 0) {
      const defaults = [
        { tier: "mini" as const, seedAmount: "0.01", currentAmount: "0.052", contributionRate: "0.001" },
        { tier: "major" as const, seedAmount: "0.1", currentAmount: "0.523", contributionRate: "0.0005" },
        { tier: "mega" as const, seedAmount: "1.0", currentAmount: "10.45", contributionRate: "0.0001" },
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
        bdtEquivalent: parseFloat(p.currentAmount) * (BDT_RATES[p.tier === "mega" ? "BTC" : "BTC"] || 1),
        seedAmount: parseFloat(p.seedAmount),
        contributionRate: parseFloat(p.contributionRate),
        hitCount: p.hitCount,
      }));
    }

    return pools.map(p => ({
      tier: p.tier,
      amount: parseFloat(p.currentAmount),
      bdtEquivalent: parseFloat(p.currentAmount) * (BDT_RATES.BTC || 1),
      seedAmount: parseFloat(p.seedAmount),
      contributionRate: parseFloat(p.contributionRate),
      hitCount: p.hitCount,
    }));
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
        bdtEquivalent: parseFloat(win.winAmount) * (BDT_RATES[win.currency as keyof typeof BDT_RATES] || 1),
      });
    }

    return results;
  }),
});

import { getDb } from "../api/queries/connection";
import * as schema from "./schema";
import { eq } from "drizzle-orm";

async function seed() {
  const db = getDb();
  console.log("🌱 Seeding Zeus Slot Database...");

  try {
    // 1. Seed Jackpot Pools (Mini, Major, Mega)
    console.log("-> Seeding Jackpot Pools...");
    const jackpotPools = [
      { tier: "mini" as const, seedAmount: "50.00000000", currentAmount: "50.00000000", contributionRate: "0.001000" },
      { tier: "major" as const, seedAmount: "500.00000000", currentAmount: "500.00000000", contributionRate: "0.000500" },
      { tier: "mega" as const, seedAmount: "10000.00000000", currentAmount: "10000.00000000", contributionRate: "0.000100" },
    ];

    for (let pool of jackpotPools) {
      const existing = await db
        .select()
        .from(schema.jackpotPool)
        .where(eq(schema.jackpotPool.tier, pool.tier))
        .then(rows => rows[0]);

      if (!existing) {
        await db.insert(schema.jackpotPool).values(pool);
        console.log(`   [+] Created Jackpot Pool tier: ${pool.tier}`);
      } else {
        console.log(`   [=] Jackpot Pool tier: ${pool.tier} already exists.`);
      }
    }

    // 2. Seed Demo User
    console.log("-> Seeding Demo User & Initial Balances...");
    const demoUnionId = "demo_user";
    let demoUser = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.unionId, demoUnionId))
      .then(rows => rows[0]);

    if (!demoUser) {
      await db.insert(schema.users).values({
        unionId: demoUnionId,
        name: "Zeus Player",
        username: "zeus_demo",
        role: "admin",
      });
      demoUser = await db
        .select()
        .from(schema.users)
        .where(eq(schema.users.unionId, demoUnionId))
        .then(rows => rows[0]);
      console.log("   [+] Created Demo User.");
    }

    // 3. Seed Demo Balances for Demo User
    if (demoUser) {
      const currencies = ["BTC", "ETH", "USDT", "BDT"] as const;
      for (let currency of currencies) {
        const existingBalance = await db
          .select()
          .from(schema.balances)
          .where(eq(schema.balances.userId, demoUser.id))
          .then(rows => rows.find(b => b.currency === currency));

        if (!existingBalance) {
          const initialAmount = currency === "BDT" ? "100000.00000000" : "1000.00000000";
          await db.insert(schema.balances).values({
            userId: demoUser.id,
            currency,
            available: initialAmount,
            totalDeposited: initialAmount,
          });
          console.log(`   [+] Initialized ${currency} balance for demo user.`);
        }
      }
    }

    console.log("✅ Seeding completed successfully!");
  } catch (err) {
    console.error("❌ Seeding failed:", err);
  }

  process.exit(0);
}

seed();

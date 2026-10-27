import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import crypto from "crypto";

/**
 * A6 tests: pool-funded jackpots.
 * - "contrib-seed" (client "a6client", nonce 1) hits NO jackpot: a 10 USDT
 *   paid spin must add exactly 0.05 / 0.03 / 0.02 to mini/major/mega
 *   (the 1% contribution split 0.5/0.3/0.2).
 * - "a6-hunt-3901" (client "a6client", nonce 1) hits MINI: the award is
 *   the pool's whole balance (preset to 7.5), the pool reseeds to 5,
 *   hit_count increments and last_won_by records the player.
 */

const tmpDir = fs.mkdtempSync(path.join("/tmp", "zeus-a6-test-"));
const dbPath = path.join(tmpDir, "test.sqlite");
process.env.ZEUS_DB_PATH = dbPath;

let gameRouter: any;
let getDb: any;
let getSqliteClient: any;
let schema: any;

async function makeSession(serverSeed: string, balance: string) {
  const db = getDb();
  const [user] = await db
    .insert(schema.users)
    .values({
      unionId: `test:a6:${Math.random().toString(36).slice(2)}`,
      name: "A6 Test",
    })
    .returning();
  await db.insert(schema.balances).values({
    userId: user.id,
    currency: "USDT",
    available: balance,
    locked: "0",
  });
  const [session] = await db
    .insert(schema.gameSessions)
    .values({
      userId: user.id,
      serverSeed,
      serverSeedHash: crypto.createHash("sha256").update(serverSeed).digest("hex"),
      clientSeed: "a6client",
      nonce: 0,
      status: "active",
    })
    .returning();
  const caller = gameRouter.createCaller({
    user,
    req: new Request("http://localhost/api/trpc"),
    resHeaders: new Headers(),
  });
  return { user, caller, sessionId: session.id as number };
}

function pool(tier: string) {
  return getSqliteClient()
    .prepare("SELECT * FROM jackpot_pool WHERE tier = ?")
    .get(tier);
}

beforeAll(async () => {
  const Database = (await import("better-sqlite3")).default;
  const sqlite = new Database(dbPath);
  const migrationsDir = path.resolve(process.cwd(), "db", "migrations");
  for (const file of fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    const sqlText = fs.readFileSync(path.join(migrationsDir, file), "utf-8");
    for (const stmt of sqlText.split("--> statement-breakpoint")) {
      const trimmed = stmt.trim();
      if (trimmed) sqlite.exec(trimmed);
    }
  }
  sqlite.close();

  ({ gameRouter } = await import("./game"));
  ({ getDb, getSqliteClient } = await import("../queries/connection"));
  schema = await import("../../db/schema");
  const client = getSqliteClient();
  for (const [tier, seed, rate] of [
    ["mini", "5", "0.005"],
    ["major", "25", "0.003"],
    ["mega", "100", "0.002"],
  ] as const) {
    client
      .prepare(
        "INSERT INTO jackpot_pool (tier, seed_amount, current_amount, contribution_rate) VALUES (?, ?, ?, ?)",
      )
      .run(tier, seed, seed, rate);
  }
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("A6: pool-funded jackpots", () => {
  it("splits the 1% contribution exactly across tiers", async () => {
    const { caller, sessionId } = await makeSession("contrib-seed", "100");
    const res = await caller.spin({ sessionId, betAmount: "10", currency: "USDT" });
    expect(res.isJackpot).toBe(false);
    expect(pool("mini").current_amount).toBe("5.05");
    expect(pool("major").current_amount).toBe("25.03");
    expect(pool("mega").current_amount).toBe("100.02");
  });

  it("pays the whole pool on a hit and reseeds", async () => {
    getSqliteClient()
      .prepare("UPDATE jackpot_pool SET current_amount = '7.5' WHERE tier = 'mini'")
      .run();
    const { user, caller, sessionId } = await makeSession("a6-hunt-3901", "100");
    const res = await caller.spin({ sessionId, betAmount: "1", currency: "USDT" });
    expect(res.isJackpot).toBe(true);
    expect(res.jackpotTier).toBe("mini");
    expect(res.jackpotAward).toBe("7.5");
    expect(parseFloat(res.winAmount)).toBeGreaterThanOrEqual(7.5);
    expect(parseFloat(res.newBalance)).toBeCloseTo(
      100 - 1 + parseFloat(res.winAmount),
      8,
    );
    const mini = pool("mini");
    expect(mini.current_amount).toBe("5"); // reseeded, no contribution on the hit tier
    expect(mini.hit_count).toBe(1);
    expect(mini.last_won_by).toBe(user.id);
    // The other tiers still received this spin's contribution.
    expect(pool("major").current_amount).toBe("25.033");
    expect(pool("mega").current_amount).toBe("100.022");
  });
});

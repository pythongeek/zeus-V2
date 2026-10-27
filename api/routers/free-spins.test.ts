import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import crypto from "crypto";

/**
 * A5 tests: server-side free spins.
 *
 * Uses hunted seeds whose provably-fair outcomes are known:
 * - "a5-hunt-15"   nonce 1 -> 3 scatters (awards 8 free spins)
 * - "a5-hunt-1823" nonce 1 -> 3 scatters (8), nonce 2 -> 4 scatters
 *   (retrigger +12 during the free spins)
 * Client seed is "a5client" in both cases.
 */

const tmpDir = fs.mkdtempSync(path.join("/tmp", "zeus-a5-test-"));
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
      unionId: `test:a5:${Math.random().toString(36).slice(2)}`,
      name: "A5 Test",
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
      clientSeed: "a5client",
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

function rawOne(sql: string, ...params: any[]) {
  return getSqliteClient().prepare(sql).get(...params);
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
  for (const [tier, seed] of [
    ["mini", "5"],
    ["major", "25"],
    ["mega", "100"],
  ] as const) {
    client
      .prepare(
        "INSERT INTO jackpot_pool (tier, seed_amount, current_amount, contribution_rate) VALUES (?, ?, ?, '0.005')",
      )
      .run(tier, seed, seed);
  }
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("A5: server-side free spins", () => {
  it("awards, consumes and exhausts free spins without charging", async () => {
    const { user, caller, sessionId } = await makeSession("a5-hunt-15", "100");

    const r1 = await caller.spin({ sessionId, betAmount: "1", currency: "USDT" });
    expect(r1.isFreeSpin).toBe(false);
    expect(r1.freeSpinsAwarded).toBe(8);
    expect(r1.freeSpinsRemaining).toBe(8);
    const balAfterPaid = parseFloat(r1.newBalance);
    expect(balAfterPaid).toBeCloseTo(100 - 1 + parseFloat(r1.winAmount), 8);

    // The session cannot be ended while free spins remain.
    await expect(caller.endSession({ sessionId })).rejects.toThrow(
      "Free spins still active",
    );

    const r2 = await caller.spin({ sessionId, betAmount: "1", currency: "USDT" });
    expect(r2.isFreeSpin).toBe(true);
    expect(r2.freeSpinsRemaining).toBe(7);
    // No charge: balance moved only by the win.
    expect(parseFloat(r2.newBalance)).toBeCloseTo(
      balAfterPaid + parseFloat(r2.winAmount),
      8,
    );

    // Ledger: exactly one debit so far (the paid spin).
    expect(
      rawOne(
        "SELECT COUNT(*) AS c FROM ledger_entries WHERE user_id = ? AND kind = 'spin_debit'",
        user.id,
      ).c,
    ).toBe(1);
    // The free spin row is flagged.
    expect(
      rawOne("SELECT is_free_spin FROM spins WHERE user_id = ? AND nonce = 2", user.id)
        .is_free_spin,
    ).toBe(1);
    // Session total wagered counts only the paid bet.
    expect(
      rawOne("SELECT total_wagered FROM game_sessions WHERE id = ?", sessionId)
        .total_wagered,
    ).toBe("1");

    // Drain the rest; every spin must be free.
    let last = r2;
    let guard = 0;
    while (last.freeSpinsRemaining > 0 && guard++ < 40) {
      last = await caller.spin({ sessionId, betAmount: "1", currency: "USDT" });
      expect(last.isFreeSpin).toBe(true);
    }
    expect(last.freeSpinsRemaining).toBe(0);

    // Next spin charges again.
    const debitsBefore = rawOne(
      "SELECT COUNT(*) AS c FROM ledger_entries WHERE user_id = ? AND kind = 'spin_debit'",
      user.id,
    ).c;
    const rPaid = await caller.spin({ sessionId, betAmount: "1", currency: "USDT" });
    expect(rPaid.isFreeSpin).toBe(false);
    expect(
      rawOne(
        "SELECT COUNT(*) AS c FROM ledger_entries WHERE user_id = ? AND kind = 'spin_debit'",
        user.id,
      ).c,
    ).toBe(debitsBefore + 1);

    // And now the session can end.
    const ended = await caller.endSession({ sessionId });
    expect(ended.serverSeed).toBe("a5-hunt-15");
  });

  it("retriggers add to the remaining count", async () => {
    const { caller, sessionId } = await makeSession("a5-hunt-1823", "100");
    const r1 = await caller.spin({ sessionId, betAmount: "1", currency: "USDT" });
    expect(r1.freeSpinsAwarded).toBe(8);
    expect(r1.freeSpinsRemaining).toBe(8);
    const r2 = await caller.spin({ sessionId, betAmount: "1", currency: "USDT" });
    expect(r2.isFreeSpin).toBe(true);
    expect(r2.freeSpinsAwarded).toBe(12); // 4 scatters on the retrigger spin
    expect(r2.freeSpinsRemaining).toBe(8 - 1 + 12);
  });
});

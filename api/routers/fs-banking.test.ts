import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import crypto from "crypto";

/**
 * FS banking tests (2026-10-31): unplayed free spins must survive
 * session boundaries. Before the fix, startSession silently
 * completed the previous session and stranded its free spins
 * (production session 60 lost 3), and endSession refused outright.
 *
 * Uses the A5 hunted seed "a5-hunt-15" (client seed "a5client"):
 * nonce 1 -> 3 scatters, awards 8 free spins at the paid bet.
 */

const tmpDir = fs.mkdtempSync(path.join("/tmp", "zeus-fsbank-test-"));
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
      unionId: `test:fsbank:${Math.random().toString(36).slice(2)}`,
      name: "FSBank Test",
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
function rawRun(sql: string, ...params: any[]) {
  return getSqliteClient().prepare(sql).run(...params);
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

describe("FS banking: free spins survive session boundaries", () => {
  it("startSession banks the old session's spins and restores them into the new one", async () => {
    const { user, caller, sessionId } = await makeSession("a5-hunt-15", "100");
    const r1 = await caller.spin({ sessionId, betAmount: "1", currency: "USDT" });
    expect(r1.freeSpinsAwarded).toBe(8);
    expect(r1.freeSpinsRemaining).toBe(8);

    // A new session starts (reload / new tab): the 8 spins must move.
    const started = await caller.startSession({});
    expect(started.freeSpinsGranted).toBe(8);
    expect(started.freeSpinsMode).toBe("classic");
    expect(started.freeSpinsBet).toBe("1");
    expect(started.freeSpinsCurrency).toBe("USDT");

    // Old session: completed, and its spins were banked (zeroed),
    // not left stranded on the dead row.
    const old = rawOne("SELECT status, free_spins_remaining FROM game_sessions WHERE id = ?", sessionId);
    expect(old.status).toBe("completed");
    expect(old.free_spins_remaining).toBe(0);
    expect(
      rawOne("SELECT COUNT(*) AS c FROM banked_free_spins WHERE user_id = ?", user.id).c,
    ).toBe(0);

    // The restored spins play free on the new session.
    const r2 = await caller.spin({ sessionId: started.sessionId, betAmount: "1", currency: "USDT" });
    expect(r2.isFreeSpin).toBe(true);
    expect(r2.freeSpinsRemaining).toBe(7);
    let last = r2;
    let guard = 0;
    while (last.freeSpinsRemaining > 0 && guard++ < 60) {
      last = await caller.spin({ sessionId: started.sessionId, betAmount: "1", currency: "USDT" });
      expect(last.isFreeSpin).toBe(true);
    }
    expect(last.freeSpinsRemaining).toBe(0);
    // Exactly ONE paid debit happened in the whole story (the
    // awarding spin) until now; the next spin charges again.
    expect(
      rawOne("SELECT COUNT(*) AS c FROM ledger_entries WHERE user_id = ? AND kind = 'spin_debit'", user.id).c,
    ).toBe(1);
    const rPaid = await caller.spin({ sessionId: started.sessionId, betAmount: "1", currency: "USDT" });
    expect(rPaid.isFreeSpin).toBe(false);
  });

  it("endSession banks instead of refusing, and the next session restores them", async () => {
    const { user, caller, sessionId } = await makeSession("a5-hunt-15", "100");
    const r1 = await caller.spin({ sessionId, betAmount: "1", currency: "USDT" });
    expect(r1.freeSpinsAwarded).toBe(8);

    const ended = await caller.endSession({ sessionId });
    expect(ended.serverSeed).toBe("a5-hunt-15");

    const banked = rawOne("SELECT * FROM banked_free_spins WHERE user_id = ?", user.id);
    expect(banked.spins).toBe(8);
    expect(banked.bet_amount).toBe("1");
    expect(banked.currency).toBe("USDT");
    expect(banked.mode).toBe("classic");

    const started = await caller.startSession({});
    expect(started.freeSpinsGranted).toBe(8);
    expect(
      rawOne("SELECT COUNT(*) AS c FROM banked_free_spins WHERE user_id = ?", user.id).c,
    ).toBe(0);
    const r2 = await caller.spin({ sessionId: started.sessionId, betAmount: "1", currency: "USDT" });
    expect(r2.isFreeSpin).toBe(true);
  });

  it("preserves the full tuple: cascade mode, bet, currency, ladder rung", async () => {
    const { caller, sessionId } = await makeSession("a5-hunt-15", "100");
    rawRun(
      "UPDATE game_sessions SET free_spins_remaining = 5, free_spins_bet = '2.5', free_spins_currency = 'BDT', free_spins_mode = 'cascade', free_spins_rung = 3 WHERE id = ?",
      sessionId,
    );
    const started = await caller.startSession({});
    expect(started.freeSpinsGranted).toBe(5);
    expect(started.freeSpinsMode).toBe("cascade");
    expect(started.freeSpinsBet).toBe("2.5");
    expect(started.freeSpinsCurrency).toBe("BDT");
    const row = rawOne(
      "SELECT free_spins_remaining, free_spins_bet, free_spins_currency, free_spins_mode, free_spins_rung FROM game_sessions WHERE id = ?",
      started.sessionId,
    );
    expect(row.free_spins_remaining).toBe(5);
    expect(row.free_spins_bet).toBe("2.5");
    expect(row.free_spins_currency).toBe("BDT");
    expect(row.free_spins_mode).toBe("cascade");
    expect(row.free_spins_rung).toBe(3);
  });

  it("banked spins seed before wheel tokens; tokens wait for the next session", async () => {
    const { user, caller, sessionId } = await makeSession("a5-hunt-15", "100");
    rawRun(
      "INSERT INTO banked_free_spins (user_id, spins, bet_amount, currency, mode, ladder_rung, created_at) VALUES (?, 6, '1', 'USDT', 'classic', 0, unixepoch())",
      user.id,
    );
    rawRun(
      "INSERT INTO free_spin_tokens (user_id, spins, updated_at) VALUES (?, 4, unixepoch())",
      user.id,
    );
    void sessionId;

    const s1 = await caller.startSession({});
    expect(s1.freeSpinsGranted).toBe(6);
    expect(rawOne("SELECT spins FROM free_spin_tokens WHERE user_id = ?", user.id).spins).toBe(4);

    // Drain the restored spins (free; outcomes irrelevant), end
    // clean, and the next start consumes the tokens.
    let last = await caller.spin({ sessionId: s1.sessionId, betAmount: "1", currency: "USDT" });
    let guard = 0;
    while (last.freeSpinsRemaining > 0 && guard++ < 200) {
      last = await caller.spin({ sessionId: s1.sessionId, betAmount: "1", currency: "USDT" });
    }
    expect(last.freeSpinsRemaining).toBe(0);
    await caller.endSession({ sessionId: s1.sessionId });
    const s2 = await caller.startSession({});
    expect(s2.freeSpinsGranted).toBe(4);
    expect(rawOne("SELECT spins FROM free_spin_tokens WHERE user_id = ?", user.id).spins).toBe(0);
  });
});

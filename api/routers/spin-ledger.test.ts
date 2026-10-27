import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";

/**
 * A2 tests: the spin path is one atomic transaction with ledger rows.
 * - a spin writes spin_debit (+ spin_credit on a win) whose amounts and
 *   balance_after chain exactly reproduce the balance movement;
 * - an unaffordable spin changes NOTHING (no spin row, no ledger, no
 *   balance or nonce movement);
 * - many overlapping spins can never overdraw: successes == spin rows ==
 *   ledger debits, nonces are unique and sequential, balance stays >= 0
 *   and equals start - bets + wins.
 */

const tmpDir = fs.mkdtempSync(path.join("/tmp", "zeus-a2-test-"));
const dbPath = path.join(tmpDir, "test.sqlite");
process.env.ZEUS_DB_PATH = dbPath;

let gameRouter: any;
let getDb: any;
let getSqliteClient: any;
let schema: any;
let caller: any;
let userId: number;
let sessionId: number;

async function makeUser(balance: string) {
  const db = getDb();
  const [user] = await db
    .insert(schema.users)
    .values({
      unionId: `test:a2:${Math.random().toString(36).slice(2)}`,
      name: "A2 Test",
    })
    .returning();
  await db.insert(schema.balances).values({
    userId: user.id,
    currency: "USDT",
    available: balance,
    locked: "0",
  });
  const c = gameRouter.createCaller({
    user,
    req: new Request("http://localhost/api/trpc"),
    resHeaders: new Headers(),
  });
  const s = await c.startSession({});
  return { user, caller: c, sessionId: s.sessionId as number };
}

function raw(sql: string, ...params: any[]) {
  return getSqliteClient().prepare(sql).all(...params);
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

  const jackpotSeed = getSqliteClient();
  for (const [tier, seed] of [
    ["mini", "0.01"],
    ["major", "0.1"],
    ["mega", "1.0"],
  ] as const) {
    jackpotSeed
      .prepare(
        "INSERT INTO jackpot_pool (tier, seed_amount, current_amount, contribution_rate) VALUES (?, ?, ?, '0.001')",
      )
      .run(tier, seed, seed);
  }

  const made = await makeUser("100");
  userId = made.user.id;
  caller = made.caller;
  sessionId = made.sessionId;
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("A2: atomic spin + ledger", () => {
  it("writes ledger legs that exactly reproduce the balance movement", async () => {
    const res = await caller.spin({
      sessionId,
      betAmount: "1",
      currency: "USDT",
    });
    const win = parseFloat(res.winAmount);

    const bal = rawOne(
      "SELECT available FROM balances WHERE user_id = ? AND currency = 'USDT'",
      userId,
    );
    expect(parseFloat(bal.available)).toBeCloseTo(parseFloat(res.newBalance), 8);
    expect(parseFloat(bal.available)).toBeCloseTo(100 - 1 + win, 8);

    const legs = raw(
      "SELECT kind, amount, balance_after FROM ledger_entries WHERE user_id = ? ORDER BY id",
      userId,
    );
    expect(legs[0].kind).toBe("spin_debit");
    expect(parseFloat(legs[0].amount)).toBeCloseTo(-1, 8);
    expect(parseFloat(legs[0].balance_after)).toBeCloseTo(99, 8);
    if (win > 0) {
      expect(legs).toHaveLength(2);
      expect(legs[1].kind).toBe("spin_credit");
      expect(parseFloat(legs[1].amount)).toBeCloseTo(win, 8);
      expect(parseFloat(legs[1].balance_after)).toBeCloseTo(
        parseFloat(res.newBalance),
        8,
      );
    } else {
      expect(legs).toHaveLength(1);
    }

    const spinRows = raw("SELECT COUNT(*) AS c FROM spins WHERE user_id = ?", userId);
    expect(spinRows[0].c).toBe(1);
  });

  it("an unaffordable spin changes nothing", async () => {
    const poor = await makeUser("0.5");
    const before = {
      spins: rawOne("SELECT COUNT(*) AS c FROM spins WHERE user_id = ?", poor.user.id).c,
      ledger: rawOne("SELECT COUNT(*) AS c FROM ledger_entries WHERE user_id = ?", poor.user.id).c,
      nonce: rawOne("SELECT nonce FROM game_sessions WHERE id = ?", poor.sessionId).nonce,
    };
    await expect(
      poor.caller.spin({
        sessionId: poor.sessionId,
        betAmount: "1",
        currency: "USDT",
      }),
    ).rejects.toThrow("Insufficient balance");
    expect(rawOne("SELECT COUNT(*) AS c FROM spins WHERE user_id = ?", poor.user.id).c).toBe(before.spins);
    expect(rawOne("SELECT COUNT(*) AS c FROM ledger_entries WHERE user_id = ?", poor.user.id).c).toBe(before.ledger);
    expect(rawOne("SELECT nonce FROM game_sessions WHERE id = ?", poor.sessionId).nonce).toBe(before.nonce);
    expect(
      parseFloat(
        rawOne("SELECT available FROM balances WHERE user_id = ? AND currency = 'USDT'", poor.user.id).available,
      ),
    ).toBeCloseTo(0.5, 8);
  });

  it("overlapping spins never overdraw and stay consistent", async () => {
    const rich = await makeUser("3");
    const attempts = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        rich.caller.spin({
          sessionId: rich.sessionId,
          betAmount: "1",
          currency: "USDT",
        }),
      ),
    );
    const ok = attempts.filter((a) => a.status === "fulfilled") as PromiseFulfilledResult<any>[];
    expect(ok.length).toBeGreaterThanOrEqual(3);

    const totalWin = ok.reduce((sum, a) => sum + parseFloat(a.value.winAmount), 0);
    const finalBal = parseFloat(
      rawOne("SELECT available FROM balances WHERE user_id = ? AND currency = 'USDT'", rich.user.id).available,
    );
    expect(finalBal).toBeGreaterThanOrEqual(0);
    expect(finalBal).toBeCloseTo(3 - ok.length + totalWin, 8);

    const spinRows = raw("SELECT nonce FROM spins WHERE user_id = ? ORDER BY nonce", rich.user.id);
    expect(spinRows).toHaveLength(ok.length);
    expect(spinRows.map((r: any) => r.nonce)).toEqual(
      Array.from({ length: ok.length }, (_, i) => i + 1),
    );
    const debits = rawOne(
      "SELECT COUNT(*) AS c FROM ledger_entries WHERE user_id = ? AND kind = 'spin_debit'",
      rich.user.id,
    ).c;
    expect(debits).toBe(ok.length);
  });
});

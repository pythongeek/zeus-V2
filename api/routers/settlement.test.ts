import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import crypto from "crypto";

/**
 * Step 10 — weekly cashback (5% of net loss, wagering-free,
 * idempotent) + turnover rebate accrual/conversion in the spin.
 */

const tmpDir = fs.mkdtempSync(path.join("/tmp", "zeus-settle-test-"));
const dbPath = path.join(tmpDir, "test.sqlite");
process.env.ZEUS_DB_PATH = dbPath;

let settlement: any;
let gameRouter: any;
let getDb: any;
let getSqliteClient: any;
let schema: any;

const S = 1_700_000_000; // fixed historical period — no real rows land here
const E = S + 7 * 86400;

function rawOne(sql: string, ...params: any[]) {
  return getSqliteClient().prepare(sql).get(...params);
}

function insertSpinRow(userId: number, bet: string, win: string, createdAt: number, nonce: number, free = false) {
  getSqliteClient()
    .prepare(
      `INSERT INTO spins (session_id, user_id, nonce, bet_amount, currency, reel_positions, symbols_shown, win_amount, hash, is_free_spin, mode_id, created_at)
       VALUES (999001, ?, ?, ?, 'USDT', '[]', '[]', ?, ?, ?, 'classic', ?)`,
    )
    .run(userId, nonce, bet, win, crypto.createHash("sha256").update(`c${nonce}`).digest("hex"), free ? 1 : 0, createdAt);
}

let userA: number;
let userB: number;
let userC: number;

beforeAll(async () => {
  const Database = (await import("better-sqlite3")).default;
  const sqlite = new Database(dbPath);
  const migrationsDir = path.resolve(process.cwd(), "db", "migrations");
  for (const file of fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()) {
    const sqlText = fs.readFileSync(path.join(migrationsDir, file), "utf8");
    for (const stmt of sqlText.split("--> statement-breakpoint")) {
      const trimmed = stmt.trim();
      if (trimmed) sqlite.exec(trimmed);
    }
  }
  sqlite.close();

  settlement = await import("../lib/settlement");
  gameRouter = (await import("./game")).gameRouter;
  getDb = (await import("../queries/connection")).getDb;
  getSqliteClient = (await import("../queries/connection")).getSqliteClient;
  schema = await import("../../db/schema");

  for (const [tier, seed] of [["mini", "0.01"], ["major", "0.1"], ["mega", "1.0"]] as const) {
    getSqliteClient()
      .prepare("INSERT INTO jackpot_pool (tier, seed_amount, current_amount, contribution_rate) VALUES (?, ?, ?, '0.001')")
      .run(tier, seed, seed);
  }

  const db = getDb();
  const mk = async (tag: string, avail: string) => {
    const [u] = await db
      .insert(schema.users)
      .values({ unionId: `test:settle:${tag}`, name: tag })
      .returning();
    await db.insert(schema.balances).values({ userId: u.id, currency: "USDT", available: avail, locked: "0" });
    return u.id;
  };
  userA = await mk("A", "20");
  userB = await mk("B", "20");
  userC = await mk("C", "20");

  // A: wagered 200, won 0 paid + 50 on a free-spin row -> net loss 150.
  insertSpinRow(userA, "100", "0", S + 100, 1);
  insertSpinRow(userA, "100", "0", S + 200, 2);
  insertSpinRow(userA, "10", "50", S + 300, 3, true);
  // B: net winner -> nothing.
  insertSpinRow(userB, "100", "130", S + 100, 4);
  // C: only outside the period -> nothing.
  insertSpinRow(userC, "100", "0", E + 100, 5);
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("dhaka week math", () => {
  it("Monday 00:00 +06 anchors the week", () => {
    const mon = Math.floor(Date.parse("2026-11-02T00:00:00+06:00") / 1000);
    expect(settlement.dhakaWeekStart(mon + 10 * 3600)).toBe(mon); // Monday 10:00
    expect(settlement.dhakaWeekStart(mon + 3 * 86400 + 5 * 3600)).toBe(mon); // Thursday
    expect(settlement.dhakaWeekStart(mon + 6 * 86400 + 23 * 3600)).toBe(mon); // Sunday 23:00
    expect(settlement.dhakaWeekStart(mon - 1)).toBe(mon - 7 * 86400); // Sunday 23:59:59 before
    const prev = settlement.previousWeekPeriod(mon + 2 * 86400);
    expect(prev).toEqual({ start: mon - 7 * 86400, end: mon });
  });
});

describe("weekly cashback", () => {
  it("pays 5% of net loss (FS wins counted), wagering-free, exactly once", () => {
    const r1 = settlement.runCashback(getSqliteClient(), { nowSec: E + 1000, periodStart: S, periodEnd: E });
    expect(r1.grants.length).toBe(1);
    expect(r1.grants[0].userId).toBe(userA);
    expect(r1.grants[0].amountMicro).toBe("750000000"); // 5% of 150
    const bal = rawOne("SELECT available, bonus FROM balances WHERE user_id = ? AND currency = 'USDT'", userA);
    expect(parseFloat(bal.available)).toBeCloseTo(27.5, 8);
    expect(parseFloat(bal.bonus)).toBeCloseTo(0, 8);
    const grant = rawOne("SELECT * FROM bonus_ledger WHERE user_id = ? AND kind = 'cashback'", userA);
    expect(grant.status).toBe("completed");
    expect(parseFloat(grant.amount)).toBeCloseTo(7.5, 8);
    const settle = rawOne("SELECT * FROM promo_settlements WHERE user_id = ? AND kind = 'cashback'", userA);
    expect(settle.period_start).toBe(S);
    // ledger chain: last available-bucket leg reproduces the balance
    const lastLeg = rawOne(
      "SELECT balance_after FROM ledger_entries WHERE user_id = ? AND bucket = 'available' ORDER BY id DESC LIMIT 1",
      userA,
    );
    expect(parseFloat(lastLeg.balance_after)).toBeCloseTo(27.5, 8);

    const r2 = settlement.runCashback(getSqliteClient(), { nowSec: E + 2000, periodStart: S, periodEnd: E });
    expect(r2.grants.length).toBe(0);
    const bal2 = rawOne("SELECT available FROM balances WHERE user_id = ? AND currency = 'USDT'", userA);
    expect(parseFloat(bal2.available)).toBeCloseTo(27.5, 8);
  });
});

describe("turnover rebate in the spin", () => {
  it("accrues per mille and converts at the BDT threshold in-spin", async () => {
    const db = getDb();
    const [u] = await db
      .insert(schema.users)
      .values({ unionId: "test:settle:rebate", name: "Rebate" })
      .returning();
    await db.insert(schema.balances).values({ userId: u.id, currency: "USDT", available: "500", locked: "0" });
    const c = gameRouter.createCaller({
      user: u,
      req: new Request("http://localhost/api/trpc"),
      resHeaders: new Headers(),
    });
    const s = await c.startSession({});
    // A paid spin may trigger free spins; drain them (tracking wins)
    // before placing the next paid bet so bets stay exact.
    let drainedWins = 0;
    async function paidSpin(bet: string) {
      for (let i = 0; i < 40; i++) {
        const sess = rawOne("SELECT free_spins_remaining AS fsr FROM game_sessions WHERE id = ?", s.sessionId);
        if (!sess || !(sess.fsr > 0)) break;
        const fr = await c.spin({ sessionId: s.sessionId, betAmount: bet, currency: "USDT" });
        drainedWins += parseFloat(fr.winAmount);
      }
      return c.spin({ sessionId: s.sessionId, betAmount: bet, currency: "USDT" });
    }
    // Small spin: accrual 0.001 USDT (0.11 BDT) — stays pending.
    const r1 = await paidSpin("1");
    let rb = rawOne("SELECT pending FROM rebate_balances WHERE user_id = ? AND currency = 'USDT'", u.id);
    expect(parseFloat(rb.pending)).toBeCloseTo(0.001, 10);
    let bal = rawOne("SELECT available FROM balances WHERE user_id = ? AND currency = 'USDT'", u.id);
    expect(parseFloat(bal.available)).toBeCloseTo(500 - 1 + parseFloat(r1.winAmount), 8);
    // Big spin: accrual 0.1 -> total 0.101 USDT = 11.11 BDT >= 10 -> converts.
    const r2 = await paidSpin("100");
    rb = rawOne("SELECT pending FROM rebate_balances WHERE user_id = ? AND currency = 'USDT'", u.id);
    expect(parseFloat(rb.pending)).toBeCloseTo(0, 10);
    bal = rawOne("SELECT available FROM balances WHERE user_id = ? AND currency = 'USDT'", u.id);
    expect(parseFloat(bal.available)).toBeCloseTo(
      500 - 1 + parseFloat(r1.winAmount) - 100 + parseFloat(r2.winAmount) + drainedWins + 0.101,
      8,
    );
    const leg = rawOne("SELECT amount FROM ledger_entries WHERE user_id = ? AND kind = 'rebate_credit'", u.id);
    expect(parseFloat(leg.amount)).toBeCloseTo(0.101, 10);
  });
});

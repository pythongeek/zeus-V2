import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";

/**
 * Section B tests: dashboard analytics.
 * Range filtering (Dhaka days), RTP math, cashflow bucketing,
 * top players, money position.
 */

const tmpDir = fs.mkdtempSync(path.join("/tmp", "zeus-analytics-test-"));
const dbPath = path.join(tmpDir, "test.sqlite");
process.env.ZEUS_DB_PATH = dbPath;

let adminRouter: any;
let getDb: any;
let getSqliteClient: any;
let schema: any;
let limits: any;

function callerFor(router: any, user: any) {
  return router.createCaller({
    user,
    req: new Request("http://localhost/api/trpc"),
    resHeaders: new Headers(),
  });
}

async function makeUser(role = "user", available = "0") {
  const db = getDb();
  const suffix = Math.random().toString(36).slice(2);
  const [user] = await db
    .insert(schema.users)
    .values({
      unionId: `test:an:${suffix}`,
      name: "AN Player",
      email: `an-${suffix}@test.local`,
      role,
    })
    .returning();
  await db.insert(schema.balances).values({
    userId: user.id,
    currency: "USDT",
    available,
    locked: "0",
  });
  return user;
}

// Production stores created_at as UTC datetime TEXT
// ('YYYY-MM-DD HH:MM:SS', the CURRENT_TIMESTAMP default) — the
// fixtures use that exact shape so the range queries are tested
// against reality, not against integer storage.
function dt(atSec: number): string {
  return new Date(atSec * 1000).toISOString().replace("T", " ").slice(0, 19);
}

function insertSpin(userId: number, bet: string, win: string, atSec: number) {
  getSqliteClient()
    .prepare(
      "INSERT INTO spins (session_id, user_id, nonce, bet_amount, currency, reel_positions, symbols_shown, win_amount, hash, created_at) VALUES (1, ?, ?, ?, 'USDT', '[]', '[]', ?, 'h', ?)",
    )
    .run(userId, Math.floor(Math.random() * 1e9), bet, win, dt(atSec));
}

function insertTx(userId: number, type: string, amount: string, status: string, atSec: number) {
  getSqliteClient()
    .prepare(
      "INSERT INTO transactions (user_id, type, currency, amount, status, to_address, created_at) VALUES (?, ?, 'USDT', ?, ?, 'addr', ?)",
    )
    .run(userId, type, amount, status, dt(atSec));
}

let admin: any;
let whale: any;
let nowSec: number;

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

  ({ adminRouter } = await import("./admin"));
  ({ getDb, getSqliteClient } = await import("../queries/connection"));
  schema = await import("../../db/schema");
  limits = await import("../lib/limits");

  admin = await makeUser("super_admin");
  whale = await makeUser("user", "1000");
  nowSec = Math.floor(Date.now() / 1000);
  const oldSec = nowSec - 10 * 86400;

  // Today: wagered 200, won 150 (RTP 75%). Ten days ago: wagered 1000, won 960.
  insertSpin(whale.id, "200", "150", nowSec - 60);
  insertSpin(whale.id, "1000", "960", oldSec);
  // Today: deposit 300 confirmed, withdrawal 120 confirmed, deposit 999 pending (excluded).
  insertTx(whale.id, "deposit", "300", "confirmed", nowSec - 30);
  insertTx(whale.id, "withdrawal", "120", "confirmed", nowSec - 30);
  insertTx(whale.id, "deposit", "999", "pending", nowSec - 30);
  insertTx(whale.id, "deposit", "500", "confirmed", oldSec);
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("B1: range analytics", () => {
  it("today counts only today's activity, with exact RTP/GGR", async () => {
    const a = callerFor(adminRouter, admin);
    const today = await a.getAnalytics({ range: "today" });
    expect(today.wageredUsdt).toBe(200);
    expect(today.wonUsdt).toBe(150);
    expect(today.ggrUsdt).toBe(50);
    expect(today.actualRtp).toBe(75);
    expect(today.theoreticalRtp).toBe(96);
    expect(today.depositsUsdt).toBe(300);
    expect(today.withdrawalsUsdt).toBe(120);
    expect(today.netCashflowUsdt).toBe(180);

    const all = await a.getAnalytics({ range: "all" });
    expect(all.wageredUsdt).toBe(1200);
    expect(all.depositsUsdt).toBe(800);

    const thirty = await a.getAnalytics({ range: "30d" });
    expect(thirty.wageredUsdt).toBe(1200); // 10 days ago is inside 30d
    const seven = await a.getAnalytics({ range: "7d" });
    expect(seven.wageredUsdt).toBe(200); // but outside 7d
  });
});

describe("B2: cashflow series", () => {
  it("returns 30 zero-filled Dhaka days with today's flows in the last bucket", async () => {
    const a = callerFor(adminRouter, admin);
    const series = await a.getCashflowSeries({ days: 30 });
    expect(series.length).toBe(30);
    const last = series[series.length - 1];
    expect(last.deposits).toBe(300);
    expect(last.withdrawals).toBe(120);
    const tenDaysAgo = series[series.length - 11];
    expect(tenDaysAgo.deposits).toBe(500);
    const empty = series[0];
    expect(empty.deposits).toBe(0);
  });
});

describe("daily tallies against production-shaped timestamps", () => {
  it("today's deposit tally excludes yesterday's datetime-text rows", async () => {
    const p = await makeUser("user", "0");
    const yesterday = nowSec - 86400;
    insertTx(p.id, "deposit", "700", "confirmed", yesterday);
    insertTx(p.id, "deposit", "30", "confirmed", nowSec - 30);
    // Before the tsSec normalizer, the TEXT-affinity comparison
    // counted BOTH rows (730). It must count only today's 30.
    expect(limits.todaysDepositsUsdt(p.id)).toBe(30);
  });
});

describe("B3/B4: top players + money position", () => {
  it("ranks the whale first and reports the biggest win", async () => {
    const a = callerFor(adminRouter, admin);
    const top = await a.getTopPlayers({ range: "all" });
    expect(top.byWagered[0].userId).toBe(whale.id);
    expect(top.byWagered[0].wagered).toBe(1200);
    expect(top.byNetLoss[0].net).toBe(90); // 1200 wagered - 1110 won
    expect(top.biggestWin.win).toBe(960);
    expect(top.biggestWin.userId).toBe(whale.id);
  });

  it("money position sums balances and pending withdrawals", async () => {
    const a = callerFor(adminRouter, admin);
    // A fresh pending withdrawal of 45 for the position check.
    insertTx(whale.id, "withdrawal", "45", "pending", nowSec - 10);
    const pos = await a.getMoneyPosition();
    expect(pos.availableUsdt).toBe(1000);
    expect(pos.liabilitiesUsdt).toBe(1000);
    expect(pos.pendingWithdrawalsCount).toBe(1);
    expect(pos.pendingWithdrawalsUsdt).toBe(45);
    expect(Array.isArray(pos.pools)).toBe(true);
  });
});

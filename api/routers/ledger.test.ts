import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";

/**
 * Ledger dashboard tests (2026-10-31): listLedger paging/filters
 * and ledgerTotals aggregates over real adjustment legs plus raw
 * spin legs. The read model is what's under test; money movement
 * itself is covered by the spin-ledger and player-admin suites.
 */

const tmpDir = fs.mkdtempSync(path.join("/tmp", "zeus-ledger-test-"));
const dbPath = path.join(tmpDir, "test.sqlite");
process.env.ZEUS_DB_PATH = dbPath;

let adminRouter: any;
let passwordLib: any;
let getDb: any;
let getSqliteClient: any;
let schema: any;

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
      unionId: `test:ledger:${suffix}`,
      name: "Ledger Player",
      email: `ledger-${suffix}@test.local`,
      role,
      passwordHash: passwordLib.hashPassword("PlayerPw2026!"),
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

  ({ adminRouter } = await import("./admin"));
  passwordLib = await import("../lib/password");
  ({ getDb, getSqliteClient } = await import("../queries/connection"));
  schema = await import("../../db/schema");
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("Ledger dashboard", () => {
  it("lists, filters and totals ledger entries", async () => {
    const admin = await makeUser("super_admin", "0");
    const player = await makeUser("user", "100");
    const other = await makeUser("user", "0");
    const adminCaller = callerFor(adminRouter, admin);

    // Real adjustment legs: +50 then -20 on the player (USDT).
    await adminCaller.adjustPlayerBalance({ userId: player.id, currency: "USDT", amount: "50", reason: "ledger test credit" });
    await adminCaller.adjustPlayerBalance({ userId: player.id, currency: "USDT", amount: "-20", reason: "ledger test debit" });

    // Raw spin legs for the player (BDT) and one for the other user.
    const nowSec = Math.floor(Date.now() / 1000);
    rawRun("INSERT INTO ledger_entries (user_id, spin_id, kind, currency, amount, balance_after, bucket, createdAt) VALUES (?, NULL, 'spin_debit', 'BDT', '-5', '1000', 'available', ?)", player.id, nowSec);
    rawRun("INSERT INTO ledger_entries (user_id, spin_id, kind, currency, amount, balance_after, bucket, createdAt) VALUES (?, NULL, 'spin_credit', 'BDT', '12.5', '1012.5', 'available', ?)", player.id, nowSec);
    rawRun("INSERT INTO ledger_entries (user_id, spin_id, kind, currency, amount, balance_after, bucket, createdAt) VALUES (?, NULL, 'spin_debit', 'BDT', '-5', '500', 'available', ?)", other.id, nowSec);

    // Unfiltered: everything, newest first.
    const all = await adminCaller.listLedger({ limit: 50, offset: 0 });
    expect(all.total).toBe(5);
    expect(all.rows.length).toBe(5);
    expect(all.rows[0].id).toBeGreaterThan(all.rows[4].id);
    expect(all.kinds).toContain("admin_adjust");
    expect(all.kinds).toContain("spin_debit");

    // Player filter isolates the player's 4 entries.
    const mine = await adminCaller.listLedger({ userId: player.id, limit: 50, offset: 0 });
    expect(mine.total).toBe(4);
    expect(mine.rows.every((r: any) => r.userId === player.id)).toBe(true);
    expect(mine.rows[0].userEmail).toBe(player.email);

    // Kind filter: the two adjustments, with the running chain.
    const adj = await adminCaller.listLedger({ userId: player.id, kind: "admin_adjust", limit: 50, offset: 0 });
    expect(adj.total).toBe(2);
    const chain = adj.rows.map((r: any) => Number(r.balanceAfter)).sort((a: number, b: number) => a - b);
    expect(chain).toEqual([130, 150]); // 100 +50 = 150, then -20 = 130 (sorted asc)

    // Currency filter + totals.
    const bdt = await adminCaller.listLedger({ currency: "BDT", limit: 50, offset: 0 });
    expect(bdt.total).toBe(3);
    const totals = await adminCaller.ledgerTotals({ userId: player.id });
    const usdt = totals.find((r: any) => r.currency === "USDT");
    const bdtT = totals.find((r: any) => r.currency === "BDT");
    expect(usdt.credit).toBeCloseTo(50, 8);
    expect(usdt.debit).toBeCloseTo(-20, 8);
    expect(usdt.net).toBeCloseTo(30, 8);
    expect(usdt.count).toBe(2);
    expect(bdtT.credit).toBeCloseTo(12.5, 8);
    expect(bdtT.debit).toBeCloseTo(-5, 8);
    expect(bdtT.count).toBe(2);

    // Date filter: a window around now includes the raw legs;
    // a window last year excludes everything.
    const inWindow = await adminCaller.listLedger({ from: nowSec - 3600, to: nowSec + 3600, limit: 50, offset: 0 });
    expect(inWindow.total).toBeGreaterThanOrEqual(3);
    const lastYear = await adminCaller.listLedger({ from: nowSec - 400 * 86400, to: nowSec - 300 * 86400, limit: 50, offset: 0 });
    expect(lastYear.total).toBe(0);

    // Paging: page size 2 over the player's 4 entries.
    const p2 = await adminCaller.listLedger({ userId: player.id, limit: 2, offset: 2 });
    expect(p2.rows.length).toBe(2);
    expect(p2.total).toBe(4);
  });

  it("refuses non-admin callers", async () => {
    const plain = await makeUser("user", "0");
    const caller = callerFor(adminRouter, plain);
    await expect(caller.listLedger({ limit: 10, offset: 0 })).rejects.toThrow();
    await expect(caller.ledgerTotals({})).rejects.toThrow();
  });
});

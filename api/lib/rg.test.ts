import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs";
import path from "path";

/**
 * F3 tests: responsible-gaming limits (api/lib/limits.ts).
 * Temp DB with all migrations applied; rows inserted via raw SQL.
 */

const tmpDir = fs.mkdtempSync(path.join("/tmp", "zeus-rg-test-"));
const dbPath = path.join(tmpDir, "test.sqlite");
process.env.ZEUS_DB_PATH = dbPath;

let limits: any;
let getSqliteClient: any;

beforeAll(async () => {
  const conn = await import("../queries/connection");
  getSqliteClient = conn.getSqliteClient;
  const db = getSqliteClient();
  const migDir = path.resolve(process.cwd(), "db", "migrations");
  for (const f of fs.readdirSync(migDir).filter((x) => x.endsWith(".sql")).sort()) {
    const sql = fs.readFileSync(path.join(migDir, f), "utf-8");
    for (const stmt of sql.split("--> statement-breakpoint")) {
      if (stmt.trim()) db.exec(stmt);
    }
  }
  limits = await import("./limits");
});

function todaySec(): number {
  return Math.floor(Date.now() / 1000);
}

describe("self-exclusion", () => {
  it("blocks deposits and spins, and cannot be shortened", () => {
    const u = 101;
    limits.setLimits(u, { selfExcludedUntil: todaySec() + 7 * 86400 });
    expect(() => limits.assertDepositAllowed(u, "USDT", 10)).toThrow(/self-excluded/);
    expect(() => limits.assertSpinAllowed(u)).toThrow(/self-excluded/);
    expect(() =>
      limits.setLimits(u, { selfExcludedUntil: todaySec() + 1 * 86400 }),
    ).toThrow(/cannot be shortened/);
    // extending is fine
    limits.setLimits(u, { selfExcludedUntil: todaySec() + 30 * 86400 });
    expect(limits.getLimits(u).selfExcludedUntil).toBeGreaterThan(todaySec() + 7 * 86400);
  });
});

describe("daily deposit limit (USDT-denominated, Dhaka day)", () => {
  it("counts today's deposits and blocks over the cap", () => {
    const u = 102;
    const db = getSqliteClient();
    db.prepare(
      "INSERT INTO transactions (user_id, type, currency, amount, status, to_address, created_at) VALUES (?, 'deposit', 'USDT', '40', 'completed', 'addr', ?)",
    ).run(u, todaySec());
    limits.setLimits(u, { depositLimitDaily: "50" });
    expect(limits.todaysDepositsUsdt(u)).toBeCloseTo(40);
    expect(() => limits.assertDepositAllowed(u, "USDT", 10.01)).toThrow(/Daily deposit limit/);
    limits.assertDepositAllowed(u, "USDT", 10); // exactly at cap: allowed
    // BDT converts at 110 BDT per USDT: 1111 BDT = 10.1 USDT -> over the cap
    expect(() => limits.assertDepositAllowed(u, "BDT", 1111)).toThrow(/Daily deposit limit/);
  });
});

describe("daily loss limit", () => {
  it("blocks spins once today's net loss reaches the cap", () => {
    const u = 103;
    const db = getSqliteClient();
    // session row is not required for the raw aggregate; spins need a
    // session_id though — use 1 and rely on no FK enforcement in sqlite.
    db.prepare(
      "INSERT INTO spins (session_id, user_id, nonce, bet_amount, currency, reel_positions, symbols_shown, win_amount, hash, created_at) VALUES (1, ?, 1, '30', 'USDT', '[]', '[]', '10', 'h', ?)",
    ).run(u, todaySec());
    limits.setLimits(u, { lossLimitDaily: "20" });
    expect(limits.todaysNetLossUsdt(u)).toBeCloseTo(20);
    expect(() => limits.assertSpinAllowed(u)).toThrow(/Daily loss limit/);
    limits.setLimits(u, { lossLimitDaily: "25" });
    limits.assertSpinAllowed(u); // under the raised cap: allowed
  });
});

describe("session limit window", () => {
  it("blocks after the window elapses and resets after a 30-min break", () => {
    const u = 104;
    limits.setLimits(u, { sessionLimitMinutes: 30 });
    const db = getSqliteClient();
    const now = todaySec();
    // window started 31 minutes ago, last spin 1 minute ago -> blocked
    db.prepare(
      "UPDATE user_limits SET play_started_at = ?, last_spin_at = ? WHERE user_id = ?",
    ).run(now - 31 * 60, now - 60, u);
    expect(() => limits.assertSpinAllowed(u)).toThrow(/Session limit/);
    // last spin 31 minutes ago -> fresh window, allowed, window restarts
    db.prepare("UPDATE user_limits SET last_spin_at = ? WHERE user_id = ?").run(now - 31 * 60, u);
    limits.assertSpinAllowed(u);
    const row = db.prepare("SELECT play_started_at FROM user_limits WHERE user_id = ?").get(u) as any;
    expect(now - row.play_started_at).toBeLessThan(10);
  });
});

describe("dhaka day boundary", () => {
  it("day start is 18:00 UTC of the previous day (UTC+6)", () => {
    // 2026-10-27T20:00:00Z = 2026-10-28 02:00 Dhaka -> day start 2026-10-27T18:00Z
    const t = Date.UTC(2026, 9, 27, 20, 0, 0) / 1000;
    expect(limits.dhakaDayStartSec(t)).toBe(Date.UTC(2026, 9, 27, 18, 0, 0) / 1000);
  });
});

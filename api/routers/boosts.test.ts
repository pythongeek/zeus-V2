import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import crypto from "crypto";

/**
 * Step 4 (BD production plan): deposit boost + bonus engine.
 * Unit: boost math and the pure spin planner (funding split,
 * wagering, conversion, expiry).
 * Integration: deposit -> boost grant -> bonus-funded spins ->
 * wagering completion, with reconciliation staying clean, plus
 * the disabled / below-minimum / insufficient-funds edges.
 */

const tmpDir = fs.mkdtempSync(path.join("/tmp", "zeus-step4-test-"));
const dbPath = path.join(tmpDir, "test.sqlite");
process.env.ZEUS_DB_PATH = dbPath;

let adminRouter: any;
let balanceRouter: any;
let gameRouter: any;
let getDb: any;
let getSqliteClient: any;
let schema: any;
let settingsLib: any;
let boosts: any;
let money: any;
let reconcile: any;
let passwordLib: any;

function callerFor(router: any, user: any) {
  return router.createCaller({
    user,
    req: new Request("http://localhost/api/trpc"),
    resHeaders: new Headers(),
  });
}

async function makeUser() {
  const db = getDb();
  const suffix = Math.random().toString(36).slice(2);
  const [user] = await db
    .insert(schema.users)
    .values({
      unionId: `test:step4:${suffix}`,
      name: "Step4 Player",
      email: `s4-${suffix}@test.local`,
      passwordHash: passwordLib.hashPassword("S4Pw2026!"),
    })
    .returning();
  return user;
}

async function makeSession(userId: number) {
  const db = getDb();
  const seed = crypto.randomBytes(32).toString("hex");
  const [session] = await db
    .insert(schema.gameSessions)
    .values({
      userId,
      serverSeed: seed,
      serverSeedHash: crypto.createHash("sha256").update(seed).digest("hex"),
      clientSeed: "step4",
      nonce: 0,
      status: "active",
    })
    .returning();
  return session.id;
}

function balRow(userId: number, currency: string) {
  return getSqliteClient()
    .prepare("SELECT available, locked, bonus FROM balances WHERE user_id = ? AND currency = ?")
    .get(userId, currency) as any;
}

function grantsOf(userId: number) {
  return getSqliteClient()
    .prepare("SELECT * FROM bonus_ledger WHERE user_id = ? ORDER BY id")
    .all(userId) as any[];
}

let adminCaller: any;

beforeAll(async () => {
  const Database = (await import("better-sqlite3")).default;
  const sqlite = new Database(dbPath);
  const migrationsDir = path.resolve(process.cwd(), "db", "migrations");
  for (const file of fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    sqlite.exec(fs.readFileSync(path.join(migrationsDir, file), "utf8"));
  }
  sqlite.close();

  adminRouter = (await import("./admin")).adminRouter;
  balanceRouter = (await import("./balance")).balanceRouter;
  gameRouter = (await import("./game")).gameRouter;
  getDb = (await import("../queries/connection")).getDb;
  getSqliteClient = (await import("../queries/connection")).getSqliteClient;
  schema = await import("../../db/schema");
  settingsLib = await import("../lib/settings");
  boosts = await import("../lib/boosts");
  money = await import("../lib/money");
  reconcile = await import("../lib/reconcile");
  passwordLib = await import("../lib/password");

  const db = getDb();
  const [admin] = await db
    .insert(schema.users)
    .values({
      unionId: "test:step4:admin",
      name: "Step4 Admin",
      email: "s4-admin@test.local",
      role: "admin",
      passwordHash: passwordLib.hashPassword("S4Admin2026!"),
    })
    .returning();
  adminCaller = callerFor(adminRouter, admin);
  // Deposits require a configured Binance PayID (fake fixture value).
  settingsLib.setSetting("binance_pay_id", "556677889", null);
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function enableBoost(pct = 5, min = "10", wagering = 1) {
  settingsLib.setSetting("deposit_boost_enabled", true, null);
  settingsLib.setSetting("deposit_boost_pct", pct, null);
  settingsLib.setSetting("deposit_boost_min_amount", min, null);
  settingsLib.setSetting("deposit_boost_wagering", wagering, null);
  settingsLib.setSetting("deposit_boost_currency", "USDT", null);
}

async function depositAndApprove(user: any, amount: string) {
  const bal = callerFor(balanceRouter, user);
  const dep = await bal.deposit({
    currency: "USDT",
    amount,
    reference: `S4${Math.random().toString(36).slice(2, 10).toUpperCase()}`,
  });
  await adminCaller.approveDeposit({ txId: dep.txId });
  return dep.txId;
}

describe("boost math", () => {
  it("100 at 5% grants exactly 5; at 3% exactly 3", () => {
    expect(money.fmtMoney(boosts.computeBoostMicro(money.parseMoney("100"), 5))).toBe("5");
    expect(money.fmtMoney(boosts.computeBoostMicro(money.parseMoney("100"), 3))).toBe("3");
  });
  it("fractional amounts round to the nearest micro", () => {
    // 33.33 * 3% = 0.9999 exactly
    expect(money.fmtMoney(boosts.computeBoostMicro(money.parseMoney("33.33"), 3))).toBe("0.9999");
  });
  it("zero or negative pct grants nothing", () => {
    expect(boosts.computeBoostMicro(money.parseMoney("100"), 0)).toBe(0n);
  });
});

describe("spin planner", () => {
  const grant = (over: any = {}) => ({
    id: 1,
    amount: "5",
    remaining: "5",
    wageringMultiplier: 1,
    wagered: "0",
    expiresAt: null,
    ...over,
  });

  it("funds the bet from bonus first and accrues wagering", () => {
    const plan = boosts.planSpinBonus({
      grants: [grant()],
      betMicro: money.parseMoney("1"),
      bonusMicro: money.parseMoney("5"),
      nowSec: 1_700_000_000,
    });
    expect(money.fmtMoney(plan.bonusPart)).toBe("1");
    expect(money.fmtMoney(plan.cashPart)).toBe("0");
    expect(plan.conversion).toBeNull();
    const upd = plan.grantUpdates.find((u: any) => u.id === 1);
    expect(upd.remaining).toBe("4");
    expect(upd.wagered).toBe("1");
    expect(upd.status).toBe("active");
  });

  it("splits funding when the bet exceeds the bonus", () => {
    const plan = boosts.planSpinBonus({
      grants: [grant({ remaining: "0.5" })],
      betMicro: money.parseMoney("2"),
      bonusMicro: money.parseMoney("0.5"),
      nowSec: 1_700_000_000,
    });
    expect(money.fmtMoney(plan.bonusPart)).toBe("0.5");
    expect(money.fmtMoney(plan.cashPart)).toBe("1.5");
  });

  it("completing wagering converts the remainder", () => {
    // multiplier 0: the first bet completes the grant, so whatever
    // bonus the bet itself did not consume converts to cash.
    const plan = boosts.planSpinBonus({
      grants: [grant({ wageringMultiplier: 0 })],
      betMicro: money.parseMoney("0.25"),
      bonusMicro: money.parseMoney("5"),
      nowSec: 1_700_000_000,
    });
    expect(plan.conversion).not.toBeNull();
    expect(money.fmtMoney(plan.conversion.amountMicro)).toBe("4.75");
    expect(money.fmtMoney(plan.finalBonusMicro)).toBe("0");
    const upd = plan.grantUpdates.find((u: any) => u.id === 1);
    expect(upd.status).toBe("completed");
    expect(upd.remaining).toBe("0");
  });

  it("expired grants forfeit their remainder before funding", () => {
    const plan = boosts.planSpinBonus({
      grants: [grant({ remaining: "3", expiresAt: 100 })],
      betMicro: money.parseMoney("1"),
      bonusMicro: money.parseMoney("3"),
      nowSec: 200,
    });
    expect(plan.expiryLegs).toHaveLength(1);
    expect(money.fmtMoney(plan.expiryLegs[0].amountMicro)).toBe("-3");
    expect(money.fmtMoney(plan.bonusPart)).toBe("0");
    expect(money.fmtMoney(plan.finalBonusMicro)).toBe("0");
  });
});

describe("deposit -> boost -> wager integration", () => {
  it("grants 5% on a 100 USDT deposit and tracks the bucket", async () => {
    enableBoost();
    const user = await makeUser();
    await depositAndApprove(user, "100");
    const bal = balRow(user.id, "USDT");
    expect(bal.available).toBe("100");
    expect(bal.bonus).toBe("5");
    const grants = grantsOf(user.id);
    expect(grants).toHaveLength(1);
    expect(grants[0].kind).toBe("deposit_boost");
    expect(grants[0].amount).toBe("5");
    expect(grants[0].remaining).toBe("5");
    expect(grants[0].wagering_multiplier).toBe(1);
    expect(grants[0].status).toBe("active");
  });

  it("grants nothing when the boost is disabled or below the minimum", async () => {
    settingsLib.setSetting("deposit_boost_enabled", false, null);
    const u1 = await makeUser();
    await depositAndApprove(u1, "100");
    expect(balRow(u1.id, "USDT").bonus).toBe("0");
    expect(grantsOf(u1.id)).toHaveLength(0);

    enableBoost(5, "10");
    const u2 = await makeUser();
    await depositAndApprove(u2, "5");
    expect(balRow(u2.id, "USDT").bonus).toBe("0");
    expect(grantsOf(u2.id)).toHaveLength(0);
  });

  it("bonus funds spins first; wagering completes the grant; recon stays clean", async () => {
    enableBoost();
    const user = await makeUser();
    await depositAndApprove(user, "100");
    const sessionId = await makeSession(user.id);
    const caller = callerFor(gameRouter, user);
    // Spin until five PAID spins have settled. A random seed can
    // trigger free spins mid-sequence; free spins neither fund from
    // bonus nor count toward wagering, so counting calls instead of
    // paid spins made this test seed-dependent (flake class F6).
    let totalWin = 0;
    let paidSpins = 0;
    for (let guard = 0; paidSpins < 5 && guard < 40; guard++) {
      const r = await caller.spin({ sessionId, betAmount: "1", currency: "USDT" });
      totalWin += parseFloat(r.winAmount);
      if (!r.isFreeSpin) paidSpins++;
    }
    expect(paidSpins).toBe(5);
    const bal = balRow(user.id, "USDT");
    // All five 1-USDT bets were bonus-funded: cash only moved by wins.
    expect(parseFloat(bal.available)).toBeCloseTo(100 + totalWin, 8);
    expect(bal.bonus).toBe("0");
    const grants = grantsOf(user.id);
    expect(grants[0].status).toBe("completed");
    expect(grants[0].wagered).toBe("5");
    const findings = reconcile
      .computeReconFindings()
      .findings.filter((f: any) => f.userId === user.id);
    expect(findings).toEqual([]);
  });

  it("a bet larger than cash+bonus is refused; a bonus-only bet works", async () => {
    enableBoost();
    const user = await makeUser();
    await depositAndApprove(user, "100");
    // Drain the cash via a direct fixture adjustment: set available 0
    // through the ledger-consistent path is overkill — instead use a
    // fresh user whose only funds are a granted bonus.
    const u2 = await makeUser();
    const client = getSqliteClient();
    client
      .prepare("INSERT INTO balances (user_id, currency, available, locked, bonus) VALUES (?, 'USDT', '0', '0', '0.5')")
      .run(u2.id);
    client
      .prepare(
        "INSERT INTO bonus_ledger (user_id, kind, currency, amount, remaining, wagering_multiplier, wagered, status) VALUES (?, 'deposit_boost', 'USDT', '0.5', '0.5', 1, '0', 'active')",
      )
      .run(u2.id);
    client
      .prepare(
        "INSERT INTO ledger_entries (user_id, kind, currency, amount, balance_after, bucket) VALUES (?, 'bonus_credit', 'USDT', '0.5', '0.5', 'bonus')",
      )
      .run(u2.id);
    const sessionId = await makeSession(u2.id);
    const caller = callerFor(gameRouter, u2);
    await expect(
      caller.spin({ sessionId, betAmount: "1", currency: "USDT" }),
    ).rejects.toThrow(/Insufficient balance/);
    const r = await caller.spin({ sessionId, betAmount: "0.5", currency: "USDT" });
    const bal = balRow(u2.id, "USDT");
    expect(bal.bonus).toBe("0");
    expect(parseFloat(bal.available)).toBeCloseTo(parseFloat(r.winAmount), 8);
    void user;
  });
});

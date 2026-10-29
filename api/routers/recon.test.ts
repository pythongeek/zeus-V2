import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import crypto from "crypto";

/**
 * Section G tests: ledger completeness for money movements,
 * reconciliation (clean -> tampered -> detected -> auto-resolved),
 * alert inbox lifecycle, big-withdrawal alerts, risk signals.
 */

const tmpDir = fs.mkdtempSync(path.join("/tmp", "zeus-g-test-"));
const dbPath = path.join(tmpDir, "test.sqlite");
process.env.ZEUS_DB_PATH = dbPath;

let adminRouter: any;
let balanceRouter: any;
let gameRouter: any;
let engine: any;
let passwordLib: any;
let getDb: any;
let getSqliteClient: any;
let schema: any;
let settingsLib: any;

function callerFor(router: any, user: any) {
  return router.createCaller({
    user,
    req: new Request("http://localhost/api/trpc"),
    resHeaders: new Headers(),
  });
}

async function makeUser(role = "user") {
  const db = getDb();
  const suffix = Math.random().toString(36).slice(2);
  const [user] = await db
    .insert(schema.users)
    .values({
      unionId: `test:g:${suffix}`,
      name: "G User",
      email: `g-${suffix}@test.local`,
      phone: `+880174${Math.floor(1000000 + Math.random() * 8999999)}`,
      role,
      kycStatus: "verified",
      passwordHash: passwordLib.hashPassword("GPw2026!"),
    })
    .returning();
  return user;
}

async function creditViaDeposit(admin: any, user: any, amount: string) {
  const bal = callerFor(balanceRouter, user);
  const dep = await bal.deposit({
    currency: "USDT",
    amount,
    reference: `REF${Math.random().toString(36).slice(2, 10).toUpperCase()}`,
  });
  await admin.approveDeposit({ txId: dep.txId });
  return dep.txId;
}

let admin: any;
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
  engine = await import("./game");
  passwordLib = await import("../lib/password");
  settingsLib = await import("../lib/settings");
  const conn = await import("../queries/connection");
  getDb = conn.getDb;
  getSqliteClient = conn.getSqliteClient;
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

  settingsLib.setSetting("binance_pay_id", "556677889", null);
  settingsLib.setSetting("binance_pay_name", "Zeus Slots", null);
  admin = await makeUser("super_admin");
  adminCaller = callerFor(adminRouter, admin);
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("G1: ledger completeness + reconciliation", () => {
  it("deposit -> withdraw lock -> reject unlock keeps the chain clean", async () => {
    const user = await makeUser();
    const bal = callerFor(balanceRouter, user);
    await creditViaDeposit(adminCaller, user, "100");

    const legsAfterDeposit = getSqliteClient()
      .prepare("SELECT kind, amount, balance_after FROM ledger_entries WHERE user_id = ? ORDER BY id")
      .all(user.id) as any[];
    expect(legsAfterDeposit).toEqual([
      { kind: "deposit_credit", amount: "100", balance_after: "100" },
    ]);

    const wd = await bal.withdraw({ currency: "USDT", amount: "40", toAddress: "TReconAddress123" });
    let res = await adminCaller.runReconciliation();
    let view = await adminCaller.getReconciliation();
    expect(view.mismatches.filter((m: any) => m.user_id === user.id)).toHaveLength(0);

    await adminCaller.rejectWithdraw({ txId: wd.txId, reason: "test reject" });
    const kinds = getSqliteClient()
      .prepare("SELECT kind FROM ledger_entries WHERE user_id = ? ORDER BY id")
      .all(user.id) as any[];
    expect(kinds.map((k) => k.kind)).toEqual([
      "deposit_credit",
      "withdrawal_lock",
      "withdrawal_unlock",
    ]);
    res = await adminCaller.runReconciliation();
    view = await adminCaller.getReconciliation();
    expect(view.mismatches.filter((m: any) => m.user_id === user.id)).toHaveLength(0);
    expect(res.accountsChecked).toBeGreaterThan(0);
  });

  it("tampered balance is detected, alerted, and auto-resolves when fixed", async () => {
    const user = await makeUser();
    await creditViaDeposit(adminCaller, user, "50");
    await adminCaller.runReconciliation();
    let view = await adminCaller.getReconciliation();
    expect(view.mismatches.filter((m: any) => m.user_id === user.id)).toHaveLength(0);

    getSqliteClient()
      .prepare("UPDATE balances SET available = '55' WHERE user_id = ? AND currency = 'USDT'")
      .run(user.id);
    await adminCaller.runReconciliation();
    view = await adminCaller.getReconciliation();
    const mine = view.mismatches.filter((m: any) => m.user_id === user.id);
    expect(mine).toHaveLength(1);
    expect(mine[0].kind).toBe("tail_mismatch");
    expect(mine[0].expected).toBe("50");
    expect(mine[0].actual).toBe("55");

    const alerts = await adminCaller.getAlerts({ status: "open", limit: 50 });
    const alert = alerts.alerts.find((a: any) => a.kind === "ledger_mismatch" && a.ref_user_id === user.id);
    expect(alert).toBeTruthy();

    // Fix the tamper; the next run auto-resolves the mismatch.
    getSqliteClient()
      .prepare("UPDATE balances SET available = '50' WHERE user_id = ? AND currency = 'USDT'")
      .run(user.id);
    await adminCaller.runReconciliation();
    view = await adminCaller.getReconciliation();
    expect(view.mismatches.filter((m: any) => m.user_id === user.id)).toHaveLength(0);

    // Alert lifecycle: ack then resolve.
    await adminCaller.ackAlert({ alertId: alert.id });
    await adminCaller.resolveAlert({ alertId: alert.id });
    const after = await adminCaller.getAlerts({ status: "open", limit: 50 });
    expect(after.alerts.find((a: any) => a.id === alert.id)).toBeUndefined();
  });

  it("legacy balance with no ledger is reported as no_ledger", async () => {
    const user = await makeUser();
    const db = getDb();
    await db.insert(schema.balances).values({
      userId: user.id,
      currency: "BTC",
      available: "1",
      locked: "0",
    });
    await adminCaller.runReconciliation();
    const view = await adminCaller.getReconciliation();
    const mine = view.mismatches.filter((m: any) => m.user_id === user.id);
    expect(mine).toHaveLength(1);
    expect(mine[0].kind).toBe("no_ledger");
  });
});

describe("G2/G3: alerts + risk signals", () => {
  it("big withdrawal alert fires at the configured threshold", async () => {
    settingsLib.setSetting("alert_big_withdrawal_usdt", 50, null);
    const user = await makeUser();
    const bal = callerFor(balanceRouter, user);
    await creditViaDeposit(adminCaller, user, "100");
    await bal.withdraw({ currency: "USDT", amount: "60", toAddress: "TBigWithdrawAddr1" });
    const alerts = await adminCaller.getAlerts({ status: "open", limit: 50 });
    const mine = alerts.alerts.filter((a: any) => a.kind === "big_withdrawal" && a.ref_user_id === user.id);
    expect(mine).toHaveLength(1);
    settingsLib.setSetting("alert_big_withdrawal_usdt", 1000, null);
  });

  it("shared payout address + deposit-without-play signals surface", async () => {
    const u1 = await makeUser();
    const u2 = await makeUser();
    await creditViaDeposit(adminCaller, u1, "200");
    await creditViaDeposit(adminCaller, u2, "200");
    const shared = "TSharedPayoutAddress99";
    const b1 = callerFor(balanceRouter, u1);
    const b2 = callerFor(balanceRouter, u2);
    const w1 = await b1.withdraw({ currency: "USDT", amount: "150", toAddress: shared });
    await b2.withdraw({ currency: "USDT", amount: "10", toAddress: shared });
    // u1 cashes out 150 of 200 with zero play -> deposit-no-play after
    // approval executes. 150 > the $100 dual-approval threshold, so
    // two different admins approve in sequence.
    const secondAdmin = callerFor(adminRouter, await makeUser("admin"));
    const stage1 = await adminCaller.approveWithdraw({ txId: w1.txId });
    expect(stage1.stage).toBe("awaiting-second");
    const stage2 = await secondAdmin.approveWithdraw({ txId: w1.txId });
    expect(stage2.stage).toBe("executed");

    const signals = await adminCaller.getRiskSignals();
    const addr = signals.sharedAddresses.find((a: any) => a.address === shared);
    expect(addr).toBeTruthy();
    expect(addr.userCount).toBe(2);
    const dnp = signals.depositNoPlay.find((d: any) => d.userId === u1.id);
    expect(dnp).toBeTruthy();
    expect(dnp.depositsUsdt).toBe(200);
    expect(dnp.withdrawalsUsdt).toBe(150);
  });

  it("big-win alert fires inside the spin when the win clears the threshold", async () => {
    settingsLib.setSetting("alert_big_win_usdt", 1, null);
    // Hunt a seed whose nonce-1 win is >= 10x (win >= $10 at $1 bet).
    let seed: string | null = null;
    for (let i = 0; i < 5000 && !seed; i++) {
      const candidate = `g-win-hunt-${i}`;
      const { symbols, hash } = engine.calculateSpin(candidate, "gclient", 1);
      if (engine.checkJackpot(hash)) continue;
      const res = engine.evaluatePaylines(symbols.map((c: number[]) => [...c]), 1);
      if (res.totalPayout >= 200) seed = candidate;
    }
    expect(seed).toBeTruthy();
    const db = getDb();
    const [user] = await db
      .insert(schema.users)
      .values({ unionId: `test:gwin:${Math.random().toString(36).slice(2)}`, name: "G Win" })
      .returning();
    await db.insert(schema.balances).values({
      userId: user.id, currency: "USDT", available: "100", locked: "0",
    });
    const [session] = await db
      .insert(schema.gameSessions)
      .values({
        userId: user.id,
        serverSeed: seed!,
        serverSeedHash: crypto.createHash("sha256").update(seed!).digest("hex"),
        clientSeed: "gclient",
        nonce: 0,
        status: "active",
      })
      .returning();
    const caller = callerFor(gameRouter, user);
    const r = await caller.spin({ sessionId: session.id, betAmount: "1", currency: "USDT" });
    expect(parseFloat(r.winAmount)).toBeGreaterThanOrEqual(10);
    const alerts = await adminCaller.getAlerts({ status: "open", limit: 50 });
    const mine = alerts.alerts.filter((a: any) => a.kind === "big_win" && a.ref_user_id === user.id);
    expect(mine).toHaveLength(1);
    settingsLib.setSetting("alert_big_win_usdt", 500, null);
  });

  it("failed-login bursts are derived from the audit log", async () => {
    const client = getSqliteClient();
    const now = Math.floor(Date.now() / 1000);
    const ins = client.prepare(
      "INSERT INTO audit_log (user_id, action, details, created_at) VALUES (NULL, 'auth.loginFailed', ?, ?)",
    );
    for (let i = 0; i < 9; i++) {
      ins.run(JSON.stringify({ identifier: "burst@test.local" }), now - i * 60);
    }
    const signals = await adminCaller.getRiskSignals();
    const burst = signals.failedLoginBursts.find((b: any) => b.identifier === "burst@test.local");
    expect(burst).toBeTruthy();
    expect(burst.failures).toBe(9);
  });
});

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";

/**
 * D3+D4 tests: withdrawal centre + policy controls.
 * dual approval (different admins), 2FA re-confirm for large
 * payouts, auto-hold + release, mark-paid, daily cap, snapshot.
 */

const tmpDir = fs.mkdtempSync(path.join("/tmp", "zeus-wops-test-"));
const dbPath = path.join(tmpDir, "test.sqlite");
process.env.ZEUS_DB_PATH = dbPath;

let balanceRouter: any;
let adminRouter: any;
let settings: any;
let totp: any;
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
  const [user] = await db
    .insert(schema.users)
    .values({
      unionId: `test:wops:${Math.random().toString(36).slice(2)}`,
      name: "W Player",
      email: `wops-${Math.random().toString(36).slice(2)}@test.local`,
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

function balanceOf(userId: number) {
  return getSqliteClient()
    .prepare("SELECT available, locked, total_withdrawn FROM balances WHERE user_id = ? AND currency = 'USDT'")
    .get(userId) as any;
}

function txRow(txId: number) {
  return getSqliteClient()
    .prepare("SELECT * FROM transactions WHERE id = ?")
    .get(txId) as any;
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

  ({ balanceRouter } = await import("./balance"));
  ({ adminRouter } = await import("./admin"));
  settings = await import("../lib/settings");
  totp = await import("../lib/totp");
  ({ getDb, getSqliteClient } = await import("../queries/connection"));
  schema = await import("../../db/schema");
  settings.setSetting("binance_pay_id", "556677889");
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("D4: dual approval", () => {
  it("parks above-threshold withdrawals for a different second admin", async () => {
    const player = await makeUser("user", "500");
    const adminA = await makeUser("admin");
    const adminB = await makeUser("super_admin");
    const p = callerFor(balanceRouter, player);
    const aA = callerFor(adminRouter, adminA);
    const aB = callerFor(adminRouter, adminB);

    const w = await p.withdraw({ currency: "USDT", amount: "150", toAddress: "payid-user-001" });
    const first = await aA.approveWithdraw({ txId: w.txId });
    expect(first.stage).toBe("awaiting-second");
    let row = txRow(w.txId);
    expect(row.status).toBe("confirming");
    expect(row.approved_by).toBe(adminA.id);
    // Money has NOT moved yet.
    let bal = balanceOf(player.id);
    expect(bal.locked).toBe("150");
    expect(bal.total_withdrawn).toBe("0");

    // Same admin cannot give the second approval.
    await expect(aA.approveWithdraw({ txId: w.txId })).rejects.toThrow("different admin");

    const second = await aB.approveWithdraw({ txId: w.txId });
    expect(second.stage).toBe("executed");
    row = txRow(w.txId);
    expect(row.status).toBe("confirmed");
    bal = balanceOf(player.id);
    expect(bal.locked).toBe("0");
    expect(bal.total_withdrawn).toBe("150");
  });

  it("a confirming withdrawal can still be rejected, refunding the lock", async () => {
    const player = await makeUser("user", "300");
    const adminA = await makeUser("admin");
    const adminB = await makeUser("admin");
    const p = callerFor(balanceRouter, player);
    const w = await p.withdraw({ currency: "USDT", amount: "200", toAddress: "payid-user-002" });
    await callerFor(adminRouter, adminA).approveWithdraw({ txId: w.txId });
    await callerFor(adminRouter, adminB).rejectWithdraw({ txId: w.txId, reason: "Failed verification" });
    expect(txRow(w.txId).status).toBe("cancelled");
    const bal = balanceOf(player.id);
    expect(bal.available).toBe("300");
    expect(bal.locked).toBe("0");
  });

  it("below the threshold a single approval executes", async () => {
    const player = await makeUser("user", "100");
    const admin = await makeUser("admin");
    const w = await callerFor(balanceRouter, player).withdraw({
      currency: "USDT", amount: "50", toAddress: "payid-user-003",
    });
    const res = await callerFor(adminRouter, admin).approveWithdraw({ txId: w.txId });
    expect(res.stage).toBe("executed");
    expect(txRow(w.txId).status).toBe("confirmed");
  });
});

describe("D4: 2FA re-confirmation for large payouts", () => {
  it("requires a fresh code from the executing approver above $1,000", async () => {
    const player = await makeUser("user", "3000");
    const adminA = await makeUser("admin");
    const adminB = await makeUser("super_admin");
    // Enroll adminB directly (secret generated + encrypted in the DB).
    const secret = totp.generateTotpSecret();
    getSqliteClient()
      .prepare("UPDATE users SET totp_secret = ?, totp_enabled = 1 WHERE id = ?")
      .run(totp.encryptSecret(secret), adminB.id);

    const w = await callerFor(balanceRouter, player).withdraw({
      currency: "USDT", amount: "1500", toAddress: "payid-user-004",
    });
    const aB = callerFor(adminRouter, adminB);
    // First approval (dual stage) needs no code.
    await callerFor(adminRouter, adminA).approveWithdraw({ txId: w.txId });
    // Second approval without a code is refused.
    await expect(aB.approveWithdraw({ txId: w.txId })).rejects.toThrow("two-factor code is required");
    // Wrong code refused.
    const goodCode = totp.totp(secret);
    const badCode = goodCode === "000000" ? "111111" : "000000";
    await expect(aB.approveWithdraw({ txId: w.txId, totpCode: badCode })).rejects.toThrow("Invalid two-factor code");
    // Correct code executes.
    const res = await aB.approveWithdraw({ txId: w.txId, totpCode: goodCode });
    expect(res.stage).toBe("executed");
    expect(balanceOf(player.id).total_withdrawn).toBe("1500");
  });
});

describe("D4: auto-hold and release", () => {
  it("holds withdrawals dwarfing lifetime deposits until released", async () => {
    settings.setSetting("withdrawal_autohold_factor", 1);
    const player = await makeUser("user", "0");
    const admin = await makeUser("admin");
    const p = callerFor(balanceRouter, player);
    const a = callerFor(adminRouter, admin);
    // Lifetime deposits: 50 confirmed.
    const dep = await p.deposit({ currency: "USDT", amount: "50", reference: "HOLD-DEP-1" });
    await a.approveDeposit({ txId: dep.txId });
    // Lifetime deposits now 80, balance 80: withdrawing 80 does NOT
    // exceed 1x deposits, so no hold is placed.
    const dep2 = await p.deposit({ currency: "USDT", amount: "30", reference: "HOLD-DEP-2" });
    await a.approveDeposit({ txId: dep2.txId });
    const w = await p.withdraw({ currency: "USDT", amount: "80", toAddress: "payid-user-005" });
    expect(txRow(w.txId).hold_reason).toBeNull();

    const whale = await makeUser("user", "500");
    // Whale has balance but ZERO lifetime deposits -> any withdrawal auto-holds.
    const w2 = await callerFor(balanceRouter, whale).withdraw({
      currency: "USDT", amount: "100", toAddress: "payid-user-006",
    });
    const held = txRow(w2.txId);
    expect(held.hold_reason).toContain("Auto-hold");
    await expect(a.approveWithdraw({ txId: w2.txId })).rejects.toThrow("on hold");
    await a.releaseHold({ txId: w2.txId });
    expect(txRow(w2.txId).hold_reason).toBeNull();
    const res = await a.approveWithdraw({ txId: w2.txId });
    expect(res.stage).toBe("executed");
    settings.setSetting("withdrawal_autohold_factor", 0);
  });

  it("daily withdrawal cap blocks creation over the cap", async () => {
    settings.setSetting("withdrawal_daily_cap_usdt", 100);
    const player = await makeUser("user", "500");
    const p = callerFor(balanceRouter, player);
    await p.withdraw({ currency: "USDT", amount: "60", toAddress: "payid-user-007" });
    await expect(
      p.withdraw({ currency: "USDT", amount: "50", toAddress: "payid-user-007" }),
    ).rejects.toThrow("Daily withdrawal limit reached");
    settings.setSetting("withdrawal_daily_cap_usdt", 0);
  });
});

describe("D3: mark paid + snapshot", () => {
  it("records the payout reference exactly once", async () => {
    const player = await makeUser("user", "100");
    const admin = await makeUser("admin");
    const a = callerFor(adminRouter, admin);
    const w = await callerFor(balanceRouter, player).withdraw({
      currency: "USDT", amount: "25", toAddress: "payid-user-008",
    });
    await expect(a.markWithdrawalPaid({ txId: w.txId, payoutRef: "BP-123" })).rejects.toThrow("approved");
    await a.approveWithdraw({ txId: w.txId });
    await a.markWithdrawalPaid({ txId: w.txId, payoutRef: "BP-999-XYZ" });
    const row = txRow(w.txId);
    expect(row.payout_ref).toBe("BP-999-XYZ");
    expect(row.paid_at).toBeGreaterThan(0);
    await expect(a.markWithdrawalPaid({ txId: w.txId, payoutRef: "BP-1000" })).rejects.toThrow("already");
  });

  it("money summary reports lifetime totals and pending count", async () => {
    const player = await makeUser("user", "0");
    const admin = await makeUser("admin");
    const p = callerFor(balanceRouter, player);
    const a = callerFor(adminRouter, admin);
    const dep = await p.deposit({ currency: "USDT", amount: "70", reference: "SUM-DEP-1" });
    await a.approveDeposit({ txId: dep.txId });
    await p.withdraw({ currency: "USDT", amount: "20", toAddress: "payid-user-009" });
    const summary = await a.getPlayerMoneySummary({ userId: player.id });
    expect(summary.depositedUsdt).toBe(70);
    expect(summary.withdrawnUsdt).toBe(0);
    expect(summary.pendingCount).toBe(1);
    const usdt = summary.balances.find((b: any) => b.currency === "USDT");
    expect(usdt.available).toBe("50");
    expect(usdt.locked).toBe("20");
  });
});

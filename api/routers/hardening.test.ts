import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";

/**
 * Step 17 — hardening: jurisdiction gate (sanctioned only),
 * KYC withdrawal gate, RG weekly/monthly caps + 24h cooling-off
 * on raises, and spin idempotency.
 */

const tmpDir = fs.mkdtempSync(path.join("/tmp", "zeus-hard-test-"));
const dbPath = path.join(tmpDir, "test.sqlite");
process.env.ZEUS_DB_PATH = dbPath;

let authLocalRouter: any;
let balanceRouter: any;
let gameRouter: any;
let limitsLib: any;
let getDb: any;
let getSqliteClient: any;
let schema: any;
let settingsLib: any;
let passwordLib: any;

function callerFor(router: any, user?: any) {
  return router.createCaller({
    user,
    req: new Request("http://localhost/api/trpc", {
      headers: { "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126 Safari/537.36" },
    }),
    resHeaders: new Headers(),
  });
}

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

  authLocalRouter = (await import("../auth-local")).authLocalRouter;
  balanceRouter = (await import("./balance")).balanceRouter;
  gameRouter = (await import("./game")).gameRouter;
  limitsLib = await import("../lib/limits");
  getDb = (await import("../queries/connection")).getDb;
  getSqliteClient = (await import("../queries/connection")).getSqliteClient;
  schema = await import("../../db/schema");
  settingsLib = await import("../lib/settings");
  passwordLib = await import("../lib/password");
  settingsLib.setSetting("binance_pay_id", "556677889", null);
  for (const [tier, seed] of [["mini", "0.01"], ["major", "0.1"], ["mega", "1.0"]] as const) {
    getSqliteClient()
      .prepare("INSERT INTO jackpot_pool (tier, seed_amount, current_amount, contribution_rate) VALUES (?, ?, ?, '0.001')")
      .run(tier, seed, seed);
  }
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("jurisdiction gate", () => {
  it("blocks sanctioned registration, allows BD and others, blocks login after the fact", async () => {
    const pub = callerFor(authLocalRouter);
    await expect(
      pub.register({ name: "Cuban", email: "cu@test.local", password: "Str0ng!Pass", ageConfirmed: true, country: "CU" }),
    ).rejects.toThrow(/not available in your jurisdiction/);
    const ok = await pub.register({
      name: "Bangladeshi", email: "bd@test.local", password: "Str0ng!Pass", ageConfirmed: true, country: "BD",
    });
    expect(ok.user).toBeTruthy();
    // A US user registers fine (worldwide launch), then their
    // declared country is moved to a sanctioned one -> login stops.
    await pub.register({ name: "States", email: "us@test.local", password: "Str0ng!Pass", ageConfirmed: true, country: "US" });
    getSqliteClient().prepare("UPDATE users SET country = 'IR' WHERE email = 'us@test.local'").run();
    await expect(
      pub.login({ identifier: "us@test.local", password: "Str0ng!Pass" }),
    ).rejects.toThrow(/not available in your jurisdiction/);
  });
});

describe("RG period caps + cooling-off", () => {
  it("weekly cap enforces; raises wait 24h while tightenings apply instantly", async () => {
    const db = getDb();
    const [u] = await db
      .insert(schema.users)
      .values({ unionId: "test:hard:rg", name: "RG", email: "rg@test.local", passwordHash: passwordLib.hashPassword("RgPw2026!") })
      .returning();
    const bal = callerFor(balanceRouter, u);
    await bal.updateLimits({ depositLimitWeekly: "50" });
    let limits = limitsLib.getLimits(u.id);
    expect(limits.depositLimitWeekly).toBe("50");
    // A deposit of 40 lands (pending counts toward the cap).
    await bal.deposit({ currency: "USDT", amount: "40", reference: "RGREF0001" });
    // Another 20 would exceed the weekly 50.
    await expect(bal.deposit({ currency: "USDT", amount: "20", reference: "RGREF0002" })).rejects.toThrow(/Weekly deposit limit/);
    // Tighten instantly.
    await bal.updateLimits({ depositLimitWeekly: "45" });
    limits = limitsLib.getLimits(u.id);
    expect(limits.depositLimitWeekly).toBe("45");
    expect(limits.pendingDepositLimits).toBeNull();
    // Raise: goes pending, old cap still enforced.
    await bal.updateLimits({ depositLimitWeekly: "500" });
    limits = limitsLib.getLimits(u.id);
    expect(limits.depositLimitWeekly).toBe("45");
    expect(limits.pendingDepositLimits?.weekly).toBe("500");
    await expect(bal.deposit({ currency: "USDT", amount: "20", reference: "RGREF0003" })).rejects.toThrow(/Weekly deposit limit/);
    // Fast-forward the cooling-off: promotion on read.
    getSqliteClient().prepare("UPDATE user_limits SET pending_effective_at = ? WHERE user_id = ?")
      .run(Math.floor(Date.now() / 1000) - 10, u.id);
    limits = limitsLib.getLimits(u.id);
    expect(limits.depositLimitWeekly).toBe("500");
    expect(limits.pendingDepositLimits).toBeNull();
    await bal.deposit({ currency: "USDT", amount: "20", reference: "RGREF0004" });
  });
});

describe("KYC withdrawal gate", () => {
  it("blocks cumulative withdrawals over the BDT threshold until verified", async () => {
    const db = getDb();
    const [u] = await db
      .insert(schema.users)
      .values({ unionId: "test:hard:kyc", name: "KYC", email: "kyc@test.local", passwordHash: passwordLib.hashPassword("KycPw2026!") })
      .returning();
    await db.insert(schema.balances).values({ userId: u.id, currency: "USDT", available: "500", locked: "0" });
    // Prior confirmed withdrawal of 50 USDT (= 5,500 BDT).
    getSqliteClient()
      .prepare("INSERT INTO transactions (user_id, type, currency, amount, status, to_address) VALUES (?, 'withdrawal', 'USDT', '50', 'confirmed', 'addr')")
      .run(u.id);
    const bal = callerFor(balanceRouter, u);
    // 50 more USDT -> cumulative 11,000 BDT > 10,000 -> blocked.
    await expect(
      bal.withdraw({ currency: "USDT", amount: "50", toAddress: "TWithdrawAddr123" }),
    ).rejects.toThrow(/KYC verification is required/);
    // Small one stays under: 40 -> 9,900 total OK.
    await bal.withdraw({ currency: "USDT", amount: "40", toAddress: "TWithdrawAddr123" });
    // Verify -> the big one passes the gate now.
    getSqliteClient().prepare("UPDATE users SET kyc_status = 'verified' WHERE id = ?").run(u.id);
    await bal.withdraw({ currency: "USDT", amount: "50", toAddress: "TWithdrawAddr123" });
  });
});

describe("spin idempotency", () => {
  it("a duplicated requestId returns the original spin and moves money once", async () => {
    const db = getDb();
    const [u] = await db
      .insert(schema.users)
      .values({ unionId: "test:hard:idem", name: "Idem", email: "idem@test.local", passwordHash: passwordLib.hashPassword("IdPw2026!") })
      .returning();
    await db.insert(schema.balances).values({ userId: u.id, currency: "USDT", available: "50", locked: "0" });
    const g = callerFor(gameRouter, u);
    const s = await g.startSession({});
    const r1 = await g.spin({ sessionId: s.sessionId, betAmount: "1", currency: "USDT", requestId: "req-idem-0001" });
    const balAfter1 = (getSqliteClient().prepare("SELECT available FROM balances WHERE user_id = ? AND currency = 'USDT'").get(u.id) as any).available;
    const r2 = await g.spin({ sessionId: s.sessionId, betAmount: "1", currency: "USDT", requestId: "req-idem-0001" });
    expect(r2.spinId).toBe(r1.spinId);
    expect(r2.winAmount).toBe(r1.winAmount);
    const balAfter2 = (getSqliteClient().prepare("SELECT available FROM balances WHERE user_id = ? AND currency = 'USDT'").get(u.id) as any).available;
    expect(balAfter2).toBe(balAfter1);
    const spinCount = getSqliteClient().prepare("SELECT COUNT(*) AS c FROM spins WHERE user_id = ?").get(u.id) as any;
    expect(spinCount.c).toBe(1);
    // A different requestId spins normally.
    const r3 = await g.spin({ sessionId: s.sessionId, betAmount: "1", currency: "USDT", requestId: "req-idem-0002" });
    expect(r3.spinId).not.toBe(r1.spinId);
  });
});

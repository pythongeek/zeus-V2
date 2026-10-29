import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import crypto from "crypto";

/**
 * Step 14 — referral: code round-trip, bind rules (24h, once, no
 * self), GGR accrual with activity gate + cap, vesting to cash,
 * stats equal ledger sums.
 */

const tmpDir = fs.mkdtempSync(path.join("/tmp", "zeus-ref-test-"));
const dbPath = path.join(tmpDir, "test.sqlite");
process.env.ZEUS_DB_PATH = dbPath;

let promoRouter: any;
let settlement: any;
let referralLib: any;
let getDb: any;
let getSqliteClient: any;
let schema: any;
let settingsLib: any;

const S = 1_700_000_000;
const E = S + 7 * 86400;
let nonce = 5000;

function insertSpin(userId: number, bet: string, win: string, currency: string, createdAt: number, free = false) {
  nonce += 1;
  getSqliteClient()
    .prepare(
      `INSERT INTO spins (session_id, user_id, nonce, bet_amount, currency, reel_positions, symbols_shown, win_amount, hash, is_free_spin, mode_id, created_at)
       VALUES (999001, ?, ?, ?, ?, '[]', '[]', ?, ?, ?, 'classic', ?)`,
    )
    .run(userId, nonce, bet, currency, win, crypto.createHash("sha256").update(`r${nonce}`).digest("hex"), free ? 1 : 0, createdAt);
}

function callerFor(u: any) {
  return promoRouter.createCaller({
    user: u,
    req: new Request("http://localhost/api/trpc", {
      headers: { "x-forwarded-for": "203.0.113.9", "user-agent": "test-agent" },
    }),
    resHeaders: new Headers(),
  });
}

let referrer: any;
let referee: any;
let lazyReferee: any;
let oldTimer: any;

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

  promoRouter = (await import("./promo")).promoRouter;
  settlement = await import("../lib/settlement");
  referralLib = await import("../lib/referral");
  getDb = (await import("../queries/connection")).getDb;
  getSqliteClient = (await import("../queries/connection")).getSqliteClient;
  schema = await import("../../db/schema");
  settingsLib = await import("../lib/settings");

  const db = getDb();
  const mk = async (tag: string) => {
    const [u] = await db.insert(schema.users).values({ unionId: `test:ref:${tag}`, name: tag }).returning();
    return u;
  };
  referrer = await mk("Referrer");
  referee = await mk("Referee");
  lazyReferee = await mk("Lazy");
  oldTimer = await mk("OldTimer");
  // OldTimer "registered" 3 days ago (createdAt stored as epoch int).
  getSqliteClient().prepare('UPDATE users SET "createdAt" = ? WHERE id = ?').run(Math.floor(Date.now() / 1000) - 3 * 86400, oldTimer.id);

  // Bind both referees at period start (fresh accounts: age ~0).
  getSqliteClient()
    .prepare("INSERT INTO referrals (referrer_id, referee_id, code, bound_at, expires_at) VALUES (?, ?, ?, ?, ?)")
    .run(referrer.id, referee.id, referralLib.encodeReferralCode(referrer.id), S, S + 90 * 86400);
  getSqliteClient()
    .prepare("INSERT INTO referrals (referrer_id, referee_id, code, bound_at, expires_at) VALUES (?, ?, ?, ?, ?)")
    .run(referrer.id, lazyReferee.id, referralLib.encodeReferralCode(referrer.id), S, S + 90 * 86400);

  // Active referee: lifetime wagered 200 USDT (22,000 BDT >= gate).
  // In-window: wagered 200, won 50 -> GGR 150 -> earn 15 USDT.
  insertSpin(referee.id, "200", "50", "USDT", S + 100);
  // Lazy referee: only 5 USDT wagered (550 BDT < 1000 gate) -> nothing.
  insertSpin(lazyReferee.id, "5", "0", "USDT", S + 100);
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("codes", () => {
  it("round-trip and reject tampering", () => {
    for (const id of [1, 7, 42, 123456, 987654321]) {
      expect(referralLib.decodeReferralCode(referralLib.encodeReferralCode(id))).toBe(id);
    }
    const code = referralLib.encodeReferralCode(42);
    const tampered = code.slice(0, 7) + (code[7] === "0" ? "1" : "0");
    expect(referralLib.decodeReferralCode(tampered)).toBeNull();
    expect(code).toHaveLength(8);
  });
});

describe("binding rules", () => {
  it("binds a fresh account, blocks self / second bind / old accounts / bad codes", async () => {
    const [newbie] = await getDb()
      .insert(schema.users)
      .values({ unionId: "test:ref:newbie", name: "Newbie" })
      .returning();
    const c = callerFor(newbie);
    const code = referralLib.encodeReferralCode(referrer.id);
    const r = await c.bindReferral({ code });
    expect(r.bound).toBe(true);
    await expect(c.bindReferral({ code })).rejects.toThrow(/already has a referrer/);
    await expect(callerFor(referrer).bindReferral({ code })).rejects.toThrow(/yourself/);
    await expect(callerFor(oldTimer).bindReferral({ code })).rejects.toThrow(/24 hours/);
    await expect(callerFor(newbie).bindReferral({ code: "ZZZZZZZZ" })).rejects.toThrow(/Invalid/);
    const mine = await callerFor(referrer).getReferral();
    expect(mine.code).toBe(code);
    expect(mine.referees.length).toBe(3);
  });
});

describe("weekly referral settlement", () => {
  it("accrues 10% of GGR past the activity gate and vests >= 50 BDT eq", () => {
    const r = settlement.runReferral(getSqliteClient(), { nowSec: E + 10, periodStart: S, periodEnd: E });
    expect(r.accrued).toBe(1); // only the active referee
    expect(r.vested).toBe(1); // 15 USDT = 1650 BDT eq >= 50
    const bal = getSqliteClient()
      .prepare("SELECT available FROM balances WHERE user_id = ? AND currency = 'USDT'")
      .get(referrer.id) as any;
    expect(parseFloat(bal.available)).toBeCloseTo(15, 8);
    const earn = getSqliteClient().prepare("SELECT * FROM referral_earnings WHERE referee_id = ?").get(referee.id) as any;
    expect(parseFloat(earn.amount)).toBeCloseTo(15, 8);
    expect(parseFloat(earn.ggr)).toBeCloseTo(150, 8);
    // Stats equal ledger sums.
    return callerFor(referrer).getReferral().then((g: any) => {
      expect(parseFloat(g.earned[0].total)).toBeCloseTo(15, 8);
      expect(parseFloat(g.paid[0].total)).toBeCloseTo(15, 8);
      expect(g.pending.length).toBe(0);
    });
  });

  it("re-running the period changes nothing", () => {
    const r = settlement.runReferral(getSqliteClient(), { nowSec: E + 20, periodStart: S, periodEnd: E });
    expect(r.accrued).toBe(0);
    expect(r.vested).toBe(0);
  });

  it("per-referee cap scales the accrual down", () => {
    settingsLib.setSetting("referral_cap_bdt", 2000, null);
    // Referee wagers big in period 2: GGR 1000 USDT = 110,000 BDT;
    // 10% = 100 USDT = 11,000 BDT eq, but only 2000 - 1650 = 350
    // BDT eq of cap remains -> ~3.1818 USDT.
    insertSpin(referee.id, "1000", "0", "USDT", E + 100);
    const r = settlement.runReferral(getSqliteClient(), { nowSec: E + 7 * 86400 + 10, periodStart: E, periodEnd: E + 7 * 86400 });
    expect(r.accrued).toBe(1);
    const rows = getSqliteClient()
      .prepare("SELECT amount FROM referral_earnings WHERE referee_id = ? ORDER BY period_start")
      .all(referee.id) as Array<{ amount: string }>;
    expect(rows.length).toBe(2);
    expect(parseFloat(rows[1].amount)).toBeCloseTo(350 / 110, 3);
  });
});

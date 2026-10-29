import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import crypto from "crypto";

/**
 * Step 13 — VIP tiers + level-up grants (once), weekly rakeback
 * (tier% of theoretical loss, idempotent), lucky wheel (weekly
 * entitlement, server draw, token prizes seed sessions).
 */

const tmpDir = fs.mkdtempSync(path.join("/tmp", "zeus-vip-test-"));
const dbPath = path.join(tmpDir, "test.sqlite");
process.env.ZEUS_DB_PATH = dbPath;

let promoRouter: any;
let gameRouter: any;
let settlement: any;
let vipLib: any;
let getDb: any;
let getSqliteClient: any;
let schema: any;
let settingsLib: any;

const S = 1_700_000_000;
const E = S + 7 * 86400;
let nonce = 1000;

function insertPaidSpin(userId: number, bet: string, currency: string, createdAt: number, win = "0") {
  nonce += 1;
  getSqliteClient()
    .prepare(
      `INSERT INTO spins (session_id, user_id, nonce, bet_amount, currency, reel_positions, symbols_shown, win_amount, hash, is_free_spin, mode_id, created_at)
       VALUES (999001, ?, ?, ?, ?, '[]', '[]', ?, ?, 0, 'classic', ?)`,
    )
    .run(userId, nonce, bet, currency, win, crypto.createHash("sha256").update(`v${nonce}`).digest("hex"), createdAt);
}

function callerFor(u: any, router: any) {
  return router.createCaller({
    user: u,
    req: new Request("http://localhost/api/trpc"),
    resHeaders: new Headers(),
  });
}

let whale: any;
let casual: any;

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
  gameRouter = (await import("./game")).gameRouter;
  settlement = await import("../lib/settlement");
  vipLib = await import("../lib/vip");
  getDb = (await import("../queries/connection")).getDb;
  getSqliteClient = (await import("../queries/connection")).getSqliteClient;
  schema = await import("../../db/schema");
  settingsLib = await import("../lib/settings");
  // Match production's declared RTP so rakeback math is exact.
  settingsLib.setSetting("rtp_declared", 95.95, null);

  const db = getDb();
  const mk = async (tag: string) => {
    const [u] = await db.insert(schema.users).values({ unionId: `test:vip:${tag}`, name: tag }).returning();
    return u;
  };
  whale = await mk("Whale");
  casual = await mk("Casual");
  // Whale: 60,000 BDT lifetime turnover (Silver), all inside period.
  insertPaidSpin(whale.id, "60000", "BDT", S + 100);
  // Casual: 100 USDT inside period (11,000 BDT lifetime — Bronze).
  insertPaidSpin(casual.id, "100", "USDT", S + 100);
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("VIP tiers + level-up", () => {
  it("turnover sets the tier; level-up bonus + wheel entitlement grant exactly once", async () => {
    const c = callerFor(whale, promoRouter);
    const s1 = await c.getVipStatus();
    expect(s1.tier.id).toBe("silver");
    expect(s1.justGranted).toEqual([{ tierId: "silver", amountBdt: 50 }]);
    const grant = getSqliteClient()
      .prepare("SELECT * FROM bonus_ledger WHERE user_id = ? AND kind = 'vip_levelup'")
      .get(whale.id) as any;
    expect(parseFloat(grant.amount)).toBeCloseTo(50, 8);
    expect(grant.wagering_multiplier).toBe(1);
    const s2 = await c.getVipStatus();
    expect(s2.justGranted).toEqual([]);
    const wheel = await c.getWheel();
    // weekly entitlement + the level-up entitlement
    expect(wheel.availableSpins).toBe(2);
  });

  it("bronze casual gets no level-up (bronze bonus is 0)", async () => {
    const s = await callerFor(casual, promoRouter).getVipStatus();
    expect(s.tier.id).toBe("bronze");
    expect(s.justGranted).toEqual([]);
  });
});

describe("weekly rakeback", () => {
  it("pays tier% of theoretical loss, once", () => {
    const r = settlement.runRakeback(getSqliteClient(), { nowSec: E + 10, periodStart: S, periodEnd: E });
    const casualGrant = r.grants.find((g: any) => g.userId === casual.id);
    // 100 USDT wagered x (1 - 0.9595) x 5% = 0.2025 USDT
    expect(casualGrant.amountMicro).toBe("20250000");
    const whaleGrant = r.grants.find((g: any) => g.userId === whale.id);
    // 60,000 BDT x 0.0405 x 8% (Silver) = 194.4 BDT
    expect(whaleGrant.amountMicro).toBe("19440000000");
    const bal = getSqliteClient()
      .prepare("SELECT available FROM balances WHERE user_id = ? AND currency = 'USDT'")
      .get(casual.id) as any;
    expect(parseFloat(bal.available)).toBeCloseTo(0.2025, 8);
    const r2 = settlement.runRakeback(getSqliteClient(), { nowSec: E + 20, periodStart: S, periodEnd: E });
    expect(r2.grants.length).toBe(0);
  });
});

describe("lucky wheel", () => {
  it("draw is deterministic; spin consumes one entitlement; token prize seeds a session", async () => {
    const prizes = vipLib.sanePrizes([{ labelEn: "5 free spins", kind: "freespins", spins: 5, weight: 1 }]);
    expect(vipLib.drawPrize("abc", prizes)?.spins).toBe(5);
    expect(vipLib.drawPrize("abc", prizes)).toEqual(vipLib.drawPrize("abc", prizes));

    settingsLib.setSetting("wheel_prizes", [
      { labelEn: "5 free spins", labelBn: "৫টি ফ্রি স্পিন", kind: "freespins", spins: 5, weight: 1 },
    ], null);
    const c = callerFor(casual, promoRouter);
    const before = await c.getWheel();
    expect(before.availableSpins).toBe(1);
    const res = await c.spinWheel();
    expect(res.prize.kind).toBe("freespins");
    expect(res.tokenBalance).toBe(5);
    await expect(c.spinWheel()).rejects.toThrow(/No wheel spins/);

    const g = callerFor(casual, gameRouter);
    const sess = await g.startSession({});
    expect(sess.freeSpinsGranted).toBe(5);
    const sessRow = getSqliteClient()
      .prepare("SELECT free_spins_remaining, free_spins_bet, free_spins_currency FROM game_sessions WHERE id = ?")
      .get(sess.sessionId) as any;
    expect(sessRow.free_spins_remaining).toBe(5);
    expect(sessRow.free_spins_bet).toBe("10");
    expect(sessRow.free_spins_currency).toBe("BDT");
    const after = await c.getWheel();
    expect(after.tokenBalance).toBe(0);
    expect(after.history.length).toBe(1);
    expect(after.history[0].roll_nonce).toBeTruthy();
  });
});

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";

/**
 * Step 8 — buy feature: EV-neutral pricing from the bundle cert
 * (price = ceil(E[feature]/0.965)), implied RTP disclosed, guards
 * (kill flag, active FS, active bonus, daily cap, balance).
 */

const tmpDir = fs.mkdtempSync(path.join("/tmp", "zeus-buy-test-"));
const dbPath = path.join(tmpDir, "test.sqlite");
process.env.ZEUS_DB_PATH = dbPath;

let gameRouter: any;
let bundles: any;
let cascadeLib: any;
let getDb: any;
let getSqliteClient: any;
let schema: any;
let settingsLib: any;

let player: any;
let caller: any;
let sessionId: number;

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

  gameRouter = (await import("./game")).gameRouter;
  bundles = await import("../lib/bundles");
  cascadeLib = await import("../lib/cascade");
  getDb = (await import("../queries/connection")).getDb;
  getSqliteClient = (await import("../queries/connection")).getSqliteClient;
  schema = await import("../../db/schema");
  settingsLib = await import("../lib/settings");
  settingsLib.setSetting("binance_pay_id", "556677889", null);
  for (const [tier, seed] of [["mini", "0.01"], ["major", "0.1"], ["mega", "1.0"]] as const) {
    getSqliteClient()
      .prepare("INSERT INTO jackpot_pool (tier, seed_amount, current_amount, contribution_rate) VALUES (?, ?, ?, '0.001')")
      .run(tier, seed, seed);
  }
  bundles.registerCascadeBundle(getSqliteClient(), cascadeLib.CASCADE_DEFAULT_MATH, 1, {
    status: "active",
    cert: { run: { rtp: 0.965, featureExpectationX: 82 } },
  });
  settingsLib.setSetting("cascade_enabled", true, null);

  const db = getDb();
  const [u] = await db.insert(schema.users).values({ unionId: "test:buy:player", name: "Buyer" }).returning();
  player = u;
  await db.insert(schema.balances).values({ userId: u.id, currency: "USDT", available: "200", locked: "0" });
  caller = gameRouter.createCaller({
    user: u,
    req: new Request("http://localhost/api/trpc"),
    resHeaders: new Headers(),
  });
  const s = await caller.startSession({});
  sessionId = s.sessionId;
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("buy feature", () => {
  it("is gated by the kill flag", async () => {
    const info = await caller.buyFeatureInfo();
    expect(info.available).toBe(false);
    await expect(
      caller.buyFeature({ sessionId, betAmount: "1", currency: "USDT" }),
    ).rejects.toThrow(/not available/);
    settingsLib.setSetting("buy_feature_enabled", true, null);
  });

  it("prices at ceil(E/0.965), discloses implied RTP, grants a locked cascade round", async () => {
    const info = await caller.buyFeatureInfo();
    expect(info.available).toBe(true);
    expect(info.priceX).toBe(85); // ceil(82 / 0.965)
    expect(info.impliedBonusRtp).toBeCloseTo(82 / 85, 10);
    const r = await caller.buyFeature({ sessionId, betAmount: "1", currency: "USDT" });
    expect(parseFloat(r.pricePaid)).toBeCloseTo(85, 8);
    expect(r.freeSpinsGranted).toBe(10);
    const bal = getSqliteClient()
      .prepare("SELECT available FROM balances WHERE user_id = ? AND currency = 'USDT'")
      .get(player.id) as any;
    expect(parseFloat(bal.available)).toBeCloseTo(115, 8);
    const sess = getSqliteClient().prepare("SELECT * FROM game_sessions WHERE id = ?").get(sessionId) as any;
    expect(sess.free_spins_remaining).toBe(10);
    expect(sess.free_spins_mode).toBe("cascade");
    // Ledger + transaction carry the debit.
    const leg = getSqliteClient()
      .prepare("SELECT amount FROM ledger_entries WHERE user_id = ? AND kind = 'buy_feature_debit'")
      .get(player.id) as any;
    expect(parseFloat(leg.amount)).toBeCloseTo(-85, 8);
    // Cannot buy again during the round.
    await expect(
      caller.buyFeature({ sessionId, betAmount: "1", currency: "USDT" }),
    ).rejects.toThrow(/Finish your free spins/);
    // The round plays as cascade free spins.
    const fs = await caller.spin({ sessionId, betAmount: "1", currency: "USDT", mode: "classic" });
    expect(fs.isFreeSpin).toBe(true);
    expect(fs.mode).toBe("cascade");
  });

  it("daily cap and active-bonus interlock hold", async () => {
    settingsLib.setSetting("buy_feature_max_per_day", 1, null);
    // Drain the round.
    for (let i = 0; i < 12; i++) {
      const sess = getSqliteClient().prepare("SELECT free_spins_remaining FROM game_sessions WHERE id = ?").get(sessionId) as any;
      if (sess.free_spins_remaining <= 0) break;
      await caller.spin({ sessionId, betAmount: "1", currency: "USDT", mode: "cascade" });
    }
    await expect(
      caller.buyFeature({ sessionId, betAmount: "1", currency: "USDT" }),
    ).rejects.toThrow(/Daily buy-feature limit/);
    settingsLib.setSetting("buy_feature_max_per_day", 10, null);
    // Active bonus blocks the buy.
    await getDb().insert(schema.bonusLedger).values({
      userId: player.id, currency: "USDT", kind: "reload", amount: "5",
      remaining: "5", wageringMultiplier: 2, wagered: "0", status: "active",
    });
    await expect(
      caller.buyFeature({ sessionId, betAmount: "1", currency: "USDT" }),
    ).rejects.toThrow(/active bonus/);
  });
});

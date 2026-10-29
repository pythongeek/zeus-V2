import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";

/**
 * Step 5 — cascade mode through the real spin path: bundle gate,
 * money exactness, mode stamping, free-spin mode lock, and a full
 * fairness replay verification.
 */

const tmpDir = fs.mkdtempSync(path.join("/tmp", "zeus-cascade-test-"));
const dbPath = path.join(tmpDir, "test.sqlite");
process.env.ZEUS_DB_PATH = dbPath;

let gameRouter: any;
let fairnessRouter: any;
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
  fairnessRouter = (await import("./fairness")).fairnessRouter;
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

  const db = getDb();
  const [u] = await db
    .insert(schema.users)
    .values({ unionId: "test:cascade:player", name: "Cascade Player" })
    .returning();
  player = u;
  await db.insert(schema.balances).values({ userId: u.id, currency: "USDT", available: "100", locked: "0" });
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

describe("cascade spin path", () => {
  it("refuses cascade while the mode is dark", async () => {
    await expect(
      caller.spin({ sessionId, betAmount: "1", currency: "USDT", mode: "cascade" }),
    ).rejects.toThrow(/not available/);
  });

  it("settles a cascade spin exactly and stamps mode + bundle", async () => {
    bundles.registerCascadeBundle(getSqliteClient(), cascadeLib.CASCADE_DEFAULT_MATH, 1, { status: "active" });
    settingsLib.setSetting("cascade_enabled", true, null);
    const before = parseFloat(
      (getSqliteClient().prepare("SELECT available FROM balances WHERE user_id = ? AND currency = 'USDT'").get(player.id) as any).available,
    );
    const res = await caller.spin({ sessionId, betAmount: "1", currency: "USDT", mode: "cascade" });
    expect(res.mode).toBe("cascade");
    expect(res.cascade).toBeTruthy();
    expect(res.cascade.chainLength).toBe(res.cascade.steps.length);
    const after = parseFloat(
      (getSqliteClient().prepare("SELECT available FROM balances WHERE user_id = ? AND currency = 'USDT'").get(player.id) as any).available,
    );
    expect(after).toBeCloseTo(before - 1 + parseFloat(res.winAmount), 8);
    const row = getSqliteClient().prepare("SELECT * FROM spins WHERE id = ?").get(res.spinId) as any;
    expect(row.mode_id).toBe("cascade");
    expect(row.bundle_id).toBe("zeus-cascade-v1");
    expect(row.bundle_sha256).toMatch(/^[0-9a-f]{64}$/);
    // Classic still settles in the same session afterwards.
    const classic = await caller.spin({ sessionId, betAmount: "1", currency: "USDT" });
    expect(classic.mode).toBe("classic");
  });

  it("free spins stay locked to cascade once awarded there", async () => {
    // v2 math: scatter-heavy so a paid cascade spin reliably awards FS.
    const fsMath = {
      ...cascadeLib.CASCADE_DEFAULT_MATH,
      weights: { "0": 1000, "1": 1, "2": 1, "3": 1, "4": 1, "5": 1, "6": 1, "7": 1, "8": 1, "9": 1 },
    };
    getSqliteClient().prepare("UPDATE math_bundles SET status = 'parked' WHERE bundle_id = 'zeus-cascade-v1'").run();
    bundles.registerCascadeBundle(getSqliteClient(), fsMath, 2, { status: "active" });
    let awarded = 0;
    for (let i = 0; i < 6 && awarded === 0; i++) {
      const r = await caller.spin({ sessionId, betAmount: "1", currency: "USDT", mode: "cascade" });
      awarded = r.freeSpinsAwarded;
    }
    expect(awarded).toBeGreaterThan(0);
    // A "classic" request now actually plays a CASCADE free spin.
    const fs = await caller.spin({ sessionId, betAmount: "1", currency: "USDT", mode: "classic" });
    expect(fs.isFreeSpin).toBe(true);
    expect(fs.mode).toBe("cascade");
    expect(fs.currencyUsed).toBe("USDT");
  });

  it("fairness.verify replays a cascade spin to verified=true", async () => {
    const spinRow = getSqliteClient()
      .prepare("SELECT nonce FROM spins WHERE mode_id = 'cascade' ORDER BY id ASC LIMIT 1")
      .get() as any;
    // The scatter-heavy v2 math retriggers forever by design, so
    // the test drains the session's free spins administratively —
    // what is under test here is the replay, not the drain.
    getSqliteClient()
      .prepare("UPDATE game_sessions SET free_spins_remaining = 0 WHERE id = ?")
      .run(sessionId);
    await caller.endSession({ sessionId });
    const fc = fairnessRouter.createCaller({
      user: player,
      req: new Request("http://localhost/api/trpc"),
      resHeaders: new Headers(),
    });
    const v = await fc.verify({ sessionId, nonce: spinRow.nonce });
    expect(v.modeId).toBe("cascade");
    expect(v.verified).toBe(true);
  });
});

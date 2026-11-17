import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import crypto from "crypto";

/**
 * U3 unified game: with unified_game OFF a classic scatter trigger
 * awards classic free spins as always. With it ON (and cascade live),
 * a PAID classic spin's trigger converts to an Olympus Cascade round:
 * the award count comes from the cascade bundle's fsTable, the
 * session stores free_spins_mode = 'cascade', the response carries
 * freeSpinsMode, and the round then plays out as cascade free spins.
 */

const tmpDir = fs.mkdtempSync(path.join("/tmp", "zeus-unified-test-"));
const dbPath = path.join(tmpDir, "test.sqlite");
process.env.ZEUS_DB_PATH = dbPath;

let gameRouter: any;
let bundles: any;
let cascadeLib: any;
let getDb: any;
let getSqliteClient: any;
let schema: any;
let settingsLib: any;

async function makePlayer(balance: string) {
  const db = getDb();
  const [u] = await db
    .insert(schema.users)
    .values({
      unionId: `test:u3:${Math.random().toString(36).slice(2)}`,
      name: "U3 Player",
    })
    .returning();
  await db.insert(schema.balances).values({
    userId: u.id,
    currency: "USDT",
    available: balance,
    locked: "0",
  });
  const serverSeed = crypto.randomBytes(32).toString("hex");
  const [session] = await db
    .insert(schema.gameSessions)
    .values({
      userId: u.id,
      serverSeed,
      serverSeedHash: crypto.createHash("sha256").update(serverSeed).digest("hex"),
      clientSeed: "u3client",
      nonce: 0,
      status: "active",
    })
    .returning();
  const caller = gameRouter.createCaller({
    user: u,
    req: new Request("http://localhost/api/trpc"),
    resHeaders: new Headers(),
  });
  return { user: u, caller, sessionId: session.id as number };
}

function scatterCount(res: any): number {
  return (res.symbols as string[][])
    .flat()
    .filter((s) => s === "thunderbolt").length;
}

function sessionFsBundle(sessionId: number): string | null {
  const row = getSqliteClient()
    .prepare("SELECT free_spins_bundle FROM game_sessions WHERE id = ?")
    .get(sessionId) as any;
  return (row.free_spins_bundle as string | null) ?? null;
}

function sessionFsMode(sessionId: number): string {
  const row = getSqliteClient()
    .prepare("SELECT free_spins_mode FROM game_sessions WHERE id = ?")
    .get(sessionId) as any;
  return row.free_spins_mode as string;
}

async function huntClassicTrigger(caller: any, sessionId: number) {
  for (let i = 0; i < 900; i++) {
    const res = await caller.spin({ sessionId, betAmount: "1", currency: "USDT" });
    if ((res.freeSpinsAwarded ?? 0) > 0) return res;
  }
  throw new Error("no classic scatter trigger in 900 spins");
}

async function drainFreeSpins(caller: any, sessionId: number, first: any) {
  const modes: string[] = [];
  let remaining = first.freeSpinsRemaining as number;
  let guard = 0;
  while (remaining > 0 && guard++ < 300) {
    const r = await caller.spin({ sessionId, betAmount: "1", currency: "USDT" });
    expect(r.isFreeSpin).toBe(true);
    modes.push(r.mode);
    remaining = r.freeSpinsRemaining;
  }
  expect(remaining).toBe(0);
  return modes;
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

  gameRouter = (await import("./game")).gameRouter;
  bundles = await import("../lib/bundles");
  cascadeLib = await import("../lib/cascade");
  getDb = (await import("../queries/connection")).getDb;
  getSqliteClient = (await import("../queries/connection")).getSqliteClient;
  schema = await import("../../db/schema");
  settingsLib = await import("../lib/settings");
  settingsLib.setSetting("binance_pay_id", "556677889", null);

  for (const [tier, seed] of [["mini", "5"], ["major", "25"], ["mega", "100"]] as const) {
    getSqliteClient()
      .prepare("INSERT INTO jackpot_pool (tier, seed_amount, current_amount, contribution_rate) VALUES (?, ?, ?, '0.005')")
      .run(tier, seed, seed);
  }

  // Cascade live with the unified award table (threshold 3).
  const unifiedMath = {
    ...cascadeLib.CASCADE_DEFAULT_MATH,
    scatterThreshold: 3,
    fsTable: { "3": 12, "4": 15, "5": 20 },
    fsRetrigger: 0, // deterministic round length for the assertions below
  };
  bundles.registerCascadeBundle(getSqliteClient(), unifiedMath, 1, { status: "active" });
  // Option B: the unified game's own cascade bundle (gentler math,
  // same 12/15/20 award table). Converted rounds must pin to it.
  const unifiedBundleMath = {
    ...cascadeLib.CASCADE_DEFAULT_MATH,
    scatterThreshold: 3,
    fsTable: { "3": 12, "4": 15, "5": 20 },
    fsRetrigger: 0,
    ladder: [1, 2, 3, 4, 6],
    attach: [0.35, 0.35, 0.35, 0.35, 0.35],
  };
  bundles.registerUnifiedCascadeBundle(getSqliteClient(), unifiedBundleMath, { status: "active" });
  settingsLib.setSetting("cascade_enabled", true, null);
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("U3 unified game conversion", () => {
  it("unified OFF: a classic trigger awards classic free spins", async () => {
    settingsLib.setSetting("unified_game", false, null);
    const { caller, sessionId } = await makePlayer("100000");
    const trig = await huntClassicTrigger(caller, sessionId);
    expect(trig.mode).toBe("classic");
    expect(trig.freeSpinsMode).toBe("classic");
    expect(sessionFsMode(sessionId)).toBe("classic");
    const modes = await drainFreeSpins(caller, sessionId, trig);
    expect(modes.every((m) => m === "classic")).toBe(true);
  }, 180000);

  it("unified ON: a paid classic trigger converts to a cascade round", async () => {
    settingsLib.setSetting("unified_game", true, null);
    const { caller, sessionId } = await makePlayer("100000");
    const trig = await huntClassicTrigger(caller, sessionId);
    const sc = scatterCount(trig);
    expect(sc).toBeGreaterThanOrEqual(3);
    const expected = ({ 3: 12, 4: 15, 5: 20 } as Record<number, number>)[Math.min(sc, 5)];
    expect(trig.mode).toBe("classic"); // the trigger spin itself is a base spin
    expect(trig.freeSpinsAwarded).toBe(expected);
    expect(trig.freeSpinsMode).toBe("cascade");
    expect(sessionFsMode(sessionId)).toBe("cascade");
    // Option B: the round is pinned to the unified bundle, and the
    // free spins stamp that bundle on their spin records.
    expect(sessionFsBundle(sessionId)).toBe("zeus-unified-cascade-v1");
    const modes = await drainFreeSpins(caller, sessionId, trig);
    expect(modes.length).toBe(expected);
    expect(modes.every((m) => m === "cascade")).toBe(true);
    const fsSpin = getSqliteClient()
      .prepare("SELECT bundle_id FROM spins WHERE session_id = ? AND is_free_spin = 1 ORDER BY id LIMIT 1")
      .get(sessionId) as any;
    expect(fsSpin.bundle_id).toBe("zeus-unified-cascade-v1");
    // Round over: the stored mode resets for the next base session.
    expect(sessionFsMode(sessionId)).toBe("classic");
    expect(sessionFsBundle(sessionId)).toBeNull();
    settingsLib.setSetting("unified_game", false, null);
  }, 180000);

  it("unified_fs_awards override: the certified table replaces the bundle table", async () => {
    settingsLib.setSetting("unified_game", true, null);
    settingsLib.setSetting("unified_fs_awards", { "3": 7, "4": 9, "5": 11 }, null);
    const { caller, sessionId } = await makePlayer("100000");
    const trig = await huntClassicTrigger(caller, sessionId);
    const sc = scatterCount(trig);
    const expected = ({ 3: 7, 4: 9, 5: 11 } as Record<number, number>)[Math.min(sc, 5)];
    expect(trig.freeSpinsAwarded).toBe(expected);
    expect(trig.freeSpinsMode).toBe("cascade");
    expect(sessionFsMode(sessionId)).toBe("cascade");
    const modes = await drainFreeSpins(caller, sessionId, trig);
    expect(modes.length).toBe(expected);
    settingsLib.setSetting("unified_fs_awards", {}, null);
    settingsLib.setSetting("unified_game", false, null);
  }, 180000);
});

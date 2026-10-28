import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import crypto from "crypto";

/**
 * Section E3 tests: the max-win cap (max_win_x setting) trims the
 * game win at x bet inside the spin transaction; 0 disables it.
 * The seed is hunted at runtime with the real engine functions so
 * nonce 1 is a known >=5x win with no jackpot interference.
 */

const tmpDir = fs.mkdtempSync(path.join("/tmp", "zeus-mw-test-"));
const dbPath = path.join(tmpDir, "test.sqlite");
process.env.ZEUS_DB_PATH = dbPath;

let gameRouter: any;
let engine: any;
let getDb: any;
let getSqliteClient: any;
let schema: any;
let settingsLib: any;
let hunted: { seed: string; winUnits: number } | null = null;

async function makeSession(serverSeed: string, balance: string) {
  const db = getDb();
  const [user] = await db
    .insert(schema.users)
    .values({
      unionId: `test:mw:${Math.random().toString(36).slice(2)}`,
      name: "MW Test",
    })
    .returning();
  await db.insert(schema.balances).values({
    userId: user.id,
    currency: "USDT",
    available: balance,
    locked: "0",
  });
  const [session] = await db
    .insert(schema.gameSessions)
    .values({
      userId: user.id,
      serverSeed,
      serverSeedHash: crypto.createHash("sha256").update(serverSeed).digest("hex"),
      clientSeed: "mwclient",
      nonce: 0,
      status: "active",
    })
    .returning();
  const caller = gameRouter.createCaller({
    user,
    req: new Request("http://localhost/api/trpc"),
    resHeaders: new Headers(),
  });
  return { user, caller, sessionId: session.id as number };
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

  ({ gameRouter } = await import("./game"));
  engine = await import("./game");
  ({ getDb, getSqliteClient } = await import("../queries/connection"));
  schema = await import("../../db/schema");
  settingsLib = await import("../lib/settings");
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

  // Hunt a seed: nonce 1 wins >= 5x bet (100 betPerLine units),
  // no jackpot on that hash.
  for (let i = 0; i < 5000 && !hunted; i++) {
    const seed = `mw-hunt-${i}`;
    const { symbols, hash } = engine.calculateSpin(seed, "mwclient", 1);
    if (engine.checkJackpot(hash)) continue;
    const res = engine.evaluatePaylines(symbols.map((c: number[]) => [...c]), 1);
    if (res.totalPayout >= 100) hunted = { seed, winUnits: res.totalPayout };
  }
  if (!hunted) throw new Error("no suitable seed found");
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("E3: max-win cap", () => {
  it("cap off (0): the full win is paid", async () => {
    settingsLib.setSetting("max_win_x", 0, null);
    const { caller, sessionId } = await makeSession(hunted!.seed, "100");
    const r = await caller.spin({ sessionId, betAmount: "1", currency: "USDT" });
    expect(parseFloat(r.winAmount)).toBeCloseTo(hunted!.winUnits / 20, 6);
    expect(parseFloat(r.newBalance)).toBeCloseTo(99 + hunted!.winUnits / 20, 6);
  });

  it("cap 2x: the win is trimmed to exactly 2x bet", async () => {
    settingsLib.setSetting("max_win_x", 2, null);
    const { caller, sessionId } = await makeSession(hunted!.seed, "100");
    const r = await caller.spin({ sessionId, betAmount: "1", currency: "USDT" });
    expect(r.winAmount).toBe("2");
    expect(r.newBalance).toBe("101");
    settingsLib.setSetting("max_win_x", 0, null);
  });
});

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import crypto from "crypto";

/**
 * B2 tests: admin settings actually drive the game.
 * - math_free_spins override changes awards (hunted seed a5-hunt-15)
 * - currencies_enabled gates spins
 * - jackpot_shares override changes contributions exactly
 * - features.jackpots=false stops contributions entirely
 * - getPaytable reflects a paytable override + declared RTP
 */

const tmpDir = fs.mkdtempSync(path.join("/tmp", "zeus-b2-test-"));
const dbPath = path.join(tmpDir, "test.sqlite");
process.env.ZEUS_DB_PATH = dbPath;

let gameRouter: any;
let settings: any;
let getDb: any;
let getSqliteClient: any;
let schema: any;

async function makeSession(serverSeed: string, clientSeed: string, balance: string) {
  const db = getDb();
  const [user] = await db
    .insert(schema.users)
    .values({
      unionId: `test:b2:${Math.random().toString(36).slice(2)}`,
      name: "B2 Test",
    })
    .returning();
  await db.insert(schema.balances).values({
    userId: user.id,
    currency: "USDT",
    available: balance,
    locked: "0",
  });
  await db.insert(schema.balances).values({
    userId: user.id,
    currency: "BDT",
    available: balance,
    locked: "0",
  });
  const [session] = await db
    .insert(schema.gameSessions)
    .values({
      userId: user.id,
      serverSeed,
      serverSeedHash: crypto.createHash("sha256").update(serverSeed).digest("hex"),
      clientSeed,
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

function pool(tier: string) {
  return getSqliteClient()
    .prepare("SELECT * FROM jackpot_pool WHERE tier = ?")
    .get(tier);
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

  settings = await import("../lib/settings");
  ({ gameRouter } = await import("./game"));
  ({ getDb, getSqliteClient } = await import("../queries/connection"));
  schema = await import("../../db/schema");
  const client = getSqliteClient();
  for (const [tier, seed, rate] of [
    ["mini", "5", "0.005"],
    ["major", "25", "0.003"],
    ["mega", "100", "0.002"],
  ] as const) {
    client
      .prepare(
        "INSERT INTO jackpot_pool (tier, seed_amount, current_amount, contribution_rate) VALUES (?, ?, ?, ?)",
      )
      .run(tier, seed, seed, rate);
  }
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("B2: settings drive the game", () => {
  it("math_free_spins override changes the award", async () => {
    settings.setSetting("math_free_spins", { "3": 3, "4": 12, "5": 20 }, 1);
    const { caller, sessionId } = await makeSession("a5-hunt-15", "a5client", "100");
    const res = await caller.spin({ sessionId, betAmount: "1", currency: "USDT" });
    expect(res.freeSpinsAwarded).toBe(3);
    expect(res.freeSpinsRemaining).toBe(3);
    settings.setSetting("math_free_spins", { "3": 8, "4": 12, "5": 20 }, 1);
  });

  it("currencies_enabled gates spins", async () => {
    settings.setSetting("currencies_enabled", ["USDT"], 1);
    const { caller, sessionId } = await makeSession("plain-seed-1", "a6client", "100");
    await expect(
      caller.spin({ sessionId, betAmount: "1", currency: "BDT" }),
    ).rejects.toThrow("Currency not enabled");
    settings.setSetting("currencies_enabled", ["USDT", "BDT"], 1);
    const ok = await caller.spin({ sessionId, betAmount: "1", currency: "BDT" });
    expect(ok.nonce).toBe(1);
  });

  it("jackpot_shares override and features toggle control contributions", async () => {
    settings.setSetting("jackpot_shares", { mini: 10, major: 3, mega: 2 }, 1);
    const a = await makeSession("contrib-seed", "a6client", "100");
    await a.caller.spin({ sessionId: a.sessionId, betAmount: "10", currency: "USDT" });
    // (Earlier tests in this file already added 0.01 of contributions.)
    expect(pool("mini").current_amount).toBe("5.11"); // +10 per 1000 of 10 = +0.10
    settings.setSetting("jackpot_shares", { mini: 5, major: 3, mega: 2 }, 1);

    settings.setSetting("features", { freeSpins: true, thunder: true, jackpots: false }, 1);
    const b = await makeSession("contrib-seed", "a6client", "100");
    await b.caller.spin({ sessionId: b.sessionId, betAmount: "10", currency: "USDT" });
    expect(pool("mini").current_amount).toBe("5.11"); // unchanged
    settings.setSetting("features", { freeSpins: true, thunder: true, jackpots: true }, 1);
  });

  it("getPaytable reflects paytable override and declared RTP", async () => {
    const pub = gameRouter.createCaller({
      user: undefined,
      req: new Request("http://localhost/api/trpc"),
      resHeaders: new Headers(),
    });
    const before = await pub.getPaytable();
    expect(before.rtp).toBe(96.0);
    const def = settings.SETTING_DEFS.math_paytable.def as any;
    const custom = JSON.parse(JSON.stringify(def));
    custom["10"] = { "3": 4, "4": 12, "5": 999 };
    settings.setSetting("math_paytable", custom, 1);
    const after = await pub.getPaytable();
    const queen = after.symbols.find((s: any) => s.name === "queen");
    expect(queen.payouts["5"]).toBe(999);
    settings.setSetting("math_paytable", def, 1);
  });
});

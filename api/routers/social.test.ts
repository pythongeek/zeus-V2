import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import crypto from "crypto";

/**
 * Step 9 — live win ticker (playbook §4.2): only real settled wins
 * >= 25x bet appear, after the display delay, names masked, no ids.
 */

const tmpDir = fs.mkdtempSync(path.join("/tmp", "zeus-social-test-"));
const dbPath = path.join(tmpDir, "test.sqlite");
process.env.ZEUS_DB_PATH = dbPath;

let socialRouter: any;
let getDb: any;
let getSqliteClient: any;
let schema: any;
let settingsLib: any;
let passwordLib: any;

function caller() {
  return socialRouter.createCaller({
    user: undefined,
    req: new Request("http://localhost/api/trpc"),
    resHeaders: new Headers(),
  });
}

function insertSpin(userId: number, bet: string, win: string, createdAtSec: number, nonce: number) {
  getSqliteClient()
    .prepare(
      `INSERT INTO spins (session_id, user_id, nonce, bet_amount, currency, reel_positions, symbols_shown, win_amount, hash, is_free_spin, mode_id, created_at)
       VALUES (1, ?, ?, ?, 'USDT', '[]', '[]', ?, ?, 0, 'classic', ?)`,
    )
    .run(userId, nonce, bet, win, crypto.createHash("sha256").update(`s${nonce}`).digest("hex"), createdAtSec);
}

beforeAll(async () => {
  const Database = (await import("better-sqlite3")).default;
  const sqlite = new Database(dbPath);
  const migrationsDir = path.resolve(process.cwd(), "db", "migrations");
  for (const file of fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()) {
    sqlite.exec(fs.readFileSync(path.join(migrationsDir, file), "utf8"));
  }
  sqlite.close();

  socialRouter = (await import("./social")).socialRouter;
  getDb = (await import("../queries/connection")).getDb;
  getSqliteClient = (await import("../queries/connection")).getSqliteClient;
  schema = await import("../../db/schema");
  settingsLib = await import("../lib/settings");
  passwordLib = await import("../lib/password");

  const db = getDb();
  const [rakib] = await db
    .insert(schema.users)
    .values({ unionId: "test:social:rakib", name: "রাকিব হোসেন", email: "rakib@test.local", passwordHash: passwordLib.hashPassword("SoPw2026!") })
    .returning();
  const [alice] = await db
    .insert(schema.users)
    .values({ unionId: "test:social:alice", name: "Alice", email: "alice@test.local", passwordHash: passwordLib.hashPassword("SoPw2026!") })
    .returning();

  const now = Math.floor(Date.now() / 1000);
  insertSpin(rakib.id, "2", "60", now - 3600, 1); // 30x — appears
  insertSpin(alice.id, "1", "150", now - 1800, 2); // 150x — gold
  insertSpin(rakib.id, "1", "10", now - 900, 3); // 10x — below threshold
  insertSpin(alice.id, "1", "50", now, 4); // 50x but inside the display delay
  insertSpin(alice.id, "1", "50", now - 8 * 86400, 5); // 50x but 8 days old
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("social.recentWins", () => {
  it("serves only qualifying, delayed, aged wins with masked names", async () => {
    const { wins } = await caller().recentWins({ limit: 20 });
    expect(wins.length).toBe(2);
    const gold = wins.find((w: any) => w.gold);
    expect(gold.maskedName).toBe("Al***");
    expect(gold.multiplier).toBe(150);
    const plain = wins.find((w: any) => !w.gold);
    expect(plain.maskedName).toBe("রা***");
    expect(plain.multiplier).toBe(30);
    expect(plain.modeId).toBe("classic");
    for (const w of wins) {
      expect(w).not.toHaveProperty("userId");
      expect(w).not.toHaveProperty("id");
      expect(w.maskedName).not.toContain("হোসেন");
    }
  });

  it("the master switch empties the feed", async () => {
    settingsLib.setSetting("ticker_enabled", false, null);
    const { wins } = await caller().recentWins({ limit: 20 });
    expect(wins).toEqual([]);
    settingsLib.setSetting("ticker_enabled", true, null);
  });
});

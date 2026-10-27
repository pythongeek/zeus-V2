import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";

/**
 * B1 tests: settings store + spin enforcement.
 * Defaults preserve shipped behaviour; writes validate by type; the spin
 * path honours min_bet/max_bet and maintenance_mode from the store.
 */

const tmpDir = fs.mkdtempSync(path.join("/tmp", "zeus-b1-test-"));
const dbPath = path.join(tmpDir, "test.sqlite");
process.env.ZEUS_DB_PATH = dbPath;

let settings: any;
let gameRouter: any;
let getDb: any;
let schema: any;
let caller: any;
let sessionId: number;

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
  ({ getDb } = await import("../queries/connection"));
  schema = await import("../../db/schema");

  const db = getDb();
  const [user] = await db
    .insert(schema.users)
    .values({ unionId: "test:b1:1", name: "B1 Test" })
    .returning();
  await db.insert(schema.balances).values({
    userId: user.id,
    currency: "USDT",
    available: "100",
    locked: "0",
  });
  caller = gameRouter.createCaller({
    user,
    req: new Request("http://localhost/api/trpc"),
    resHeaders: new Headers(),
  });
  const s = await caller.startSession({});
  sessionId = s.sessionId as number;
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("B1: settings", () => {
  it("serves typed defaults before anything is stored", () => {
    expect(settings.getSetting("min_bet")).toBe("0.1");
    expect(settings.getSetting("max_bet")).toBe("1000");
    expect(settings.getSetting("maintenance_mode")).toBe(false);
    const pub = settings.getPublicConfig();
    expect(pub.min_bet).toBe("0.1");
    expect(pub.support_hours).toBe("18:00–02:00 (Dhaka)");
    expect(settings.getAllSettings().length).toBe(
      Object.keys(settings.SETTING_DEFS).length,
    );
  });

  it("validates values by type", () => {
    expect(() => settings.setSetting("maintenance_mode", "yes", 1)).toThrow(
      "must be true/false",
    );
    expect(() => settings.setSetting("min_bet", "not-a-number", 1)).toThrow();
    expect(() => settings.setSetting("nope_key", 1, 1)).toThrow("Unknown setting");
    settings.setSetting("big_win_threshold_x", 25, 1);
    expect(settings.getSetting("big_win_threshold_x")).toBe(25);
  });

  it("spin honours min_bet and maintenance_mode from settings", async () => {
    settings.setSetting("min_bet", "5", 1);
    await expect(
      caller.spin({ sessionId, betAmount: "1", currency: "USDT" }),
    ).rejects.toThrow("Bet must be between 5 and 1000");
    settings.setSetting("min_bet", "0.1", 1);

    settings.setSetting("maintenance_mode", true, 1);
    await expect(
      caller.spin({ sessionId, betAmount: "1", currency: "USDT" }),
    ).rejects.toThrow("Game is under maintenance");
    settings.setSetting("maintenance_mode", false, 1);

    const ok = await caller.spin({ sessionId, betAmount: "1", currency: "USDT" });
    expect(ok.nonce).toBe(1);
  });
});

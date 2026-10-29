import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";

/**
 * Step 7 — near-miss flags are FACTS about settled outcomes:
 * classic flag ⟺ exactly 2 scatters in the final grid; cascade
 * flag ⟺ the final grid's largest symbol count is exactly 7.
 * The flag never influences the outcome (write-only telemetry).
 */

const tmpDir = fs.mkdtempSync(path.join("/tmp", "zeus-nm-test-"));
const dbPath = path.join(tmpDir, "test.sqlite");
process.env.ZEUS_DB_PATH = dbPath;

let gameRouter: any;
let bundles: any;
let cascadeLib: any;
let getDb: any;
let getSqliteClient: any;
let schema: any;
let settingsLib: any;

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
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function makePlayer(tag: string, balance: string) {
  const db = getDb();
  const [u] = await db.insert(schema.users).values({ unionId: `test:nm:${tag}`, name: tag }).returning();
  await db.insert(schema.balances).values({ userId: u.id, currency: "USDT", available: balance, locked: "0" });
  const caller = gameRouter.createCaller({
    user: u,
    req: new Request("http://localhost/api/trpc"),
    resHeaders: new Headers(),
  });
  const s = await caller.startSession({});
  return { u, caller, sessionId: s.sessionId as number };
}

describe("near-miss flags", () => {
  it("classic: flag ⟺ exactly two scatters in the settled grid", async () => {
    const { caller, sessionId } = await makePlayer("Classic", "500");
    let flagged = 0;
    for (let i = 0; i < 220 && flagged < 2; i++) {
      const r = await caller.spin({ sessionId, betAmount: "0.25", currency: "USDT" });
      const row = getSqliteClient().prepare("SELECT near_miss, symbols_shown FROM spins WHERE id = ?").get(r.spinId) as any;
      const names = (typeof row.symbols_shown === "string" ? JSON.parse(row.symbols_shown) : row.symbols_shown).flat();
      const scatters = names.filter((n: string) => n === "thunderbolt").length;
      expect(row.near_miss).toBe(scatters === 2 ? 1 : 0);
      expect(r.nearMiss).toBe(scatters === 2);
      if (row.near_miss === 1) flagged += 1;
    }
    expect(flagged).toBeGreaterThanOrEqual(1);
  });

  it("cascade: flag ⟺ final grid max symbol count is exactly 7", async () => {
    // One symbol at p=0.23: its count lands on exactly 7 often.
    const math = JSON.parse(JSON.stringify(cascadeLib.CASCADE_DEFAULT_MATH));
    for (const strip of math.weights) {
      strip["9"] = 52; // king: 52/224 ~ 0.23
    }
    bundles.registerCascadeBundle(getSqliteClient(), math, 7, { status: "active" });
    settingsLib.setSetting("cascade_enabled", true, null);
    const { caller, sessionId } = await makePlayer("Cascade", "500");
    let flagged = 0;
    for (let i = 0; i < 60 && flagged < 2; i++) {
      const r = await caller.spin({ sessionId, betAmount: "1", currency: "USDT", mode: "cascade" });
      const row = getSqliteClient().prepare("SELECT near_miss FROM spins WHERE id = ?").get(r.spinId) as any;
      const counts = new Map<number, number>();
      for (const s of r.cascade.finalGrid as number[]) {
        if (s === 0) continue;
        counts.set(s, (counts.get(s) ?? 0) + 1);
      }
      const max = Math.max(0, ...counts.values());
      expect(row.near_miss).toBe(max === 7 ? 1 : 0);
      if (row.near_miss === 1) flagged += 1;
    }
    expect(flagged).toBeGreaterThanOrEqual(1);
  });
});

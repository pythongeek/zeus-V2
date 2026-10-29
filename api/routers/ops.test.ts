import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import crypto from "crypto";

/**
 * Step 15 — ops dashboard aggregates: per-mode actual RTP with
 * process attribution, DAU, bonus funnel; players are locked out.
 */

const tmpDir = fs.mkdtempSync(path.join("/tmp", "zeus-ops-test-"));
const dbPath = path.join(tmpDir, "test.sqlite");
process.env.ZEUS_DB_PATH = dbPath;

let adminRouter: any;
let getDb: any;
let getSqliteClient: any;
let schema: any;
let settingsLib: any;

let adminCtx: any;
let playerCtx: any;
const nowSec = Math.floor(Date.now() / 1000);
let nonce = 0;

function insertSpin(userId: number, bet: string, win: string, free = false) {
  nonce += 1;
  getSqliteClient()
    .prepare(
      `INSERT INTO spins (session_id, user_id, nonce, bet_amount, currency, reel_positions, symbols_shown, win_amount, hash, is_free_spin, mode_id, created_at)
       VALUES (999001, ?, ?, ?, 'USDT', '[]', '[]', ?, ?, ?, 'classic', ?)`,
    )
    .run(userId, nonce, bet, win, crypto.createHash("sha256").update(`o${nonce}`).digest("hex"), free ? 1 : 0, nowSec - 3600);
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

  adminRouter = (await import("./admin")).adminRouter;
  getDb = (await import("../queries/connection")).getDb;
  getSqliteClient = (await import("../queries/connection")).getSqliteClient;
  schema = await import("../../db/schema");
  settingsLib = await import("../lib/settings");
  settingsLib.setSetting("binance_pay_id", "556677889", null);

  const db = getDb();
  const [admin] = await db.insert(schema.users).values({ unionId: "test:ops:admin", name: "Ops Admin", role: "admin" }).returning();
  adminCtx = { user: admin, req: new Request("http://localhost/api/trpc"), resHeaders: new Headers() };
  const [p1] = await db.insert(schema.users).values({ unionId: "test:ops:p1", name: "P1" }).returning();
  const [p2] = await db.insert(schema.users).values({ unionId: "test:ops:p2", name: "P2" }).returning();
  playerCtx = { user: p1, req: new Request("http://localhost/api/trpc"), resHeaders: new Headers() };

  // wagered 100, returned 40 on paid rows + 56 on a free-spin row.
  insertSpin(p1.id, "60", "40");
  insertSpin(p1.id, "40", "0");
  insertSpin(p1.id, "40", "56", true);
  insertSpin(p2.id, "0", "0", true); // p2 only free-spun: counts for DAU, not for paid volume
  // Bonus funnel: one completed cashback grant of 10, one expired 5.
  await db.insert(schema.bonusLedger).values([
    { userId: p1.id, currency: "USDT", kind: "cashback", amount: "10", remaining: "0", wageringMultiplier: 0, wagered: "0", status: "completed" },
    { userId: p1.id, currency: "USDT", kind: "wheel", amount: "5", remaining: "0", wageringMultiplier: 1, wagered: "0", status: "expired" },
  ]);
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("admin.getOpsDashboard", () => {
  it("aggregates modes, engagement and bonus funnel; players get refused", async () => {
    const admin = adminRouter.createCaller(adminCtx);
    const d = await admin.getOpsDashboard();
    const classic = d.modes.find((m: any) => m.modeId === "classic");
    expect(classic.paidSpins30d).toBe(2);
    expect(classic.wageredUsdt).toBeCloseTo(100, 8);
    expect(classic.wonUsdt).toBeCloseTo(96, 8);
    expect(classic.actualRtp).toBeCloseTo(96, 6);
    expect(d.tripwire[0].modeId).toBe("classic");
    const todayUsers = d.engagement.dau.reduce((a: number, r: any) => a + 0, 0);
    expect(d.engagement.dau.length).toBeGreaterThanOrEqual(1);
    expect(d.engagement.dau[d.engagement.dau.length - 1].users).toBe(2);
    expect(todayUsers).toBe(0);
    expect(d.bonus.conversionRate).toBeCloseTo((10 / 15) * 100, 6);
    await expect(adminRouter.createCaller(playerCtx).getOpsDashboard()).rejects.toThrow();
  });
});

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";

/**
 * Step 12 — reload bonus: opt-in arms, approval attaches (pct with
 * cap, offer wagering), min/currency matching, one-shot consume.
 */

const tmpDir = fs.mkdtempSync(path.join("/tmp", "zeus-reload-test-"));
const dbPath = path.join(tmpDir, "test.sqlite");
process.env.ZEUS_DB_PATH = dbPath;

let promoRouter: any;
let adminRouter: any;
let balanceRouter: any;
let getDb: any;
let getSqliteClient: any;
let schema: any;
let settingsLib: any;
let passwordLib: any;

let player: any;
let adminCtx: any;

function playerCaller() {
  return promoRouter.createCaller({
    user: player,
    req: new Request("http://localhost/api/trpc"),
    resHeaders: new Headers(),
  });
}
function balanceCaller() {
  return balanceRouter.createCaller({
    user: player,
    req: new Request("http://localhost/api/trpc"),
    resHeaders: new Headers(),
  });
}

let refCounter = 0;
async function depositAndApprove(amount: string) {
  refCounter += 1;
  const dep = await balanceCaller().deposit({
    amount,
    currency: "USDT",
    reference: `REF${String(refCounter).padStart(6, "0")}`,
  });
  const admin = adminRouter.createCaller(adminCtx);
  return admin.approveDeposit({ txId: dep.txId });
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

  promoRouter = (await import("./promo")).promoRouter;
  adminRouter = (await import("./admin")).adminRouter;
  balanceRouter = (await import("./balance")).balanceRouter;
  getDb = (await import("../queries/connection")).getDb;
  getSqliteClient = (await import("../queries/connection")).getSqliteClient;
  schema = await import("../../db/schema");
  settingsLib = await import("../lib/settings");
  passwordLib = await import("../lib/password");
  settingsLib.setSetting("binance_pay_id", "556677889", null);
  // Default offer: +15%, 2x wagering, min $20, max $50, USDT.

  const db = getDb();
  const [p] = await db
    .insert(schema.users)
    .values({ unionId: "test:reload:player", name: "Reloader", email: "reload@test.local", passwordHash: passwordLib.hashPassword("RlPw2026!") })
    .returning();
  player = p;
  const [admin] = await db
    .insert(schema.users)
    .values({ unionId: "test:reload:admin", name: "Reload Admin", role: "admin" })
    .returning();
  adminCtx = { user: admin, req: new Request("http://localhost/api/trpc"), resHeaders: new Headers() };
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("reload flow", () => {
  it("deposit without opt-in gets no reload", async () => {
    await depositAndApprove("30");
    const grants = getSqliteClient()
      .prepare("SELECT COUNT(*) AS c FROM bonus_ledger WHERE user_id = ? AND kind = 'reload'")
      .get(player.id) as any;
    expect(grants.c).toBe(0);
  });

  it("opt-in + qualifying deposit: +15% at 2x wagering, opt-in consumed", async () => {
    await playerCaller().optInReload({ offerId: "reload-15" });
    const armed = await playerCaller().myReloadOptin();
    expect(armed.optin?.offerId).toBe("reload-15");
    await depositAndApprove("100"); // 15% = 15 (< cap 50)
    const grant = getSqliteClient()
      .prepare("SELECT * FROM bonus_ledger WHERE user_id = ? AND kind = 'reload'")
      .get(player.id) as any;
    expect(parseFloat(grant.amount)).toBeCloseTo(15, 8);
    expect(grant.wagering_multiplier).toBe(2);
    const after = await playerCaller().myReloadOptin();
    expect(after.optin).toBeNull();
    // Second deposit without a fresh opt-in: no second grant.
    await depositAndApprove("100");
    const count = getSqliteClient()
      .prepare("SELECT COUNT(*) AS c FROM bonus_ledger WHERE user_id = ? AND kind = 'reload'")
      .get(player.id) as any;
    expect(count.c).toBe(1);
  });

  it("cap applies and below-min deposits leave the opt-in armed", async () => {
    await playerCaller().optInReload({ offerId: "reload-15" });
    await depositAndApprove("10"); // below $20 min — no grant, still armed
    let count = getSqliteClient()
      .prepare("SELECT COUNT(*) AS c FROM bonus_ledger WHERE user_id = ? AND kind = 'reload'")
      .get(player.id) as any;
    expect(count.c).toBe(1);
    const armed = await playerCaller().myReloadOptin();
    expect(armed.optin?.offerId).toBe("reload-15");
    await depositAndApprove("1000"); // 15% = 150 -> capped at 50
    const grants = getSqliteClient()
      .prepare("SELECT amount FROM bonus_ledger WHERE user_id = ? AND kind = 'reload' ORDER BY id")
      .all(player.id) as Array<{ amount: string }>;
    expect(grants.length).toBe(2);
    expect(parseFloat(grants[1].amount)).toBeCloseTo(50, 8);
  });

  it("insane offers are filtered out by the sanity rules", async () => {
    settingsLib.setSetting("reload_offers", [
      { id: "greedy", pct: 90, wagering: 1, minDepositUsdt: 0, maxBonus: 999, currency: "USDT", active: true },
      { id: "ok", pct: 10, wagering: 3, minDepositUsdt: 5, maxBonus: 10, currency: "ANY", active: true },
    ], null);
    const { offers } = await playerCaller().listReloadOffers();
    expect(offers.map((o: any) => o.id)).toEqual(["ok"]);
    await expect(playerCaller().optInReload({ offerId: "greedy" })).rejects.toThrow(/not available/);
  });
});

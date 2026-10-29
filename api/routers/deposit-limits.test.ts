import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";

/**
 * D2 tests: operator deposit bounds.
 * - per-currency min/max from settings gate deposit creation
 * - the daily cap (USDT terms) counts pending AND confirmed deposits
 *   (the confirmed half pins the limits.ts status fix: the tally used
 *   to count a 'completed' status that never occurs)
 */

const tmpDir = fs.mkdtempSync(path.join("/tmp", "zeus-d2-test-"));
const dbPath = path.join(tmpDir, "test.sqlite");
process.env.ZEUS_DB_PATH = dbPath;

let balanceRouter: any;
let adminRouter: any;
let settings: any;
let getDb: any;
let schema: any;

function callerFor(router: any, user: any) {
  return router.createCaller({
    user,
    req: new Request("http://localhost/api/trpc"),
    resHeaders: new Headers(),
  });
}

async function makeUser(role = "user") {
  const db = getDb();
  const [user] = await db
    .insert(schema.users)
    .values({
      unionId: `test:d2:${Math.random().toString(36).slice(2)}`,
      name: "D2 Player",
      email: `d2-${Math.random().toString(36).slice(2)}@test.local`,
      role,
    })
    .returning();
  await db.insert(schema.balances).values({
    userId: user.id,
    currency: "USDT",
    available: "0",
    locked: "0",
  });
  return user;
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

  ({ balanceRouter } = await import("./balance"));
  ({ adminRouter } = await import("./admin"));
  settings = await import("../lib/settings");
  ({ getDb } = await import("../queries/connection"));
  schema = await import("../../db/schema");
  settings.setSetting("binance_pay_id", "556677889");
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("D2: deposit bounds", () => {
  it("enforces per-currency min and max", async () => {
    const player = await makeUser();
    const caller = callerFor(balanceRouter, player);
    // Defaults: USDT min 5, max 10000.
    await expect(
      caller.deposit({ currency: "USDT", amount: "4", reference: "MIN-TEST-1" }),
    ).rejects.toThrow("Deposit below minimum");
    await expect(
      caller.deposit({ currency: "USDT", amount: "10001", reference: "MAX-TEST-1" }),
    ).rejects.toThrow("Deposit above maximum");
    await expect(
      caller.deposit({ currency: "USDT", amount: "5", reference: "EDGE-TEST-1" }),
    ).resolves.toMatchObject({ status: "pending" });
  });

  it("daily cap counts pending deposits", async () => {
    settings.setSetting("deposit_daily_cap_usdt", 60);
    const player = await makeUser();
    const caller = callerFor(balanceRouter, player);
    await caller.deposit({ currency: "USDT", amount: "40", reference: "CAP-PEND-1" });
    await expect(
      caller.deposit({ currency: "USDT", amount: "30", reference: "CAP-PEND-2" }),
    ).rejects.toThrow("Daily deposit limit reached");
    await expect(
      caller.deposit({ currency: "USDT", amount: "20", reference: "CAP-PEND-3" }),
    ).resolves.toMatchObject({ status: "pending" });
  });

  it("daily cap still counts a deposit after it is confirmed", async () => {
    settings.setSetting("deposit_daily_cap_usdt", 60);
    const player = await makeUser();
    const admin = await makeUser("admin");
    const pCaller = callerFor(balanceRouter, player);
    const aCaller = callerFor(adminRouter, admin);
    const dep = await pCaller.deposit({ currency: "USDT", amount: "45", reference: "CAP-CONF-1" });
    await aCaller.approveDeposit({ txId: dep.txId });
    // 45 confirmed + 20 = 65 > 60: refused only if 'confirmed' counts.
    await expect(
      pCaller.deposit({ currency: "USDT", amount: "20", reference: "CAP-CONF-2" }),
    ).rejects.toThrow("Daily deposit limit reached");
    settings.setSetting("deposit_daily_cap_usdt", 5000);
  });
});

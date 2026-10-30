import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";

/**
 * F4 tests: Binance PayID deposit rail.
 * - creates a pending tx addressed to the configured PayID with the
 *   player's reference stored in tx_hash
 * - refuses when no PayID is configured (never invents an address)
 * - refuses non-PayID currencies (BTC)
 * - the F3 daily deposit limit still gates the rail
 */

const tmpDir = fs.mkdtempSync(path.join("/tmp", "zeus-f4-test-"));
const dbPath = path.join(tmpDir, "test.sqlite");
process.env.ZEUS_DB_PATH = dbPath;

let balanceRouter: any;
let settings: any;
let getDb: any;
let getSqliteClient: any;
let schema: any;

async function makeUser(balance = "0") {
  const db = getDb();
  const [user] = await db
    .insert(schema.users)
    .values({
      unionId: `test:f4:${Math.random().toString(36).slice(2)}`,
      name: "F4 Test",
    })
    .returning();
  await db.insert(schema.balances).values({
    userId: user.id,
    currency: "USDT",
    available: balance,
    locked: "0",
  });
  const caller = balanceRouter.createCaller({
    user,
    req: new Request("http://localhost/api/trpc"),
    resHeaders: new Headers(),
  });
  return { user, caller };
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
  settings = await import("../lib/settings");
  ({ getDb, getSqliteClient } = await import("../queries/connection"));
  schema = await import("../../db/schema");
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("F4: Binance PayID deposits", () => {
  it("refuses to invent an address when no PayID is configured", async () => {
    const { caller } = await makeUser();
    await expect(
      caller.deposit({ currency: "USDT", amount: "25", reference: "ORDER12345" }),
    ).rejects.toThrow("Deposits are not available yet");
  });

  it("creates a pending deposit to the configured PayID with the reference", async () => {
    settings.setSetting("binance_pay_id", "556677889");
    settings.setSetting("binance_pay_name", "Zeus Slots");
    const { user, caller } = await makeUser();
    const res = await caller.deposit({
      currency: "USDT",
      amount: "25",
      reference: "ORDER12345",
    });
    expect(res.payId).toBe("556677889");
    expect(res.payName).toBe("Zeus Slots");
    expect(res.status).toBe("pending");
    const row = getSqliteClient()
      .prepare("SELECT to_address, tx_hash, status, amount FROM transactions WHERE id = ?")
      .get(res.txId) as any;
    expect(row.to_address).toBe("556677889");
    expect(row.tx_hash).toBe("ORDER12345");
    expect(row.status).toBe("pending");
    expect(row.amount).toBe("25");
    expect(user.id).toBeGreaterThan(0);
  });

  it("accepts BDT on the same rail", async () => {
    const { caller } = await makeUser();
    const res = await caller.deposit({
      currency: "BDT",
      amount: "1100",
      reference: "BDTREF999",
    });
    expect(res.currency).toBe("BDT");
  });

  it("refuses BTC (not a PayID currency)", async () => {
    const { caller } = await makeUser();
    // default config: BTC is not even an enabled currency
    await expect(
      caller.deposit({ currency: "BTC", amount: "0.01", reference: "BTCREF123" }),
    ).rejects.toThrow("Currency not enabled");
    // even if an admin enabled BTC, the PayID rail itself refuses it
    settings.setSetting("currencies_enabled", ["USDT", "BDT", "BTC"]);
    await expect(
      caller.deposit({ currency: "BTC", amount: "0.01", reference: "BTCREF123" }),
    ).rejects.toThrow("Binance Pay / RedotPay only");
    settings.setSetting("currencies_enabled", ["USDT", "BDT"]);
  });

  it("requires a plausible reference", async () => {
    const { caller } = await makeUser();
    await expect(
      caller.deposit({ currency: "USDT", amount: "5", reference: "ab" }),
    ).rejects.toThrow();
  });

  it("redotpay refuses when no RedotPay ID is configured", async () => {
    const { caller } = await makeUser();
    await expect(
      caller.deposit({ currency: "USDT", amount: "25", reference: "REDOT12345", method: "redotpay" }),
    ).rejects.toThrow("Deposits are not available yet");
  });

  it("redotpay creates a pending deposit to the configured RedotPay ID", async () => {
    settings.setSetting("redot_pay_id", "1210819625");
    const { caller } = await makeUser();
    const res = await caller.deposit({
      currency: "USDT",
      amount: "25",
      reference: "REDOT12345",
      method: "redotpay",
    });
    expect(res.method).toBe("redotpay");
    expect(res.payId).toBe("1210819625");
    expect(res.status).toBe("pending");
    const row = getSqliteClient()
      .prepare("SELECT to_address, tx_hash, status FROM transactions WHERE id = ?")
      .get(res.txId) as any;
    expect(row.to_address).toBe("1210819625");
    expect(row.tx_hash).toBe("REDOT12345");
    expect(row.status).toBe("pending");
  });

  it("the F3 daily deposit limit still gates the rail", async () => {
    const { user, caller } = await makeUser();
    const { setLimits } = await import("../lib/limits");
    setLimits(user.id, { depositLimitDaily: "10" });
    await expect(
      caller.deposit({ currency: "USDT", amount: "25", reference: "ORDER12345" }),
    ).rejects.toThrow("Daily deposit limit reached");
  });
});

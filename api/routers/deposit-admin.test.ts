import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";

/**
 * D1 tests: deposit review queue.
 * - an admin can reject a pending deposit with a reason (no money moves)
 * - approving still credits exactly
 * - history lists/searches/filters across statuses
 */

const tmpDir = fs.mkdtempSync(path.join("/tmp", "zeus-d1-test-"));
const dbPath = path.join(tmpDir, "test.sqlite");
process.env.ZEUS_DB_PATH = dbPath;

let balanceRouter: any;
let adminRouter: any;
let settings: any;
let getDb: any;
let getSqliteClient: any;
let schema: any;

function callerFor(router: any, user: any) {
  return router.createCaller({
    user,
    req: new Request("http://localhost/api/trpc"),
    resHeaders: new Headers(),
  });
}

async function makeUser(role = "user", balance = "0") {
  const db = getDb();
  const [user] = await db
    .insert(schema.users)
    .values({
      unionId: `test:d1:${Math.random().toString(36).slice(2)}`,
      name: "D1 Player",
      email: `d1-${Math.random().toString(36).slice(2)}@test.local`,
      role,
    })
    .returning();
  await db.insert(schema.balances).values({
    userId: user.id,
    currency: "USDT",
    available: balance,
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
  ({ getDb, getSqliteClient } = await import("../queries/connection"));
  schema = await import("../../db/schema");
  settings.setSetting("binance_pay_id", "85719015");
  settings.setSetting("binance_pay_name", "Test Pay");
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("D1: deposit review", () => {
  it("rejects a pending deposit with a reason and moves no money", async () => {
    const player = await makeUser("user", "100");
    const admin = await makeUser("admin");
    const pCaller = callerFor(balanceRouter, player);
    const aCaller = callerFor(adminRouter, admin);

    const dep = await pCaller.deposit({ currency: "USDT", amount: "25", reference: "BADREF-123" });
    await aCaller.rejectDeposit({ txId: dep.txId, reason: "Reference not found in Binance" });

    const row = getSqliteClient()
      .prepare("SELECT status, review_note FROM transactions WHERE id = ?")
      .get(dep.txId) as any;
    expect(row.status).toBe("failed");
    expect(row.review_note).toBe("Reference not found in Binance");

    const bal = getSqliteClient()
      .prepare("SELECT available FROM balances WHERE user_id = ? AND currency = 'USDT'")
      .get(player.id) as any;
    expect(bal.available).toBe("100");

    // A rejected deposit cannot be approved afterwards.
    await expect(aCaller.approveDeposit({ txId: dep.txId })).rejects.toThrow("not pending");
    // And rejection requires a real reason.
    const dep2 = await pCaller.deposit({ currency: "USDT", amount: "5", reference: "REF-OK-9999" });
    await expect(aCaller.rejectDeposit({ txId: dep2.txId, reason: "no" })).rejects.toThrow();
  });

  it("history filters by status and searches by reference and email", async () => {
    const player = await makeUser("user", "0");
    const admin = await makeUser("super_admin");
    const pCaller = callerFor(balanceRouter, player);
    const aCaller = callerFor(adminRouter, admin);

    const dep = await pCaller.deposit({ currency: "USDT", amount: "40", reference: "HISTORY-REF-1" });
    await aCaller.approveDeposit({ txId: dep.txId });

    const confirmed = await aCaller.listTransactions({ status: "confirmed", type: "deposit" });
    expect(confirmed.some((r: any) => r.id === dep.txId)).toBe(true);

    const failed = await aCaller.listTransactions({ status: "failed" });
    expect(failed.some((r: any) => r.id === dep.txId)).toBe(false);

    const byRef = await aCaller.listTransactions({ search: "HISTORY-REF-1" });
    expect(byRef.some((r: any) => r.id === dep.txId)).toBe(true);

    const byEmail = await aCaller.listTransactions({ search: player.email });
    expect(byEmail.some((r: any) => r.id === dep.txId)).toBe(true);

    const noMatch = await aCaller.listTransactions({ search: "zzz-no-such-thing" });
    expect(noMatch.some((r: any) => r.id === dep.txId)).toBe(false);

    // Approval credited exactly 40.
    const bal = getSqliteClient()
      .prepare("SELECT available FROM balances WHERE user_id = ? AND currency = 'USDT'")
      .get(player.id) as any;
    expect(bal.available).toBe("40");
  });

  it("players cannot use the review endpoints", async () => {
    const player = await makeUser("user", "0");
    const pAdminCaller = callerFor(adminRouter, player);
    await expect(pAdminCaller.listTransactions({})).rejects.toThrow();
    await expect(pAdminCaller.rejectDeposit({ txId: 1, reason: "test reason" })).rejects.toThrow();
  });
});

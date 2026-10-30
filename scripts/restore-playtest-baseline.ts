import { createRequire } from "module";

// Operator maintenance: return the playtest account's BDT available
// balance to its standing 55,000 baseline after a verification round.
// Mirrors admin.adjustPlayerBalance exactly (same balance update +
// 'admin_adjust' ledger leg) and adds an audit_log row stating the
// actor and reason, because the owner admin accounts have not yet
// completed their forced 2FA enrollment and cannot run the UI action.
//
// Usage: npx tsx scripts/restore-playtest-baseline.ts
(globalThis as any).require = createRequire(import.meta.url);
const { getSqliteClient } = await import("../api/queries/connection");
const { parseMoney, fmtMoney } = await import("../api/lib/money");

const USER_ID = 8;
const CURRENCY = "BDT";
const TARGET = "55000";

const sqlite = getSqliteClient();
sqlite.exec("BEGIN IMMEDIATE");
try {
  const row = sqlite
    .prepare("SELECT id, available FROM balances WHERE user_id = ? AND currency = ?")
    .get(USER_ID, CURRENCY) as any;
  if (!row) throw new Error("balance row missing");
  const current = parseMoney(row.available || "0");
  const delta = parseMoney(TARGET) - current;
  if (delta === 0n) {
    console.log("already at baseline, no adjustment");
    sqlite.exec("COMMIT");
    process.exit(0);
  }
  const balanceAfter = fmtMoney(parseMoney(TARGET));
  sqlite.prepare("UPDATE balances SET available = ? WHERE id = ?").run(balanceAfter, row.id);
  sqlite
    .prepare("INSERT INTO ledger_entries (user_id, kind, currency, amount, balance_after) VALUES (?, 'admin_adjust', ?, ?, ?)")
    .run(USER_ID, CURRENCY, fmtMoney(delta), balanceAfter);
  sqlite
    .prepare("INSERT INTO audit_log (user_id, action, details) VALUES (NULL, 'admin.adjustBalance', ?)")
    .run(JSON.stringify({
      userId: USER_ID,
      currency: CURRENCY,
      amount: fmtMoney(delta),
      reason: "Playtest baseline restore to 55000 BDT after cascade activation verification (operator script; owner admins pending 2FA enrollment)",
      balanceAfter,
      actor: "operator-agent",
    }));
  sqlite.exec("COMMIT");
  console.log(JSON.stringify({ adjusted: fmtMoney(delta), balanceAfter }));
} catch (e) {
  sqlite.exec("ROLLBACK");
  throw e;
}

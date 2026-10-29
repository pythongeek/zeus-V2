#!/usr/bin/env node
/**
 * F1: jackpot pool snapshots for the admin history chart + low-pool
 * alerts. Extracted from zeus-monitor.sh (2026-10-30): the inline
 * node -e version carried unescaped quotes, which made bash abandon
 * the monitor script at this block — health alerts, nightly
 * reconciliation and everything below it silently never ran.
 * Standalone file = no quoting hazards. Best-effort by design.
 */
import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
try {
  const db = new Database(process.env.ZEUS_DB_PATH || path.join(root, "data", "zeus.sqlite"));
  const pools = db.prepare("SELECT tier, current_amount FROM jackpot_pool").all();
  const ins = db.prepare("INSERT INTO jackpot_pool_snapshots (tier, amount) VALUES (?, ?)");
  for (const p of pools) ins.run(p.tier, p.current_amount);
  db.prepare("DELETE FROM jackpot_pool_snapshots WHERE created_at < unixepoch() - 30*86400").run();
  try {
    const poolsNow = db.prepare("SELECT tier, seed_amount, current_amount FROM jackpot_pool").all();
    for (const p of poolsNow) {
      if (parseFloat(p.current_amount) < parseFloat(p.seed_amount)) {
        const dup = db
          .prepare("SELECT id FROM admin_alerts WHERE kind = 'low_pool' AND ref_id = ? AND status IN ('open', 'acknowledged') LIMIT 1")
          .get(p.tier);
        if (!dup) {
          db.prepare(
            "INSERT INTO admin_alerts (kind, severity, title, details, ref_id) VALUES ('low_pool', 'warning', ?, ?, ?)",
          ).run(
            "Jackpot pool below seed: " + p.tier,
            JSON.stringify({ tier: p.tier, current: p.current_amount, seed: p.seed_amount }),
            p.tier,
          );
        }
      }
    }
  } catch {
    /* alerts table may predate migration 0018 */
  }
  db.close();
} catch {
  /* snapshots are best-effort */
}

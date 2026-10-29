#!/usr/bin/env node
/**
 * Prints the admin-configured alert webhook URL (settings), or
 * nothing. Extracted from zeus-monitor.sh for the same quoting
 * reason as pool-snapshot.mjs — the monitor captures stdout.
 */
import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
try {
  const db = new Database(process.env.ZEUS_DB_PATH || path.join(root, "data", "zeus.sqlite"), { readonly: true });
  const row = db.prepare("SELECT value FROM settings WHERE key = 'alert_webhook_url'").get();
  db.close();
  if (row) {
    const v = JSON.parse(row.value);
    if (typeof v === "string" && v) console.log(v);
  }
} catch {
  /* no webhook configured */
}

#!/usr/bin/env node
/**
 * migrate.mjs — apply pending migration files to an EXISTING Zeus
 * database, one file per transaction, recorded in a `_migrations`
 * table so every file runs exactly once.
 *
 * Fresh databases do NOT need this: the server bootstrap applies
 * every migration when the database is empty. This runner exists
 * for upgrades — the case the bootstrap deliberately skips.
 *
 * Usage:
 *   node scripts/migrate.mjs [--db <path>]            apply pending
 *   node scripts/migrate.mjs --baseline [--db <path>] record every
 *       current file as applied WITHOUT running it — for databases
 *       that were migrated by hand before this runner existed
 *       (e.g. production). Run --baseline once on such a database,
 *       then plain runs apply only genuinely new files.
 *
 * Default database: $ZEUS_DB_PATH or ./data/zeus.sqlite
 * Always back up the database file before migrating.
 */
import { createRequire } from "module";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const args = process.argv.slice(2);
const baseline = args.includes("--baseline");
const dbArgIdx = args.indexOf("--db");
const dbPath =
  (dbArgIdx >= 0 ? args[dbArgIdx + 1] : null) ||
  process.env.ZEUS_DB_PATH ||
  path.join(root, "data", "zeus.sqlite");
const migrationsDir =
  process.env.ZEUS_MIGRATIONS_DIR || path.join(root, "db", "migrations");

if (!fs.existsSync(dbPath)) {
  console.error(`[migrate] database not found: ${dbPath}`);
  process.exit(1);
}
if (!fs.existsSync(migrationsDir)) {
  console.error(`[migrate] migrations dir not found: ${migrationsDir}`);
  process.exit(1);
}

const Database = require(path.join(root, "node_modules", "better-sqlite3"));
const db = new Database(dbPath);
db.pragma("busy_timeout = 5000");
db.exec(
  "CREATE TABLE IF NOT EXISTS _migrations (filename TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)",
);

const files = fs
  .readdirSync(migrationsDir)
  .filter((f) => f.endsWith(".sql"))
  .sort();
const applied = new Set(
  db.prepare("SELECT filename FROM _migrations").all().map((r) => r.filename),
);
const record = db.prepare(
  "INSERT OR IGNORE INTO _migrations (filename, applied_at) VALUES (?, ?)",
);
const now = Math.floor(Date.now() / 1000);

if (baseline) {
  let n = 0;
  for (const f of files) {
    if (!applied.has(f)) {
      record.run(f, now);
      n++;
    }
  }
  console.log(
    `[migrate] baseline recorded ${n} file(s) as applied (${files.length} total) on ${dbPath}`,
  );
  db.close();
  process.exit(0);
}

const pending = files.filter((f) => !applied.has(f));
if (pending.length === 0) {
  console.log(`[migrate] up to date — ${files.length} migration(s), none pending`);
  db.close();
  process.exit(0);
}

console.log(`[migrate] applying ${pending.length} pending migration(s) to ${dbPath}:`);
for (const f of pending) {
  const sql = fs.readFileSync(path.join(migrationsDir, f), "utf8");
  const run = db.transaction(() => {
    db.exec(sql);
    record.run(f, now);
  });
  run();
  console.log(`[migrate] applied ${f}`);
}
console.log("[migrate] done");
db.close();

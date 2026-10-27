/// <reference types="@cloudflare/workers-types" />
import { drizzle as drizzleD1, DrizzleD1Database } from "drizzle-orm/d1";
import { drizzle as drizzleSqlite } from "drizzle-orm/better-sqlite3";
import * as schema from "@db/schema";
import * as relations from "@db/relations";

const fullSchema = { ...schema, ...relations };

let instance: DrizzleD1Database<typeof fullSchema> | null = null;

function createNodeDatabase() {
  // Node/VPS deployment: file-backed SQLite via better-sqlite3.
  // Required lazily so Cloudflare Workers builds never load native modules.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require("better-sqlite3");
  const fs = require("fs");
  const path = require("path");
  const dbPath =
    process.env.ZEUS_DB_PATH ||
    path.resolve(process.cwd(), "data", "zeus.sqlite");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  // Writers (spin transactions) wait up to 5s for the write lock instead of
  // failing with SQLITE_BUSY when requests overlap.
  sqlite.pragma("busy_timeout = 5000");
  return drizzleSqlite(sqlite, { schema: fullSchema });
}

function getNodeDatabase(): ReturnType<typeof createNodeDatabase> {
  return createNodeDatabase();
}

export function getDb(d1?: D1Database): DrizzleD1Database<typeof fullSchema> {
  if (d1) {
    return drizzleD1(d1, { schema: fullSchema });
  }
  if (!instance) {
    // If D1 binding is attached to globalThis or env (Cloudflare Workers)
    const globalD1 = (globalThis as unknown as { DB?: D1Database }).DB;
    if (globalD1) {
      instance = drizzleD1(globalD1, { schema: fullSchema });
    } else {
      // Node/VPS deployment: file-backed SQLite. The two drizzle dialects
      // share the same query-builder surface at runtime; the D1 type is kept
      // as the declared shape because every call site was written against it.
      instance = getNodeDatabase() as unknown as DrizzleD1Database<typeof fullSchema>;
    }
  }
  return instance;
}

/**
 * The raw better-sqlite3 client behind getDb() (Node/VPS only). Used where a
 * real synchronous multi-statement transaction is required (the spin path).
 * Throws on non-Node deployments where no file SQLite exists.
 */
export function getSqliteClient(): any {
  const db: any = getDb();
  const client = db?.$client;
  if (!client || typeof client.transaction !== "function") {
    throw new Error("SQLite client unavailable in this deployment");
  }
  return client;
}

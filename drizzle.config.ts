import "dotenv/config";
import { defineConfig } from "drizzle-kit";

// Local file-backed SQLite is the only production datastore.
// (The original template pointed this at Cloudflare D1; that path
// is gone — see README.md "Database & migrations".)
//
// Production schema changes ship as hand-written, sequentially
// numbered SQL files in db/migrations: the server bootstrap applies
// them to a fresh database, and scripts/migrate.mjs applies new
// ones to an existing database. `db:generate` below is a drafting
// aid for new schema diffs only — always review and renumber its
// output to the next sequential file before committing.
export default defineConfig({
  schema: "./db/schema.ts",
  out: "./db/migrations",
  dialect: "sqlite",
  dbCredentials: {
    url: process.env.ZEUS_DB_PATH ?? "./data/zeus.sqlite",
  },
});

// Production Node/VPS entry for Zeus Slot.
// Serves the built SPA from dist/public and the Hono API (tRPC + OAuth) on one port.
// Usage: node dist/server.js  (env: PORT, ZEUS_DB_PATH, APP_SECRET, ...)

import fs from "fs";
import path from "path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { compress } from "hono/compress";
import app from "./boot";

// --- One-time schema bootstrap for file-backed SQLite (Node/VPS deployments).
// Applies bundled migration files in order when the database is empty.
function bootstrapSchema() {
  const Database = require("better-sqlite3");
  const dbPath =
    process.env.ZEUS_DB_PATH ||
    path.resolve(process.cwd(), "data", "zeus.sqlite");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const sqlite = new Database(dbPath);
  const hasTables = sqlite
    .prepare("select count(*) as c from sqlite_master where type='table'")
    .get().c > 0;
  if (hasTables) {
    sqlite.close();
    return;
  }
  const migrationsDir = path.resolve(process.cwd(), "db", "migrations");
  if (fs.existsSync(migrationsDir)) {
    const files = fs
      .readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    for (const file of files) {
      const sql = fs.readFileSync(path.join(migrationsDir, file), "utf-8");
      for (const stmt of sql.split("--> statement-breakpoint")) {
        const trimmed = stmt.trim();
        if (trimmed) sqlite.exec(trimmed);
      }
      console.log(`[zeus] applied migration ${file}`);
    }
    console.log("[zeus] database schema bootstrap complete");
  } else {
    console.warn(
      `[zeus] WARNING: fresh database but no migrations dir at ${migrationsDir} — schema not created`,
    );
  }
  sqlite.close();
}

bootstrapSchema();

const port = parseInt(process.env.PORT || "3100", 10);
const distPublic = path.resolve(process.cwd(), "dist", "public");

// C3: gzip/brotli for text responses (JS/CSS/HTML/JSON).
app.use(compress());

// C3: cache policy — Vite-hashed bundles and game art under /assets/ are
// immutable for a year; HTML (and SPA route fallbacks) must revalidate so
// deploys take effect immediately.
app.use("*", async (c, next) => {
  await next();
  // F2: security headers on every response.
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
  c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  c.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  c.header(
    "Content-Security-Policy",
    "default-src 'self'; img-src 'self' data: blob:; media-src 'self'; font-src 'self' https://fonts.gstatic.com data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  );
  const p = c.req.path;
  if (p.startsWith("/api/")) return;
  if (p.startsWith("/assets/")) {
    c.header("Cache-Control", "public, max-age=31536000, immutable");
  } else if ((c.res.headers.get("content-type") || "").includes("text/html")) {
    c.header("Cache-Control", "no-cache");
  }
});

// Static assets + SPA fallback for client-side routes
app.use("*", serveStatic({ root: "./dist/public" }));
app.get("*", (c) => {
  if (c.req.path.startsWith("/api/")) {
    return c.json({ error: "Not Found" }, 404);
  }
  const indexPath = path.join(distPublic, "index.html");
  if (fs.existsSync(indexPath)) {
    return c.html(fs.readFileSync(indexPath, "utf-8"));
  }
  return c.text("Not Found", 404);
});

serve({ fetch: app.fetch, port }, () => {
  console.log(`[zeus] production server listening on http://0.0.0.0:${port}`);
});

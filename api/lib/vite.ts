import type { Hono } from "hono";
import type { HttpBindings } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import fs from "fs";
import path from "path";

type App = Hono<{ Bindings: HttpBindings }>;

export function serveStaticFiles(app: App) {
  const distPublic = path.resolve(process.cwd(), "dist/public");

  // Serve static assets from dist/public
  app.use("*", serveStatic({ root: "./dist/public" }));

  // Fallback all non-API GET requests to index.html for Single Page Application (SPA) routing
  app.get("*", (c) => {
    if (c.req.path.startsWith("/api/")) {
      return c.json({ error: "Not Found" }, 404);
    }
    const indexPath = path.resolve(distPublic, "index.html");
    if (fs.existsSync(indexPath)) {
      const content = fs.readFileSync(indexPath, "utf-8");
      return c.html(content);
    }
    return c.text("Not Found", 404);
  });
}

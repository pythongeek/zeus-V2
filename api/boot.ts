/// <reference types="@cloudflare/workers-types" />
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter } from "./router";
import { createContext } from "./context";
import { createOAuthCallbackHandler } from "./kimi/auth";
import { Paths } from "@contracts/constants";

export interface Bindings {
  DB?: D1Database;
}

const app = new Hono<{ Bindings: Bindings }>();

app.use("*", async (c, next) => {
  if (c.env?.DB) {
    (globalThis as unknown as { DB: D1Database }).DB = c.env.DB;
  }
  await next();
});

app.use(bodyLimit({ maxSize: 50 * 1024 * 1024 }));
app.get(Paths.oauthCallback, createOAuthCallbackHandler());
app.use("/api/trpc/*", async (c) => {
  return fetchRequestHandler({
    endpoint: "/api/trpc",
    req: c.req.raw,
    router: appRouter,
    createContext,
  });
});
app.get("/api/health", (c) => c.json({ status: "ok", name: "zeus-slot-game" }));
app.all("/api/*", (c) => c.json({ error: "Not Found" }, 404));

export default app;

if (typeof process !== "undefined" && process.env?.NODE_ENV === "development" && !process.env.CF_PAGES) {
  try {
    const { serve } = await import("@hono/node-server");
    const { serveStaticFiles } = await import("./lib/vite");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    serveStaticFiles(app as any);

    const port = parseInt(process.env.PORT || "3000");
    serve({ fetch: app.fetch as any, port }, () => {
      console.log(`Server running on http://localhost:${port}/`);
    });
  } catch {
    // Ignore node-server import when bundled for workers
  }
}

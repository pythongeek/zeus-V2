/// <reference types="@cloudflare/workers-types" />
import app from "./boot";

export interface Env {
  DB: D1Database;
  APP_ID?: string;
  APP_SECRET?: string;
  KIMI_AUTH_URL?: string;
  KIMI_OPEN_URL?: string;
  OWNER_UNION_ID?: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (env.DB) {
      (globalThis as unknown as { DB: D1Database }).DB = env.DB;
    }
    return app.fetch(request, env, ctx);
  },
};

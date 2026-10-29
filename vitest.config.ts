import { defineConfig } from "vitest/config";
import path from "path";

const templateRoot = path.resolve(import.meta.dirname);

export default defineConfig({
  root: templateRoot,
  resolve: {
    alias: {
      "@": path.resolve(templateRoot, "src"),
      "@contracts": path.resolve(templateRoot, "contracts"),
      "@assets": path.resolve(templateRoot, "attached_assets"),
      "@db": path.resolve(templateRoot, "db"),
    },
  },
  test: {
    environment: "node",
    include: ["api/**/*.test.ts", "api/**/*.spec.ts"],
    // Tests sign sessions with APP_SECRET (api/lib/env.ts refuses a
    // short one). Provide a clearly-labelled test-only value so a
    // fresh clone passes `npm test` with zero setup; a real .env
    // value, when present, wins.
    env: {
      APP_SECRET:
        process.env.APP_SECRET ??
        "test-only-secret-not-for-production-0123456789abcdef",
    },
  },
});

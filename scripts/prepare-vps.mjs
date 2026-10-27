// prepare-vps.mjs — stage runtime files into dist/ for the VPS bundle.
// dist/ after this script:
//   dist/server.js          (built by esbuild afterwards)
//   dist/public/            (built by vite beforehand)
//   dist/db/migrations/     (applied by server.js bootstrap on fresh DB)
import { cpSync, mkdirSync, existsSync } from "fs";

if (!existsSync("dist/public")) {
  console.error("dist/public missing — run `vite build` first (npm run build does this).");
  process.exit(1);
}
mkdirSync("dist/db/migrations", { recursive: true });
cpSync("db/migrations", "dist/db/migrations", { recursive: true });
console.log("[prepare-vps] staged dist/db/migrations");

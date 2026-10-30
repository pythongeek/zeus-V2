import fs from "fs";
import { createRequire } from "module";
import type { CascadeMath } from "../api/lib/cascade";

// api/queries/connection.ts resolves better-sqlite3 through a bare
// `require` (the server bundle injects one via its esbuild banner).
// Under tsx there is no ambient require, so provide one on the
// global before the connection module is first called, and load the
// DB-touching modules dynamically so the shim lands first.
(globalThis as any).require = createRequire(import.meta.url);
const { getSqliteClient } = await import("../api/queries/connection");
const { registerCascadeBundle, getBundleById } = await import("../api/lib/bundles");
const { setSetting } = await import("../api/lib/settings");

/**
 * Cascade activation (the certification publish): registers the
 * certified math as the ACTIVE cascade bundle with its cert,
 * parks every other cascade bundle, and opens the mode. The buy
 * feature stays OFF (its own flag, owner's call) — its price
 * derives from this same cert when enabled.
 *
 * Usage: npx tsx scripts/cascade-activate.ts <math.json> <cert.json> [version]
 */
const [mathFile, certFile, versionArg] = process.argv.slice(2);
const math = JSON.parse(fs.readFileSync(mathFile, "utf8")) as CascadeMath;
const cert = JSON.parse(fs.readFileSync(certFile, "utf8"));
if (cert.result !== "PASS") {
  console.error(`Refusing to activate: cert result is ${cert.result}`);
  process.exit(1);
}
const version = Number(versionArg ?? 1);
const client = getSqliteClient();
client.prepare("UPDATE math_bundles SET status = 'parked' WHERE mode_id = 'cascade' AND status = 'active'").run();
const row = registerCascadeBundle(client, math, version, { status: "active", cert });
setSetting("cascade_enabled", true, null);
console.log(JSON.stringify({
  activated: row.bundle_id,
  sha256: row.sha256,
  certRtp: cert.run.rtp,
  certSigma: cert.run.sigma,
  featureExpectationX: cert.run.featureExpectationX,
  cascadeEnabled: true,
  buyFeatureEnabled: false,
}));
if (getBundleById(client, row.bundle_id)?.status !== "active") {
  console.error("activation did not stick");
  process.exit(1);
}

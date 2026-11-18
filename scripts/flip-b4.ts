// U5-B4 activation flip: park the v1 unified bundles, activate
// the certified gated-wild v2 bundles, and re-declare the RTP to
// the v2 certified value (96.288% -> 96.29). Audited. Rollback is
// the exact inverse (reactivate v1, park v2, rtp_declared 96.34);
// rounds pinned to v2 keep resolving through their pin either way.
import { createRequire } from "node:module";
(globalThis as any).require = createRequire(import.meta.url);
const { getSqliteClient } = await import("/opt/zeus-slot/api/queries/connection.ts");
const { setSetting } = await import("/opt/zeus-slot/api/lib/settings.ts");

const client = getSqliteClient();
const now = Math.floor(Date.now() / 1000);
const flip = client.transaction(() => {
  client.prepare("UPDATE math_bundles SET status = 'parked' WHERE bundle_id = 'zeus-unified-cascade-v1'").run();
  client.prepare("UPDATE math_bundles SET status = 'active', activated_at = ? WHERE bundle_id = 'zeus-unified-cascade-v2'").run(now);
  client.prepare("UPDATE math_bundles SET status = 'parked' WHERE bundle_id = 'zeus-unified-v1'").run();
  client.prepare("UPDATE math_bundles SET status = 'active', activated_at = ? WHERE bundle_id = 'zeus-unified-v2'").run(now);
});
flip();
setSetting("rtp_declared", 96.29, null);
const audit = client.prepare("INSERT INTO audit_log (user_id, action, details) VALUES (NULL, ?, ?)");
audit.run("u5b_wild_launch", JSON.stringify({
  cascadeBundle: "zeus-unified-cascade-v2",
  composition: "zeus-unified-v2",
  certifiedRtp: 96.288,
  rtp_declared: 96.29,
  wild: { id: 11, weight: 2, gate: "1 in 3" },
  by: "operator-agent (U5-B4 flip)",
}));
for (const r of client.prepare("SELECT bundle_id, status FROM math_bundles WHERE mode_id IN ('cascade-unified', 'unified') ORDER BY bundle_id").all()) {
  console.log((r as any).bundle_id, (r as any).status);
}
console.log("rtp_declared:", JSON.stringify(client.prepare("SELECT value FROM settings WHERE key = 'rtp_declared'").get()));
console.log("DONE");
process.exit(0);

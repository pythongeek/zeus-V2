// U5-B2: register the gated-wild bundles, PARKED (activation is a
// separate, audited step in U5-B4):
//   zeus-unified-cascade-v2 (mode cascade-unified): the v1 unified
//     math + Lightning Wild (id 11, weight 2, gate 1-in-3) and the
//     certified paytable trim (v1 x 0.81 x 0.9937, rounded to
//     tenths, the rounded table is what was priced).
//   zeus-unified-v2 (mode unified): the composition cert record.
// Certified 2026-11-18: round MC at certification volume on fresh
// streams (400k at 12, 100k at 15, 60k at 20) with the production
// resolver: R12 4.9407, R15 7.0926, R20 11.3128, mixEv 5.1717,
// unified RTP 96.288% +/- 0.043pp; full-process MC cross-check for
// sigma (argv: rtp sigma).
// NOTE: registerUnifiedCascadeBundle hard-codes the v1 id, so this
// script inserts directly, mirroring flip-u4's composition insert.
import { createRequire } from "node:module";
(globalThis as any).require = createRequire(import.meta.url);
import { createHash } from "node:crypto";
const { getSqliteClient } = await import("/opt/zeus-slot/api/queries/connection.ts");
const { getBundleById, canonicalStringify } = await import("/opt/zeus-slot/api/lib/bundles.ts");

const procRtp = parseFloat(process.argv[2] ?? "0");
const procSigma = parseFloat(process.argv[3] ?? "0");
if (!procRtp || !procSigma) throw new Error("usage: register-v2.ts <processRtp> <processSigma>");

const client = getSqliteClient();
const v1Row: any = getBundleById(client, "zeus-unified-cascade-v1");
const V1 = JSON.parse(v1Row.bundle).math;
const round1 = (x: number) => Math.round(x * 10) / 10;
const paytable: Record<string, number[]> = {};
for (const [k, v] of Object.entries(V1.paytable as Record<string, number[]>)) {
  paytable[k] = (v as number[]).map((x) => round1(x * 0.81 * 0.9937));
}
const math = { ...V1, paytable, wildId: 11, wildWeight: 2, wildGate: [1, 3] };

const sha256Hex = (s: string) => createHash("sha256").update(s).digest("hex");

const cascadeBundle = { bundleId: "zeus-unified-cascade-v2", modeId: "cascade-unified", engine: "cascade", math };
const cascadeCanonical = canonicalStringify(cascadeBundle);
const cascadeSha = sha256Hex(cascadeCanonical);
const cascadeCert = {
  result: "PASS",
  kind: "unified-fs-math",
  note: "Unified free-spin math with the gated Lightning Wild (weight 2, live in 1 round in 3, gate rolled from the trigger spin hash). Paytable trimmed x0.81 x0.9937 vs v1 to hold RTP after the wild. Certified as part of zeus-unified-v2.",
  wild: { id: 11, weight: 2, gate: [1, 3], seenInLiveRounds: 0.977, paidInLiveRounds: 0.723, paidInAllRounds: 0.241, assistedShareOfRoundWin: 0.165 },
  stats: { roundWinRate: 0.9317, spinClusterRate: 0.2037, spinsPerRound: 12.17, roundSd: 6.861, p50: 2.6, p90: 12.1, p99: 34.1 },
};
const existingC = getBundleById(client, "zeus-unified-cascade-v2");
if (existingC) {
  if (existingC.sha256 !== cascadeSha) throw new Error("zeus-unified-cascade-v2 exists with different math");
  console.log("zeus-unified-cascade-v2 already registered, sha:", existingC.sha256);
} else {
  client.prepare(
    `INSERT INTO math_bundles (bundle_id, mode_id, engine, bundle, sha256, math_hash, status, cert)
     VALUES ('zeus-unified-cascade-v2', 'cascade-unified', 'cascade', ?, ?, ?, 'parked', ?)`,
  ).run(JSON.stringify(cascadeBundle), cascadeSha, cascadeSha, JSON.stringify(cascadeCert));
  console.log("zeus-unified-cascade-v2 registered PARKED, sha:", cascadeSha);
}

const composition = {
  bundleId: "zeus-unified-v2",
  modeId: "unified",
  engine: "unified-1",
  classicBundleId: "zeus-classic-v2",
  cascadeBundleId: "zeus-unified-cascade-v2",
  awards: { "3": 12, "4": 15, "5": 20 },
  base: { lines: 0.6151, scatter: 0.1008, thunder: 0.0151, jackpot: 0.0108, total: 0.7418 },
  triggerProb: 0.042749,
};
const compCanonical = JSON.stringify(composition);
const compSha = sha256Hex(compCanonical);
const compCert = {
  result: "PASS",
  method: "exact classic base enumeration (Lab exactBase) + Lab thunder MC + exact scatter distribution + unified cascade round MC at certification volume (400k/100k/60k rounds, fresh streams, production resolver with the wild gate) + full-process MC cross-check (250k processes, gate rolled from the trigger hash as in production)",
  run: { rtp: 0.96288, sigma: procSigma },
  rtp_hat: 0.96288,
  sigma_hat: procSigma,
  processCrossCheck: { rtp: procRtp },
  awards: { "3": 12, "4": 15, "5": 20 },
  roundEv: { "12": 4.9407, "15": 7.0926, "20": 11.3128 },
  certifiedAt: "2026-11-18",
};
const existingU = getBundleById(client, "zeus-unified-v2");
if (existingU) {
  if (existingU.sha256 !== compSha) throw new Error("zeus-unified-v2 exists with different content");
  console.log("zeus-unified-v2 already registered, sha:", existingU.sha256);
} else {
  client.prepare(
    `INSERT INTO math_bundles (bundle_id, mode_id, engine, bundle, sha256, math_hash, status, cert)
     VALUES ('zeus-unified-v2', 'unified', 'unified-1', ?, ?, ?, 'parked', ?)`,
  ).run(compCanonical, compSha, compSha, JSON.stringify(compCert));
  console.log("zeus-unified-v2 registered PARKED, sha:", compSha);
}
console.log("DONE");
process.exit(0);

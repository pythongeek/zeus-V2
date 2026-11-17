/**
 * Mode registry & math bundles (Cascade Decision Playbook §5.2/§5.3).
 *
 * A math bundle is an immutable, versioned JSON document that fully
 * determines a mode's outcomes. Bundles are pinned by SHA-256; the only
 * mutable state is which bundle is 'active' per mode. Every spin stamps
 * the bundle that resolved it (spins.bundle_id / bundle_sha256), so any
 * historical spin can be replayed against the exact math that produced
 * it, and the RTP tripwire can audit bundle hashes against this registry.
 *
 * Classic activation governance (audit 2026-11-04, A4/A5):
 *  - The engine NEVER falls back to hardcoded constants. The only math
 *    sources are (a) the active certified bundle and (b) the settings
 *    mirror that only the RTP Lab publish writes.
 *  - The active bundle's math_hash is re-verified against the settings
 *    mirror on EVERY spin. A settings edit that skipped certification
 *    desyncs the two and the spin refuses (MATH_DESYNC) until the
 *    operator publishes through the RTP Lab (which runs the certifier
 *    and enforces the publish bounds).
 *  - Fresh installs self-bootstrap: the settings default math is
 *    certified inline (exact enumeration + thunder MC, bounds-checked)
 *    before it may activate. Nothing activates without a measured cert.
 */
import crypto from "crypto";
import { getSqliteClient } from "../queries/connection";
import { getSetting } from "./settings";
import type { MathConfig } from "../routers/game";

type SqliteClient = ReturnType<typeof getSqliteClient>;

export interface BundleRow {
  bundle_id: string;
  mode_id: string;
  engine: string;
  bundle: string;
  sha256: string;
  math_hash: string;
  status: string;
  cert: string | null;
  created_at: number;
  activated_at: number | null;
}

/** Deterministic JSON: object keys sorted recursively, arrays in order. */
export function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return "[" + value.map(canonicalStringify).join(",") + "]";
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalStringify(obj[k])).join(",") + "}";
}

export function sha256Hex(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

/** The math-only part of the classic bundle (drives math_hash). */
export function classicMathPart(math: MathConfig, symbolNames: Record<number, string>) {
  const paytable: Record<string, { 3: number; 4: number; 5: number }> = {};
  for (const [id, pays] of Object.entries(math.payouts)) {
    paytable[symbolNames[Number(id)] ?? `sym${id}`] = pays as { 3: number; 4: number; 5: number };
  }
  return {
    engine: "lines-5x3",
    lines: 20,
    symbols: { ...symbolNames },
    paytable,
    reels: math.strips.map((strip) => strip.map((id) => symbolNames[id] ?? `sym${id}`)),
    free_spins: { ...math.freeSpins },
    thunder: { denominator: math.thunderDenominator, floor_x: math.thunderFloorX },
  };
}

export function buildClassicBundle(
  math: MathConfig,
  symbolNames: Record<number, string>,
  bundleId: string,
  certRtpPercent: number,
) {
  const mathPart = classicMathPart(math, symbolNames);
  const bundle = {
    bundle_id: bundleId,
    mode_id: "classic",
    ...mathPart,
    cert: {
      method: "exact-enumeration (base + free spins) + monte-carlo (thunder strike)",
      rtp_percent: certRtpPercent,
      source: "RTP Lab certification of the identical math",
    },
  };
  const json = canonicalStringify(bundle);
  return { bundle, json, sha256: sha256Hex(json), mathHash: sha256Hex(canonicalStringify(mathPart)) };
}

function getActiveRow(sqlite: SqliteClient, modeId: string): BundleRow | null {
  return (sqlite
    .prepare("SELECT * FROM math_bundles WHERE mode_id = ? AND status = 'active'")
    .get(modeId) as BundleRow | undefined) ?? null;
}

/* ---- Classic: strict bundle <-> settings binding (A4/A5) ---- */

/** Parse a classic bundle payload into the engine's MathConfig.
 * Throws (never falls back) when anything is malformed. */
export function classicCfgFromBundle(payload: unknown, symbolNames: Record<number, string>): MathConfig {
  const b = payload as Record<string, any>;
  if (!b || typeof b !== "object" || b.engine !== "lines-5x3") {
    throw new Error("BUNDLE_INVALID: not a lines-5x3 classic bundle");
  }
  const idByName = new Map<string, number>();
  for (const [idStr, name] of Object.entries(symbolNames)) idByName.set(name, Number(idStr));
  if (typeof b.paytable !== "object" || !b.paytable) throw new Error("BUNDLE_INVALID: paytable missing");
  const payouts: Record<number, { 3: number; 4: number; 5: number }> = {};
  for (const [name, id] of idByName) {
    const p = b.paytable[name];
    if (!p || ![3, 4, 5].every((k) => Number.isFinite((p as Record<number, number>)[k]) && (p as Record<number, number>)[k] >= 0)) {
      throw new Error(`BUNDLE_INVALID: paytable missing/invalid for symbol ${name}`);
    }
    const pp = p as Record<number, number>;
    payouts[id] = { 3: pp[3], 4: pp[4], 5: pp[5] };
  }
  if (!Array.isArray(b.reels) || b.reels.length !== 5 ||
      !b.reels.every((r: unknown) => Array.isArray(r) && r.length >= 10 && r.every((v: unknown) => typeof v === "string" && idByName.has(v)))) {
    throw new Error("BUNDLE_INVALID: reels must be 5 strips of >=10 known symbol names");
  }
  const strips: number[][] = (b.reels as string[][]).map((strip) =>
    strip.map((name) => idByName.get(name) as number),
  );
  const fs = b.free_spins;
  if (!fs || !["3", "4", "5"].every((k) => Number.isInteger(fs[k]) && fs[k] >= 0 && fs[k] <= 1000)) {
    throw new Error("BUNDLE_INVALID: free_spins must define integer counts for 3/4/5 scatters");
  }
  const th = b.thunder;
  if (!th || !Number.isInteger(th.denominator) || th.denominator < 1 || th.denominator > 100000 ||
      !Number.isFinite(th.floor_x) || th.floor_x < 0 || th.floor_x > 100) {
    throw new Error("BUNDLE_INVALID: thunder must define denominator 1..100000 and floor_x 0..100");
  }
  return {
    payouts,
    strips,
    freeSpins: { "3": fs["3"], "4": fs["4"], "5": fs["5"] },
    thunderDenominator: th.denominator,
    thunderFloorX: th.floor_x,
  };
}

/** The settings mirror (math_* keys) parsed STRICTLY. The settings
 * registry carries the certified defaults, so this always yields a
 * coherent config; corrupt values throw instead of falling back. */
export function settingsMathConfig(): MathConfig {
  const p = getSetting<Record<string, { 3: number; 4: number; 5: number }>>("math_paytable");
  const st = getSetting<number[][]>("math_reels");
  const fs = getSetting<Record<string, number>>("math_free_spins");
  const th = getSetting<{ chanceDenominator: number; floorX: number }>("math_thunder");
  if (!p || !st || !fs || !th) throw new Error("MATH_INVALID: math settings are missing");
  const payouts: Record<number, { 3: number; 4: number; 5: number }> = {};
  for (let id = 0; id <= 10; id++) {
    const e = p[String(id)] as Record<number, number> | undefined;
    if (!e || ![3, 4, 5].every((k) => Number.isFinite(e[k]) && e[k] >= 0)) {
      throw new Error(`MATH_INVALID: settings paytable invalid for symbol id ${id}`);
    }
    payouts[id] = { 3: e[3], 4: e[4], 5: e[5] };
  }
  if (!Array.isArray(st) || st.length !== 5 ||
      !st.every((r) => Array.isArray(r) && r.length >= 10 && r.every((v) => Number.isInteger(v) && v >= 0 && v <= 10))) {
    throw new Error("MATH_INVALID: settings reels invalid");
  }
  if (!["3", "4", "5"].every((k) => Number.isInteger(fs[k]) && fs[k] >= 0 && fs[k] <= 1000)) {
    throw new Error("MATH_INVALID: settings free spins invalid");
  }
  if (!Number.isInteger(th.chanceDenominator) || th.chanceDenominator < 1 || th.chanceDenominator > 100000 ||
      !Number.isFinite(th.floorX) || th.floorX < 0 || th.floorX > 100) {
    throw new Error("MATH_INVALID: settings thunder invalid");
  }
  return { payouts, strips: st, freeSpins: { "3": fs["3"], "4": fs["4"], "5": fs["5"] }, thunderDenominator: th.chanceDenominator, thunderFloorX: th.floorX };
}

/** Sync reader for non-spin callers (paytable, admin mirror, tests).
 * Resolves the ACTIVE bundle only — no fallback math exists. */
export function getActiveCertifiedClassic(sqlite: SqliteClient, symbolNames: Record<number, string>): { row: BundleRow; cfg: MathConfig } | null {
  const row = getActiveRow(sqlite, "classic");
  if (!row) return null;
  try {
    const cert = row.cert ? (JSON.parse(row.cert) as { rtp_percent?: unknown }) : null;
    if (!cert || typeof cert.rtp_percent !== "number" || !(cert.rtp_percent >= 50 && cert.rtp_percent <= 100)) {
      return null; // uncertified — refuse
    }
    const cfg = classicCfgFromBundle(typeof row.bundle === "string" ? JSON.parse(row.bundle) : row.bundle, symbolNames);
    return { row, cfg };
  } catch {
    return null; // malformed bundle or cert — refuse, never fall back
  }
}

/** Hash the settings mirror and compare with the active bundle. */
function settingsMatchActive(sqlite: SqliteClient, symbolNames: Record<number, string>): { row: BundleRow; cfg: MathConfig } | "NO_ACTIVE" | "DESYNC" {
  const active = getActiveRow(sqlite, "classic");
  if (!active) return "NO_ACTIVE";
  const settingsCfg = settingsMathConfig();
  const settingsHash = sha256Hex(canonicalStringify(classicMathPart(settingsCfg, symbolNames)));
  if (active.math_hash !== settingsHash) return "DESYNC";
  const cfg = classicCfgFromBundle(typeof active.bundle === "string" ? JSON.parse(active.bundle) : active.bundle, symbolNames);
  return { row: active, cfg };
}

/**
 * Resolve the classic math for a spin. Bootstrap-safe: when no active
 * bundle exists, the settings default math is certified inline (exact
 * enumeration + thunder MC, bounds-checked) before it activates —
 * nothing goes live without a measured certificate. When an active
 * bundle exists but the settings mirror drifted from it (an edit that
 * skipped the RTP Lab), the spin REFUSES (MATH_DESYNC) — certification
 * is the only door that changes live math.
 */
export async function ensureActiveCertifiedClassicBundle(symbolNames: Record<number, string>): Promise<{ row: BundleRow; cfg: MathConfig }> {
  const sqlite = getSqliteClient();
  const state = settingsMatchActive(sqlite, symbolNames);
  if (state === "DESYNC") {
    throw new Error(
      "MATH_DESYNC: math settings changed without publishing. Open the RTP Lab and publish (with certification) to activate them.",
    );
  }
  if (state !== "NO_ACTIVE") return state;

  // Bootstrap: certify the settings default math, then activate.
  const cfg = settingsMathConfig();
  const paytableForCert: Record<string, { 3: number; 4: number; 5: number }> = {};
  for (const [id, pays] of Object.entries(cfg.payouts)) {
    paytableForCert[String(id)] = pays as { 3: number; 4: number; 5: number };
  }
  const { certifyMath } = await import("./certify");
  const cert = certifyMath({
    paytable: paytableForCert,
    reels: cfg.strips,
    freeSpins: cfg.freeSpins,
    thunder: { chanceDenominator: cfg.thunderDenominator, floorX: cfg.thunderFloorX },
  });
  const min = getSetting<number>("rtp_publish_min") ?? 90;
  const max = getSetting<number>("rtp_publish_max") ?? 98;
  if (cert.totalPct < min || cert.totalPct > max) {
    throw new Error(
      `MATH_NOT_CERTIFIABLE: default math certifies at ${cert.totalPct}%, outside the publish bounds ${min}-${max}%. Classic is disabled until the math is fixed and published.`,
    );
  }
  return activateClassicBundle(sqlite, cfg, symbolNames, { rtpPercent: cert.totalPct, breakdown: cert });
}

/** Register + activate a classic bundle (the publish door). Parks any
 * previous active and stores the full certification with the bundle. */
export function activateClassicBundle(
  sqlite: SqliteClient,
  cfg: MathConfig,
  symbolNames: Record<number, string>,
  cert: { rtpPercent: number; breakdown?: unknown },
): { row: BundleRow; cfg: MathConfig } {
  const count = sqlite
    .prepare("SELECT COUNT(*) AS c FROM math_bundles WHERE mode_id = 'classic'")
    .get() as { c: number };
  const bundleId = `zeus-classic-v${count.c + 1}`;
  const { json, sha256 } = buildClassicBundle(cfg, symbolNames, bundleId, cert.rtpPercent);
  const certJson = JSON.stringify({
    method: "exact-enumeration (base + free spins) + monte-carlo (thunder strike)",
    rtp_percent: cert.rtpPercent,
    breakdown: cert.breakdown ?? null,
  });
  const park = sqlite.prepare("UPDATE math_bundles SET status = 'parked' WHERE mode_id = 'classic' AND status = 'active'");
  const insert = sqlite.prepare(
    "INSERT INTO math_bundles (bundle_id, mode_id, engine, bundle, sha256, math_hash, status, cert, activated_at) VALUES (?, 'classic', 'lines-5x3', ?, ?, ?, 'active', ?, unixepoch())",
  );
  const activate = sqlite.transaction(() => {
    park.run();
    insert.run(bundleId, json, sha256, sha256Hex(canonicalStringify(classicMathPart(cfg, symbolNames))), certJson);
  });
  activate();
  const row = sqlite.prepare("SELECT * FROM math_bundles WHERE bundle_id = ?").get(bundleId) as BundleRow;
  return { row, cfg };
}

/* ---- Cascade bundles (Step 5) ---- */

export interface CascadeBundleMath {
  symbols: number[];
  weights: Record<string, number>[];
  scatterId: number;
  attach: number[];
  paytable: Record<string, [number, number, number, number]>;
  ladder: number[];
  fsTable: Record<string, number>;
  fsRetrigger: number;
  capX: number;
}

export function buildCascadeBundle(math: CascadeBundleMath, version: number) {
  const bundleId = `zeus-cascade-v${version}`;
  const bundle = {
    bundleId,
    modeId: "cascade",
    engine: "cascade",
    math,
  };
  const canonical = canonicalStringify(bundle);
  return { bundleId, bundle, sha256: sha256Hex(canonical) };
}

/**
 * Register a cascade bundle (idempotent per version). New bundles
 * land as 'draft'; activation is a separate, deliberate act (the
 * certification publish), except when opts.activate is set by a
 * test or the publish flow itself.
 */
export function registerCascadeBundle(
  sqlite: SqliteClient,
  math: CascadeBundleMath,
  version: number,
  opts: { status?: string; cert?: unknown } = {},
): BundleRow {
  const { bundleId, bundle, sha256 } = buildCascadeBundle(math, version);
  const existing = getBundleById(sqlite, bundleId);
  if (existing) {
    if (existing.sha256 !== sha256) {
      throw new Error(`Bundle ${bundleId} already exists with different math — bump the version`);
    }
    return existing;
  }
  sqlite
    .prepare(
      `INSERT INTO math_bundles (bundle_id, mode_id, engine, bundle, sha256, math_hash, status, cert)
       VALUES (?, 'cascade', 'cascade', ?, ?, ?, ?, ?)`,
    )
    .run(bundleId, JSON.stringify(bundle), sha256, sha256, opts.status ?? "draft", opts.cert ? JSON.stringify(opts.cert) : null);
  return getBundleById(sqlite, bundleId)!;
}

/**
 * U4 Option B: register the unified game's cascade bundle. The
 * math is cascade-shaped (same engine), but it lives under its
 * own mode_id ('cascade-unified') and bundle id, so the spin
 * path can pin converted free-spin rounds to it without ever
 * touching the standalone cascade mode's certified bundle.
 */
export function registerUnifiedCascadeBundle(
  sqlite: SqliteClient,
  math: CascadeBundleMath,
  opts: { status?: string; cert?: unknown } = {},
): BundleRow {
  const bundleId = "zeus-unified-cascade-v1";
  const bundle = {
    bundleId,
    modeId: "cascade-unified",
    engine: "cascade",
    math,
  };
  const sha256 = sha256Hex(canonicalStringify(bundle));
  const existing = getBundleById(sqlite, bundleId);
  if (existing) {
    if (existing.sha256 !== sha256) {
      throw new Error(`Bundle ${bundleId} already exists with different math — bump the version`);
    }
    return existing;
  }
  sqlite
    .prepare(
      `INSERT INTO math_bundles (bundle_id, mode_id, engine, bundle, sha256, math_hash, status, cert)
       VALUES (?, 'cascade-unified', 'cascade', ?, ?, ?, ?, ?)`,
    )
    .run(bundleId, JSON.stringify(bundle), sha256, sha256, opts.status ?? "draft", opts.cert ? JSON.stringify(opts.cert) : null);
  return getBundleById(sqlite, bundleId)!;
}

export function getActiveBundle(sqlite: SqliteClient, modeId: string): BundleRow | null {
  return getActiveRow(sqlite, modeId);
}

export function getBundleByHash(sqlite: SqliteClient, sha256: string): BundleRow | null {
  return (sqlite.prepare("SELECT * FROM math_bundles WHERE sha256 = ?").get(sha256) as BundleRow | undefined) ?? null;
}

export function getBundleById(sqlite: SqliteClient, bundleId: string): BundleRow | null {
  return (sqlite.prepare("SELECT * FROM math_bundles WHERE bundle_id = ?").get(bundleId) as BundleRow | undefined) ?? null;
}

/**
 * Registry view for clients/config: one entry per known mode — the active
 * bundle when one exists, otherwise the newest bundle (parked), so a
 * parked mode reads as unavailable rather than vanishing silently.
 */
export function listModes(sqlite: SqliteClient): Array<{
  modeId: string;
  status: string;
  bundleId: string;
  sha256: string;
  engine: string;
}> {
  const rows = sqlite
    .prepare("SELECT * FROM math_bundles ORDER BY created_at ASC, bundle_id ASC")
    .all() as BundleRow[];
  const byMode = new Map<string, BundleRow>();
  for (const r of rows) {
    const cur = byMode.get(r.mode_id);
    if (!cur || r.status === "active" || cur.status !== "active") byMode.set(r.mode_id, r);
  }
  return [...byMode.values()].map((r) => {
    let certRtp: number | null = null;
    try {
      if (r.cert) {
        const cert = JSON.parse(r.cert);
        if (typeof cert.rtp === "number") certRtp = cert.rtp;
        else if (cert.run && typeof cert.run.rtp === "number") certRtp = cert.run.rtp;
      }
      if (certRtp === null && r.bundle) {
        const bundleCert = JSON.parse(r.bundle)?.cert;
        if (bundleCert && typeof bundleCert.rtp_percent === "number") {
          certRtp = bundleCert.rtp_percent / 100;
        }
      }
    } catch { /* certs are JSON by construction */ }
    return {
      modeId: r.mode_id,
      status: r.status,
      bundleId: r.bundle_id,
      sha256: r.sha256,
      engine: r.engine,
      certRtp,
    };
  });
}

/** Convenience wrapper on the shared connection (non-transactional reads). */
export function listModesDefault() {
  return listModes(getSqliteClient());
}

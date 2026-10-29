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
 * The classic bundle is derived from the EFFECTIVE math config
 * (getMathConfig: settings over certified defaults), so it stays truthful
 * no matter which door the math changed through (RTP Lab publish, Game
 * Config settings edit). When the effective math drifts from the active
 * bundle, the next spin auto-registers the next version and parks the old
 * one — the registry is an append-only history, never an edit.
 */
import crypto from "crypto";
import { getSqliteClient } from "../queries/connection";
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

/**
 * Return the active classic bundle, registering the next version first if
 * the effective math has drifted from it (or none exists yet). Safe to
 * call inside the spin transaction: reads/writes join the caller's txn.
 */
export function ensureActiveClassicBundle(
  sqlite: SqliteClient,
  math: MathConfig,
  symbolNames: Record<number, string>,
  certRtpPercent: number,
): BundleRow {
  const mathPart = classicMathPart(math, symbolNames);
  const mathHash = sha256Hex(canonicalStringify(mathPart));
  const active = getActiveRow(sqlite, "classic");
  if (active && active.math_hash === mathHash) return active;

  const count = sqlite
    .prepare("SELECT COUNT(*) AS c FROM math_bundles WHERE mode_id = 'classic'")
    .get() as { c: number };
  const bundleId = `zeus-classic-v${count.c + 1}`;
  const { json, sha256 } = buildClassicBundle(math, symbolNames, bundleId, certRtpPercent);
  if (active) {
    sqlite.prepare("UPDATE math_bundles SET status = 'parked' WHERE bundle_id = ?").run(active.bundle_id);
  }
  sqlite
    .prepare(
      "INSERT INTO math_bundles (bundle_id, mode_id, engine, bundle, sha256, math_hash, status, cert, activated_at) VALUES (?, 'classic', 'lines-5x3', ?, ?, ?, 'active', ?, unixepoch())",
    )
    .run(bundleId, json, sha256, mathHash, JSON.stringify({ method: "exact-enumeration (base + free spins) + monte-carlo (thunder strike)", rtp_percent: certRtpPercent }));
  return sqlite.prepare("SELECT * FROM math_bundles WHERE bundle_id = ?").get(bundleId) as BundleRow;
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

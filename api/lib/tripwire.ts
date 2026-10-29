/**
 * Step 15 — RTP-drift tripwire (Cascade Decision Playbook §4.1),
 * re-prioritized to run BEFORE any cascade code exists.
 *
 * Two layers, because a naive fixed band is useless on a high-
 * volatility game:
 *
 * Layer 1 — gross-error hard stop. The rolling window mean payout
 * must stay inside mu0 ± 3*sigma/sqrt(W). A wrong bundle, a mispay
 * bug or a duplicated multiplier shifts RTP by ~10pp and trips this
 * quickly; honest noise essentially never does. Armed only once the
 * window holds >= layer1MinSpins completed processes.
 *
 * Layer 2 — slow drift. An EWMA of per-process payout (warning
 * tier) plus a two-sided tabular CUSUM tuned to a 2pp shift
 * (critical tier). Detection horizons are long by mathematical
 * necessity — the ops dashboard prints them from the actual spin
 * rate so nobody expects lab precision from an ops signal.
 *
 * OBSERVATION UNIT — a PROCESS, not a spin row: the total payout of
 * one paid spin including its whole free-spin chain, divided by the
 * paid bet. That is the quantity the declared RTP describes. (The
 * first version observed paid rows only; free-spin wins live on
 * their own rows, so the row mean sits ~24pp below the declared
 * RTP and would have false-tripped Layer 1 the day it armed. The
 * Phase 0 MC harness caught this — see mc.ts, sigma 4.71 measured
 * at process level for the classic game.)
 *
 * Bundle-hash audit rides the same pass: every spin stamped with a
 * bundle hash that is not in the registry (or whose bundle belongs
 * to another mode) is a hard-stop event — a mis-pointed bundle is
 * the most likely way a certified game silently becomes uncertified.
 *
 * Actions: Layer 1 breach on classic flips maintenance_mode on
 * (the classic park equivalent; one click to reverse) and raises a
 * critical alert; on any other mode it parks the mode's active
 * bundle. CUSUM drift raises a critical alert; EWMA drift a warning.
 * Alerts dedupe per (mode, layer) while open.
 *
 * scripts/tripwire.mjs is the plain-node mirror the monitor runs
 * nightly; keep the math in step.
 */
import { getSqliteClient } from "../queries/connection";
import { tsSec } from "./limits";
import { getSetting, setSetting } from "./settings";

type SqliteClient = ReturnType<typeof getSqliteClient>;

export interface TripwireParams {
  layer1Window: number;
  layer1MinSpins: number;
  ewmaAlpha: number;
  ewmaArmSpins: number;
  /** Target RTP shift (fraction of bet) the CUSUM is tuned to. */
  cusumShift: number;
  /** Standardized CUSUM decision interval. */
  cusumH: number;
  batchSize: number;
}

export const TRIPWIRE_PARAMS: TripwireParams = {
  layer1Window: 1_000_000,
  layer1MinSpins: 100_000,
  ewmaAlpha: 1 / 50_000,
  ewmaArmSpins: 50_000,
  cusumShift: 0.02,
  cusumH: 4600,
  batchSize: 50_000,
};

interface ModeParams {
  mu0: number;
  sigma0: number;
}

function modeParams(sqlite: SqliteClient, modeId: string): ModeParams {
  if (modeId === "classic") {
    return {
      mu0: (getSetting<number>("rtp_declared") ?? 95.95) / 100,
      sigma0: getSetting<number>("tripwire_sigma_classic") ?? 4.7,
    };
  }
  const row = sqlite
    .prepare("SELECT cert FROM math_bundles WHERE mode_id = ? AND status = 'active'")
    .get(modeId) as { cert: string | null } | undefined;
  if (row?.cert) {
    try {
      const cert = typeof row.cert === "string" ? JSON.parse(row.cert) : row.cert;
      const mu0 = cert.rtp_hat ?? (cert.rtp_percent != null ? cert.rtp_percent / 100 : 0.965);
      const sigma0 = cert.sigma_hat ?? cert.sigma_x ?? 18;
      return { mu0, sigma0 };
    } catch { /* fall through to defaults */ }
  }
  return { mu0: 0.965, sigma0: 18 };
}

interface StateRow {
  mode_id: string;
  last_spin_id: number;
  ewma: number | null;
  cusum_pos: number;
  cusum_neg: number;
  spins_seen: number;
  pending_session: number | null;
  pending_bet: number | null;
  pending_win: number;
  pending_spin_id: number | null;
}

function loadState(sqlite: SqliteClient, modeId: string): StateRow {
  const row = sqlite.prepare("SELECT * FROM tripwire_state WHERE mode_id = ?").get(modeId) as StateRow | undefined;
  if (row) return row;
  sqlite.prepare("INSERT INTO tripwire_state (mode_id) VALUES (?)").run(modeId);
  return {
    mode_id: modeId, last_spin_id: 0, ewma: null, cusum_pos: 0, cusum_neg: 0, spins_seen: 0,
    pending_session: null, pending_bet: null, pending_win: 0, pending_spin_id: null,
  };
}

function saveState(sqlite: SqliteClient, s: StateRow) {
  sqlite
    .prepare(
      `UPDATE tripwire_state SET last_spin_id = ?, ewma = ?, cusum_pos = ?, cusum_neg = ?, spins_seen = ?,
       pending_session = ?, pending_bet = ?, pending_win = ?, pending_spin_id = ?, updated_at = unixepoch()
       WHERE mode_id = ?`,
    )
    .run(
      s.last_spin_id, s.ewma, s.cusum_pos, s.cusum_neg, s.spins_seen,
      s.pending_session, s.pending_bet, s.pending_win, s.pending_spin_id, s.mode_id,
    );
}

function recordEvent(
  sqlite: SqliteClient,
  modeId: string,
  layer: number,
  kind: string,
  detail: Record<string, unknown>,
  spinId: number | null,
) {
  sqlite
    .prepare("INSERT INTO tripwire_events (mode_id, layer, kind, detail, spin_id) VALUES (?, ?, ?, ?, ?)")
    .run(modeId, layer, kind, JSON.stringify(detail), spinId);
}

function raiseAlert(
  sqlite: SqliteClient,
  modeId: string,
  layer: number,
  severity: "warning" | "critical",
  title: string,
  detail: Record<string, unknown>,
) {
  const refId = `${modeId}:L${layer}`;
  const open = sqlite
    .prepare("SELECT id FROM admin_alerts WHERE kind = 'rtp_tripwire' AND ref_id = ? AND status = 'open'")
    .get(refId);
  if (open) return;
  sqlite
    .prepare("INSERT INTO admin_alerts (kind, severity, title, details, ref_id) VALUES ('rtp_tripwire', ?, ?, ?, ?)")
    .run(severity, title, JSON.stringify(detail), refId);
}

export interface ModeReport {
  modeId: string;
  processed: number;
  spinsSeen: number;
  layer1: { armed: boolean; windowSpins: number; mean: number | null; band: number | null; breach: boolean };
  ewma: { armed: boolean; value: number | null; limit: number; drift: boolean };
  cusum: { pos: number; neg: number; h: number; drift: boolean };
  hashEvents: number;
}

export function evaluateMode(
  sqlite: SqliteClient,
  modeId: string,
  params: TripwireParams = TRIPWIRE_PARAMS,
  actions = true,
): ModeReport {
  const { mu0, sigma0 } = modeParams(sqlite, modeId);
  const state = loadState(sqlite, modeId);

  const bundleModeBySha = new Map<string, string>();
  for (const b of sqlite.prepare("SELECT sha256, mode_id FROM math_bundles").all() as Array<{ sha256: string; mode_id: string }>) {
    bundleModeBySha.set(b.sha256, b.mode_id);
  }

  const kZ = sigma0 > 0 ? params.cusumShift / sigma0 / 2 : 0;
  let processed = 0;
  let hashEvents = 0;
  let firstBadHashSpin: number | null = null;
  let firstMismatchSpin: number | null = null;

  /** Flush the open process as one observation. */
  const flushProcess = () => {
    if (state.pending_spin_id === null || state.pending_bet === null || state.pending_bet <= 0) return;
    const x = state.pending_win / state.pending_bet;
    state.ewma = state.ewma === null ? x : state.ewma + params.ewmaAlpha * (x - state.ewma);
    if (sigma0 > 0) {
      const z = (x - mu0) / sigma0;
      state.cusum_pos = Math.max(0, state.cusum_pos + z - kZ);
      state.cusum_neg = Math.min(0, state.cusum_neg + z + kZ);
    }
    sqlite
      .prepare("INSERT INTO tripwire_processes (mode_id, spin_id, x) VALUES (?, ?, ?)")
      .run(modeId, state.pending_spin_id, x);
    state.spins_seen += 1;
    state.pending_session = null;
    state.pending_bet = null;
    state.pending_win = 0;
    state.pending_spin_id = null;
  };

  for (;;) {
    const batch = sqlite
      .prepare(
        `SELECT id, session_id, bet_amount, win_amount, bundle_sha256, is_free_spin FROM spins
         WHERE mode_id = ? AND id > ?
         ORDER BY id ASC LIMIT ?`,
      )
      .all(modeId, state.last_spin_id, params.batchSize) as Array<{
      id: number;
      session_id: number;
      bet_amount: string;
      win_amount: string;
      bundle_sha256: string | null;
      is_free_spin: number;
    }>;
    if (batch.length === 0) break;
    for (const s of batch) {
      if (s.bundle_sha256) {
        const owner = bundleModeBySha.get(s.bundle_sha256);
        if (owner === undefined) {
          hashEvents++;
          if (firstBadHashSpin === null) firstBadHashSpin = s.id;
        } else if (owner !== modeId) {
          hashEvents++;
          if (firstMismatchSpin === null) firstMismatchSpin = s.id;
        }
      }
      const win = parseFloat(s.win_amount);
      if (!s.is_free_spin) {
        // A new paid spin closes the previous process (chains never
        // span two paid spins) and opens its own.
        flushProcess();
        state.pending_session = s.session_id;
        state.pending_bet = parseFloat(s.bet_amount);
        state.pending_win = win;
        state.pending_spin_id = s.id;
      } else if (state.pending_spin_id !== null && state.pending_session === s.session_id) {
        state.pending_win += win;
      } else {
        // Orphan free-spin row (its trigger predates tracking): it
        // forms a one-row process at its locked bet so its payout is
        // still observed.
        flushProcess();
        state.pending_session = s.session_id;
        state.pending_bet = parseFloat(s.bet_amount);
        state.pending_win = win;
        state.pending_spin_id = s.id;
      }
      state.last_spin_id = s.id;
      processed += 1;
    }
    saveState(sqlite, state);
    if (batch.length < params.batchSize) break;
  }

  if (firstBadHashSpin !== null) {
    recordEvent(sqlite, modeId, 0, "unregistered_bundle", { firstSpinId: firstBadHashSpin }, firstBadHashSpin);
    if (actions) raiseAlert(sqlite, modeId, 0, "critical", `Tripwire: unregistered bundle hash on ${modeId} spins`, { firstSpinId: firstBadHashSpin });
  }
  if (firstMismatchSpin !== null) {
    recordEvent(sqlite, modeId, 0, "bundle_mode_mismatch", { firstSpinId: firstMismatchSpin }, firstMismatchSpin);
    if (actions) raiseAlert(sqlite, modeId, 0, "critical", `Tripwire: bundle/mode mismatch on ${modeId} spins`, { firstSpinId: firstMismatchSpin });
  }

  // Layer 1 — window aggregate over completed processes (statistical
  // monitor; REAL arithmetic is fine here, this never moves money).
  const agg = sqlite
    .prepare(
      `SELECT COUNT(*) AS c, AVG(x) AS mean, AVG(x * x) AS mean2 FROM (
         SELECT x FROM tripwire_processes WHERE mode_id = ? ORDER BY id DESC LIMIT ?
       )`,
    )
    .get(modeId, params.layer1Window) as { c: number; mean: number | null; mean2: number | null };
  const windowSpins = agg.c;
  const mean = agg.mean;
  const sigmaEmp = mean !== null && agg.mean2 !== null ? Math.sqrt(Math.max(agg.mean2 - mean * mean, 0)) : 0;
  const sigmaUsed = Math.max(sigmaEmp, 0.25 * sigma0);
  const band = windowSpins > 0 ? (3 * sigmaUsed) / Math.sqrt(windowSpins) : null;
  const layer1Armed = windowSpins >= params.layer1MinSpins;
  const layer1Breach = layer1Armed && mean !== null && band !== null && Math.abs(mean - mu0) > band;

  const ewmaLimit = 3 * sigma0 * Math.sqrt(params.ewmaAlpha / (2 - params.ewmaAlpha));
  const ewmaArmed = state.spins_seen >= params.ewmaArmSpins && state.ewma !== null;
  const ewmaDrift = ewmaArmed && state.ewma !== null && Math.abs(state.ewma - mu0) > ewmaLimit;

  const cusumDrift = state.cusum_pos > params.cusumH || state.cusum_neg < -params.cusumH;

  if (layer1Breach) {
    recordEvent(sqlite, modeId, 1, "layer1_breach", { mean, mu0, band, windowSpins }, state.last_spin_id);
    if (actions) {
      raiseAlert(sqlite, modeId, 1, "critical", `Tripwire LAYER 1 BREACH on ${modeId}: RTP ${(mean! * 100).toFixed(2)}% vs ${(mu0 * 100).toFixed(2)}%`, { mean, mu0, band, windowSpins });
      if (modeId === "classic") {
        if (!getSetting<boolean>("maintenance_mode")) setSetting("maintenance_mode", true, null);
      } else {
        sqlite.prepare("UPDATE math_bundles SET status = 'parked' WHERE mode_id = ? AND status = 'active'").run(modeId);
      }
    }
  }
  if (cusumDrift) {
    recordEvent(sqlite, modeId, 2, "cusum_drift", { cusumPos: state.cusum_pos, cusumNeg: state.cusum_neg, h: params.cusumH }, state.last_spin_id);
    if (actions) raiseAlert(sqlite, modeId, 2, "critical", `Tripwire: sustained RTP drift on ${modeId} (CUSUM)`, { cusumPos: state.cusum_pos, cusumNeg: state.cusum_neg });
  }
  if (ewmaDrift) {
    recordEvent(sqlite, modeId, 2, "ewma_drift", { ewma: state.ewma, mu0, limit: ewmaLimit }, state.last_spin_id);
    if (actions) raiseAlert(sqlite, modeId, 2, "warning", `Tripwire: RTP drifting on ${modeId} (EWMA)`, { ewma: state.ewma, mu0, limit: ewmaLimit });
  }

  return {
    modeId,
    processed,
    spinsSeen: state.spins_seen,
    layer1: { armed: layer1Armed, windowSpins, mean, band, breach: layer1Breach },
    ewma: { armed: ewmaArmed, value: state.ewma, limit: ewmaLimit, drift: ewmaDrift },
    cusum: { pos: state.cusum_pos, neg: state.cusum_neg, h: params.cusumH, drift: cusumDrift },
    hashEvents,
  };
}

export function evaluateAllModes(
  sqlite: SqliteClient,
  params: TripwireParams = TRIPWIRE_PARAMS,
  actions = true,
): ModeReport[] {
  if (getSetting<boolean>("tripwire_enabled") === false) return [];
  const modes = new Set<string>(["classic"]);
  for (const r of sqlite.prepare("SELECT DISTINCT mode_id FROM spins").all() as Array<{ mode_id: string }>) modes.add(r.mode_id);
  for (const r of sqlite.prepare("SELECT DISTINCT mode_id FROM math_bundles").all() as Array<{ mode_id: string }>) modes.add(r.mode_id);
  return [...modes].map((m) => evaluateMode(sqlite, m, params, actions));
}

/** Dashboard/status view: state + recent events + honest horizons. */
export function getTripwireStatus(sqlite: SqliteClient) {
  const modes = new Set<string>(["classic"]);
  for (const r of sqlite.prepare("SELECT DISTINCT mode_id FROM spins").all() as Array<{ mode_id: string }>) modes.add(r.mode_id);
  for (const r of sqlite.prepare("SELECT DISTINCT mode_id FROM math_bundles").all() as Array<{ mode_id: string }>) modes.add(r.mode_id);
  return [...modes].map((modeId) => {
    const { mu0, sigma0 } = modeParams(sqlite, modeId);
    const state = sqlite.prepare("SELECT * FROM tripwire_state WHERE mode_id = ?").get(modeId) as StateRow | undefined;
    const rate = sqlite
      .prepare(
        `SELECT COUNT(*) AS c FROM spins WHERE mode_id = ? AND is_free_spin = 0 AND ${tsSec("created_at")} >= unixepoch() - 7 * 86400`,
      )
      .get(modeId) as { c: number };
    const spinsPerDay = rate.c / 7;
    const events = sqlite
      .prepare("SELECT * FROM tripwire_events WHERE mode_id = ? ORDER BY id DESC LIMIT 10")
      .all(modeId);
    const daysTo = (spins: number) => (spinsPerDay >= 1 ? Math.round((spins / spinsPerDay) * 10) / 10 : null);
    return {
      modeId,
      mu0,
      sigma0,
      spinsSeen: state?.spins_seen ?? 0,
      ewma: state?.ewma ?? null,
      cusumPos: state?.cusum_pos ?? 0,
      cusumNeg: state?.cusum_neg ?? 0,
      spinsPerDay: Math.round(spinsPerDay * 10) / 10,
      horizons: {
        layer1MinSpins: TRIPWIRE_PARAMS.layer1MinSpins,
        layer1Days: daysTo(TRIPWIRE_PARAMS.layer1MinSpins),
        cusum2ppSpins: 3_000_000,
        cusum2ppDays: daysTo(3_000_000),
        note: "±0.3pp is lab precision (certification), not an ops signal — the tripwire catches gross errors fast and drift slowly, by design.",
      },
      events,
    };
  });
}

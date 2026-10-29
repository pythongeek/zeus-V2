#!/usr/bin/env node
/**
 * Step 15 — RTP-drift tripwire (plain-node mirror of api/lib/tripwire.ts;
 * keep the math in step). Invoked by the 5-minute monitor on its first
 * run of each day. Two layers (gross-error window stop + EWMA/CUSUM
 * drift) plus the bundle-hash audit, per playbook §4.1.
 *
 * Observation unit is a PROCESS: one paid spin plus its whole
 * free-spin chain, total payout / paid bet — the quantity the
 * declared RTP describes. Completed processes land in
 * tripwire_processes; the open process rides in tripwire_state.
 *
 * A Layer-1 breach on classic flips maintenance_mode on; on any
 * other mode it parks the mode's active bundle. Alerts dedupe
 * while open.
 */
import Database from "/opt/zeus-slot/node_modules/better-sqlite3/lib/index.js";

const db = new Database("/opt/zeus-slot/data/zeus.sqlite");
db.pragma("busy_timeout = 5000");

const PARAMS = {
  layer1Window: 1_000_000,
  layer1MinSpins: 100_000,
  ewmaAlpha: 1 / 50_000,
  ewmaArmSpins: 50_000,
  cusumShift: 0.02,
  cusumH: 4600,
  batchSize: 50_000,
};

function setting(key, fallback) {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch { return fallback; }
}

function modeParams(modeId) {
  if (modeId === "classic") {
    return { mu0: setting("rtp_declared", 95.95) / 100, sigma0: setting("tripwire_sigma_classic", 4.7) };
  }
  const row = db.prepare("SELECT cert FROM math_bundles WHERE mode_id = ? AND status = 'active'").get(modeId);
  if (row?.cert) {
    try {
      const cert = JSON.parse(row.cert);
      return {
        mu0: cert.rtp_hat ?? (cert.rtp_percent != null ? cert.rtp_percent / 100 : 0.965),
        sigma0: cert.sigma_hat ?? cert.sigma_x ?? 18,
      };
    } catch { /* defaults below */ }
  }
  return { mu0: 0.965, sigma0: 18 };
}

function raiseAlert(modeId, layer, severity, title, detail) {
  const refId = `${modeId}:L${layer}`;
  const open = db.prepare("SELECT id FROM admin_alerts WHERE kind = 'rtp_tripwire' AND ref_id = ? AND status = 'open'").get(refId);
  if (open) return;
  db.prepare("INSERT INTO admin_alerts (kind, severity, title, details, ref_id) VALUES ('rtp_tripwire', ?, ?, ?, ?)")
    .run(severity, title, JSON.stringify(detail), refId);
}

function recordEvent(modeId, layer, kind, detail, spinId) {
  db.prepare("INSERT INTO tripwire_events (mode_id, layer, kind, detail, spin_id) VALUES (?, ?, ?, ?, ?)")
    .run(modeId, layer, kind, JSON.stringify(detail), spinId);
}

function evaluateMode(modeId) {
  const { mu0, sigma0 } = modeParams(modeId);
  let state = db.prepare("SELECT * FROM tripwire_state WHERE mode_id = ?").get(modeId);
  if (!state) {
    db.prepare("INSERT INTO tripwire_state (mode_id) VALUES (?)").run(modeId);
    state = {
      mode_id: modeId, last_spin_id: 0, ewma: null, cusum_pos: 0, cusum_neg: 0, spins_seen: 0,
      pending_session: null, pending_bet: null, pending_win: 0, pending_spin_id: null,
    };
  }
  const bundleModeBySha = new Map();
  for (const b of db.prepare("SELECT sha256, mode_id FROM math_bundles").all()) bundleModeBySha.set(b.sha256, b.mode_id);

  const kZ = sigma0 > 0 ? PARAMS.cusumShift / sigma0 / 2 : 0;
  let processed = 0;
  let firstBadHashSpin = null;
  let firstMismatchSpin = null;

  const flushProcess = () => {
    if (state.pending_spin_id === null || state.pending_bet === null || state.pending_bet <= 0) return;
    const x = state.pending_win / state.pending_bet;
    state.ewma = state.ewma === null ? x : state.ewma + PARAMS.ewmaAlpha * (x - state.ewma);
    if (sigma0 > 0) {
      const z = (x - mu0) / sigma0;
      state.cusum_pos = Math.max(0, state.cusum_pos + z - kZ);
      state.cusum_neg = Math.min(0, state.cusum_neg + z + kZ);
    }
    db.prepare("INSERT INTO tripwire_processes (mode_id, spin_id, x) VALUES (?, ?, ?)").run(modeId, state.pending_spin_id, x);
    state.spins_seen += 1;
    state.pending_session = null;
    state.pending_bet = null;
    state.pending_win = 0;
    state.pending_spin_id = null;
  };

  const saveState = () => {
    db.prepare(
      `UPDATE tripwire_state SET last_spin_id = ?, ewma = ?, cusum_pos = ?, cusum_neg = ?, spins_seen = ?,
       pending_session = ?, pending_bet = ?, pending_win = ?, pending_spin_id = ?, updated_at = unixepoch()
       WHERE mode_id = ?`,
    ).run(
      state.last_spin_id, state.ewma, state.cusum_pos, state.cusum_neg, state.spins_seen,
      state.pending_session, state.pending_bet, state.pending_win, state.pending_spin_id, modeId,
    );
  };

  for (;;) {
    const batch = db.prepare(
      `SELECT id, session_id, bet_amount, win_amount, bundle_sha256, is_free_spin FROM spins
       WHERE mode_id = ? AND id > ?
       ORDER BY id ASC LIMIT ?`,
    ).all(modeId, state.last_spin_id, PARAMS.batchSize);
    if (batch.length === 0) break;
    for (const s of batch) {
      if (s.bundle_sha256) {
        const owner = bundleModeBySha.get(s.bundle_sha256);
        if (owner === undefined && firstBadHashSpin === null) firstBadHashSpin = s.id;
        else if (owner !== undefined && owner !== modeId && firstMismatchSpin === null) firstMismatchSpin = s.id;
      }
      const win = parseFloat(s.win_amount);
      if (!s.is_free_spin) {
        flushProcess();
        state.pending_session = s.session_id;
        state.pending_bet = parseFloat(s.bet_amount);
        state.pending_win = win;
        state.pending_spin_id = s.id;
      } else if (state.pending_spin_id !== null && state.pending_session === s.session_id) {
        state.pending_win += win;
      } else {
        flushProcess();
        state.pending_session = s.session_id;
        state.pending_bet = parseFloat(s.bet_amount);
        state.pending_win = win;
        state.pending_spin_id = s.id;
      }
      state.last_spin_id = s.id;
      processed += 1;
    }
    saveState();
    if (batch.length < PARAMS.batchSize) break;
  }

  if (firstBadHashSpin !== null) {
    recordEvent(modeId, 0, "unregistered_bundle", { firstSpinId: firstBadHashSpin }, firstBadHashSpin);
    raiseAlert(modeId, 0, "critical", `Tripwire: unregistered bundle hash on ${modeId} spins`, { firstSpinId: firstBadHashSpin });
  }
  if (firstMismatchSpin !== null) {
    recordEvent(modeId, 0, "bundle_mode_mismatch", { firstSpinId: firstMismatchSpin }, firstMismatchSpin);
    raiseAlert(modeId, 0, "critical", `Tripwire: bundle/mode mismatch on ${modeId} spins`, { firstSpinId: firstMismatchSpin });
  }

  const agg = db.prepare(
    `SELECT COUNT(*) AS c, AVG(x) AS mean, AVG(x * x) AS mean2 FROM (
       SELECT x FROM tripwire_processes WHERE mode_id = ? ORDER BY id DESC LIMIT ?
     )`,
  ).get(modeId, PARAMS.layer1Window);
  const windowSpins = agg.c;
  const mean = agg.mean;
  const sigmaEmp = mean !== null && agg.mean2 !== null ? Math.sqrt(Math.max(agg.mean2 - mean * mean, 0)) : 0;
  const sigmaUsed = Math.max(sigmaEmp, 0.25 * sigma0);
  const band = windowSpins > 0 ? (3 * sigmaUsed) / Math.sqrt(windowSpins) : null;
  const armed = windowSpins >= PARAMS.layer1MinSpins;
  const breach = armed && mean !== null && band !== null && Math.abs(mean - mu0) > band;

  const ewmaLimit = 3 * sigma0 * Math.sqrt(PARAMS.ewmaAlpha / (2 - PARAMS.ewmaAlpha));
  const ewmaDrift = state.spins_seen >= PARAMS.ewmaArmSpins && state.ewma !== null && Math.abs(state.ewma - mu0) > ewmaLimit;
  const cusumDrift = state.cusum_pos > PARAMS.cusumH || state.cusum_neg < -PARAMS.cusumH;

  if (breach) {
    recordEvent(modeId, 1, "layer1_breach", { mean, mu0, band, windowSpins }, state.last_spin_id);
    raiseAlert(modeId, 1, "critical", `Tripwire LAYER 1 BREACH on ${modeId}: RTP ${(mean * 100).toFixed(2)}% vs ${(mu0 * 100).toFixed(2)}%`, { mean, mu0, band, windowSpins });
    if (modeId === "classic") {
      db.prepare("INSERT INTO settings (key, value) VALUES ('maintenance_mode', 'true') ON CONFLICT(key) DO UPDATE SET value = 'true', updated_at = unixepoch()").run();
    } else {
      db.prepare("UPDATE math_bundles SET status = 'parked' WHERE mode_id = ? AND status = 'active'").run(modeId);
    }
  }
  if (cusumDrift) {
    recordEvent(modeId, 2, "cusum_drift", { cusumPos: state.cusum_pos, cusumNeg: state.cusum_neg, h: PARAMS.cusumH }, state.last_spin_id);
    raiseAlert(modeId, 2, "critical", `Tripwire: sustained RTP drift on ${modeId} (CUSUM)`, { cusumPos: state.cusum_pos, cusumNeg: state.cusum_neg });
  }
  if (ewmaDrift) {
    recordEvent(modeId, 2, "ewma_drift", { ewma: state.ewma, mu0, limit: ewmaLimit }, state.last_spin_id);
    raiseAlert(modeId, 2, "warning", `Tripwire: RTP drifting on ${modeId} (EWMA)`, { ewma: state.ewma, mu0, limit: ewmaLimit });
  }

  return { modeId, processed, spinsSeen: state.spins_seen, windowSpins, mean, armed, breach, ewmaDrift, cusumDrift };
}

if (setting("tripwire_enabled", true) === false) {
  console.log("TRIPWIRE disabled by setting");
  process.exit(0);
}

const modes = new Set(["classic"]);
for (const r of db.prepare("SELECT DISTINCT mode_id FROM spins").all()) modes.add(r.mode_id);
for (const r of db.prepare("SELECT DISTINCT mode_id FROM math_bundles").all()) modes.add(r.mode_id);
for (const modeId of modes) {
  const r = evaluateMode(modeId);
  console.log(
    `TRIPWIRE ${r.modeId}: +${r.processed} rows (${r.spinsSeen} processes), window ${r.windowSpins}, mean ${r.mean === null ? "n/a" : (r.mean * 100).toFixed(2) + "%"}, L1 ${r.breach ? "BREACH" : r.armed ? "ok" : "unarmed"}, EWMA ${r.ewmaDrift ? "DRIFT" : "ok"}, CUSUM ${r.cusumDrift ? "DRIFT" : "ok"}`,
  );
}

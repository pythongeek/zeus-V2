import { getSqliteClient } from "../queries/connection";

/**
 * RTP Lab — per-bundle RTP reporting (audit 2026-11-04, A1/A2/A8).
 *
 * Reports are ALWAYS per math bundle, never blended: the aggregate
 * number historically mixed a legacy era (57 spins), a parked
 * high-volatility bundle (292 spins) and the live bundle, which made
 * real RTP unmanageable. Every row carries the certified RTP, the
 * observed true RTP (all wins incl. free-spin wins ÷ PAID bets), a
 * ±95% band from the per-spin win/bet sample, and an "insufficient
 * sample" verdict below MIN_SAMPLE_SPINS — a bundle cannot be judged
 * on less, and the dashboard says so instead of implying signal.
 */

export const MIN_SAMPLE_SPINS = 5000;

export interface RtpBundleRow {
  modeId: string;
  bundleId: string;
  bundleStatus: string;
  certRtp: number | null; // certified RTP % (from the bundle's cert)
  spins: number;
  paidSpins: number;
  fsSpins: number;
  paidBets: number;
  paidWins: number;
  totalWins: number;
  baseRtp: number | null; // paid wins ÷ paid bets, %
  trueRtp: number | null; // total wins ÷ paid bets, %
  rtpLow: number | null; // 95% band on trueRtp, %
  rtpHigh: number | null;
  hitRatePaid: number | null; // % of paid spins with any win
  hitRateFs: number | null;
  fsRounds: number;
  zeroFsRounds: number;
  sufficient: boolean;
  lastSpinAt: string | null;
}

export interface RtpDayRow {
  day: string;
  modeId: string;
  bundleId: string;
  spins: number;
  bets: number;
  wins: number;
  rtp: number | null;
}

export interface RtpReport {
  rows: RtpBundleRow[];
  days: RtpDayRow[];
  jackpots: Array<{ tier: string; seed: number; current: number; hitCount: number }>;
  generatedAt: string;
}

interface BundleMeta {
  mode: string;
  status: string;
  certRtp: number | null;
}

function certRtpOf(certJson: string | null, bundleJson: string | null): number | null {
  const norm = (v: number): number => {
    // Classic bundles store percent (96.04); cascade cert stores a
    // fraction (0.9648). Normalize everything to percent.
    return v > 0 && v <= 1.5 ? v * 100 : v;
  };
  try {
    if (certJson) {
      const c = JSON.parse(certJson);
      if (typeof c.rtp_percent === "number") return norm(c.rtp_percent);
      if (c.run && typeof c.run.rtp === "number") return norm(c.run.rtp);
      if (typeof c.totalPct === "number") return norm(c.totalPct);
    }
    if (bundleJson) {
      const b = JSON.parse(bundleJson);
      if (b.cert && typeof b.cert.rtp_percent === "number") return norm(b.cert.rtp_percent);
    }
  } catch {
    /* certs are JSON by construction */
  }
  return null;
}

/** Aggregate production spins into per-bundle RTP rows + per-day detail. */
export function computeRtpReport(sqlite = getSqliteClient()): RtpReport {
  const bundleMeta = new Map<string, BundleMeta>();
  for (const r of sqlite
    .prepare("SELECT bundle_id, mode_id, status, cert, bundle FROM math_bundles")
    .all() as any[]) {
    bundleMeta.set(r.bundle_id, {
      mode: r.mode_id,
      status: r.status,
      certRtp: certRtpOf(r.cert, r.bundle),
    });
  }

  const perBundle = sqlite
    .prepare(
      `SELECT mode_id, bundle_id, count(*) spins,
              sum(CASE WHEN is_free_spin = 0 THEN 1 ELSE 0 END) paid_spins,
              sum(CASE WHEN is_free_spin = 1 THEN 1 ELSE 0 END) fs_spins,
              sum(CASE WHEN is_free_spin = 0 THEN cast(bet_amount as real) ELSE 0 END) paid_bets,
              sum(CASE WHEN is_free_spin = 0 THEN cast(win_amount as real) ELSE 0 END) paid_wins,
              sum(cast(win_amount as real)) total_wins,
              sum(CASE WHEN is_free_spin = 0 AND cast(win_amount as real) > 0 THEN 1 ELSE 0 END) paid_hits,
              sum(CASE WHEN is_free_spin = 1 AND cast(win_amount as real) > 0 THEN 1 ELSE 0 END) fs_hits,
              max(created_at) last_spin
       FROM spins GROUP BY mode_id, bundle_id`,
    )
    .all() as any[];

  // Per-spin win/bet sample stats on PAID spins, for the ±95% band.
  const xStats = sqlite
    .prepare(
      `SELECT mode_id, bundle_id,
              count(*) n,
              avg(cast(win_amount as real) / cast(bet_amount as real)) mean_x,
              avg((cast(win_amount as real) / cast(bet_amount as real)) * (cast(win_amount as real) / cast(bet_amount as real))) mean_x2
       FROM spins WHERE is_free_spin = 0 AND cast(bet_amount as real) > 0
       GROUP BY mode_id, bundle_id`,
    )
    .all() as any[];
  const xByKey = new Map(xStats.map((r) => [`${r.mode_id}|${r.bundle_id}`, r]));

  // Free-spin ROUNDS: grouped per session; a round with zero total win
  // is the "free spins paid nothing" signal the owner cares about (A3).
  const fsRounds = sqlite
    .prepare(
      `SELECT mode_id, bundle_id, session_id, sum(cast(win_amount as real)) w
       FROM spins WHERE is_free_spin = 1 GROUP BY mode_id, bundle_id, session_id`,
    )
    .all() as any[];
  const roundByKey = new Map<string, { rounds: number; zero: number }>();
  for (const r of fsRounds) {
    const key = `${r.mode_id}|${r.bundle_id}`;
    const cur = roundByKey.get(key) ?? { rounds: 0, zero: 0 };
    cur.rounds += 1;
    if (r.w <= 0) cur.zero += 1;
    roundByKey.set(key, cur);
  }

  const rows: RtpBundleRow[] = perBundle.map((r) => {
    const meta = bundleMeta.get(r.bundle_id);
    const key = `${r.mode_id}|${r.bundle_id}`;
    const x = xByKey.get(key);
    const nPaid = x?.n ?? 0;
    let trueRtp: number | null = null;
    let low: number | null = null;
    let high: number | null = null;
    if (r.paid_bets > 0) {
      trueRtp = (r.total_wins / r.paid_bets) * 100;
      if (nPaid > 1) {
        const variance = Math.max((x.mean_x2 ?? 0) - (x.mean_x ?? 0) ** 2, 0);
        const sd = Math.sqrt(variance);
        const half = 1.96 * sd * 100 / Math.sqrt(nPaid); // percentage points
        low = Math.max(0, trueRtp - half);
        high = trueRtp + half;
      }
    }
    const rounds = roundByKey.get(key) ?? { rounds: 0, zero: 0 };
    return {
      modeId: r.mode_id,
      bundleId: r.bundle_id ?? "(none — pre-registry era)",
      bundleStatus: meta?.status ?? "(unregistered)",
      certRtp: meta?.certRtp ?? null,
      spins: r.spins,
      paidSpins: r.paid_spins,
      fsSpins: r.fs_spins,
      paidBets: r.paid_bets,
      paidWins: r.paid_wins,
      totalWins: r.total_wins,
      baseRtp: r.paid_bets > 0 ? (r.paid_wins / r.paid_bets) * 100 : null,
      trueRtp,
      rtpLow: low,
      rtpHigh: high,
      hitRatePaid: r.paid_spins > 0 ? (r.paid_hits / r.paid_spins) * 100 : null,
      hitRateFs: r.fs_spins > 0 ? (r.fs_hits / r.fs_spins) * 100 : null,
      fsRounds: rounds.rounds,
      zeroFsRounds: rounds.zero,
      sufficient: r.spins >= MIN_SAMPLE_SPINS,
      lastSpinAt: r.last_spin ?? null,
    };
  });
  rows.sort((a, b) => (a.modeId === b.modeId ? b.spins - a.spins : a.modeId < b.modeId ? -1 : 1));

  const days: RtpDayRow[] = (sqlite
    .prepare(
      `SELECT substr(created_at, 1, 10) d, mode_id, bundle_id, count(*) spins,
              sum(cast(bet_amount as real)) bets, sum(cast(win_amount as real)) wins
       FROM spins GROUP BY d, mode_id, bundle_id ORDER BY d`,
    )
    .all() as any[]).map((r) => ({
    day: r.d,
    modeId: r.mode_id,
    bundleId: r.bundle_id ?? "(none — pre-registry era)",
    spins: r.spins,
    bets: r.bets,
    wins: r.wins,
    rtp: r.bets > 0 ? (r.wins / r.bets) * 100 : null,
  }));

  const jackpots = (sqlite.prepare("SELECT * FROM jackpot_pool").all() as any[]).map((p) => ({
    tier: p.tier,
    seed: parseFloat(p.seed_amount),
    current: parseFloat(p.current_amount),
    hitCount: p.hit_count ?? 0,
  }));

  return { rows, days, jackpots, generatedAt: new Date().toISOString() };
}

/**
 * F3: responsible-gaming limits — per-user deposit/loss/session caps and
 * self-exclusion, enforced server-side on every money path.
 *
 * Limits are denominated in USDT; other currencies are converted at the
 * configured FX rates (BDT per unit). "Today" is the Asia/Dhaka calendar
 * day (UTC+6, no DST). Storage: user_limits (migration 0005), raw SQL via
 * the shared better-sqlite3 client.
 */
import { getSqliteClient } from "../queries/connection";
import { getSetting } from "./settings";

export interface UserLimits {
  depositLimitDaily: string | null; // USDT
  lossLimitDaily: string | null; // USDT
  sessionLimitMinutes: number | null;
  selfExcludedUntil: number; // unix seconds, 0 = not excluded
}

const DEFAULT_LIMITS: UserLimits = {
  depositLimitDaily: null,
  lossLimitDaily: null,
  sessionLimitMinutes: null,
  selfExcludedUntil: 0,
};

export function getLimits(userId: number): UserLimits {
  const db = getSqliteClient();
  const row = db
    .prepare(
      "SELECT deposit_limit_daily, loss_limit_daily, session_limit_minutes, self_excluded_until FROM user_limits WHERE user_id = ?",
    )
    .get(userId) as any;
  if (!row) return { ...DEFAULT_LIMITS };
  return {
    depositLimitDaily: row.deposit_limit_daily ?? null,
    lossLimitDaily: row.loss_limit_daily ?? null,
    sessionLimitMinutes: row.session_limit_minutes ?? null,
    selfExcludedUntil: row.self_excluded_until ?? 0,
  };
}

function upsertLimits(userId: number, l: UserLimits): void {
  const db = getSqliteClient();
  db.prepare(
    `INSERT INTO user_limits (user_id, deposit_limit_daily, loss_limit_daily, session_limit_minutes, self_excluded_until, updated_at)
     VALUES (?, ?, ?, ?, ?, unixepoch())
     ON CONFLICT(user_id) DO UPDATE SET
       deposit_limit_daily = excluded.deposit_limit_daily,
       loss_limit_daily = excluded.loss_limit_daily,
       session_limit_minutes = excluded.session_limit_minutes,
       self_excluded_until = excluded.self_excluded_until,
       updated_at = unixepoch()`,
  ).run(
    userId,
    l.depositLimitDaily,
    l.lossLimitDaily,
    l.sessionLimitMinutes,
    l.selfExcludedUntil,
  );
}

export function setLimits(
  userId: number,
  patch: Partial<UserLimits>,
): UserLimits {
  const current = getLimits(userId);
  // Self-exclusion can be set or extended, never shortened or cancelled.
  if (
    patch.selfExcludedUntil !== undefined &&
    current.selfExcludedUntil > Math.floor(Date.now() / 1000) &&
    patch.selfExcludedUntil < current.selfExcludedUntil
  ) {
    throw new Error("Self-exclusion cannot be shortened or cancelled early");
  }
  const next: UserLimits = {
    depositLimitDaily:
      patch.depositLimitDaily !== undefined
        ? patch.depositLimitDaily
        : current.depositLimitDaily,
    lossLimitDaily:
      patch.lossLimitDaily !== undefined
        ? patch.lossLimitDaily
        : current.lossLimitDaily,
    sessionLimitMinutes:
      patch.sessionLimitMinutes !== undefined
        ? patch.sessionLimitMinutes
        : current.sessionLimitMinutes,
    selfExcludedUntil:
      patch.selfExcludedUntil !== undefined
        ? patch.selfExcludedUntil
        : current.selfExcludedUntil,
  };
  upsertLimits(userId, next);
  return next;
}

/** Start of the current Asia/Dhaka calendar day, as unix seconds (UTC). */
export function dhakaDayStartSec(nowSec: number = Math.floor(Date.now() / 1000)): number {
  const DHAKA_OFFSET = 6 * 3600;
  const dhakaNow = nowSec + DHAKA_OFFSET;
  return Math.floor(dhakaNow / 86400) * 86400 - DHAKA_OFFSET;
}

/** Convert an amount in `currency` to USDT at the configured FX rates. */
export function toUsdt(amount: number, currency: string): number {
  if (currency === "USDT") return amount;
  const rates = getSetting<Record<string, number>>("fx_rates") ?? {
    BTC: 11000000,
    ETH: 380000,
    USDT: 110,
    BDT: 1,
  };
  const bdtPerUnit = rates[currency];
  const usdtRate = rates.USDT || 110;
  if (!bdtPerUnit) return amount;
  return (amount * bdtPerUnit) / usdtRate;
}

/**
 * Epoch-seconds SQL expression for a timestamp column whose storage
 * shape varies by era: newer drizzle writes are integer epochs,
 * while the original tables store 'YYYY-MM-DD HH:MM:SS' text
 * (CURRENT_TIMESTAMP defaults). A bare `created_at >= ?` comparison
 * against a TEXT column applies TEXT affinity to the bound integer
 * and degenerates into a lexicographic compare that matches every
 * row — the daily tallies below silently counted all-time rows
 * until this normalizer was added (found in Section B, 2026-10-29).
 */
export function tsSec(col: string): string {
  return `CASE WHEN typeof(${col}) IN ('integer', 'real') THEN ${col} WHEN strftime('%s', ${col}) IS NOT NULL THEN CAST(strftime('%s', ${col}) AS INTEGER) ELSE CAST(${col} AS REAL) END`;
}

export function todaysDepositsUsdt(userId: number): number {
  const db = getSqliteClient();
  const rows = db
    .prepare(
      `SELECT currency, SUM(CAST(amount AS REAL)) AS total FROM transactions
       WHERE user_id = ? AND type = 'deposit' AND status IN ('pending', 'confirmed')
         AND ${tsSec("created_at")} >= ?
       GROUP BY currency`,
    )
    .all(userId, dhakaDayStartSec()) as any[];
  return rows.reduce((sum, r) => sum + toUsdt(r.total || 0, r.currency), 0);
}

export function todaysNetLossUsdt(userId: number): number {
  const db = getSqliteClient();
  const rows = db
    .prepare(
      `SELECT currency,
              SUM(CAST(bet_amount AS REAL)) AS wagered,
              SUM(CAST(win_amount AS REAL)) AS won
       FROM spins
       WHERE user_id = ? AND is_free_spin = 0 AND ${tsSec("created_at")} >= ?
       GROUP BY currency`,
    )
    .all(userId, dhakaDayStartSec()) as any[];
  return rows.reduce(
    (sum, r) => sum + toUsdt((r.wagered || 0) - (r.won || 0), r.currency),
    0,
  );
}

export function assertNotExcluded(userId: number): void {
  const { selfExcludedUntil } = getLimits(userId);
  if (selfExcludedUntil > Math.floor(Date.now() / 1000)) {
    const until = new Date(selfExcludedUntil * 1000).toISOString().slice(0, 10);
    throw new Error(`Your account is self-excluded until ${until}`);
  }
}

export function assertDepositAllowed(
  userId: number,
  currency: string,
  amount: number,
): void {
  assertNotExcluded(userId);
  const { depositLimitDaily } = getLimits(userId);
  if (depositLimitDaily !== null) {
    const used = todaysDepositsUsdt(userId);
    if (used + toUsdt(amount, currency) > parseFloat(depositLimitDaily)) {
      throw new Error("Daily deposit limit reached");
    }
  }
}

/**
 * Spin gate: self-exclusion, daily loss cap, and the session window.
 * The session window starts at the first spin after a 30-minute gap;
 * once the configured minutes elapse inside a window, spins pause
 * until a 30-minute break resets it.
 */
export function assertSpinAllowed(userId: number): void {
  assertNotExcluded(userId);
  const limits = getLimits(userId);
  if (limits.lossLimitDaily !== null) {
    if (todaysNetLossUsdt(userId) >= parseFloat(limits.lossLimitDaily)) {
      throw new Error("Daily loss limit reached — spinning is paused until tomorrow");
    }
  }
  if (limits.sessionLimitMinutes !== null) {
    const db = getSqliteClient();
    const now = Math.floor(Date.now() / 1000);
    const row = db
      .prepare("SELECT play_started_at, last_spin_at FROM user_limits WHERE user_id = ?")
      .get(userId) as any;
    let playStartedAt = row?.play_started_at ?? 0;
    const lastSpinAt = row?.last_spin_at ?? 0;
    if (now - lastSpinAt > 30 * 60 || playStartedAt === 0) {
      playStartedAt = now; // fresh window after a break
    } else if (now - playStartedAt > limits.sessionLimitMinutes * 60) {
      throw new Error("Session limit reached — please take a break");
    }
    db.prepare(
      `INSERT INTO user_limits (user_id, play_started_at, last_spin_at, updated_at)
       VALUES (?, ?, ?, unixepoch())
       ON CONFLICT(user_id) DO UPDATE SET play_started_at = excluded.play_started_at,
         last_spin_at = excluded.last_spin_at, updated_at = unixepoch()`,
    ).run(userId, playStartedAt, now);
  }
}

/** Usage snapshot for the Settings UI. */
export function getUsage(userId: number) {
  return {
    depositsTodayUsdt: todaysDepositsUsdt(userId),
    netLossTodayUsdt: todaysNetLossUsdt(userId),
  };
}

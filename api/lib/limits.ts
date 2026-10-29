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
  depositLimitWeekly: string | null; // USDT
  depositLimitMonthly: string | null; // USDT
  lossLimitDaily: string | null; // USDT
  sessionLimitMinutes: number | null;
  selfExcludedUntil: number; // unix seconds, 0 = not excluded
  /** Step 17: a limit RAISE waits 24h (cooling-off); the pending
   *  values + effective time are exposed so the UI can say so. */
  pendingDepositLimits: {
    daily: string | null;
    weekly: string | null;
    monthly: string | null;
    effectiveAt: number;
  } | null;
}

const DEFAULT_LIMITS: UserLimits = {
  depositLimitDaily: null,
  depositLimitWeekly: null,
  depositLimitMonthly: null,
  lossLimitDaily: null,
  sessionLimitMinutes: null,
  selfExcludedUntil: 0,
  pendingDepositLimits: null,
};

const LIMIT_COLS =
  "deposit_limit_daily, deposit_limit_weekly, deposit_limit_monthly, loss_limit_daily, session_limit_minutes, self_excluded_until, pending_deposit_limit_daily, pending_deposit_limit_weekly, pending_deposit_limit_monthly, pending_effective_at";

function rowToLimits(row: any): UserLimits {
  return {
    depositLimitDaily: row.deposit_limit_daily ?? null,
    depositLimitWeekly: row.deposit_limit_weekly ?? null,
    depositLimitMonthly: row.deposit_limit_monthly ?? null,
    lossLimitDaily: row.loss_limit_daily ?? null,
    sessionLimitMinutes: row.session_limit_minutes ?? null,
    selfExcludedUntil: row.self_excluded_until ?? 0,
    pendingDepositLimits:
      row.pending_effective_at != null
        ? {
            daily: row.pending_deposit_limit_daily ?? null,
            weekly: row.pending_deposit_limit_weekly ?? null,
            monthly: row.pending_deposit_limit_monthly ?? null,
            effectiveAt: row.pending_effective_at,
          }
        : null,
  };
}

export function getLimits(userId: number): UserLimits {
  const db = getSqliteClient();
  const row = db
    .prepare(`SELECT ${LIMIT_COLS} FROM user_limits WHERE user_id = ?`)
    .get(userId) as any;
  if (!row) return { ...DEFAULT_LIMITS };
  // Cooling-off promotion: a pending raise whose time has come
  // becomes the active cap, atomically, on first read past it.
  if (row.pending_effective_at != null && row.pending_effective_at <= Math.floor(Date.now() / 1000)) {
    db.prepare(
      `UPDATE user_limits SET
         deposit_limit_daily = pending_deposit_limit_daily,
         deposit_limit_weekly = pending_deposit_limit_weekly,
         deposit_limit_monthly = pending_deposit_limit_monthly,
         pending_deposit_limit_daily = NULL,
         pending_deposit_limit_weekly = NULL,
         pending_deposit_limit_monthly = NULL,
         pending_effective_at = NULL,
         updated_at = unixepoch()
       WHERE user_id = ?`,
    ).run(userId);
    const fresh = db.prepare(`SELECT ${LIMIT_COLS} FROM user_limits WHERE user_id = ?`).get(userId) as any;
    return rowToLimits(fresh);
  }
  return rowToLimits(row);
}

function upsertLimits(userId: number, l: UserLimits): void {
  const db = getSqliteClient();
  db.prepare(
    `INSERT INTO user_limits (user_id, deposit_limit_daily, deposit_limit_weekly, deposit_limit_monthly, loss_limit_daily, session_limit_minutes, self_excluded_until, pending_deposit_limit_daily, pending_deposit_limit_weekly, pending_deposit_limit_monthly, pending_effective_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
     ON CONFLICT(user_id) DO UPDATE SET
       deposit_limit_daily = excluded.deposit_limit_daily,
       deposit_limit_weekly = excluded.deposit_limit_weekly,
       deposit_limit_monthly = excluded.deposit_limit_monthly,
       loss_limit_daily = excluded.loss_limit_daily,
       session_limit_minutes = excluded.session_limit_minutes,
       self_excluded_until = excluded.self_excluded_until,
       pending_deposit_limit_daily = excluded.pending_deposit_limit_daily,
       pending_deposit_limit_weekly = excluded.pending_deposit_limit_weekly,
       pending_deposit_limit_monthly = excluded.pending_deposit_limit_monthly,
       pending_effective_at = excluded.pending_effective_at,
       updated_at = unixepoch()`,
  ).run(
    userId,
    l.depositLimitDaily,
    l.depositLimitWeekly,
    l.depositLimitMonthly,
    l.lossLimitDaily,
    l.sessionLimitMinutes,
    l.selfExcludedUntil,
    l.pendingDepositLimits?.daily ?? null,
    l.pendingDepositLimits?.weekly ?? null,
    l.pendingDepositLimits?.monthly ?? null,
    l.pendingDepositLimits?.effectiveAt ?? null,
  );
}

/** A change is a RAISE when it loosens an existing cap: a higher
 *  number, or removing a cap entirely. New caps and tightenings
 *  are not raises. */
function isRaise(current: string | null, next: string | null): boolean {
  if (current === null) return false;
  if (next === null) return true;
  return parseFloat(next) > parseFloat(current);
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
  const nowSec = Math.floor(Date.now() / 1000);
  const next: UserLimits = {
    depositLimitDaily: current.depositLimitDaily,
    depositLimitWeekly: current.depositLimitWeekly,
    depositLimitMonthly: current.depositLimitMonthly,
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
    pendingDepositLimits: current.pendingDepositLimits,
  };
  // Deposit caps: tightenings apply now; raises go to pending for
  // 24h (cooling-off), keeping the CURRENT (tighter) caps active.
  const capFields = [
    ["depositLimitDaily", "daily"],
    ["depositLimitWeekly", "weekly"],
    ["depositLimitMonthly", "monthly"],
  ] as const;
  let anyRaise = false;
  const pending = {
    daily: current.pendingDepositLimits?.daily ?? current.depositLimitDaily,
    weekly: current.pendingDepositLimits?.weekly ?? current.depositLimitWeekly,
    monthly: current.pendingDepositLimits?.monthly ?? current.depositLimitMonthly,
  };
  for (const [field, key] of capFields) {
    const v = (patch as any)[field];
    if (v === undefined) continue;
    if (isRaise(current[field], v)) {
      anyRaise = true;
      pending[key] = v;
    } else {
      next[field] = v;
      pending[key] = v;
    }
  }
  if (anyRaise) {
    next.pendingDepositLimits = { ...pending, effectiveAt: nowSec + 86400 };
  } else if (capFields.some(([f]) => (patch as any)[f] !== undefined)) {
    next.pendingDepositLimits = null;
  }
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

export function depositsUsdtSince(userId: number, sinceSec: number): number {
  const db = getSqliteClient();
  const rows = db
    .prepare(
      `SELECT currency, SUM(CAST(amount AS REAL)) AS total FROM transactions
       WHERE user_id = ? AND type = 'deposit' AND status IN ('pending', 'confirmed')
         AND ${tsSec("created_at")} >= ?
       GROUP BY currency`,
    )
    .all(userId, sinceSec) as any[];
  return rows.reduce((sum, r) => sum + toUsdt(r.total || 0, r.currency), 0);
}

/** Monday 00:00 Asia/Dhaka of the current week (unix seconds). */
export function dhakaWeekStartSec(nowSec: number = Math.floor(Date.now() / 1000)): number {
  const localDay = Math.floor((nowSec + 21600) / 86400);
  const mon0 = (((localDay % 7) + 3) % 7 + 7) % 7;
  return (localDay - mon0) * 86400 - 21600;
}

/** 1st 00:00 Asia/Dhaka of the current month (unix seconds). */
export function dhakaMonthStartSec(nowSec: number = Math.floor(Date.now() / 1000)): number {
  const dhaka = new Date((nowSec + 21600) * 1000);
  return Math.floor(Date.UTC(dhaka.getUTCFullYear(), dhaka.getUTCMonth(), 1) / 1000) - 21600;
}

export function assertDepositAllowed(
  userId: number,
  currency: string,
  amount: number,
): void {
  assertNotExcluded(userId);
  const limits = getLimits(userId);
  const add = toUsdt(amount, currency);
  if (limits.depositLimitDaily !== null) {
    if (todaysDepositsUsdt(userId) + add > parseFloat(limits.depositLimitDaily)) {
      throw new Error("Daily deposit limit reached");
    }
  }
  if (limits.depositLimitWeekly !== null) {
    if (depositsUsdtSince(userId, dhakaWeekStartSec()) + add > parseFloat(limits.depositLimitWeekly)) {
      throw new Error("Weekly deposit limit reached");
    }
  }
  if (limits.depositLimitMonthly !== null) {
    if (depositsUsdtSince(userId, dhakaMonthStartSec()) + add > parseFloat(limits.depositLimitMonthly)) {
      throw new Error("Monthly deposit limit reached");
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

import { z } from "zod";
import { createRouter, publicQuery } from "../middleware";
import { getSqliteClient } from "../queries/connection";
import { getSetting } from "../lib/settings";
import { toUsdt } from "../lib/limits";
import { displayFxRates } from "./balance";

/**
 * Step 9 — live win ticker (playbook §4.2 integrity rules).
 * REAL settled spins only — nothing is ever fabricated; in
 * production an empty feed simply renders nothing. A win appears
 * only at >= ticker_min_multiplier x bet (default 25x), after a
 * short display delay, with the player's name masked to its first
 * two characters. No user ids leave the server.
 *
 * Capacity (Phase 4): the previous implementation filtered with
 * per-row SQL functions (tsSec()/CAST) over the whole spins table on
 * every poll (~150 ms+ per call on a large table) and blocked the
 * single Node event loop while the client polls every few seconds.
 * Now:
 *  - the scan walks the primary-key index (ORDER BY id DESC) in
 *    bounded batches, so no full table scan and no per-row SQL
 *    functions; the time window and multiplier checks run in JS on
 *    rows we already had to deserialize;
 *  - the scan stops at the 7-day window, at `limit` hits, or after
 *    TICKER_MAX_SCAN rows (defensive ceiling), whichever comes first;
 *  - a 2.5 s in-process cache makes N concurrent polls cost ONE
 *    query, and expires by TTL only (same behaviour for every
 *    caller in the window).
 * Output shape is unchanged.
 */

const TICKER_DELAY_SECONDS = 15;
const TICKER_MAX_AGE_SECONDS = 7 * 86400;
/** Concurrent pollers in the same 2.5 s window share one query. */
const TICKER_CACHE_MS = 2500;
/** Rows fetched per primary-key step while walking backwards. */
const TICKER_BATCH = 500;
/** Hard ceiling on rows examined by one cold cache fill. */
const TICKER_MAX_SCAN = 50_000;

export function maskName(name: string | null, email: string | null): string {
  const base = (name && name.trim()) || (email ? email.split("@")[0] : "") || "Player";
  const chars = [...base];
  return chars.slice(0, 2).join("") + "***";
}

type SpinRow = {
  id: number;
  user_id: number;
  win_amount: string;
  bet_amount: string;
  currency: string;
  mode_id: string;
  created_at: unknown;
};

type TickerWin = {
  maskedName: string;
  amount: string;
  currency: string;
  multiplier: number;
  gold: boolean;
  modeId: string;
  usdtEquivalent: number;
  bdtEquivalent: number;
  createdAt: number;
};

let cache: { at: number; key: string; wins: TickerWin[] } | null = null;
/** Cache is disabled under vitest: tests insert wins and immediately re-read. */
const CACHE_ENABLED = process.env.NODE_ENV !== "test" && !process.env.VITEST;

/** Test/ops hook — the cache is otherwise TTL-only by design. */
export function invalidateTickerCache(): void {
  cache = null;
}

function collectRecentWins(
  client: ReturnType<typeof getSqliteClient>,
  limit: number,
  minMult: number,
  nowSec: number,
): SpinRow[] {
  const maxRow = client.prepare("SELECT MAX(id) AS m FROM spins").get() as { m: number | null } | undefined;
  let cursor = (maxRow?.m ?? 0) + 1;
  const cutoff = nowSec - TICKER_MAX_AGE_SECONDS;
  const newest = nowSec - TICKER_DELAY_SECONDS;
  const batchStmt = client.prepare(
    `SELECT id, user_id, win_amount, bet_amount, currency, mode_id, created_at
       FROM spins WHERE id < ? ORDER BY id DESC LIMIT ?`,
  );
  const hits: SpinRow[] = [];
  let scanned = 0;
  while (hits.length < limit && scanned < TICKER_MAX_SCAN) {
    const batch = batchStmt.all(cursor, TICKER_BATCH) as SpinRow[];
    if (batch.length === 0) break;
    let batchHasRecent = false;
    for (const row of batch) {
      const ts = Number(tsSecValue(row.created_at));
      if (ts >= cutoff) batchHasRecent = true;
      if (ts < cutoff || ts > newest) continue;
      const bet = parseFloat(row.bet_amount);
      if (!(bet > 0)) continue;
      const win = parseFloat(row.win_amount);
      if (win >= minMult * bet) hits.push(row);
      if (hits.length >= limit) break;
    }
    cursor = batch[batch.length - 1].id;
    scanned += batch.length;
    // End of table, or a full batch whose rows are all already outside the
    // 7-day window (ids are time-ordered in practice) => no more useful rows.
    if (batch.length < TICKER_BATCH || !batchHasRecent) break;
  }
  return hits;
}

export const socialRouter = createRouter({
  recentWins: publicQuery
    .input(z.object({ limit: z.number().min(1).max(50).default(20) }).optional())
    .query(async ({ input }) => {
      if (getSetting<boolean>("ticker_enabled") === false) return { wins: [] };
      const minMult = getSetting<number>("ticker_min_multiplier") ?? 25;
      const goldMult = getSetting<number>("ticker_gold_multiplier") ?? 100;
      const limit = input?.limit ?? 20;
      const nowSec = Math.floor(Date.now() / 1000);
      const rates = displayFxRates();
      const usdtRate = rates.USDT ?? 110;

      const key = `${limit}|${minMult}|${goldMult}|${usdtRate}`;
      const nowMs = Date.now();
      if (CACHE_ENABLED && cache && cache.key === key && nowMs - cache.at < TICKER_CACHE_MS) {
        return { wins: cache.wins };
      }

      const client = getSqliteClient();
      const rows = collectRecentWins(client, limit, minMult, nowSec);

      const userIds = [...new Set(rows.map((r) => r.user_id))];
      const usersById = new Map<number, { name: string | null; email: string | null }>();
      if (userIds.length > 0) {
        const placeholders = userIds.map(() => "?").join(",");
        const userRows = client
          .prepare(`SELECT id, name, email FROM users WHERE id IN (${placeholders})`)
          .all(...userIds) as Array<{ id: number; name: string | null; email: string | null }>;
        for (const u of userRows) usersById.set(u.id, { name: u.name, email: u.email });
      }

      const wins: TickerWin[] = rows.map((r) => {
        const win = parseFloat(r.win_amount);
        const bet = parseFloat(r.bet_amount);
        const multiplier = bet > 0 ? win / bet : 0;
        const usdtEquivalent = toUsdt(win, r.currency);
        const u = usersById.get(r.user_id);
        return {
          maskedName: maskName(u?.name ?? null, u?.email ?? null),
          amount: r.win_amount,
          currency: r.currency,
          multiplier: Math.round(multiplier * 100) / 100,
          gold: multiplier >= goldMult,
          modeId: r.mode_id,
          usdtEquivalent,
          bdtEquivalent: usdtEquivalent * usdtRate,
          createdAt: Number(tsSecValue(r.created_at)),
        };
      });

      if (CACHE_ENABLED) cache = { at: nowMs, key, wins };
      return { wins };
    }),
});

function tsSecValue(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const asNum = Number(v);
    if (Number.isFinite(asNum) && v.trim() !== "") return asNum;
    const parsed = Date.parse(v.replace(" ", "T") + "Z");
    return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0;
  }
  if (v instanceof Date) return Math.floor(v.getTime() / 1000);
  return 0;
}




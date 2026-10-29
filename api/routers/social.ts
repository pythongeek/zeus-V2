import { z } from "zod";
import { createRouter, publicQuery } from "../middleware";
import { getSqliteClient } from "../queries/connection";
import { getSetting } from "../lib/settings";
import { tsSec, toUsdt } from "../lib/limits";
import { displayFxRates } from "./balance";

/**
 * Step 9 — live win ticker (playbook §4.2 integrity rules).
 * REAL settled spins only — nothing is ever fabricated; in
 * production an empty feed simply renders nothing. A win appears
 * only at >= ticker_min_multiplier x bet (default 25x), after a
 * short display delay, with the player's name masked to its first
 * two characters. No user ids leave the server.
 */

const TICKER_DELAY_SECONDS = 15;
const TICKER_MAX_AGE_SECONDS = 7 * 86400;

export function maskName(name: string | null, email: string | null): string {
  const base = (name && name.trim()) || (email ? email.split("@")[0] : "") || "Player";
  const chars = [...base];
  return chars.slice(0, 2).join("") + "***";
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
      const rows = getSqliteClient()
        .prepare(
          `SELECT s.id, s.win_amount, s.bet_amount, s.currency, s.mode_id, s.created_at, u.name, u.email
           FROM spins s JOIN users u ON u.id = s.user_id
           WHERE CAST(s.bet_amount AS REAL) > 0
             AND CAST(s.win_amount AS REAL) >= ? * CAST(s.bet_amount AS REAL)
             AND ${tsSec("s.created_at")} <= ?
             AND ${tsSec("s.created_at")} >= ?
           ORDER BY s.id DESC LIMIT ?`,
        )
        .all(minMult, nowSec - TICKER_DELAY_SECONDS, nowSec - TICKER_MAX_AGE_SECONDS, limit) as Array<{
        id: number;
        win_amount: string;
        bet_amount: string;
        currency: string;
        mode_id: string;
        created_at: unknown;
        name: string | null;
        email: string | null;
      }>;
      const rates = displayFxRates();
      return {
        wins: rows.map((r) => {
          const win = parseFloat(r.win_amount);
          const bet = parseFloat(r.bet_amount);
          const multiplier = bet > 0 ? win / bet : 0;
          const usdtEquivalent = toUsdt(win, r.currency);
          return {
            maskedName: maskName(r.name, r.email),
            amount: r.win_amount,
            currency: r.currency,
            multiplier: Math.round(multiplier * 100) / 100,
            gold: multiplier >= goldMult,
            modeId: r.mode_id,
            usdtEquivalent,
            bdtEquivalent: usdtEquivalent * (rates.USDT ?? 110),
            createdAt: Number(tsSecValue(r.created_at)),
          };
        }),
      };
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

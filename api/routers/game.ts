import { z } from "zod";
import { createRouter, publicQuery, authedQuery } from "../middleware";
import { getDb, getSqliteClient } from "../queries/connection";
import { parseMoney, fmtMoney, mulDivRound } from "../lib/money";
import { getSetting, getPublicConfig } from "../lib/settings";
import { checkSpinPace } from "../lib/rate-limit";
import { gameSessions, spins } from "../../db/schema";
import { eq, and, desc } from "drizzle-orm";
import crypto from "crypto";

// Bet limits (server-enforced; mirror the frontend store)
// Bet limits live in admin settings (B1: min_bet / max_bet) and are
// read per spin; the defaults preserve the original 0.1 / 1000.

// A6: pools are USDT-denominated and pool-funded. Seeds are the house
// float restored after every hit; contributions (below) regrow them.
const JACKPOT_SEEDS: Record<string, string> = {
  mini: "5",
  major: "25",
  mega: "100",
};

function getDbSeedForTier(tier: string): string {
  // B2: seeds are admin-configurable; the const is the fallback.
  const seeds = getSetting<Record<string, string>>("jackpot_seeds");
  return seeds?.[tier] ?? JACKPOT_SEEDS[tier] ?? "5";
}

// Symbol definitions
const SYMBOLS = {
  ZEUS: 0,      // Wild
  SCATTER: 1,   // Thunderbolt
  PEGASUS: 2,
  TEMPLE: 3,
  HARP: 4,
  AMPHORA: 5,
  HELMET: 6,
  SHIELD: 7,
  ACE: 8,
  KING: 9,
  QUEEN: 10,
} as const;

const SYMBOL_NAMES: Record<number, string> = {
  0: "zeus", 1: "thunderbolt", 2: "pegasus", 3: "temple",
  4: "harp", 5: "amphora", 6: "helmet", 7: "shield",
  8: "ace", 9: "king", 10: "queen",
};

// Payout table (multiplier of bet per line)
const PAYOUTS: Record<number, { 3: number; 4: number; 5: number }> = {
  [SYMBOLS.ZEUS]: { 3: 50, 4: 200, 5: 1000 },
  [SYMBOLS.SCATTER]: { 3: 2, 4: 5, 5: 20 },  // Scatter pays anywhere + free spins
  [SYMBOLS.PEGASUS]: { 3: 30, 4: 100, 5: 500 },
  [SYMBOLS.TEMPLE]: { 3: 25, 4: 80, 5: 400 },
  [SYMBOLS.HARP]: { 3: 20, 4: 75, 5: 300 },
  [SYMBOLS.AMPHORA]: { 3: 15, 4: 40, 5: 200 },
  [SYMBOLS.HELMET]: { 3: 12, 4: 30, 5: 150 },
  [SYMBOLS.SHIELD]: { 3: 10, 4: 30, 5: 100 },
  [SYMBOLS.ACE]: { 3: 5, 4: 18, 5: 75 },
  [SYMBOLS.KING]: { 3: 5, 4: 18, 5: 75 },
  [SYMBOLS.QUEEN]: { 3: 4, 4: 12, 5: 60 },
};

// Reel strips (50 positions each, weighted)
const REEL_STRIPS = [
  [0,0,1,1, 2,2,2,3,3,3, 4,4,4,5,5,5,5, 6,6,6,6,7,7,7,7, 8,8,8,8,8,9,9,9,9,9, 10,10,10,10,10],
  [0,0,10,1, 2,2,2,3,3,3, 4,4,4,5,5,5,5, 6,6,6,6,7,7,7,7, 8,8,8,8,8,9,9,9,9,9, 10,10,10,10,10],
  [0,0,0,1,1, 2,2,2,3,3,3, 4,4,4,5,5,5,5, 6,6,6,6,7,7,7,7, 8,8,8,8,8,9,9,9,9,9, 10,10,10,10,10],
  [0,0,10,1, 2,2,2,3,3,3, 4,4,4,5,5,5,5, 6,6,6,6,7,7,7,7, 8,8,8,8,8,9,9,9,9,9, 10,10,10,10,10],
  [0,0,10,1, 2,2,2,3,3,3, 4,4,4,5,5,5,5, 6,6,6,6,7,7,7,7, 8,8,8,8,8,9,9,9,9,9, 10,10,10,10,10],
];

// B2: the game math is admin-configurable through settings. Defaults
// below are exactly the A4-certified constants (PAYOUTS / REEL_STRIPS /
// free-spin awards / thunder). Any invalid stored shape falls back to
// the certified default for that piece. NOTE: changing reels/paytable
// invalidates fairness verification for spins played under the old math
// and requires RTP re-certification (see admin UI warning).
export interface MathConfig {
  payouts: typeof PAYOUTS;
  strips: number[][];
  freeSpins: Record<string, number>;
  thunderDenominator: number;
  thunderFloorX: number;
}
const DEFAULT_FREE_SPINS: Record<string, number> = { "3": 8, "4": 12, "5": 20 };

export function getMathConfig(): MathConfig {
  const cfg: MathConfig = {
    payouts: PAYOUTS,
    strips: REEL_STRIPS,
    freeSpins: DEFAULT_FREE_SPINS,
    thunderDenominator: 200,
    thunderFloorX: 5,
  };
  try {
    const p = getSetting<Record<string, { 3: number; 4: number; 5: number }>>("math_paytable");
    if (p && typeof p === "object") {
      const merged: Record<number, { 3: number; 4: number; 5: number }> = { ...PAYOUTS };
      let ok = true;
      for (let id = 0; id <= 10; id++) {
        const e = (p as any)[String(id)];
        if (!e || ![3, 4, 5].every((k) => Number.isFinite(e[k]) && e[k] >= 0)) { ok = false; break; }
        merged[id] = { 3: e[3], 4: e[4], 5: e[5] };
      }
      if (ok) cfg.payouts = merged as typeof PAYOUTS;
    }
  } catch { /* keep default */ }
  try {
    const st = getSetting<number[][]>("math_reels");
    if (
      Array.isArray(st) && st.length === 5 &&
      st.every((r) => Array.isArray(r) && r.length >= 10 && r.every((v) => Number.isInteger(v) && v >= 0 && v <= 10))
    ) cfg.strips = st;
  } catch { /* keep default */ }
  try {
    const fs = getSetting<Record<string, number>>("math_free_spins");
    if (fs && ["3", "4", "5"].every((k) => Number.isInteger(fs[k]) && fs[k] >= 0 && fs[k] <= 1000)) {
      cfg.freeSpins = { "3": fs["3"], "4": fs["4"], "5": fs["5"] };
    }
  } catch { /* keep default */ }
  try {
    const th = getSetting<{ chanceDenominator: number; floorX: number }>("math_thunder");
    if (th && Number.isInteger(th.chanceDenominator) && th.chanceDenominator >= 1 && th.chanceDenominator <= 100000 &&
        Number.isFinite(th.floorX) && th.floorX >= 0 && th.floorX <= 100) {
      cfg.thunderDenominator = th.chanceDenominator;
      cfg.thunderFloorX = th.floorX;
    }
  } catch { /* keep default */ }
  return cfg;
}

// 20 paylines (row indices for each reel)
const PAYLINES = [
  [1,1,1,1,1], // Middle row
  [0,0,0,0,0], // Top row
  [2,2,2,2,2], // Bottom row
  [0,1,2,1,0], // V shape
  [2,1,0,1,2], // Inverted V
  [0,0,1,0,0], // Top with dip
  [2,2,1,2,2], // Bottom with rise
  [1,0,0,0,1], // Top U
  [1,2,2,2,1], // Bottom U
  [0,1,1,1,0], // Top valley
  [2,1,1,1,2], // Bottom valley
  [1,0,1,0,1], // W shape
  [1,2,1,2,1], // M shape
  [0,1,0,1,0], // Zigzag top
  [2,1,2,1,2], // Zigzag bottom
  [0,2,0,2,0], // Extreme zigzag
  [2,0,2,0,2], // Extreme zigzag inv
  [1,1,0,1,1], // Middle with top dip
  [1,1,2,1,1], // Middle with bottom dip
  [0,0,2,0,0], // Top to bottom spike
];

// Provably fair spin calculation
function calculateSpin(
  serverSeed: string,
  clientSeed: string,
  nonce: number,
  strips: number[][] = REEL_STRIPS
) {
  const hash = crypto
    .createHash("sha256")
    .update(serverSeed + clientSeed + String(nonce))
    .digest("hex");

  // Use first 10 bytes (20 hex chars) for 5 reel stops
  const reelStops: number[] = [];
  for (let i = 0; i < 5; i++) {
    const bytePair = hash.substring(i * 4, i * 4 + 4);
    const value = parseInt(bytePair, 16);
    const reelLength = strips[i].length;
    reelStops.push(value % reelLength);
  }

  // Get visible symbols (3 per reel)
  const symbols: number[][] = [];
  for (let reel = 0; reel < 5; reel++) {
    const reelSymbols: number[] = [];
    for (let row = 0; row < 3; row++) {
      const pos = (reelStops[reel] + row) % strips[reel].length;
      reelSymbols.push(strips[reel][pos]);
    }
    symbols.push(reelSymbols);
  }

  return { reelStops, symbols, hash };
}

// Evaluate paylines
function evaluatePaylines(
  symbols: number[][],
  betPerLine: number,
  math: { payouts: typeof PAYOUTS; freeSpins: Record<string, number> } = {
    payouts: PAYOUTS,
    freeSpins: DEFAULT_FREE_SPINS,
  }
): { lines: Array<{ lineIndex: number; symbol: number; count: number; payout: number; positions: Array<[number, number]> }>; totalPayout: number; scatterCount: number; freeSpinsAwarded: number } {
  const lines: Array<{ lineIndex: number; symbol: number; count: number; payout: number; positions: Array<[number, number]> }> = [];
  let totalPayout = 0;

  // Check each payline
  for (let li = 0; li < PAYLINES.length; li++) {
    const line = PAYLINES[li];
    const firstSymbol = symbols[0][line[0]];
    
    // Wild can substitute
    let matchSymbol = firstSymbol === SYMBOLS.ZEUS ? -1 : firstSymbol;
    let matchCount = 1;
    const positions: Array<[number, number]> = [[0, line[0]]];

    for (let reel = 1; reel < 5; reel++) {
      const sym = symbols[reel][line[reel]];
      if (sym === SYMBOLS.ZEUS || sym === matchSymbol || matchSymbol === -1) {
        if (matchSymbol === -1 && sym !== SYMBOLS.ZEUS) {
          matchSymbol = sym;
        }
        matchCount++;
        positions.push([reel, line[reel]]);
      } else {
        break;
      }
    }

    if (matchSymbol === -1) matchSymbol = SYMBOLS.ZEUS;

    if (matchCount >= 3 && math.payouts[matchSymbol]) {
      const payout = math.payouts[matchSymbol][matchCount as 3 | 4 | 5] * betPerLine;
      if (payout > 0) {
        lines.push({ lineIndex: li, symbol: matchSymbol, count: matchCount, payout, positions });
        totalPayout += payout;
      }
    }
  }

  // Count scatters (anywhere on reels)
  let scatterCount = 0;
  for (let reel = 0; reel < 5; reel++) {
    for (let row = 0; row < 3; row++) {
      if (symbols[reel][row] === SYMBOLS.SCATTER) {
        scatterCount++;
      }
    }
  }

  let freeSpinsAwarded = 0;
  if (scatterCount >= 3) {
    const scatterPayout = math.payouts[SYMBOLS.SCATTER][Math.min(scatterCount, 5) as 3 | 4 | 5] * betPerLine * PAYLINES.length;
    totalPayout += scatterPayout;
    freeSpinsAwarded = math.freeSpins[String(Math.min(scatterCount, 5))] ?? 0;
  }

  return { lines, totalPayout, scatterCount, freeSpinsAwarded };
}

// Check for provably fair thunder strike bonus derived from spin SHA-256 hash
function checkThunderStrike(hash: string, denominator = 200): boolean {
  const val = parseInt(hash.substring(20, 24), 16);
  return val % denominator === 0; // default 0.5% (A4 rebalance: was 1%)
}

// Check provably fair jackpots derived from spin SHA-256 hash
function checkJackpot(hash: string): { tier: string } | null {
  const val = parseInt(hash.substring(24, 30), 16); // 24-bit value (0..16777215)
  if (val < 16) return { tier: "mega" };
  if (val < 167) return { tier: "major" };
  if (val < 1677) return { tier: "mini" };
  return null;
}

export const gameRouter = createRouter({
  startSession: authedQuery
    .input(z.object({
      clientSeed: z.string().min(1).max(64).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const serverSeed = crypto.randomBytes(32).toString("hex");
      const serverSeedHash = crypto.createHash("sha256").update(serverSeed).digest("hex");
      const clientSeed = input.clientSeed || crypto.randomBytes(16).toString("hex");

      // No demo fallback: sessions are always persisted. If the database is
      // unavailable the spin endpoint must not operate on untracked state.
      const db = getDb();
      const userId = ctx.user.id;

      // End any active sessions
      await db.update(gameSessions)
        .set({ status: "completed", endedAt: new Date() })
        .where(and(
          eq(gameSessions.userId, userId),
          eq(gameSessions.status, "active")
        ));

      const [session] = await db.insert(gameSessions).values({
        userId,
        serverSeed,
        serverSeedHash,
        clientSeed,
        nonce: 0,
        status: "active",
      }).returning();

      const fullSession = await db.select().from(gameSessions)
        .where(eq(gameSessions.id, session.id))
        .then(rows => rows[0]);

      return {
        sessionId: fullSession.id,
        serverSeedHash: fullSession.serverSeedHash,
        clientSeed: fullSession.clientSeed,
        startingNonce: 0,
      };
    }),

  spin: authedQuery
    .input(z.object({
      sessionId: z.number(),
      betAmount: z.string().regex(/^\d+\.?\d*$/),
      currency: z.enum(["BTC", "ETH", "USDT", "BDT"]),
    }))
    .mutation(async ({ ctx, input }) => {
      // A3: from here the bet is exact decimal money (BigInt micro units).
      let betMicro: bigint;
      try {
        betMicro = parseMoney(input.betAmount);
      } catch {
        throw new Error("Invalid bet amount");
      }
      if (betMicro <= 0n) {
        throw new Error("Invalid bet amount");
      }
      if (getSetting<boolean>("maintenance_mode")) {
        throw new Error("Game is under maintenance");
      }
      // F1: per-user spin pacing (300ms floor, 90/min burst cap).
      if (!checkSpinPace(ctx.user.id)) {
        throw new Error("You are spinning too fast — please slow down");
      }
      const enabledCurrencies = getSetting<string[]>("currencies_enabled");
      if (
        Array.isArray(enabledCurrencies) &&
        !enabledCurrencies.includes(input.currency)
      ) {
        throw new Error("Currency not enabled");
      }
      const minMicro = parseMoney(getSetting<string>("min_bet"));
      const maxMicro = parseMoney(getSetting<string>("max_bet"));
      if (betMicro < minMicro || betMicro > maxMicro) {
        throw new Error(
          `Bet must be between ${fmtMoney(minMicro)} and ${fmtMoney(maxMicro)}`,
        );
      }

      // A2: the whole spin — session/balance reads, outcome calculation,
      // balance update, session update, spin record, jackpot movement and
      // ledger rows — runs in ONE synchronous BEGIN IMMEDIATE transaction on
      // the raw SQLite client. Concurrent spins serialize on the write lock
      // (busy_timeout is set in connection.ts), re-read nonce and balance
      // inside the lock, and either every write lands or none do. The
      // previous implementation used separate awaited writes: a mid-spin
      // failure could move money with no spin record, and parallel spins
      // raced the balance check and could overdraw the account.
      const client = getSqliteClient();
      const runSpin = client.transaction(() => {
        const session = client
          .prepare(
            "SELECT * FROM game_sessions WHERE id = ? AND user_id = ? AND status = 'active'",
          )
          .get(input.sessionId, ctx.user.id) as any;
        if (!session) {
          throw new Error("Active session not found for this user");
        }

        // A5: free-spin state lives on the session. While free spins
        // remain, this spin is FREE: it plays at the bet/currency locked
        // when the spins were awarded, ignores the requested bet, and is
        // never charged. Awards during a free spin retrigger (add).
        const fsRemaining = (session.free_spins_remaining as number) ?? 0;
        const isFreeSpin = fsRemaining > 0;
        const spinBetMicro = isFreeSpin
          ? parseMoney(session.free_spins_bet as string)
          : betMicro;
        const spinCurrency = isFreeSpin
          ? (session.free_spins_currency as string)
          : input.currency;

        const balRow = client
          .prepare("SELECT * FROM balances WHERE user_id = ? AND currency = ?")
          .get(ctx.user.id, spinCurrency) as any;
        const availableMicro = balRow ? parseMoney(balRow.available) : 0n;
        if (!isFreeSpin && (!balRow || availableMicro < spinBetMicro)) {
          throw new Error("Insufficient balance");
        }

        // Provably fair outcome for this spin (math + feature toggles
        // are read per spin from admin settings — B2)
        const math = getMathConfig();
        const features = getSetting<{ freeSpins: boolean; thunder: boolean; jackpots: boolean }>("features");
        const newNonce = session.nonce + 1;
        const { reelStops, symbols, hash } = calculateSpin(
          session.server_seed,
          session.client_seed,
          newNonce,
          math.strips,
        );

        const betPerLine = Number(spinBetMicro) / 1e8 / PAYLINES.length;
        const { lines, scatterCount, freeSpinsAwarded: rawAward } =
          evaluatePaylines(symbols, betPerLine, math);
        const freeSpinsAwarded = features.freeSpins ? rawAward : 0;

        // Exact win in micro units, recomputed from line multipliers —
        // evaluatePaylines works in floats; money never does (A3).
        const microForResult = (ls: typeof lines, sc: number): bigint => {
          let total = 0n;
          for (const l of ls) {
            total += mulDivRound(
              spinBetMicro,
              BigInt(math.payouts[l.symbol][l.count as 3 | 4 | 5]),
              20n,
            );
          }
          if (sc >= 3) {
            total +=
              spinBetMicro *
              BigInt(math.payouts[SYMBOLS.SCATTER][Math.min(sc, 5) as 3 | 4 | 5]);
          }
          return total;
        };
        let winMicro = microForResult(lines, scatterCount);
        const isBigWin = winMicro >= spinBetMicro * 50n;
        let isJackpot = false;
        let featureTriggered: "none" | "free_spins" | "thunder_strike" = "none";
        let jackpotTier: string | null = null;

        if (scatterCount >= 3 && freeSpinsAwarded > 0) {
          featureTriggered = "free_spins";
        }

        if (winMicro === 0n && features.thunder && checkThunderStrike(hash, math.thunderDenominator)) {
          featureTriggered = "thunder_strike";
          const numTransforms = (parseInt(hash.substring(30, 32), 16) % 3) + 1;
          for (let i = 0; i < numTransforms; i++) {
            const r = parseInt(hash.substring(32 + i * 4, 34 + i * 4), 16) % 5;
            const row = parseInt(hash.substring(34 + i * 4, 36 + i * 4), 16) % 3;
            symbols[r][row] = SYMBOLS.ZEUS;
          }
          const reeval = evaluatePaylines(symbols, betPerLine, math);
          const reevalMicro = microForResult(reeval.lines, reeval.scatterCount);
          const thunderFloor = mulDivRound(
            spinBetMicro,
            BigInt(Math.round(math.thunderFloorX * 100)),
            100n,
          );
          winMicro = reevalMicro > thunderFloor ? reevalMicro : thunderFloor; // A4/B2: thunder floor from math settings
          lines.push(...reeval.lines);
        }

        const jackpot = features.jackpots ? checkJackpot(hash) : null;
        // A6: the award IS the tier's pool balance at this moment (read
        // inside the transaction) — no longer a bet multiplier.
        const poolRows = client
          .prepare("SELECT tier, current_amount FROM jackpot_pool")
          .all() as any[];
        const poolMicroByTier: Record<string, bigint> = {};
        for (const p of poolRows) {
          poolMicroByTier[p.tier] = parseMoney(p.current_amount);
        }
        let jackpotAwardMicro = 0n;
        if (jackpot) {
          isJackpot = true;
          jackpotTier = jackpot.tier;
          jackpotAwardMicro = poolMicroByTier[jackpot.tier] ?? 0n;
          winMicro += jackpotAwardMicro;
        }

        // Free-spin bookkeeping: consume one, add any retrigger/award.
        const fsRemainingAfter = isFreeSpin
          ? fsRemaining - 1 + freeSpinsAwarded
          : freeSpinsAwarded;
        const fsBetStored =
          fsRemainingAfter > 0
            ? isFreeSpin
              ? (session.free_spins_bet as string)
              : fmtMoney(spinBetMicro)
            : null;
        const fsCurrencyStored =
          fsRemainingAfter > 0 ? spinCurrency : null;

        const updatedMicro = isFreeSpin
          ? availableMicro + winMicro
          : availableMicro - spinBetMicro + winMicro;
        const nowSec = Math.floor(Date.now() / 1000);

        if (balRow) {
          client
            .prepare("UPDATE balances SET available = ?, updated_at = ? WHERE id = ?")
            .run(fmtMoney(updatedMicro), nowSec, balRow.id);
        } else {
          // Only reachable on a free spin whose balance row never existed.
          client
            .prepare(
              "INSERT INTO balances (user_id, currency, available, locked, total_deposited, total_withdrawn, updated_at) VALUES (?, ?, ?, '0', '0', '0', ?)",
            )
            .run(ctx.user.id, spinCurrency, fmtMoney(updatedMicro), nowSec);
        }

        client
          .prepare(
            "UPDATE game_sessions SET nonce = ?, total_spins = ?, total_wagered = ?, total_won = ?, free_spins_remaining = ?, free_spins_bet = ?, free_spins_currency = ? WHERE id = ?",
          )
          .run(
            newNonce,
            session.total_spins + 1,
            fmtMoney(
              parseMoney(session.total_wagered) +
                (isFreeSpin ? 0n : spinBetMicro),
            ),
            fmtMoney(parseMoney(session.total_won) + winMicro),
            fsRemainingAfter,
            fsBetStored,
            fsCurrencyStored,
            session.id,
          );

        const spinRow = client
          .prepare(
            `INSERT INTO spins (session_id, user_id, nonce, bet_amount, currency, reel_positions, symbols_shown, win_amount, win_lines, is_big_win, is_jackpot, feature_triggered, free_spins_awarded, hash, is_free_spin)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
          )
          .get(
            session.id,
            ctx.user.id,
            newNonce,
            fmtMoney(spinBetMicro),
            spinCurrency,
            JSON.stringify(reelStops),
            JSON.stringify(symbols.map((col) => col.map((s) => SYMBOL_NAMES[s]))),
            fmtMoney(winMicro),
            JSON.stringify(lines),
            isBigWin ? 1 : 0,
            isJackpot ? 1 : 0,
            featureTriggered,
            freeSpinsAwarded,
            hash,
            isFreeSpin ? 1 : 0,
          ) as any;
        const spinId = spinRow.id as number;

        // Ledger: paid spins write a debit leg (then a credit leg on a
        // win); free spins write only a free_spin_credit leg on a win.
        const insLedger = client.prepare(
          "INSERT INTO ledger_entries (user_id, spin_id, kind, currency, amount, balance_after) VALUES (?, ?, ?, ?, ?, ?)",
        );
        if (!isFreeSpin) {
          insLedger.run(
            ctx.user.id,
            spinId,
            "spin_debit",
            spinCurrency,
            fmtMoney(-spinBetMicro),
            fmtMoney(availableMicro - spinBetMicro),
          );
        }
        if (winMicro > 0n) {
          insLedger.run(
            ctx.user.id,
            spinId,
            isFreeSpin ? "free_spin_credit" : "spin_credit",
            spinCurrency,
            fmtMoney(winMicro),
            fmtMoney(updatedMicro),
          );
        }

        // A6 pool movement: paid spins contribute 1% of the bet, split
        // mini 0.5% / major 0.3% / mega 0.2%. The hit tier paid out its
        // whole balance above and now reseeds to the house float.
        const sharesCfg = getSetting<Record<string, number>>("jackpot_shares");
        const SHARES: Record<string, bigint> = {
          mini: BigInt(sharesCfg?.mini ?? 5),
          major: BigInt(sharesCfg?.major ?? 3),
          mega: BigInt(sharesCfg?.mega ?? 2),
        };
        for (const p of features.jackpots ? poolRows : []) {
          if (jackpotTier && p.tier === jackpotTier) {
            client
              .prepare(
                "UPDATE jackpot_pool SET current_amount = ?, last_won_at = ?, last_won_by = ?, hit_count = hit_count + 1 WHERE tier = ?",
              )
              .run(getDbSeedForTier(p.tier), nowSec, ctx.user.id, p.tier);
          } else if (!isFreeSpin) {
            const share = mulDivRound(
              spinBetMicro,
              SHARES[p.tier] ?? 0n,
              1000n,
            );
            if (share > 0n) {
              client
                .prepare("UPDATE jackpot_pool SET current_amount = ? WHERE tier = ?")
                .run(
                  fmtMoney((poolMicroByTier[p.tier] ?? 0n) + share),
                  p.tier,
                );
            }
          }
        }

        return {
          spinId,
          newNonce,
          reelStops,
          symbols,
          winMicro,
          lines,
          isBigWin,
          isJackpot,
          featureTriggered,
          freeSpinsAwarded,
          hash,
          updatedMicro,
          jackpotTier,
          jackpotAwardMicro,
          isFreeSpin,
          fsRemainingAfter,
          spinBetMicro,
          spinCurrency,
        };
      });

      let out: ReturnType<typeof runSpin>;
      try {
        out = runSpin.immediate();
      } catch (e: any) {
        const userFacing = [
          "Insufficient balance",
          "Active session not found for this user",
        ].includes(e?.message);
        if (userFacing) throw e;
        // The transaction rolled back: no money moved, no spin recorded.
        console.error("[spin] transaction failed", e);
        throw new Error("Spin could not be recorded — please try again");
      }

      return {
        spinId: out.spinId,
        nonce: out.newNonce,
        reelPositions: out.reelStops,
        symbols: out.symbols.map((col: number[]) => col.map((s: number) => SYMBOL_NAMES[s])),
        winAmount: fmtMoney(out.winMicro),
        winLines: out.lines,
        isBigWin: out.isBigWin,
        isJackpot: out.isJackpot,
        featureTriggered: out.featureTriggered,
        freeSpinsAwarded: out.freeSpinsAwarded,
        hash: out.hash,
        newBalance: fmtMoney(out.updatedMicro),
        jackpotTier: out.jackpotTier,
        jackpotAward:
          out.jackpotAwardMicro > 0n ? fmtMoney(out.jackpotAwardMicro) : null,
        isFreeSpin: out.isFreeSpin,
        freeSpinsRemaining: out.fsRemainingAfter,
        betUsed: fmtMoney(out.spinBetMicro),
        currencyUsed: out.spinCurrency,
      };
    }),

  endSession: authedQuery
    .input(z.object({ sessionId: z.number() }))
    .mutation(async ({ ctx, input }) => {
      // Strict DB-only: reveal the seed only for a real session owned by the
      // caller. No demo fallback data.
      const db = getDb();
      const session = await db.select().from(gameSessions)
        .where(and(
          eq(gameSessions.id, input.sessionId),
          eq(gameSessions.userId, ctx.user.id)
        ))
        .then(rows => rows[0]);

      if (!session) {
        throw new Error("Session not found");
      }

      if ((session.freeSpinsRemaining ?? 0) > 0) {
        throw new Error(
          "Free spins still active: finish them before ending the session",
        );
      }

      await db.update(gameSessions)
        .set({ status: "completed", endedAt: new Date() })
        .where(eq(gameSessions.id, input.sessionId));

      return {
        serverSeed: session.serverSeed,
        totalSpins: session.totalSpins,
        totalWagered: session.totalWagered,
        totalWon: session.totalWon,
      };
    }),

  getPaytable: publicQuery.query(() => {
    return {
      symbols: Object.entries(SYMBOL_NAMES).map(([id, name]) => ({
        id: parseInt(id),
        name,
        payouts: getMathConfig().payouts[parseInt(id)] || null,
        isWild: parseInt(id) === SYMBOLS.ZEUS,
        isScatter: parseInt(id) === SYMBOLS.SCATTER,
      })),
      paylines: PAYLINES.length,
      rtp: getSetting<number>("rtp_declared"), // A4-certified 96.0 for the default math (see rtp.test.ts); admin updates only after re-certification
      volatility: "HIGH",
      freeSpins: getMathConfig().freeSpins,
    };
  }),

  getRecentSpins: authedQuery
    .input(z.object({ limit: z.number().min(1).max(100).default(20) }))
    .query(async ({ ctx, input }) => {
      try {
        const db = getDb();
        return await db.select()
          .from(spins)
          .where(eq(spins.userId, ctx.user.id))
          .orderBy(desc(spins.createdAt))
          .limit(input.limit);
      } catch {
        return [];
      }
    }),

  // B1: public admin-controlled configuration for the game client.
  getConfig: publicQuery.query(async () => {
    return getPublicConfig();
  }),

  getSessionSpins: authedQuery
    .input(z.object({ sessionId: z.number() }))
    .query(async ({ ctx, input }) => {
      // A1 (Z-01): strict lookup only — the previous version returned a
      // fabricated demo session (fake hash, fake totals) when the real one
      // was missing. Never invent money/session data; a missing session is
      // an error, and DB failures surface instead of being masked.
      const db = getDb();
      const session = await db.select().from(gameSessions)
        .where(and(
          eq(gameSessions.id, input.sessionId),
          eq(gameSessions.userId, ctx.user.id)
        ))
        .then(rows => rows[0]);

      if (!session) {
        throw new Error("Session not found");
      }

      const spinRecords = await db.select()
        .from(spins)
        .where(eq(spins.sessionId, input.sessionId))
        .orderBy(spins.nonce);

      return {
        session: {
          ...session,
          serverSeed: session.status === "completed" ? session.serverSeed : null,
        },
        spins: spinRecords,
      };
    }),
});

export { SYMBOLS, SYMBOL_NAMES, REEL_STRIPS, PAYLINES, calculateSpin, evaluatePaylines, checkThunderStrike };

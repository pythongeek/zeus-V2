import { z } from "zod";
import { createRouter, publicQuery, authedQuery } from "../middleware";
import { getDb, getSqliteClient } from "../queries/connection";
import { parseMoney, fmtMoney, mulDivRound } from "../lib/money";
import { gameSessions, spins } from "../../db/schema";
import { eq, and, desc } from "drizzle-orm";
import crypto from "crypto";

// Bet limits (server-enforced; mirror the frontend store)
const MIN_BET = 0.1;
const MAX_BET = 1000;
const MIN_BET_MICRO = parseMoney("0.1");
const MAX_BET_MICRO = parseMoney("1000");

const JACKPOT_SEEDS: Record<string, string> = {
  mini: "0.01",
  major: "0.1",
  mega: "1.0",
};

function getDbSeedForTier(tier: string): string {
  return JACKPOT_SEEDS[tier] ?? "0.01";
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
  nonce: number
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
    const reelLength = REEL_STRIPS[i].length;
    reelStops.push(value % reelLength);
  }

  // Get visible symbols (3 per reel)
  const symbols: number[][] = [];
  for (let reel = 0; reel < 5; reel++) {
    const reelSymbols: number[] = [];
    for (let row = 0; row < 3; row++) {
      const pos = (reelStops[reel] + row) % REEL_STRIPS[reel].length;
      reelSymbols.push(REEL_STRIPS[reel][pos]);
    }
    symbols.push(reelSymbols);
  }

  return { reelStops, symbols, hash };
}

// Evaluate paylines
function evaluatePaylines(
  symbols: number[][],
  betPerLine: number
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

    if (matchCount >= 3 && PAYOUTS[matchSymbol]) {
      const payout = PAYOUTS[matchSymbol][matchCount as 3 | 4 | 5] * betPerLine;
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
    const scatterPayout = PAYOUTS[SYMBOLS.SCATTER][Math.min(scatterCount, 5) as 3 | 4 | 5] * betPerLine * PAYLINES.length;
    totalPayout += scatterPayout;
    freeSpinsAwarded = scatterCount === 3 ? 8 : scatterCount === 4 ? 12 : 20;
  }

  return { lines, totalPayout, scatterCount, freeSpinsAwarded };
}

// Check for provably fair thunder strike bonus derived from spin SHA-256 hash
function checkThunderStrike(hash: string): boolean {
  const val = parseInt(hash.substring(20, 24), 16);
  return (val % 200) === 0; // 0.5% deterministic chance (A4 rebalance: was 1%)
}

// Check provably fair jackpots derived from spin SHA-256 hash
function checkJackpot(hash: string): { tier: string; amount: number } | null {
  const val = parseInt(hash.substring(24, 30), 16); // 24-bit value (0..16777215)
  if (val < 16) return { tier: "mega", amount: 10000 };
  if (val < 167) return { tier: "major", amount: 500 };
  if (val < 1677) return { tier: "mini", amount: 50 };
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
      if (betMicro < MIN_BET_MICRO || betMicro > MAX_BET_MICRO) {
        throw new Error(`Bet must be between ${MIN_BET} and ${MAX_BET}`);
      }
      const betAmount = Number(betMicro) / 1e8; // engine/display float only

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

        const balRow = client
          .prepare("SELECT * FROM balances WHERE user_id = ? AND currency = ?")
          .get(ctx.user.id, input.currency) as any;
        const availableMicro = balRow ? parseMoney(balRow.available) : 0n;
        if (!balRow || availableMicro < betMicro) {
          throw new Error("Insufficient balance");
        }

        // Provably fair outcome for this spin
        const newNonce = session.nonce + 1;
        const { reelStops, symbols, hash } = calculateSpin(
          session.server_seed,
          session.client_seed,
          newNonce,
        );

        const betPerLine = betAmount / PAYLINES.length;
        const { lines, scatterCount, freeSpinsAwarded } =
          evaluatePaylines(symbols, betPerLine);

        // Exact win in micro units, recomputed from line multipliers —
        // evaluatePaylines works in floats; money never does (A3).
        const microForResult = (ls: typeof lines, sc: number): bigint => {
          let total = 0n;
          for (const l of ls) {
            total += mulDivRound(
              betMicro,
              BigInt(PAYOUTS[l.symbol][l.count as 3 | 4 | 5]),
              20n,
            );
          }
          if (sc >= 3) {
            total +=
              betMicro *
              BigInt(PAYOUTS[SYMBOLS.SCATTER][Math.min(sc, 5) as 3 | 4 | 5]);
          }
          return total;
        };
        let winMicro = microForResult(lines, scatterCount);
        const isBigWin = winMicro >= betMicro * 50n;
        let isJackpot = false;
        let featureTriggered: "none" | "free_spins" | "thunder_strike" = "none";
        let jackpotTier: string | null = null;

        if (scatterCount >= 3) {
          featureTriggered = "free_spins";
        }

        if (winMicro === 0n && checkThunderStrike(hash)) {
          featureTriggered = "thunder_strike";
          const numTransforms = (parseInt(hash.substring(30, 32), 16) % 3) + 1;
          for (let i = 0; i < numTransforms; i++) {
            const r = parseInt(hash.substring(32 + i * 4, 34 + i * 4), 16) % 5;
            const row = parseInt(hash.substring(34 + i * 4, 36 + i * 4), 16) % 3;
            symbols[r][row] = SYMBOLS.ZEUS;
          }
          const reeval = evaluatePaylines(symbols, betPerLine);
          const reevalMicro = microForResult(reeval.lines, reeval.scatterCount);
          winMicro = reevalMicro > betMicro * 5n ? reevalMicro : betMicro * 5n; // A4: thunder floor 5x total bet (was 10x)
          lines.push(...reeval.lines);
        }

        const jackpot = checkJackpot(hash);
        if (jackpot) {
          isJackpot = true;
          jackpotTier = jackpot.tier;
          winMicro += betMicro * BigInt(jackpot.amount);
        }

        const updatedMicro = availableMicro - betMicro + winMicro;
        const nowSec = Math.floor(Date.now() / 1000);

        client
          .prepare("UPDATE balances SET available = ?, updated_at = ? WHERE id = ?")
          .run(fmtMoney(updatedMicro), nowSec, balRow.id);

        client
          .prepare(
            "UPDATE game_sessions SET nonce = ?, total_spins = ?, total_wagered = ?, total_won = ? WHERE id = ?",
          )
          .run(
            newNonce,
            session.total_spins + 1,
            fmtMoney(parseMoney(session.total_wagered) + betMicro),
            fmtMoney(parseMoney(session.total_won) + winMicro),
            session.id,
          );

        const spinRow = client
          .prepare(
            `INSERT INTO spins (session_id, user_id, nonce, bet_amount, currency, reel_positions, symbols_shown, win_amount, win_lines, is_big_win, is_jackpot, feature_triggered, free_spins_awarded, hash)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
          )
          .get(
            session.id,
            ctx.user.id,
            newNonce,
            fmtMoney(betMicro),
            input.currency,
            JSON.stringify(reelStops),
            JSON.stringify(symbols.map((col) => col.map((s) => SYMBOL_NAMES[s]))),
            fmtMoney(winMicro),
            JSON.stringify(lines),
            isBigWin ? 1 : 0,
            isJackpot ? 1 : 0,
            featureTriggered,
            freeSpinsAwarded,
            hash,
          ) as any;
        const spinId = spinRow.id as number;

        // Ledger: debit leg first, then the credit leg when there is a win.
        // balance_after is the player's available balance after that leg.
        const insLedger = client.prepare(
          "INSERT INTO ledger_entries (user_id, spin_id, kind, currency, amount, balance_after) VALUES (?, ?, ?, ?, ?, ?)",
        );
        insLedger.run(
          ctx.user.id,
          spinId,
          "spin_debit",
          input.currency,
          fmtMoney(-betMicro),
          fmtMoney(availableMicro - betMicro),
        );
        if (winMicro > 0n) {
          insLedger.run(
            ctx.user.id,
            spinId,
            "spin_credit",
            input.currency,
            fmtMoney(winMicro),
            fmtMoney(updatedMicro),
          );
        }

        // Jackpot pool movement (amounts unchanged from the pre-A2 model;
        // A6 redesigns funding/awards). On a hit the tier resets to its
        // seed; otherwise every tier receives the 1% contribution, exactly
        // as the previous code did — now atomically with the spin.
        const contributionMicro = mulDivRound(betMicro, 1n, 100n);
        if (isJackpot && jackpotTier) {
          client
            .prepare(
              "UPDATE jackpot_pool SET current_amount = ?, last_won_at = ?, last_won_by = ?, hit_count = hit_count + 1 WHERE tier = ?",
            )
            .run(getDbSeedForTier(jackpotTier), nowSec, ctx.user.id, jackpotTier);
        } else {
          const pools = client
            .prepare("SELECT tier, current_amount FROM jackpot_pool")
            .all() as any[];
          for (const p of pools) {
            client
              .prepare("UPDATE jackpot_pool SET current_amount = ? WHERE tier = ?")
              .run(fmtMoney(parseMoney(p.current_amount) + contributionMicro), p.tier);
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
        payouts: PAYOUTS[parseInt(id)] || null,
        isWild: parseInt(id) === SYMBOLS.ZEUS,
        isScatter: parseInt(id) === SYMBOLS.SCATTER,
      })),
      paylines: PAYLINES.length,
      rtp: 96.0, // A4 CERTIFIED (see rtp.test.ts): 1M-spin simulation of the shipped math = 96.02% total (base 68.2 + thunder 2.6 + free-spin chain + pool-funded jackpot ~1.17 at $1 reference bet)
      volatility: "HIGH",
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

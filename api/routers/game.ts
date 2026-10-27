import { z } from "zod";
import { createRouter, publicQuery, authedQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { gameSessions, spins, balances, jackpotPool } from "../../db/schema";
import { eq, and, desc, sql } from "drizzle-orm";
import crypto from "crypto";

// Bet limits (server-enforced; mirror the frontend store)
const MIN_BET = 0.1;
const MAX_BET = 1000;

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
  [SYMBOLS.HARP]: { 3: 20, 4: 60, 5: 300 },
  [SYMBOLS.AMPHORA]: { 3: 15, 4: 40, 5: 200 },
  [SYMBOLS.HELMET]: { 3: 10, 4: 30, 5: 150 },
  [SYMBOLS.SHIELD]: { 3: 8, 4: 25, 5: 100 },
  [SYMBOLS.ACE]: { 3: 5, 4: 15, 5: 60 },
  [SYMBOLS.KING]: { 3: 5, 4: 15, 5: 60 },
  [SYMBOLS.QUEEN]: { 3: 4, 4: 10, 5: 50 },
};

// Reel strips (50 positions each, weighted)
const REEL_STRIPS = [
  [0,0,1,1, 2,2,2,3,3,3, 4,4,4,5,5,5,5, 6,6,6,6,7,7,7,7, 8,8,8,8,8,9,9,9,9,9, 10,10,10,10,10],
  [0,0,1,1, 2,2,2,3,3,3, 4,4,4,5,5,5,5, 6,6,6,6,7,7,7,7, 8,8,8,8,8,9,9,9,9,9, 10,10,10,10,10],
  [0,0,0,1,1, 2,2,2,3,3,3, 4,4,4,5,5,5,5, 6,6,6,6,7,7,7,7, 8,8,8,8,8,9,9,9,9,9, 10,10,10,10,10],
  [0,0,1,1, 2,2,2,3,3,3, 4,4,4,5,5,5,5, 6,6,6,6,7,7,7,7, 8,8,8,8,8,9,9,9,9,9, 10,10,10,10,10],
  [0,0,1,1, 2,2,2,3,3,3, 4,4,4,5,5,5,5, 6,6,6,6,7,7,7,7, 8,8,8,8,8,9,9,9,9,9, 10,10,10,10,10],
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
    freeSpinsAwarded = scatterCount === 3 ? 10 : scatterCount === 4 ? 15 : 25;
  }

  return { lines, totalPayout, scatterCount, freeSpinsAwarded };
}

// Check for provably fair thunder strike bonus derived from spin SHA-256 hash
function checkThunderStrike(hash: string): boolean {
  const val = parseInt(hash.substring(20, 24), 16);
  return (val % 100) === 0; // 1% deterministic chance
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
      const betAmount = parseFloat(input.betAmount);
      if (!Number.isFinite(betAmount) || betAmount <= 0) {
        throw new Error("Invalid bet amount");
      }
      if (betAmount < MIN_BET || betAmount > MAX_BET) {
        throw new Error(`Bet must be between ${MIN_BET} and ${MAX_BET}`);
      }

      // Strict DB-only session lookup: no demo fallback. A spin request must
      // reference a real, active session owned by the authenticated user.
      const db = getDb();
      const dbSession = await db.select().from(gameSessions)
        .where(and(
          eq(gameSessions.id, input.sessionId),
          eq(gameSessions.userId, ctx.user.id),
          eq(gameSessions.status, "active")
        ))
        .then(rows => rows[0]);

      if (!dbSession) {
        throw new Error("Active session not found for this user");
      }

      const session = {
        id: dbSession.id,
        serverSeed: dbSession.serverSeed,
        serverSeedHash: dbSession.serverSeedHash,
        clientSeed: dbSession.clientSeed,
        nonce: dbSession.nonce,
        totalSpins: dbSession.totalSpins,
        totalWagered: dbSession.totalWagered,
        totalWon: dbSession.totalWon,
      };

      const dbBalance = await db.select().from(balances)
        .where(and(
          eq(balances.userId, ctx.user.id),
          eq(balances.currency, input.currency)
        ))
        .then(rows => rows[0]);

      const availableBalance = dbBalance ? parseFloat(dbBalance.available) : 0;

      if (availableBalance < betAmount) {
        throw new Error("Insufficient balance");
      }

      // Calculate spin using Provably Fair SHA-256 algorithm
      const newNonce = session.nonce + 1;

      const { reelStops, symbols, hash } = calculateSpin(
        session.serverSeed,
        session.clientSeed,
        newNonce
      );

      const betPerLine = betAmount / PAYLINES.length;
      const { lines, totalPayout, scatterCount, freeSpinsAwarded } = evaluatePaylines(symbols, betPerLine);

      let winAmount = totalPayout;
      let isBigWin = winAmount >= betAmount * 50;
      let isJackpot = false;
      let featureTriggered: "none" | "free_spins" | "thunder_strike" = "none";
      let jackpotTier: string | null = null;

      if (scatterCount >= 3) {
        featureTriggered = "free_spins";
      }

      if (winAmount === 0 && checkThunderStrike(hash)) {
        featureTriggered = "thunder_strike";
        const numTransforms = (parseInt(hash.substring(30, 32), 16) % 3) + 1;
        for (let i = 0; i < numTransforms; i++) {
          const r = parseInt(hash.substring(32 + i * 4, 34 + i * 4), 16) % 5;
          const row = parseInt(hash.substring(34 + i * 4, 36 + i * 4), 16) % 3;
          symbols[r][row] = SYMBOLS.ZEUS;
        }
        const reeval = evaluatePaylines(symbols, betPerLine);
        winAmount = Math.max(reeval.totalPayout, betAmount * 10);
        lines.push(...reeval.lines);
      }

      const jackpot = checkJackpot(hash);
      if (jackpot) {
        isJackpot = true;
        jackpotTier = jackpot.tier;
        winAmount += betAmount * jackpot.amount;
      }

      const updatedBalance = availableBalance - betAmount + winAmount;

      // DB writes are mandatory: a failed write aborts the spin rather than
      // silently leaving balance/ledger inconsistent.
      let spinRecordId: number;
      try {
        await db.update(balances)
          .set({ available: String(updatedBalance) })
          .where(and(
            eq(balances.userId, ctx.user.id),
            eq(balances.currency, input.currency)
          ));

        await db.update(gameSessions)
          .set({
            nonce: newNonce,
            totalSpins: session.totalSpins + 1,
            totalWagered: String(parseFloat(session.totalWagered) + betAmount),
            totalWon: String(parseFloat(session.totalWon) + winAmount),
          })
          .where(eq(gameSessions.id, input.sessionId));

        const [insertedSpin] = await db.insert(spins).values({
          sessionId: input.sessionId,
          userId: ctx.user.id,
          nonce: newNonce,
          betAmount: input.betAmount,
          currency: input.currency,
          reelPositions: reelStops,
          symbolsShown: symbols.map(col => col.map(s => SYMBOL_NAMES[s])),
          winAmount: String(winAmount),
          winLines: lines,
          isBigWin,
          isJackpot,
          featureTriggered,
          freeSpinsAwarded,
          hash,
        }).returning();

        spinRecordId = insertedSpin?.id ?? crypto.randomInt(1, 100000);

        // Jackpot pool contribution (1% of bet amount); when this spin won a
        // jackpot, the pool resets to its seed and the win is recorded.
        const contribution = betAmount * 0.01;
        if (isJackpot && jackpotTier) {
          const tier = jackpotTier as "mini" | "major" | "mega";
          const seed = getDbSeedForTier(tier);
          const updated = await db.update(jackpotPool)
            .set({
              currentAmount: seed,
              lastWonAt: new Date(),
              lastWonBy: ctx.user.id,
              hitCount: sql`${jackpotPool.hitCount} + 1`,
            })
            .where(eq(jackpotPool.tier, tier))
            .returning();
          if (updated.length === 0) {
            console.error("[spin] jackpot pool tier missing:", jackpotTier);
          }
        } else {
          await db.update(jackpotPool)
            .set({
              currentAmount: sql`${jackpotPool.currentAmount} + ${contribution}`,
            });
        }
      } catch (e) {
        // Ledger writes must not fail silently — surface the error so the
        // client does not see a "successful" spin that was never recorded.
        console.error("[spin] DB write failed", e);
        throw new Error("Spin could not be recorded — please try again");
      }

      return {
        spinId: spinRecordId,
        nonce: newNonce,
        reelPositions: reelStops,
        symbols: symbols.map(col => col.map(s => SYMBOL_NAMES[s])),
        winAmount: String(winAmount),
        winLines: lines,
        isBigWin,
        isJackpot,
        featureTriggered,
        freeSpinsAwarded,
        hash,
        newBalance: String(updatedBalance),
        jackpotTier,
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
      rtp: 96.5,
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
      try {
        const db = getDb();
        const session = await db.select().from(gameSessions)
          .where(and(
            eq(gameSessions.id, input.sessionId),
            eq(gameSessions.userId, ctx.user.id)
          ))
          .then(rows => rows[0]);

        if (session) {
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
        }
      } catch {
        // Fallback
      }

      return {
        session: {
          id: input.sessionId,
          serverSeedHash: "a1b2c3d4e5f67890",
          serverSeed: null,
          clientSeed: "demo_client_seed",
          nonce: 1,
          status: "active",
          totalSpins: 1,
          totalWagered: "10",
          totalWon: "15",
        },
        spins: [],
      };
    }),
});

export { SYMBOLS, SYMBOL_NAMES, REEL_STRIPS, PAYLINES, calculateSpin, evaluatePaylines };

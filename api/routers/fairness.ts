import { z } from "zod";
import { createRouter, authedQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { gameSessions, spins } from "../../db/schema";
import { eq, and } from "drizzle-orm";
import crypto from "crypto";
import { REEL_STRIPS, SYMBOL_NAMES } from "./game";

export const fairnessRouter = createRouter({
  verify: authedQuery
    .input(z.object({
      sessionId: z.number(),
      nonce: z.number().min(1),
    }))
    .query(async ({ ctx, input }) => {
      const db = getDb();

      // Get session
      const session = await db.select().from(gameSessions)
        .where(and(
          eq(gameSessions.id, input.sessionId),
          eq(gameSessions.userId, ctx.user.id)
        ))
        .then(rows => rows[0]);

      if (!session) throw new Error("Session not found");

      // Get the specific spin
      const spin = await db.select().from(spins)
        .where(and(
          eq(spins.sessionId, input.sessionId),
          eq(spins.nonce, input.nonce)
        ))
        .then(rows => rows[0]);

      if (!spin) throw new Error("Spin not found");

      // Recalculate the hash
      const hash = crypto
        .createHash("sha256")
        .update(session.serverSeed + session.clientSeed + String(input.nonce))
        .digest("hex");

      // Recalculate reel stops from hash
      const reelStops: number[] = [];
      for (let i = 0; i < 5; i++) {
        const bytePair = hash.substring(i * 4, i * 4 + 4);
        const value = parseInt(bytePair, 16);
        const reelLength = REEL_STRIPS[i].length;
        reelStops.push(value % reelLength);
      }

      // Get visible symbols
      const symbols: number[][] = [];
      for (let reel = 0; reel < 5; reel++) {
        const reelSymbols: number[] = [];
        for (let row = 0; row < 3; row++) {
          const pos = (reelStops[reel] + row) % REEL_STRIPS[reel].length;
          reelSymbols.push(REEL_STRIPS[reel][pos]);
        }
        symbols.push(reelSymbols);
      }

      const storedSymbols = JSON.parse(spin.symbolsShown as string);
      const storedPositions = JSON.parse(spin.reelPositions as string);

      // Verify match
      const hashMatch = hash === spin.hash;
      const positionsMatch = JSON.stringify(reelStops) === JSON.stringify(storedPositions);
      const symbolsMatch = JSON.stringify(symbols) === JSON.stringify(storedSymbols);

      return {
        verified: hashMatch && positionsMatch && symbolsMatch,
        serverSeed: session.serverSeed,
        clientSeed: session.clientSeed,
        nonce: input.nonce,
        hash,
        storedHash: spin.hash,
        hashMatch,
        positionsMatch,
        symbolsMatch,
        reelPositions: reelStops,
        symbols: symbols.map(col => col.map(s => SYMBOL_NAMES[s])),
        winAmount: spin.winAmount,
        calculationSteps: [
          `Step 1: hash = SHA-256("${session.serverSeed}" + "${session.clientSeed}" + "${input.nonce}")`,
          `Step 2: hash = "${hash}"`,
          `Step 3: reel_1 = hex("${hash.substring(0, 4)}") % ${REEL_STRIPS[0].length} = ${reelStops[0]}`,
          `Step 4: reel_2 = hex("${hash.substring(4, 8)}") % ${REEL_STRIPS[1].length} = ${reelStops[1]}`,
          `Step 5: reel_3 = hex("${hash.substring(8, 12)}") % ${REEL_STRIPS[2].length} = ${reelStops[2]}`,
          `Step 6: reel_4 = hex("${hash.substring(12, 16)}") % ${REEL_STRIPS[3].length} = ${reelStops[3]}`,
          `Step 7: reel_5 = hex("${hash.substring(16, 20)}") % ${REEL_STRIPS[4].length} = ${reelStops[4]}`,
        ],
      };
    }),

  getSession: authedQuery
    .input(z.object({ sessionId: z.number() }))
    .query(async ({ ctx, input }) => {
      const db = getDb();

      const session = await db.select().from(gameSessions)
        .where(and(
          eq(gameSessions.id, input.sessionId),
          eq(gameSessions.userId, ctx.user.id)
        ))
        .then(rows => rows[0]);

      if (!session) throw new Error("Session not found");

      const spinRecords = await db.select()
        .from(spins)
        .where(eq(spins.sessionId, input.sessionId))
        .orderBy(spins.nonce);

      return {
        session: {
          id: session.id,
          serverSeedHash: session.serverSeedHash,
          serverSeed: session.status === "completed" ? session.serverSeed : null,
          clientSeed: session.clientSeed,
          nonce: session.nonce,
          status: session.status,
          totalSpins: session.totalSpins,
          totalWagered: session.totalWagered,
          totalWon: session.totalWon,
        },
        spins: spinRecords.map(s => ({
          ...s,
          symbolsShown: JSON.parse(s.symbolsShown as string),
          reelPositions: JSON.parse(s.reelPositions as string),
          winLines: s.winLines ? JSON.parse(s.winLines as string) : null,
        })),
      };
    }),

  changeSeed: authedQuery
    .input(z.object({
      sessionId: z.number(),
      newClientSeed: z.string().min(1).max(64),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();

      const session = await db.select().from(gameSessions)
        .where(and(
          eq(gameSessions.id, input.sessionId),
          eq(gameSessions.userId, ctx.user.id),
          eq(gameSessions.status, "active")
        ))
        .then(rows => rows[0]);

      if (!session) throw new Error("Active session not found");

      await db.update(gameSessions)
        .set({ clientSeed: input.newClientSeed })
        .where(eq(gameSessions.id, input.sessionId));

      return { success: true, newClientSeed: input.newClientSeed };
    }),
});

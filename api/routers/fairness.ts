import { z } from "zod";
import { createRouter, authedQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { gameSessions, spins } from "../../db/schema";
import { eq, and } from "drizzle-orm";
import crypto from "crypto";
import { SYMBOL_NAMES, PAYLINES, SYMBOLS, hashSeedV1, hashSeedV2 } from "./game";
import { getBundleByHash, classicCfgFromBundle } from "../lib/bundles";
import { parseMoney, fmtMoney, mulDivRound } from "../lib/money";
import { getSqliteClient } from "../queries/connection";
import { getSetting } from "../lib/settings";

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

      // Step 5: cascade spins verify by full deterministic replay —
      // same seeds, same bundle math, same resolver; the recomputed
      // steps and capped win must equal what was stored and paid.
      if ((spin as any).modeId === "cascade") {
        const { getBundleByHash, canonicalStringify } = await import("../lib/bundles");
        const { resolveCascade, makeCascadeDraw } = await import("../lib/cascade");
        const { parseMoney, fmtMoney } = await import("../lib/money");
        const { symbolName } = await import("./game");
        const revealedC = session.status === "completed";
        const bundle = (spin as any).bundleSha256
          ? getBundleByHash(getSqliteClient(), (spin as any).bundleSha256)
          : null;
        if (!bundle) {
          return {
            verified: false,
            modeId: "cascade",
            bundleId: (spin as any).bundleId ?? null,
            bundleSha256: (spin as any).bundleSha256 ?? null,
            note: "The math bundle for this spin is no longer in the registry.",
          };
        }
        const cmath = (JSON.parse(bundle.bundle) as any).math;
        const res = resolveCascade({
          draw: makeCascadeDraw(session.serverSeed, session.clientSeed, input.nonce),
          math: cmath,
          betMicro: parseMoney(spin.betAmount as string),
          isFreeSpin: !!(spin as any).isFreeSpin,
          rungIn: (spin as any).isFreeSpin ? Number((spin as any).ladderRung ?? 0) : 0,
          // U5-B: replay under the round's stamped wild gate.
          wildLive: Number((spin as any).wildLive ?? 0) === 1,
        });
        const storedSteps = typeof (spin as any).winLines === "string"
          ? JSON.parse((spin as any).winLines)
          : (spin as any).winLines;
        const storedSymbolsC = typeof spin.symbolsShown === "string"
          ? JSON.parse(spin.symbolsShown)
          : spin.symbolsShown;
        const columns: number[][] = [];
        for (let c = 0; c < 6; c++) columns.push(res.initialGrid.slice(c * 5, c * 5 + 5));
        const winMatch = fmtMoney(res.cappedWinMicro) === spin.winAmount;
        const stepsMatch = canonicalStringify(storedSteps) === canonicalStringify(res.steps);
        const symbolsMatch =
          JSON.stringify(columns.map((col) => col.map((s: number) => symbolName(s)))) ===
          JSON.stringify(storedSymbolsC);
        const hashC = crypto
          .createHash("sha256")
          .update(session.serverSeed + session.clientSeed + String(input.nonce))
          .digest("hex");
        return {
          verified: winMatch && stepsMatch && symbolsMatch && hashC === spin.hash,
          modeId: "cascade",
          bundleId: (spin as any).bundleId ?? null,
          bundleSha256: (spin as any).bundleSha256 ?? null,
          serverSeed: revealedC ? session.serverSeed : null,
          serverSeedHash: session.serverSeedHash,
          clientSeed: session.clientSeed,
          nonce: input.nonce,
          hash: hashC,
          storedHash: spin.hash,
          winAmount: spin.winAmount,
          recomputedWin: fmtMoney(res.cappedWinMicro),
          winMatch,
          stepsMatch,
          symbolsMatch,
          cascade: {
            steps: res.steps,
            chainLength: res.chainLength,
            scatters: res.scattersInitial,
            drawsUsed: res.drawsUsed,
          },
          calculationSteps: [
            "Step 1: draw(k) = uint52(SHA-256(serverSeed:clientSeed:nonce:c:k)) / 2^52 — slot-indexed stream",
            "Step 2: initial grid = slots 0..29, column-major, weighted by the bundle's weights",
            `Step 3: resolved ${res.chainLength} cascade step(s), ${res.drawsUsed} draws total`,
            `Step 4: total win ${fmtMoney(res.totalWinMicro)} capped at ${cmath.capX}x -> ${fmtMoney(res.cappedWinMicro)}`,
          ],
        };
      }

      // A1 (Z-01): the server seed decides every FUTURE spin in this session
      // (SHA-256(serverSeed + clientSeed + nonce)), so it must never leave the
      // server while the session is active. It is revealed only after the
      // session completes — mirroring fairness.getSession and endSession.
      const revealed = session.status === "completed";
      const seedForDisplay = revealed
        ? session.serverSeed
        : "<hidden until this session ends>";

      // A4 (audit 2026-11-04): replay against the spin's OWN certified
      // bundle — the previous static REEL_STRIPS replay could never
      // verify spins played under published math.
      const bundleRowC = (spin as any).bundleSha256
        ? getBundleByHash(getSqliteClient(), (spin as any).bundleSha256)
        : null;
      let strips: number[][] | null = null;
      if (bundleRowC) {
        try {
          strips = classicCfgFromBundle(
            typeof bundleRowC.bundle === "string" ? JSON.parse(bundleRowC.bundle) : bundleRowC.bundle,
            SYMBOL_NAMES,
          ).strips;
        } catch {
          strips = null;
        }
      }

      // GE-01: hash version and the client seed come from the spin row.
      // Historical rows are v1 (no stamp) and keep verifying; new rows are
      // v2 (length-prefixed fields) and store the seed that was used, so a
      // later changeSeed cannot rewrite history.
      const hashVersion = Number((spin as any).hashVersion ?? 1);
      const spinClientSeed =
        ((spin as any).clientSeed as string | null) || session.clientSeed;
      const hash = hashVersion >= 2
        ? hashSeedV2(session.serverSeed, spinClientSeed, input.nonce)
        : hashSeedV1(session.serverSeed, spinClientSeed, input.nonce);

      if (!strips) {
        // Legacy spins played before the registry existed carry no
        // bundle; honesty over theater — report exactly that.
        return {
          verified: false,
          unverifiable: "PRE_REGISTRY",
          note: "This spin predates the math registry (no certified bundle was stamped), so an independent replay is impossible. Hash binding is shown for reference only.",
          modeId: (spin as any).modeId ?? "classic",
          bundleId: (spin as any).bundleId ?? null,
          bundleSha256: (spin as any).bundleSha256 ?? null,
          serverSeed: revealed ? session.serverSeed : null,
          serverSeedHash: session.serverSeedHash,
          clientSeed: session.clientSeed,
          nonce: input.nonce,
          hash,
          storedHash: spin.hash,
          hashMatch: hash === spin.hash,
          winAmount: spin.winAmount,
          reelPositions: null,
          symbols: null,
          calculationSteps: [
            `Step 1: hash = SHA-256(serverSeed + clientSeed + nonce) = "${hash}"`,
            "Step 2: no certified bundle was stamped on this spin (pre-registry era) — replay unavailable.",
          ],
        };
      }

      // Recalculate reel stops from hash against the spin's bundle strips
      const reelStops: number[] = [];
      for (let i = 0; i < 5; i++) {
        const bytePair = hash.substring(i * 4, i * 4 + 4);
        const value = parseInt(bytePair, 16);
        const reelLength = strips[i].length;
        reelStops.push(value % reelLength);
      }

      // GE-05: rebuild the RAW (pre-transform) grid. `symbols_shown` stores
      // the post-Thunder grid, so verifying against it was impossible for
      // genuine thunder wins.
      const baseGrid: number[][] = [];
      for (let reel = 0; reel < 5; reel++) {
        const reelSymbols: number[] = [];
        for (let row = 0; row < 3; row++) {
          const pos = (reelStops[reel] + row) % strips[reel].length;
          reelSymbols.push(strips[reel][pos]);
        }
        baseGrid.push(reelSymbols);
      }

      // better-sqlite3/drizzle returns JSON columns already parsed; the D1
      // shape returns raw text. Accept both.
      const asJson = (v: unknown) => (typeof v === "string" ? JSON.parse(v) : v);
      const storedSymbols = asJson((spin as any).symbolsShown);
      const storedPositions = asJson((spin as any).reelPositions);
      const storedBase = (spin as any).baseSymbols ? asJson((spin as any).baseSymbols) : null;
      const thunderMeta = (spin as any).thunder ? asJson((spin as any).thunder) : null;

      const baseSymbolNames = baseGrid.map((col) => col.map((s) => SYMBOL_NAMES[s]));

      // Replay the exact transform recorded at spin time (GE-05).
      const replayGrid = baseGrid.map((col) => col.slice());
      const transforms: Array<{ reel: number; row: number }> =
        Array.isArray(thunderMeta?.transforms) ? thunderMeta.transforms : [];
      for (const t of transforms) {
        if (
          t && Number.isInteger(t.reel) && Number.isInteger(t.row) &&
          replayGrid[t.reel] && replayGrid[t.reel][t.row] !== undefined
        ) {
          replayGrid[t.reel][t.row] = SYMBOLS.ZEUS;
        }
      }
      const replayNames = replayGrid.map((col) => col.map((s) => SYMBOL_NAMES[s]));

      // GE-05: recompute the paid win from the certified bundle. Jackpot
      // awards are pool transfers, not multiplier outcomes, so for those the
      // game win is verified as a lower bound and reported separately.
      const cfg = classicCfgFromBundle(
        typeof bundleRowC!.bundle === "string" ? JSON.parse(bundleRowC!.bundle) : bundleRowC!.bundle,
        SYMBOL_NAMES,
      );
      const betMicro = parseMoney((spin as any).betAmount as string);
      let lineWinMicro = 0n;
      let scatterCount = 0;
      for (const line of PAYLINES) {
        const first = replayGrid[0][line[0]];
        let matchSymbol = first === SYMBOLS.ZEUS ? -1 : first;
        let matchCount = 1;
        for (let reel = 1; reel < 5; reel++) {
          const sym = replayGrid[reel][line[reel]];
          if (sym === SYMBOLS.ZEUS || sym === matchSymbol || matchSymbol === -1) {
            if (matchSymbol === -1 && sym !== SYMBOLS.ZEUS) matchSymbol = sym;
            matchCount++;
          } else {
            break;
          }
        }
        if (matchSymbol === -1) matchSymbol = SYMBOLS.ZEUS;
        const payoutRow = cfg.payouts[matchSymbol];
        if (matchCount >= 3 && payoutRow) {
          const p = payoutRow[matchCount as 3 | 4 | 5] || 0;
          if (p > 0) lineWinMicro += mulDivRound(betMicro, BigInt(p), BigInt(PAYLINES.length));
        }
      }
      for (let reel = 0; reel < 5; reel++) {
        for (let row = 0; row < 3; row++) {
          if (replayGrid[reel][row] === SYMBOLS.SCATTER) scatterCount++;
        }
      }
      let recomputedWin = lineWinMicro;
      if (scatterCount >= 3) {
        const p = cfg.payouts[SYMBOLS.SCATTER]?.[Math.min(scatterCount, 5) as 3 | 4 | 5] || 0;
        recomputedWin += betMicro * BigInt(p);
      }
      if (transforms.length > 0) {
        const floorX = Number((cfg as any).thunderFloorX ?? 0);
        const floorMicro = mulDivRound(betMicro, BigInt(Math.round(floorX * 100)), 100n);
        if (recomputedWin < floorMicro) recomputedWin = floorMicro;
      }
      const maxWinX = getSetting<number>("max_win_x");
      if (typeof maxWinX === "number" && maxWinX > 0) {
        const capMicro = mulDivRound(betMicro, BigInt(Math.round(maxWinX * 100)), 100n);
        if (recomputedWin > capMicro) recomputedWin = capMicro;
      }

      const hashMatch = hash === spin.hash;
      const positionsMatch = JSON.stringify(reelStops) === JSON.stringify(storedPositions);
      const baseMatch = storedBase
        ? JSON.stringify(baseSymbolNames) === JSON.stringify(storedBase)
        : null;
      // symbols_shown is the post-transform grid for thunder spins.
      const symbolsMatch = JSON.stringify(replayNames) === JSON.stringify(storedSymbols);
      const jackpotSpin = !!(spin as any).isJackpot;
      const storedWin = parseMoney((spin as any).winAmount);
      const winMatch = jackpotSpin ? storedWin >= recomputedWin : storedWin === recomputedWin;

      return {
        verified:
          hashMatch && positionsMatch && symbolsMatch && winMatch && baseMatch !== false,
        // Phase 0 (playbook §5.3): the reveal record binds the spin to
        // the exact math bundle that resolved it, resolvable by hash
        // via fairness.bundleByHash. Null for pre-registry spins.
        modeId: (spin as any).modeId ?? "classic",
        bundleId: (spin as any).bundleId ?? null,
        bundleSha256: (spin as any).bundleSha256 ?? null,
        hashVersion,
        serverSeed: revealed ? session.serverSeed : null,
        serverSeedHash: session.serverSeedHash,
        clientSeed: spinClientSeed,
        nonce: input.nonce,
        hash,
        storedHash: spin.hash,
        hashMatch,
        positionsMatch,
        symbolsMatch,
        baseMatch,
        winMatch,
        thunderReplayed: transforms.length,
        // Jackpot transfers are pool movements, not claimable from the
        // bundle; flagged so the UI does not imply full verification.
        jackpotIncluded: jackpotSpin,
        storedWin: fmtMoney(storedWin),
        recomputedWin: fmtMoney(recomputedWin),
        reelPositions: reelStops,
        baseSymbols: baseSymbolNames,
        symbols: replayNames,
        winAmount: spin.winAmount,
        calculationSteps: [
          `Step 1: hash = SHA-256(${hashVersion >= 2 ? "v2 length-prefixed" : "v1 concatenation"}("${seedForDisplay}", "${spinClientSeed}", ${input.nonce}))`,
          `Step 2: hash = "${hash}"`,
          `Step 3: reel_1 = hex("${hash.substring(0, 4)}") % ${strips[0].length} = ${reelStops[0]}`,
          `Step 4: reel_2 = hex("${hash.substring(4, 8)}") % ${strips[1].length} = ${reelStops[1]}`,
          `Step 5: reel_3 = hex("${hash.substring(8, 12)}") % ${strips[2].length} = ${reelStops[2]}`,
          `Step 6: reel_4 = hex("${hash.substring(12, 16)}") % ${strips[3].length} = ${reelStops[3]}`,
          `Step 7: reel_5 = hex("${hash.substring(16, 20)}") % ${strips[4].length} = ${reelStops[4]}`,
          `Step 8: ${transforms.length} thunder transform(s) replayed; win recomputed from the certified paytable = ${fmtMoney(recomputedWin)}`,
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
          // Same dual-shape handling as verify above (parsed vs raw text).
          symbolsShown: typeof s.symbolsShown === "string" ? JSON.parse(s.symbolsShown) : s.symbolsShown,
          reelPositions: typeof s.reelPositions === "string" ? JSON.parse(s.reelPositions) : s.reelPositions,
          winLines: typeof s.winLines === "string" ? JSON.parse(s.winLines) : (s.winLines ?? null),
        })),
      };
    }),

  // Phase 0 (playbook §6.8): resolve any published math bundle by its
  // SHA-256 so a player can audit exactly which mathematics a spin ran.
  bundleByHash: authedQuery
    .input(z.object({ sha256: z.string().length(64) }))
    .query(async ({ input }) => {
      const row = getBundleByHash(getSqliteClient(), input.sha256);
      if (!row) throw new Error("Bundle not found");
      return {
        bundleId: row.bundle_id,
        modeId: row.mode_id,
        engine: row.engine,
        status: row.status,
        sha256: row.sha256,
        bundle: typeof row.bundle === "string" ? JSON.parse(row.bundle) : row.bundle,
        cert: row.cert ? (typeof row.cert === "string" ? JSON.parse(row.cert) : row.cert) : null,
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

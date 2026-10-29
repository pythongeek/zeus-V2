import crypto from "crypto";

/**
 * Step 5 — cascade (grid-tumble) engine: the SECOND Zeus mode.
 * Pure resolver, no I/O — the same function settles live spins,
 * replays fairness verifications, and drives the Monte Carlo
 * certification sampler, so the certified math IS the shipped math.
 *
 * Rules (frozen for certification; the tuning rig moves weights
 * only):
 * - 6 columns x 5 rows. Index = col * 5 + row, row 0 at the TOP.
 * - Cluster pays: a symbol appearing >= 8 times ANYWHERE pays its
 *   bracket (8-9 / 10-11 / 12-14 / 15+) x bet x step multiplier.
 * - Winning cells explode; survivors drop; refills consume RNG
 *   slots in column-major order. Steps repeat until no cluster.
 * - Step multiplier ladder: [1, 2, 3, 5, 10] by step index, capped
 *   at the last rung.
 * - Scatter (ZEUS) count in the INITIAL grid: 4+ awards free spins
 *   (fsTable). During free spins, 4+ scatters in a grid retrigger.
 * - Total win per spin resolution is capped at capX x bet.
 * - Jackpots and Thunder Strike are classic-only in v1.
 *
 * RNG: slot-indexed — draw(k) is the k-th uniform of the spin's
 * stream. Initial grid consumes slots 0..29 (column-major);
 * refills consume subsequent slots, per step, column-major over
 * the cells that need new symbols (top of each column first).
 */

export const CASCADE_COLS = 6;
export const CASCADE_ROWS = 5;
export const CASCADE_CELLS = CASCADE_COLS * CASCADE_ROWS;
export const CASCADE_LADDER = [1, 2, 3, 5, 10];
export const CLUSTER_MIN = 8;

export interface CascadeMath {
  /** Paying symbol ids in draw order (scatter handled separately). */
  symbols: number[];
  /** Relative draw weight per symbol id (scatter included). */
  weights: Record<string, number>;
  scatterId: number;
  /** Per paying symbol: [pay@8-9, pay@10-11, pay@12-14, pay@15+] in bet multipliers. */
  paytable: Record<string, [number, number, number, number]>;
  ladder: number[];
  /** Free spins by initial scatter count: { "4": 10, "5": 12, "6": 15 } (6 = 6+). */
  fsTable: Record<string, number>;
  fsRetrigger: number;
  capX: number;
}

export interface CascadeCluster {
  symbol: number;
  count: number;
  positions: number[];
  payMicro: string;
}

export interface CascadeStep {
  grid: number[];
  clusters: CascadeCluster[];
  multiplier: number;
  stepWinMicro: string;
}

export interface CascadeResult {
  initialGrid: number[];
  steps: CascadeStep[];
  totalWinMicro: bigint;
  cappedWinMicro: bigint;
  wasCapped: boolean;
  scattersInitial: number;
  freeSpinsAwarded: number;
  drawsUsed: number;
  chainLength: number;
}

export function bracketIndex(count: number): number {
  if (count >= 15) return 3;
  if (count >= 12) return 2;
  if (count >= 10) return 1;
  return 0;
}

export function pickSymbol(r: number, math: CascadeMath): number {
  const ids = [...math.symbols, math.scatterId];
  let total = 0;
  for (const id of ids) total += math.weights[String(id)] ?? 0;
  let x = r * total;
  for (const id of ids) {
    x -= math.weights[String(id)] ?? 0;
    if (x < 0) return id;
  }
  return ids[ids.length - 1];
}

export function resolveCascade(args: {
  draw: (slot: number) => number;
  math: CascadeMath;
  betMicro: bigint;
  isFreeSpin: boolean;
}): CascadeResult {
  const { draw, math, betMicro } = args;
  let slot = 0;
  const nextSymbol = () => pickSymbol(draw(slot++), math);

  // Initial grid, column-major.
  let grid: number[] = [];
  for (let i = 0; i < CASCADE_CELLS; i++) grid.push(nextSymbol());
  const scattersInitial = grid.filter((s) => s === math.scatterId).length;

  const steps: CascadeStep[] = [];
  let total = 0n;
  let stepIndex = 0;

  for (;;) {
    // Count clusters.
    const counts = new Map<number, number[]>();
    grid.forEach((sym, idx) => {
      if (sym === math.scatterId) return;
      const arr = counts.get(sym) ?? [];
      arr.push(idx);
      counts.set(sym, arr);
    });
    const clusters: CascadeCluster[] = [];
    let stepWin = 0n;
    const multiplier = math.ladder[Math.min(stepIndex, math.ladder.length - 1)];
    for (const [sym, positions] of counts) {
      if (positions.length < CLUSTER_MIN) continue;
      const pay = math.paytable[String(sym)]?.[bracketIndex(positions.length)] ?? 0;
      if (pay <= 0) continue;
      // Exact money: paytable values carry at most one decimal, so
      // work in tenths — payMicro = bet x pay x multiplier, integer
      // math throughout (any sub-micro remainder truncates, and the
      // truncation is part of the deterministic replay).
      const payMicro = (betMicro * BigInt(Math.round(pay * 10)) * BigInt(multiplier)) / 10n;
      clusters.push({ symbol: sym, count: positions.length, positions, payMicro: String(payMicro) });
      stepWin += payMicro;
    }
    if (clusters.length === 0) break;

    steps.push({ grid: [...grid], clusters, multiplier, stepWinMicro: String(stepWin) });
    total += stepWin;

    // Explode winners, drop survivors, refill from the top.
    const removed = new Set<number>();
    for (const c of clusters) for (const pos of c.positions) removed.add(pos);
    const nextGrid = new Array(CASCADE_CELLS).fill(-1);
    for (let col = 0; col < CASCADE_COLS; col++) {
      const survivors: number[] = [];
      for (let row = 0; row < CASCADE_ROWS; row++) {
        const idx = col * CASCADE_ROWS + row;
        if (!removed.has(idx)) survivors.push(grid[idx]);
      }
      const missing = CASCADE_ROWS - survivors.length;
      const column: number[] = [];
      for (let i = 0; i < missing; i++) column.push(nextSymbol());
      column.push(...survivors);
      for (let row = 0; row < CASCADE_ROWS; row++) {
        nextGrid[col * CASCADE_ROWS + row] = column[row];
      }
    }
    grid = nextGrid;
    stepIndex += 1;
    if (stepIndex > 200) break; // unreachable safety: chains are finite in practice
  }

  let freeSpinsAwarded = 0;
  if (!args.isFreeSpin) {
    if (scattersInitial >= 4) {
      freeSpinsAwarded = math.fsTable[String(Math.min(scattersInitial, 6))] ?? math.fsTable["4"] ?? 0;
    }
  } else if (scattersInitial >= 4) {
    freeSpinsAwarded = math.fsRetrigger;
  }

  const capMicro = betMicro * BigInt(math.capX);
  const capped = total > capMicro ? capMicro : total;
  return {
    initialGrid: steps.length > 0 ? steps[0].grid : grid,
    steps,
    totalWinMicro: total,
    cappedWinMicro: capped,
    wasCapped: total > capMicro,
    scattersInitial,
    freeSpinsAwarded,
    drawsUsed: slot,
    chainLength: steps.length,
  };
}

/**
 * The spin's deterministic draw stream, shared by live play,
 * fairness replay and simulation: draw(k) = uint52 of
 * sha256(serverSeed:clientSeed:nonce:c:k) / 2^52.
 */
export function makeCascadeDraw(serverSeed: string, clientSeed: string, nonce: number): (slot: number) => number {
  return (slot: number) => {
    const h = crypto.createHash("sha256").update(`${serverSeed}:${clientSeed}:${nonce}:c:${slot}`).digest();
    const bits = h.readUInt32BE(0) * 2 ** 20 + (h.readUInt32BE(4) >>> 12);
    return bits / 2 ** 52;
  };
}

/** Default v1 math — the tuning rig adjusts WEIGHTS only. */
export const CASCADE_DEFAULT_MATH: CascadeMath = {
  symbols: [1, 2, 3, 4, 5, 6, 7, 8, 9],
  weights: {
    "0": 4, // ZEUS scatter
    "1": 10, // thunderbolt
    "2": 14, // pegasus
    "3": 16, // temple
    "4": 18, // harp
    "5": 20, // amphora
    "6": 22, // helmet
    "7": 24, // shield
    "8": 26, // ace
    "9": 28, // king
  },
  scatterId: 0,
  paytable: {
    "1": [10, 25, 50, 150],
    "2": [8, 20, 40, 100],
    "3": [6, 15, 30, 80],
    "4": [5, 12, 25, 60],
    "5": [4, 10, 20, 50],
    "6": [3, 8, 16, 40],
    "7": [2.5, 6, 12, 30],
    "8": [2, 5, 10, 25],
    "9": [1.5, 4, 8, 20],
  },
  ladder: CASCADE_LADDER,
  fsTable: { "4": 10, "5": 12, "6": 15 },
  fsRetrigger: 5,
  capX: 5000,
};

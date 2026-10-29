import { describe, it, expect } from "vitest";
import {
  resolveCascade,
  makeCascadeDraw,
  CASCADE_DEFAULT_MATH,
  type CascadeMath,
} from "./cascade";

/**
 * Step 5 — cascade resolver unit tests with scripted draw streams.
 * Default-math total weight is 182; the r-values below sit at the
 * middle of each symbol's cumulative band:
 *   1:0.027 2:0.093 3:0.176 4:0.269 5:0.374 6:0.489 7:0.615
 *   8:0.753 9:0.901 scatter(0):0.989
 */
const R: Record<number, number> = {
  0: 0.989, 1: 0.027, 2: 0.093, 3: 0.176, 4: 0.269,
  5: 0.374, 6: 0.489, 7: 0.615, 8: 0.753, 9: 0.901,
};
const SAFE = [1, 2, 3, 4, 5, 6, 7, 8]; // cycle with no possible cluster

function scripted(slots: Map<number, number>, fallback: (slot: number) => number) {
  return (slot: number) => slots.get(slot) ?? fallback(slot);
}
function safeFallback(offset = 0) {
  return (slot: number) => R[SAFE[(slot + offset) % SAFE.length]];
}

const BET = 100_000_000n; // 1.00

describe("cascade resolver", () => {
  it("pays a single cluster, then a second step at ladder x2", () => {
    const slots = new Map<number, number>();
    for (let i = 0; i < 8; i++) slots.set(i, R[9]); // 8 kings, indices 0..7
    for (let i = 30; i < 38; i++) slots.set(i, R[9]); // refill: 8 more kings
    const draw = scripted(slots, safeFallback());
    const res = resolveCascade({ draw, math: CASCADE_DEFAULT_MATH, betMicro: BET, isFreeSpin: false });
    expect(res.chainLength).toBe(2);
    expect(res.steps[0].multiplier).toBe(1);
    expect(res.steps[0].clusters).toEqual([
      expect.objectContaining({ symbol: 9, count: 8 }),
    ]);
    expect(res.steps[0].stepWinMicro).toBe("150000000"); // 1.5x at x1
    expect(res.steps[1].multiplier).toBe(2);
    expect(res.steps[1].stepWinMicro).toBe("300000000"); // 1.5x at x2
    expect(res.totalWinMicro).toBe(450_000_000n);
    expect(res.drawsUsed).toBe(48); // 30 + 8 refills + attach + 8 refills + attach
    // Gravity: column 1 survivors (ids 1, 2) dropped below the refills.
    expect(res.steps[1].grid.slice(5, 10)).toEqual([9, 9, 9, 1, 2]);
    expect(res.freeSpinsAwarded).toBe(0);
  });

  it("awards free spins on 4+ initial scatters; retrigger pays the flat award", () => {
    const slots = new Map<number, number>();
    for (let i = 0; i < 4; i++) slots.set(i, R[0]);
    const draw = scripted(slots, safeFallback());
    const paid = resolveCascade({ draw, math: CASCADE_DEFAULT_MATH, betMicro: BET, isFreeSpin: false });
    expect(paid.scattersInitial).toBe(4);
    expect(paid.freeSpinsAwarded).toBe(10);
    expect(paid.chainLength).toBe(0);
    const free = resolveCascade({ draw, math: CASCADE_DEFAULT_MATH, betMicro: BET, isFreeSpin: true });
    expect(free.freeSpinsAwarded).toBe(5);
  });

  it("an all-scatter grid awards the 6+ tier and pays nothing", () => {
    const res = resolveCascade({
      draw: () => R[0],
      math: CASCADE_DEFAULT_MATH,
      betMicro: BET,
      isFreeSpin: false,
    });
    expect(res.scattersInitial).toBe(30);
    expect(res.freeSpinsAwarded).toBe(15);
    expect(res.totalWinMicro).toBe(0n);
  });

  it("caps the spin win at capX x bet", () => {
    const math: CascadeMath = {
      ...CASCADE_DEFAULT_MATH,
      paytable: { ...CASCADE_DEFAULT_MATH.paytable, "9": [9999, 9999, 9999, 9999] },
    };
    const slots = new Map<number, number>();
    for (let i = 0; i < 30; i++) slots.set(i, R[9]);
    const res = resolveCascade({ draw: scripted(slots, safeFallback()), math, betMicro: BET, isFreeSpin: false });
    expect(res.wasCapped).toBe(true);
    expect(res.cappedWinMicro).toBe(BET * 5000n);
  });

  it("the seeded stream is deterministic across replays", () => {
    const run = () =>
      resolveCascade({
        draw: makeCascadeDraw("server-secret", "client-seed", 42),
        math: CASCADE_DEFAULT_MATH,
        betMicro: BET,
        isFreeSpin: false,
      });
    const a = run();
    const b = run();
    expect(JSON.stringify(a.steps)).toBe(JSON.stringify(b.steps));
    expect(a.totalWinMicro).toBe(b.totalWinMicro);
    expect(a.drawsUsed).toBe(b.drawsUsed);
    expect(a.initialGrid.length).toBe(30);
  });
});

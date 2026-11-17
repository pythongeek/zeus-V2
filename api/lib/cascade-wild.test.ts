import { describe, it, expect } from "vitest";
import {
  resolveCascade,
  makeCascadeDraw,
  CASCADE_DEFAULT_MATH,
  type CascadeMath,
} from "./cascade";

const wildMath: CascadeMath = {
  ...CASCADE_DEFAULT_MATH,
  wildId: 11,
  wildWeight: 60,
  wildGate: [1, 3],
};

function run(math: CascadeMath, seed: string, wildLive?: boolean) {
  return resolveCascade({
    draw: makeCascadeDraw(seed, "wild-test", 1),
    math,
    betMicro: 100000000n,
    isFreeSpin: true,
    rungIn: 0,
    ...(wildLive === undefined ? {} : { wildLive }),
  });
}

describe("cascade wild (U5-B)", () => {
  it("gate off is byte-identical to the pre-wild engine", () => {
    for (let i = 0; i < 25; i++) {
      const legacy = run(wildMath, `parity-${i}`);
      const gatedOff = run(wildMath, `parity-${i}`, false);
      expect(JSON.stringify(gatedOff.steps)).toBe(JSON.stringify(legacy.steps));
      expect(gatedOff.finalGrid).toEqual(legacy.finalGrid);
      expect(gatedOff.totalWinMicro).toBe(legacy.totalWinMicro);
      expect(gatedOff.drawsUsed).toBe(legacy.drawsUsed);
    }
  });

  it("a bundle without a wild ignores the gate entirely", () => {
    for (let i = 0; i < 10; i++) {
      const legacy = run(CASCADE_DEFAULT_MATH, `nowild-${i}`);
      const gated = run(CASCADE_DEFAULT_MATH, `nowild-${i}`, true);
      expect(JSON.stringify(gated.steps)).toBe(JSON.stringify(legacy.steps));
      expect(gated.totalWinMicro).toBe(legacy.totalWinMicro);
    }
  });

  it("wild live: wilds appear, join one paying symbol, never cluster alone", () => {
    let sawWild = 0;
    let sawAssisted = 0;
    for (let i = 0; i < 40; i++) {
      const res = run(wildMath, `live-${i}`, true);
      for (const step of res.steps) {
        const wildCells = step.grid
          .map((s, idx) => (s === 11 ? idx : -1))
          .filter((x) => x >= 0);
        if (wildCells.length > 0) sawWild++;
        for (const c of step.clusters) {
          expect(c.symbol).not.toBe(11);
          expect(c.count).toBe(c.positions.length);
          if (wildCells.some((p) => c.positions.includes(p))) {
            sawAssisted++;
            // Every wild on the grid joins the one assisted cluster.
            for (const p of wildCells) expect(c.positions).toContain(p);
          }
        }
      }
    }
    expect(sawWild).toBeGreaterThan(0);
    expect(sawAssisted).toBeGreaterThan(0);
  });

  it("resolution is deterministic under the gate", () => {
    const a = run(wildMath, "det-1", true);
    const b = run(wildMath, "det-1", true);
    expect(JSON.stringify(a.steps)).toBe(JSON.stringify(b.steps));
    expect(a.totalWinMicro).toBe(b.totalWinMicro);
  });
});

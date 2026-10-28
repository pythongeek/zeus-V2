import { describe, it, expect } from "vitest";
import { certifyMath, exactBase, linePayout, type MathBundle } from "../lib/certify";
import { getMathConfig } from "../routers/game";

/**
 * Section E1: the Lab certifier must reproduce the A4 certified
 * numbers for the live default bundle — base EV 68.344% and
 * f 0.2501 by EXACT enumeration; total 96.00% with the Monte-Carlo
 * thunder term.
 */
function defaultBundle(): MathBundle {
  const cfg = getMathConfig();
  const paytable: MathBundle["paytable"] = {};
  for (let id = 0; id <= 10; id++) {
    const p = cfg.payouts[id as keyof typeof cfg.payouts];
    paytable[String(id)] = { "3": p[3], "4": p[4], "5": p[5] };
  }
  return {
    paytable,
    reels: cfg.strips,
    freeSpins: cfg.freeSpins,
    thunder: { chanceDenominator: cfg.thunderDenominator, floorX: cfg.thunderFloorX },
  };
}

describe("E1: certifier exact enumeration", () => {
  it("reproduces the A4 exact base EV and free-spin expectation", () => {
    const exact = exactBase(defaultBundle());
    expect(exact.baseEv).toBeGreaterThan(0.678);
    expect(exact.baseEv).toBeLessThan(0.689);
    expect(exact.fsPerSpin).toBeGreaterThan(0.245);
    expect(exact.fsPerSpin).toBeLessThan(0.256);
    expect(exact.fsTriggerProb).toBeGreaterThan(0.027);
    expect(exact.fsTriggerProb).toBeLessThan(0.0295);
  });

  it("linePayout replicates the evaluator's wild-commit quirk", () => {
    const payouts = {
      0: { 3: 50, 4: 200, 5: 1000 },
      8: { 3: 5, 4: 18, 5: 75 },
    } as any;
    // W W W A K pays as four Aces (18), NOT three Zeus (50).
    expect(linePayout([0, 0, 0, 8, 9], payouts)).toBe(18);
    // Five wilds pay as Zeus.
    expect(linePayout([0, 0, 0, 0, 0], payouts)).toBe(1000);
    // A W A breaks at reel 4 only after count 3.
    expect(linePayout([8, 0, 8, 9, 8], payouts)).toBe(5);
  });

  it("full certification lands on the certified 96% for the default bundle", () => {
    const cert = certifyMath(defaultBundle(), 80_000);
    expect(cert.basePct).toBeGreaterThan(67.8);
    expect(cert.basePct).toBeLessThan(68.9);
    expect(cert.thunderPct).toBeGreaterThan(1.8);
    expect(cert.thunderPct).toBeLessThan(3.4);
    expect(cert.totalPct).toBeGreaterThan(94.8);
    expect(cert.totalPct).toBeLessThan(97.2);
    expect(cert.jackpotPct).toBe(1.08);
  }, 120_000);

  it("a dead paytable certifies near zero (sanity)", () => {
    const dead = defaultBundle();
    for (const k of Object.keys(dead.paytable)) dead.paytable[k] = { "3": 0, "4": 0, "5": 0 };
    dead.thunder = { chanceDenominator: 200, floorX: 0 };
    const cert = certifyMath(dead, 20_000);
    expect(cert.basePct).toBe(0);
    expect(cert.totalPct).toBeLessThan(2);
  }, 60_000);
});

import { describe, it, expect } from "vitest";
import { hashSeedV1, hashSeedV2 } from "../routers/game";
import { fxRatio, toUsdtMicro, fromUsdtMicro, parseMoney, fmtMoney } from "./money";

/**
 * Pre-launch remediation regressions:
 *  - GE-01: the v2 length-prefixed hash must NOT have the seed/nonce boundary
 *    collision that allowed replaying a known win at a higher bet.
 *  - GE-02: jackpot pools are canonical USDT; conversion in and out must be
 *    exact at the configured fx rate (1 USDT = 110 BDT).
 */
describe("GE-01: fairness hash v2", () => {
  it("removes the v1 seed/nonce collision", () => {
    const seed = "server-seed-abc";
    // Historical collision: nonce 1 + seed "X1" == nonce 11 + seed "X".
    expect(hashSeedV1(seed, "X1", 1)).toBe(hashSeedV1(seed, "X", 11));
    // v2 length-prefixes both fields, so the boundary is unambiguous.
    expect(hashSeedV2(seed, "X1", 1)).not.toBe(hashSeedV2(seed, "X", 11));
  });

  it("is deterministic and differs per nonce/seed", () => {
    expect(hashSeedV2("s", "c", 1)).toBe(hashSeedV2("s", "c", 1));
    expect(hashSeedV2("s", "c", 1)).not.toBe(hashSeedV2("s", "c", 2));
    expect(hashSeedV2("s", "c", 1)).not.toBe(hashSeedV2("s2", "c", 1));
    expect(hashSeedV2("s", "c", 1)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("GE-02: jackpot currency conversion", () => {
  const rates = { BTC: 11_000_000, ETH: 380_000, USDT: 110, BDT: 1 };

  it("derives exact currency-per-USDT ratios from the admin fx map", () => {
    expect(fxRatio("BDT", rates)).toEqual({ num: 110n, den: 1n });
    expect(fxRatio("USDT", rates)).toEqual({ num: 110n, den: 110n });
    expect(fxRatio("BTC", rates)).toEqual({ num: 110n, den: 11000000n });
  });

  it("converts a bet into USDT and a pool payout back into BDT", () => {
    const bdt = fxRatio("BDT", rates);
    // 1 BDT bet -> 1/110 USDT
    expect(fmtMoney(toUsdtMicro(parseMoney("1"), bdt))).toBe("0.00909091");
    // A 7.282 USDT mini pool pays 7.282 * 110 = 801.02 BDT (the amount the
    // UI advertises), not 7.282 BDT.
    expect(fmtMoney(fromUsdtMicro(parseMoney("7.282"), bdt))).toBe("801.02");
    // Round trip preserves integral micro amounts.
    expect(fromUsdtMicro(toUsdtMicro(parseMoney("220"), bdt), bdt)).toBe(parseMoney("220"));
  });

  it("keeps USDT payouts 1:1", () => {
    const usdt = fxRatio("USDT", rates);
    const pool = parseMoney("26.3692");
    expect(fmtMoney(fromUsdtMicro(pool, usdt))).toBe("26.3692");
  });
});

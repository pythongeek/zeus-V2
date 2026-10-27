import { describe, it, expect } from "vitest";
import {
  parseMoney,
  fmtMoney,
  canonicalMoney,
  mulDivRound,
  addMoney,
  subMoney,
} from "./money";

describe("A3: exact money", () => {
  it("adds the classic float trap exactly", () => {
    expect(addMoney("0.1", "0.2")).toBe("0.3");
    expect(addMoney("0.262", "0.471")).toBe("0.733");
    expect(subMoney("100", "0.1")).toBe("99.9");
  });

  it("repairs legacy float-drifted strings on parse", () => {
    expect(canonicalMoney("0.26200000000000007")).toBe("0.262");
    expect(canonicalMoney("0.7330000000000001")).toBe("0.733");
    expect(canonicalMoney("10.660000000000001")).toBe("10.66");
  });

  it("round-trips canonical values and trims zeros", () => {
    for (const v of ["0", "1", "0.1", "12.34", "1000000.00000001", "-5.5", "0.00000001"]) {
      expect(fmtMoney(parseMoney(v))).toBe(v);
    }
    expect(fmtMoney(parseMoney("1.50000000"))).toBe("1.5");
    expect(fmtMoney(0n)).toBe("0");
  });

  it("handles negatives and rejects garbage", () => {
    expect(canonicalMoney("-0.26200000000000007")).toBe("-0.262");
    expect(addMoney("-5", "5")).toBe("0");
    expect(() => parseMoney("abc")).toThrow("Invalid money value");
    expect(() => parseMoney("1.2.3")).toThrow("Invalid money value");
  });

  it("mulDivRound rounds half-up on magnitude", () => {
    // 1% contribution of a 0.15 bet = 0.0015 exactly
    expect(fmtMoney(mulDivRound(parseMoney("0.15"), 1n, 100n))).toBe("0.0015");
    // line payout: bet 0.1, multiplier 15 over 20 lines -> 0.075
    expect(fmtMoney(mulDivRound(parseMoney("0.1"), 15n, 20n))).toBe("0.075");
    // 1% of 0.00000001 -> 0 (rounds down below half a micro)
    expect(fmtMoney(mulDivRound(1n, 1n, 100n))).toBe("0");
    // half a micro rounds up
    expect(fmtMoney(mulDivRound(parseMoney("0.00000005"), 1n, 1n))).toBe("0.00000005");
    expect(fmtMoney(mulDivRound(parseMoney("1"), 1n, 200n))).toBe("0.005");
  });
});

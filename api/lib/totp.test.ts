import { describe, it, expect } from "vitest";
import {
  base32Encode,
  base32Decode,
  hotp,
  totp,
  verifyTotp,
  generateTotpSecret,
  encryptSecret,
  decryptSecret,
  generateRecoveryCodes,
  hashRecoveryCode,
} from "./totp";

// RFC 6238 Appendix B test secret: ASCII "12345678901234567890" for SHA-1.
const RFC_SECRET_B32 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

describe("base32", () => {
  it("encodes the RFC secret bytes", () => {
    expect(base32Encode(Buffer.from("12345678901234567890", "ascii"))).toBe(RFC_SECRET_B32);
  });
  it("round-trips random secrets", () => {
    for (let i = 0; i < 20; i++) {
      const s = generateTotpSecret();
      expect(base32Encode(base32Decode(s))).toBe(s);
      expect(base32Decode(s).length).toBe(20);
    }
  });
});

describe("totp (RFC 6238 vectors, 6-digit truncation)", () => {
  // RFC 6238 Appendix B: time (s) -> 8-digit value -> 6-digit code
  // (mod 10^6). Cross-verified against an independent Python
  // hmac/hashlib implementation of the same algorithm.
  const vectors: Array<[number, string]> = [
    [59, "287082"], // 94287082
    [1111111109, "081804"], // 07081804
    [1111111111, "050471"], // 14050471
    [1234567890, "005924"], // 89005924
    [2000000000, "279037"], // 69279037
    [20000000000, "353130"], // 65353130
  ];
  for (const [tSec, expected] of vectors) {
    it(`T=${tSec} -> ${expected}`, () => {
      expect(totp(RFC_SECRET_B32, tSec * 1000)).toBe(expected);
    });
  }
  it("hotp counter 1 equals totp at 59s", () => {
    expect(hotp(RFC_SECRET_B32, 1)).toBe("287082");
  });
  it("verify accepts ±1 step and rejects others", () => {
    const t = 1234567890 * 1000;
    const code = totp(RFC_SECRET_B32, t);
    expect(verifyTotp(RFC_SECRET_B32, code, t)).toBe(true);
    expect(verifyTotp(RFC_SECRET_B32, code, t + 30_000)).toBe(true);
    expect(verifyTotp(RFC_SECRET_B32, code, t - 30_000)).toBe(true);
    expect(verifyTotp(RFC_SECRET_B32, code, t + 90_000)).toBe(false);
    expect(verifyTotp(RFC_SECRET_B32, "000000", t)).toBe(false);
    expect(verifyTotp(RFC_SECRET_B32, "abc123", t)).toBe(false);
  });
});

describe("secret storage", () => {
  it("encrypt/decrypt round-trips and is not plaintext", () => {
    const s = generateTotpSecret();
    const enc = encryptSecret(s);
    expect(enc.startsWith("v1:")).toBe(true);
    expect(enc.includes(s)).toBe(false);
    expect(decryptSecret(enc)).toBe(s);
  });
});

describe("recovery codes", () => {
  it("generates formatted codes whose hashes match case/format-insensitively", () => {
    const codes = generateRecoveryCodes(10);
    expect(codes).toHaveLength(10);
    for (const c of codes) {
      expect(c).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
      expect(hashRecoveryCode(c)).toBe(hashRecoveryCode(c.toLowerCase().replace("-", " ")));
    }
  });
});

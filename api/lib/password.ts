import crypto from "crypto";
/**
 * Password hashing with Node's built-in scrypt (no external dependency).
 * Format: scrypt$N$r$p$salt_hex$hash_hex
 */
const N = 16384; // 2^14
const R = 8;
const P = 1;
const KEYLEN = 64;

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  try {
    const parts = stored.split("$");
    if (parts.length !== 6 || parts[0] !== "scrypt") return false;
    const n = parseInt(parts[1], 10);
    const r = parseInt(parts[2], 10);
    const p = parseInt(parts[3], 10);
    const salt = Buffer.from(parts[4], "hex");
    const expected = Buffer.from(parts[5], "hex");
    const actual = crypto.scryptSync(password, salt, expected.length, { N: n, r, p });
    return crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

/** Constant-time random 6-digit OTP hash (for phone/email verification). */
export function generateOtp(): string {
  return String(crypto.randomInt(100000, 1000000));
}

export function hashOtp(code: string, identifier: string): string {
  return crypto.createHmac("sha256", identifier).update(code).digest("hex");
}

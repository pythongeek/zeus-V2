import { createHmac, createHash, randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import * as jose from "jose";
import { env } from "./env";

/**
 * AP1: TOTP two-factor authentication for admin accounts (RFC 4226 /
 * 6238, HMAC-SHA1, 30s step, 6 digits — the authenticator-app
 * standard). Implemented directly on node:crypto so the security
 * core has no third-party dependency; correctness is pinned by the
 * RFC 6238 test vectors in totp.test.ts.
 *
 * Secrets are never stored in plain text: they are AES-256-GCM
 * encrypted with a key derived from APP_SECRET before hitting the
 * users table, and recovery codes are stored as SHA-256 hashes.
 */

const B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/=+$/, "").replace(/\s+/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error("Invalid base32 character");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** New random TOTP secret (160-bit, the RFC-recommended size). */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function hotp(secretBase32: string, counter: number): string {
  const key = base32Decode(secretBase32);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", key).update(msg).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(binary % 1_000_000).padStart(6, "0");
}

export function totp(secretBase32: string, atMs: number = Date.now()): string {
  return hotp(secretBase32, Math.floor(atMs / 1000 / 30));
}

/** Accept the current step plus one step either side (clock skew). */
export function verifyTotp(secretBase32: string, code: string, atMs: number = Date.now()): boolean {
  const clean = code.replace(/\s+/g, "");
  if (!/^\d{6}$/.test(clean)) return false;
  const counter = Math.floor(atMs / 1000 / 30);
  for (const delta of [-1, 0, 1]) {
    if (hotp(secretBase32, counter + delta) === clean) return true;
  }
  return false;
}

export function otpauthUrl(secretBase32: string, account: string): string {
  const issuer = "Zeus Slot";
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secretBase32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

// --- secret storage encryption (AES-256-GCM, key = SHA-256(APP_SECRET)) ---

function storageKey(): Buffer {
  return createHash("sha256").update(env.appSecret).digest();
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", storageKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${enc.toString("base64")}`;
}

export function decryptSecret(stored: string): string {
  const [v, ivB64, tagB64, dataB64] = stored.split(":");
  if (v !== "v1") throw new Error("Unknown secret format");
  const decipher = createDecipheriv("aes-256-gcm", storageKey(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString("utf8");
}

// --- recovery codes ---

const RECOVERY_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no I/L/O/0/1

export function generateRecoveryCodes(count = 10): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    const bytes = randomBytes(8);
    let s = "";
    for (const b of bytes) s += RECOVERY_ALPHABET[b % RECOVERY_ALPHABET.length];
    codes.push(`${s.slice(0, 4)}-${s.slice(4)}`);
  }
  return codes;
}

export function hashRecoveryCode(code: string): string {
  return createHash("sha256").update(code.replace(/[\s-]/g, "").toUpperCase()).digest("hex");
}

// --- short-lived "password ok, TOTP pending" token (separate cookie) ---

export const TOTP_PENDING_COOKIE = "zeus_totp_pending";

export async function signPendingToken(unionId: string): Promise<string> {
  const secret = new TextEncoder().encode(env.appSecret);
  return new jose.SignJWT({ unionId, purpose: "totp" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(secret);
}

export async function verifyPendingToken(token: string): Promise<string | null> {
  try {
    const secret = new TextEncoder().encode(env.appSecret);
    const { payload } = await jose.jwtVerify(token, secret, { algorithms: ["HS256"] });
    if (payload.purpose !== "totp" || typeof payload.unionId !== "string") return null;
    return payload.unionId;
  } catch {
    return null;
  }
}

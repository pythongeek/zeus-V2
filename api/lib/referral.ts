/**
 * Step 14 — referral codes: 8-character Crockford base32 of the
 * user id (7 chars, zero-padded) + 1 checksum character. Anyone
 * can verify a code's checksum offline; decoding yields the
 * referrer's user id. Codes are deterministic — no separate code
 * table to keep in sync.
 */

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function encodeReferralCode(userId: number): string {
  let n = userId;
  let body = "";
  do {
    body = ALPHABET[n % 32] + body;
    n = Math.floor(n / 32);
  } while (n > 0);
  body = body.padStart(7, "0");
  let sum = userId;
  for (const ch of body) sum += ALPHABET.indexOf(ch);
  return body + ALPHABET[sum % 32];
}

export function decodeReferralCode(code: string): number | null {
  const clean = code.trim().toUpperCase();
  if (clean.length !== 8) return null;
  for (const ch of clean) if (!ALPHABET.includes(ch)) return null;
  const body = clean.slice(0, 7);
  let id = 0;
  for (const ch of body) id = id * 32 + ALPHABET.indexOf(ch);
  let sum = id;
  for (const ch of body) sum += ALPHABET.indexOf(ch);
  if (ALPHABET[sum % 32] !== clean[7]) return null;
  if (encodeReferralCode(id) !== clean) return null;
  return id;
}

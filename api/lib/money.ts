/**
 * Exact money arithmetic (A3).
 *
 * All stored money is a decimal STRING in the database (e.g. "0.262").
 * Internally we convert to BigInt "micro" units at 8 decimal places and
 * do every add/subtract/multiply there, so values like 0.1 + 0.2 are
 * exact and float drift ("0.26200000000000007") can never be produced.
 * Conversion back always yields the canonical decimal string.
 *
 * parseMoney quantizes to 8dp (round half-up on magnitude) so legacy
 * float-drifted strings are repaired on first read.
 */

const SCALE = 100_000_000n; // 10^8
const DECIMAL_RE = /^(-?)(\d+)(?:\.(\d+))?$/;

export function parseMoney(value: string | number): bigint {
  const s = typeof value === "number" ? String(value) : value.trim();
  const m = DECIMAL_RE.exec(s);
  if (!m) throw new Error(`Invalid money value: ${value}`);
  const [, sign, intPart, fracPart = ""] = m;
  let micro =
    BigInt(intPart) * SCALE + BigInt((fracPart + "00000000").slice(0, 8));
  // Round half-up on magnitude when more than 8 dp were supplied.
  if (fracPart.length > 8 && fracPart[8] >= "5") micro += 1n;
  return sign === "-" ? -micro : micro;
}

export function fmtMoney(micro: bigint): string {
  const negative = micro < 0n;
  const abs = negative ? -micro : micro;
  const intPart = abs / SCALE;
  const frac = abs % SCALE;
  if (frac === 0n) return (negative ? "-" : "") + intPart.toString();
  const fracStr = frac.toString().padStart(8, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${intPart.toString()}.${fracStr}`;
}

/** Convenience: canonical string form of any stored money value. */
export function canonicalMoney(value: string | number): string {
  return fmtMoney(parseMoney(value));
}

/** micro * num / den, rounded half-up on magnitude (den > 0). */
export function mulDivRound(micro: bigint, num: bigint, den: bigint): bigint {
  if (den <= 0n) throw new Error("mulDivRound: denominator must be positive");
  const negative = micro < 0n !== num < 0n;
  const a = micro < 0n ? -micro : micro;
  const b = num < 0n ? -num : num;
  const product = a * b;
  let q = product / den;
  const r = product % den;
  if (r * 2n >= den) q += 1n;
  return negative ? -q : q;
}

export function addMoney(a: string, b: string): string {
  return fmtMoney(parseMoney(a) + parseMoney(b));
}

export function subMoney(a: string, b: string): string {
  return fmtMoney(parseMoney(a) - parseMoney(b));
}

export const ZERO_MONEY = 0n;

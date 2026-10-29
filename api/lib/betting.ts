import { parseMoney } from "./money";

/**
 * Step 1 (BD production plan): per-currency bet ladders.
 *
 * The client stepper can only land on ladder values, and the spin
 * endpoint enforces membership server-side, so a bet can never be
 * placed off-ladder. Ladders are admin-tunable via the public
 * `bet_ladders` setting; these constants are the defaults and the
 * fallback when the setting is missing or malformed.
 *
 * BDT is a micro-stake ladder (৳1–৳100). USDT keeps the ladder the
 * game has always used (including the 0.25 step and the 1000 top,
 * which matches the max_bet setting). Currencies without a ladder
 * (BTC/ETH — not enabled for play) fall back to the min/max range
 * check only.
 */
export const BDT_LADDER: readonly number[] = [1, 2, 5, 10, 20, 50, 100];
export const USDT_LADDER: readonly number[] = [
  0.1, 0.25, 0.5, 1, 2.5, 5, 10, 25, 50, 100, 250, 500, 1000,
];

export const DEFAULT_BET_LADDERS: Record<string, readonly number[]> = {
  BDT: BDT_LADDER,
  USDT: USDT_LADDER,
};

/** Resolve the ladder for a currency from the bet_ladders setting. */
export function ladderFor(
  laddersSetting: unknown,
  currency: string,
): readonly number[] | null {
  const fromSetting = (laddersSetting as Record<string, unknown> | null)?.[
    currency
  ];
  const candidate = Array.isArray(fromSetting)
    ? fromSetting
    : DEFAULT_BET_LADDERS[currency];
  if (!candidate) return null;
  const clean = candidate.filter(
    (v): v is number => typeof v === "number" && Number.isFinite(v) && v > 0,
  );
  if (clean.length === 0) return null;
  return [...clean].sort((a, b) => a - b);
}

/** Exact membership test in micro units — no float comparison. */
export function isOnLadder(
  ladder: readonly number[],
  betMicro: bigint,
): boolean {
  return ladder.some((step) => parseMoney(String(step)) === betMicro);
}

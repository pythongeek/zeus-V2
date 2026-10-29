/**
 * Step 1 (BD production plan): client mirror of api/lib/betting.ts.
 *
 * The authoritative ladders arrive with the public config
 * (`bet_ladders` setting); these defaults only cover the first
 * paint before config loads. The server enforces membership, so
 * anything the stepper offers here is validated again on spin.
 */
export const BDT_LADDER: readonly number[] = [1, 2, 5, 10, 20, 50, 100];
export const USDT_LADDER: readonly number[] = [
  0.1, 0.25, 0.5, 1, 2.5, 5, 10, 25, 50, 100, 250, 500, 1000,
];

export const DEFAULT_BET_LADDERS: Record<string, readonly number[]> = {
  BDT: BDT_LADDER,
  USDT: USDT_LADDER,
};

type ConfigLike = {
  bet_ladders?: Record<string, unknown>;
  bet_steps?: number[];
} | null | undefined;

export function ladderFor(
  config: ConfigLike,
  currency: string,
): readonly number[] {
  const fromSetting = config?.bet_ladders?.[currency];
  if (Array.isArray(fromSetting)) {
    const clean = fromSetting.filter(
      (v): v is number =>
        typeof v === "number" && Number.isFinite(v) && v > 0,
    );
    if (clean.length > 0) return [...clean].sort((a, b) => a - b);
  }
  if (DEFAULT_BET_LADDERS[currency]) return DEFAULT_BET_LADDERS[currency];
  if (Array.isArray(config?.bet_steps) && config.bet_steps.length > 0) {
    return config.bet_steps;
  }
  return USDT_LADDER;
}

/** Snap an arbitrary amount onto the nearest ladder step (ties go down). */
export function snapToLadder(
  amount: number,
  ladder: readonly number[],
): number {
  if (ladder.length === 0) return amount;
  if (amount <= ladder[0]) return ladder[0];
  if (amount >= ladder[ladder.length - 1]) return ladder[ladder.length - 1];
  let best = ladder[0];
  for (const step of ladder) {
    if (Math.abs(step - amount) < Math.abs(best - amount) - 1e-12) {
      best = step;
    }
  }
  return best;
}

/** Move one step up/down the ladder, snapping first if off-ladder. */
export function stepBet(
  current: number,
  ladder: readonly number[],
  dir: "up" | "down",
): number {
  if (ladder.length === 0) return current;
  const snapped = snapToLadder(current, ladder);
  const i = ladder.indexOf(snapped);
  const next = Math.min(
    Math.max(i + (dir === "up" ? 1 : -1), 0),
    ladder.length - 1,
  );
  return ladder[next];
}

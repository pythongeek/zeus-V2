import { resolveCascade, type CascadeMath } from "./cascade";
import { mulberry32, seedFromString, type MCSample } from "./mc";

/**
 * Cascade Monte Carlo machinery (playbook §6): a full-process
 * sampler (paid spin + its entire free-spin chain) through the
 * REAL resolver, plus the EXACT step-0 expectation used as the
 * control variate.
 *
 * E[step-0 payout] is exact because initial-grid cells are
 * independent weighted draws: each symbol's count is marginally
 * Binomial(30, p_sym), and the step-0 payout is the sum over
 * symbols of payBracket(count) (ladder rung 0 = 1). Expectations
 * of sums need only the marginals.
 */

function binomPmf(n: number, k: number, p: number): number {
  if (p <= 0) return k === 0 ? 1 : 0;
  if (p >= 1) return k === n ? 1 : 0;
  // log-space to avoid overflow at n=30 (small, but free to be safe)
  let logC = 0;
  for (let i = 0; i < k; i++) logC += Math.log(n - i) - Math.log(i + 1);
  return Math.exp(logC + k * Math.log(p) + (n - k) * Math.log(1 - p));
}

export function bracketPay(paytable: [number, number, number, number], count: number): number {
  if (count < 8) return 0;
  if (count >= 15) return paytable[3];
  if (count >= 12) return paytable[2];
  if (count >= 10) return paytable[1];
  return paytable[0];
}

/** Exact E[step-0 payout] in bet units for the given math.
 *  Cells are independent but not identically distributed (per-
 *  column strips), so each symbol's count is Poisson-binomial:
 *  the convolution over columns of Binomial(5, p_col). */
export function step0Expectation(math: CascadeMath): number {
  let expectation = 0;
  for (const sym of math.symbols) {
    const table = math.paytable[String(sym)];
    if (!table) continue;
    // dist[k] = P(count = k) built column by column.
    let dist: number[] = [1];
    for (let col = 0; col < 6; col++) {
      const strip = math.weights[col] ?? math.weights[0];
      const total = Object.values(strip).reduce((a, b) => a + b, 0);
      const p = (strip[String(sym)] ?? 0) / total;
      const next = new Array(dist.length + 5).fill(0);
      for (let k = 0; k < dist.length; k++) {
        if (dist[k] === 0) continue;
        for (let j = 0; j <= 5; j++) {
          next[k + j] += dist[k] * binomPmf(5, j, p);
        }
      }
      dist = next;
    }
    for (let k = 8; k < dist.length; k++) {
      expectation += dist[k] * bracketPay(table, k);
    }
  }
  return expectation;
}

export interface CascadeProcessStats {
  /** Raw (unadjusted) per-process mean and SD — the playbook's
   *  sigma is the plain sample SD, not the CV-adjusted one. */
  rawMean: number;
  rawSigma: number;
  processes: number;
  hitRate: number; // paid-spin resolution win > 0
  chainHist: Record<number, number>; // paid-spin chain length counts
  fsTriggers: number;
  /** Mean value (bet units) of one free-spin round incl. retriggers
   *  — the E[feature] the buy-feature price is built from. */
  featureExpectationX: number;
  maxWinX: number;
  winsAtCap: number; // processes whose total >= capX (tail bound input)
  totalFsSpins: number;
}

export function makeCascadeProcessSampler(math: CascadeMath, seedLabel: string) {
  const rng = mulberry32(seedFromString(seedLabel));
  const betMicro = 100_000_000n;
  const stats = {
    sumX: 0,
    sumX2: 0,
    processes: 0,
    hits: 0,
    chainHist: {} as Record<number, number>,
    fsTriggers: 0,
    fsValueX: 0,
    maxWinX: 0,
    winsAtCap: 0,
    totalFsSpins: 0,
  };

  const next = (): MCSample => {
    const draw = () => rng();
    const paid = resolveCascade({ draw, math, betMicro, isFreeSpin: false });
    let totalMicro = paid.cappedWinMicro;
    let fsLeft = paid.freeSpinsAwarded;
    if (fsLeft > 0) stats.fsTriggers += 1;
    stats.chainHist[paid.chainLength] = (stats.chainHist[paid.chainLength] ?? 0) + 1;
    if (paid.cappedWinMicro > 0n) stats.hits += 1;
    let guard = 0;
    let fsValueMicro = 0n;
    let rung = 0; // an FS round always starts at rung 0 and compounds
    while (fsLeft > 0 && guard < 10000) {
      guard += 1;
      fsLeft -= 1;
      stats.totalFsSpins += 1;
      const fs = resolveCascade({ draw: () => rng(), math, betMicro, isFreeSpin: true, rungIn: rung });
      rung = fs.rungOut;
      fsValueMicro += fs.cappedWinMicro;
      totalMicro += fs.cappedWinMicro;
      fsLeft += fs.freeSpinsAwarded;
    }
    if (paid.freeSpinsAwarded > 0) stats.fsValueX += Number(fsValueMicro) / 1e8;
    stats.processes += 1;
    const x = Number(totalMicro) / 1e8;
    stats.sumX += x;
    stats.sumX2 += x * x;
    if (x > stats.maxWinX) stats.maxWinX = x;
    if (x >= math.capX) stats.winsAtCap += 1;
    const c = paid.steps.length > 0 ? Number(paid.steps[0].stepWinMicro) / 1e8 : 0;
    return { x, c };
  };

  const summary = (): CascadeProcessStats => ({
    rawMean: stats.processes > 0 ? stats.sumX / stats.processes : 0,
    rawSigma:
      stats.processes > 0
        ? Math.sqrt(Math.max(0, stats.sumX2 / stats.processes - (stats.sumX / stats.processes) ** 2))
        : 0,
    processes: stats.processes,
    hitRate: stats.processes > 0 ? stats.hits / stats.processes : 0,
    chainHist: { ...stats.chainHist },
    fsTriggers: stats.fsTriggers,
    featureExpectationX: stats.fsTriggers > 0 ? stats.fsValueX / stats.fsTriggers : 0,
    maxWinX: stats.maxWinX,
    winsAtCap: stats.winsAtCap,
    totalFsSpins: stats.totalFsSpins,
  });

  return { next, summary };
}

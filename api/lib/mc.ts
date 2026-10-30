/**
 * Monte Carlo certification harness (Cascade Decision Playbook §6).
 *
 * The estimator reports BOTH intervals, per §6.4: the naive
 * fixed-sample 95% CI at the final n, and an always-valid sequential
 * interval (Robbins sub-Gaussian mixture bound, plug-in sigma) that
 * may be checked after every batch without inflating the error rate
 * — the run stops the moment the SEQUENTIAL interval is tight
 * enough, and if the two disagree materially the sampler is suspect
 * and the run certifies nothing.
 *
 * Optional control variate (§6.5): when the source also returns a
 * variate c whose exact expectation is known (e.g. the cascade
 * step-0 payout, whose expectation is computable from binomial
 * marginals), the adjusted estimator x - beta*(c - E[c]) removes
 * that variance component. kappa (naive variance / adjusted
 * variance) is measured and reported, never assumed.
 */
import { calculateSpin, evaluatePaylines, checkThunderStrike, SYMBOLS, type MathConfig } from "../routers/game";
import { certifyMath, type MathBundle } from "./certify";

/** Deterministic PRNG (mulberry32) for simulation streams. */
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seedFromString(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Robbins (1970) mixture bound half-width for the sample mean:
 * always-valid at level alpha for sub-Gaussian samples with the
 * given sigma (plug-in estimate in practice). rho is the mixture
 * prior scale (in samples).
 */
export function robbinsHalfWidth(sigma: number, n: number, alpha = 0.05, rho = 1000): number {
  if (n <= 0) return Infinity;
  if (sigma <= 0) return 0;
  const inner = Math.sqrt((n + rho) / rho) / alpha;
  return (sigma * Math.sqrt(2 * (n + rho) * Math.log(inner))) / n;
}

export interface MCSample {
  x: number;
  c?: number;
}

export interface MCResult {
  n: number;
  mean: number;
  sigma: number;
  naiveHalfWidth: number;
  seqHalfWidth: number;
  stoppedBy: "tolerance" | "max";
  /** Variance-reduction factor actually measured (1 when no CV). */
  kappa: number;
  cvBeta: number | null;
}

export interface MCOptions {
  /** Stop when the sequential half-width drops to this (bet units). */
  tolerance: number;
  maxSpins: number;
  batchSize?: number;
  alpha?: number;
  /** Exact expectation of the control variate, when samples carry c. */
  expectedC?: number;
  /**
   * Minimum EFFECTIVE sample size (n x measured kappa) that must be
   * reached before a tolerance stop is allowed. The cascade
   * certification gate (playbook section 6) requires >= 50M effective spins
   * AND a sequential CI <= tolerance; without this floor the
   * tolerance stop fires first (first cert run: 18.5M raw / 26.4M
   * effective, verdict FAIL on the floor alone).
   */
  minEffectiveSpins?: number;
}

export function runSequentialMC(next: () => MCSample, opts: MCOptions): MCResult {
  const batch = opts.batchSize ?? 25_000;
  const alpha = opts.alpha ?? 0.05;
  let n = 0;
  let sx = 0;
  let sx2 = 0;
  let sc = 0;
  let sc2 = 0;
  let sxc = 0;
  const useCv = opts.expectedC !== undefined;

  const stats = () => {
    const meanX = sx / n;
    const rawVar = sx2 / n - meanX * meanX;
    // Clamp float residue: a truly constant stream must read sigma 0.
    const varX = rawVar < 1e-9 ? 0 : Math.max(rawVar, 0);
    if (!useCv) {
      const sigma = Math.sqrt(varX);
      return { mean: meanX, sigma, kappa: 1, beta: null as number | null };
    }
    const meanC = sc / n;
    const rawVarC = sc2 / n - meanC * meanC;
    const varC = rawVarC < 1e-9 ? 0 : Math.max(rawVarC, 0);
    const cov = sxc / n - meanX * meanC;
    const beta = varC > 0 ? cov / varC : 0;
    const mean = meanX - beta * (meanC - (opts.expectedC as number));
    const varY = Math.max(varX - 2 * beta * cov + beta * beta * varC, 0);
    return {
      mean,
      sigma: Math.sqrt(varY),
      kappa: varY > 0 ? varX / varY : 1,
      beta,
    };
  };

  let stoppedBy: "tolerance" | "max" = "max";
  while (n < opts.maxSpins) {
    const take = Math.min(batch, opts.maxSpins - n);
    for (let i = 0; i < take; i++) {
      const s = next();
      n += 1;
      sx += s.x;
      sx2 += s.x * s.x;
      if (useCv && s.c !== undefined) {
        sc += s.c;
        sc2 += s.c * s.c;
        sxc += s.x * s.c;
      }
    }
    const st = stats();
    if (
      robbinsHalfWidth(st.sigma, n, alpha) <= opts.tolerance &&
      n * st.kappa >= (opts.minEffectiveSpins ?? 0)
    ) {
      stoppedBy = "tolerance";
      break;
    }
  }
  const st = stats();
  return {
    n,
    mean: st.mean,
    sigma: st.sigma,
    naiveHalfWidth: st.sigma > 0 ? (1.96 * st.sigma) / Math.sqrt(n) : 0,
    seqHalfWidth: robbinsHalfWidth(st.sigma, n, alpha),
    stoppedBy,
    kappa: st.kappa,
    cvBeta: st.beta,
  };
}

export function makeClassicProcessSampler(math: MathConfig, seedLabel: string) {
  let nonce = 0;
  const serverSeed = `mc-${seedLabel}`;
  const spinOnce = () => {
    nonce += 1;
    const { symbols, hash } = calculateSpin(serverSeed, "mc", nonce, math.strips);
    const res = evaluatePaylines(symbols.map((c) => [...c]), 1, math);
    let units = res.totalPayout;
    if (res.totalPayout === 0 && checkThunderStrike(hash, math.thunderDenominator)) {
      const g = symbols.map((c) => [...c]);
      const numTransforms = (parseInt(hash.substring(30, 32), 16) % 3) + 1;
      for (let i = 0; i < numTransforms; i++) {
        const r = parseInt(hash.substring(32 + i * 4, 34 + i * 4), 16) % 5;
        const row = parseInt(hash.substring(34 + i * 4, 36 + i * 4), 16) % 3;
        g[r][row] = SYMBOLS.ZEUS;
      }
      const re = evaluatePaylines(g, 1, math);
      units = Math.max(re.totalPayout, math.thunderFloorX * 20);
    }
    return { payoutBetUnits: units / 20, baseBetUnits: res.totalPayout / 20, awarded: res.freeSpinsAwarded };
  };
  return function next(): MCSample {
    let total = 0;
    let base = 0;
    let remaining = 0;
    let isFirst = true;
    do {
      if (!isFirst) remaining -= 1;
      const r = spinOnce();
      total += r.payoutBetUnits;
      if (isFirst) base = r.baseBetUnits;
      remaining += r.awarded;
      isFirst = false;
    } while (remaining > 0);
    return { x: total, c: base };
  };
}

/** The certified full-process target (excl. jackpot) from the Lab. */
export function classicProcessTarget(math: MathConfig): { target: number; cert: ReturnType<typeof certifyMath> } {
  const bundle: MathBundle = {
    paytable: Object.fromEntries(
      Object.entries(math.payouts).map(([id, p]) => [
        String(id),
        { "3": p[3], "4": p[4], "5": p[5] },
      ]),
    ),
    reels: math.strips,
    freeSpins: math.freeSpins,
    thunder: { chanceDenominator: math.thunderDenominator, floorX: math.thunderFloorX },
  };
  const cert = certifyMath(bundle);
  const target = (cert.basePct + cert.thunderPct) / 100 / (1 - cert.fsPerSpin);
  return { target, cert };
}

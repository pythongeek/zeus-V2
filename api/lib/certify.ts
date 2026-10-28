import {
  calculateSpin,
  evaluatePaylines,
  checkThunderStrike,
  SYMBOLS,
} from "../routers/game";

/**
 * Section E (RTP Lab) — math certification.
 *
 * Base game and free spins are certified EXACTLY by combinatorics:
 *  - Paylines: a line's result depends only on its 5 symbols, and
 *    each reel's symbol distribution over stops is the strip's
 *    symbol counts — so the expected line payout is a finite sum
 *    over 11^5 symbol sequences, weighted by strip counts. EV is
 *    linear, so summing the 20 identical-distribution lines is
 *    exact (each line pays out x betPerLine; 20 lines x 1/20 bet
 *    makes the lines EV equal the single-line expected payout).
 *  - Scatters / free spins: per-reel window scatter counts (3
 *    consecutive stops) convolve exactly across the 5 reels.
 * The evaluator's wild semantics are replicated faithfully in
 * linePayout(), including its quirk of committing to the first
 * non-wild symbol (W W W A pays as 4 Aces, not 3 Zeus).
 *
 * Thunder Strike depends on hash slices and grid transforms, so
 * it is Monte-Carlo'd through the REAL engine functions with fixed
 * certification seeds (same approach as the A4 regression test).
 *
 * Total RTP follows the A4 model: free spins replay at the same
 * bet, forming a geometric chain, and the pool-funded jackpot EV
 * is the A6 modelled constant at the reference bet:
 *   total = (B + T + J) / (1 - f)
 * J assumes the default jackpot seeds/shares; if those change
 * materially the constant must be re-derived (Section F).
 */
export const JACKPOT_EV = 0.0108;

export interface MathBundle {
  paytable: Record<string, { "3": number; "4": number; "5": number }>;
  reels: number[][];
  freeSpins: Record<string, number>;
  thunder: { chanceDenominator: number; floorX: number };
}

type Payouts = Record<number, { 3: number; 4: number; 5: number }>;

export function bundlePayouts(bundle: MathBundle): Payouts {
  const out: Payouts = {};
  for (let id = 0; id <= 10; id++) {
    const e = bundle.paytable[String(id)];
    out[id] = { 3: e["3"], 4: e["4"], 5: e["5"] };
  }
  return out;
}

/** One payline's payout (in betPerLine units) for a 5-symbol sequence. */
export function linePayout(seq: number[], payouts: Payouts): number {
  let matchSymbol = seq[0] === SYMBOLS.ZEUS ? -1 : seq[0];
  let matchCount = 1;
  for (let reel = 1; reel < 5; reel++) {
    const sym = seq[reel];
    if (sym === SYMBOLS.ZEUS || sym === matchSymbol || matchSymbol === -1) {
      if (matchSymbol === -1 && sym !== SYMBOLS.ZEUS) matchSymbol = sym;
      matchCount++;
    } else break;
  }
  if (matchSymbol === -1) matchSymbol = SYMBOLS.ZEUS;
  if (matchCount >= 3 && payouts[matchSymbol]) {
    return payouts[matchSymbol][matchCount as 3 | 4 | 5] || 0;
  }
  return 0;
}

export interface ExactResult {
  linesEv: number; // in total-bet units
  scatterEv: number; // in total-bet units
  baseEv: number; // lines + scatter
  fsPerSpin: number; // expected free spins awarded per paid spin
  fsTriggerProb: number;
}

export function exactBase(bundle: MathBundle): ExactResult {
  const payouts = bundlePayouts(bundle);
  const strips = bundle.reels;

  // Per-reel symbol counts.
  const counts: number[][] = strips.map((strip) => {
    const c = new Array(11).fill(0);
    for (const s of strip) c[s]++;
    return c;
  });

  // Expected single-line payout via weighted sequence enumeration.
  let lineExpectation = 0;
  const seq = new Array(5).fill(0);
  const walk = (reel: number, prob: number) => {
    if (reel === 5) {
      if (prob > 0) lineExpectation += prob * linePayout(seq, payouts);
      return;
    }
    const len = strips[reel].length;
    for (let sym = 0; sym <= 10; sym++) {
      const cnt = counts[reel][sym];
      if (cnt === 0) continue;
      seq[reel] = sym;
      walk(reel + 1, prob * (cnt / len));
    }
  };
  walk(0, 1);
  const linesEv = lineExpectation; // 20 lines x betPerLine(=bet/20)

  // Scatter distribution: per-reel window counts convolved.
  let dist: number[] = [1];
  for (let reel = 0; reel < 5; reel++) {
    const strip = strips[reel];
    const len = strip.length;
    const reelDist = new Array(4).fill(0);
    for (let stop = 0; stop < len; stop++) {
      let c = 0;
      for (let row = 0; row < 3; row++) {
        if (strip[(stop + row) % len] === SYMBOLS.SCATTER) c++;
      }
      reelDist[c]++;
    }
    const next = new Array(dist.length + 3).fill(0);
    for (let a = 0; a < dist.length; a++) {
      if (dist[a] === 0) continue;
      for (let b = 0; b <= 3; b++) {
        if (reelDist[b] === 0) continue;
        next[a + b] += dist[a] * (reelDist[b] / len);
      }
    }
    dist = next;
  }
  let scatterEv = 0;
  let fsPerSpin = 0;
  let fsTriggerProb = 0;
  for (let c = 3; c < dist.length; c++) {
    const p = dist[c];
    if (!p) continue;
    const key = Math.min(c, 5) as 3 | 4 | 5;
    scatterEv += p * (payouts[SYMBOLS.SCATTER][key] || 0);
    fsPerSpin += p * (bundle.freeSpins[String(key)] ?? 0);
    fsTriggerProb += p;
  }

  return { linesEv, scatterEv, baseEv: linesEv + scatterEv, fsPerSpin, fsTriggerProb };
}

export interface CertifyResult {
  linesPct: number;
  scatterPct: number;
  basePct: number;
  thunderPct: number;
  jackpotPct: number;
  fsPerSpin: number;
  fsTriggerPct: number;
  hitRatePct: number;
  maxWinObservedX: number;
  totalPct: number;
  mcSpins: number;
}

export function certifyMath(bundle: MathBundle, mcSpins = 150_000): CertifyResult {
  const exact = exactBase(bundle);
  const payouts = bundlePayouts(bundle);
  const mathLike = {
    payouts,
    freeSpins: bundle.freeSpins,
  };
  const denom = bundle.thunder.chanceDenominator;
  const floorUnits = bundle.thunder.floorX * 20; // betPerLine units

  let thunderSum = 0;
  let hits = 0;
  let maxWinUnits = 0;
  for (let nonce = 1; nonce <= mcSpins; nonce++) {
    const { symbols, hash } = calculateSpin("lab-cert-seed", "lab", nonce, bundle.reels);
    const res = evaluatePaylines(symbols.map((c) => [...c]), 1, mathLike);
    let winUnits = res.totalPayout;
    if (res.totalPayout === 0 && checkThunderStrike(hash, denom)) {
      const g = symbols.map((c) => [...c]);
      const numTransforms = (parseInt(hash.substring(30, 32), 16) % 3) + 1;
      for (let i = 0; i < numTransforms; i++) {
        const r = parseInt(hash.substring(32 + i * 4, 34 + i * 4), 16) % 5;
        const row = parseInt(hash.substring(34 + i * 4, 36 + i * 4), 16) % 3;
        g[r][row] = SYMBOLS.ZEUS;
      }
      const re = evaluatePaylines(g, 1, mathLike);
      winUnits = Math.max(re.totalPayout, floorUnits);
      thunderSum += winUnits;
    }
    if (winUnits > 0) hits++;
    if (winUnits > maxWinUnits) maxWinUnits = winUnits;
  }
  const thunderEv = thunderSum / mcSpins / 20;
  const total = (exact.baseEv + thunderEv + JACKPOT_EV) / (1 - exact.fsPerSpin);
  const pct = (x: number) => Math.round(x * 10000) / 100;
  return {
    linesPct: pct(exact.linesEv),
    scatterPct: pct(exact.scatterEv),
    basePct: pct(exact.baseEv),
    thunderPct: pct(thunderEv),
    jackpotPct: pct(JACKPOT_EV),
    fsPerSpin: Math.round(exact.fsPerSpin * 10000) / 10000,
    fsTriggerPct: pct(exact.fsTriggerProb),
    hitRatePct: pct(hits / mcSpins),
    maxWinObservedX: Math.round((maxWinUnits / 20) * 100) / 100,
    totalPct: pct(total),
    mcSpins,
  };
}

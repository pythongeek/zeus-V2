import fs from "fs";
import { CASCADE_DEFAULT_MATH, type CascadeMath } from "../api/lib/cascade";
import { makeCascadeProcessSampler, step0Expectation } from "../api/lib/cascade-mc";
import { runSequentialMC, mulberry32, seedFromString } from "../api/lib/mc";

/**
 * Cascade tuning rig (playbook §7.3): randomized coordinate
 * descent on log-weights + ladder attach, screens at N processes
 * with common random numbers per generation (paired comparisons),
 * checkpointing the incumbent to disk after every generation.
 *
 * Usage: npx tsx scripts/cascade-tune.ts <start.json|default> <generations> <movesPerGen> <screenN> <out.json>
 */

interface Metrics {
  rtp: number;
  sigma: number;
  hit: number;
  pGe3: number;
  pGe5: number;
  pGe8: number;
  score: number;
}

function evaluate(math: CascadeMath, n: number, seedLabel: string): Metrics {
  const sampler = makeCascadeProcessSampler(math, seedLabel);
  const res = runSequentialMC(sampler.next, {
    tolerance: 0,
    maxSpins: n,
    batchSize: n,
    expectedC: step0Expectation(math),
  });
  const s = sampler.summary();
  const chainP = (k: number) =>
    Object.entries(s.chainHist).reduce((a, [len, c]) => (Number(len) >= k ? a + c : a), 0) / s.processes;
  const rtp = res.mean * 100;
  const hit = s.hitRate * 100;
  const pGe3 = chainP(3) * 100;
  const pGe5 = chainP(5) * 100;
  const pGe8 = chainP(8) * 100;
  const viol = (x: number, lo: number, hi: number) => (x < lo ? lo - x : x > hi ? x - hi : 0);
  // Bands as RATIFIED at the Phase 2 kick-off (see the acceptance
  // report): the playbook Table 7 chain/sigma bands are not jointly
  // reachable under the frozen rules — with iid weighted refills,
  // continuation is bounded by roughly the step-0 cluster rate, so
  // P(>=3) ~ hit x cont^2 <= ~1-3% at a 21% hit rate; and sigma is
  // ratified to the playbook's own "2-4x classic" ratio (classic
  // measured 4.71x) instead of the 15-25x planning figure.
  const score =
    Math.abs(rtp - 96.5) * 3 +
    viol(hit, 18, 25) * 2 +
    viol(pGe3, 1.0, 3.0) * 4 +
    viol(pGe5, 0.1, 0.5) * 3 +
    viol(s.rawSigma, 8, 16) * 1.5 +
    Math.max(0, pGe8 - 0.05) * 50;
  return { rtp, sigma: s.rawSigma, hit, pGe3, pGe5, pGe8, score };
}

function clone(math: CascadeMath): CascadeMath {
  return JSON.parse(JSON.stringify(math)) as CascadeMath;
}

function randomMove(math: CascadeMath, rng: () => number): { math: CascadeMath; desc: string } {
  const m = clone(math);
  const kind = rng();
  const syms = [...m.symbols, m.scatterId];
  if (kind < 0.22) {
    // Sharpen / flatten every strip (the criticality axis).
    const gamma = 0.85 + rng() * 0.4;
    for (const strip of m.weights) {
      for (const k of Object.keys(strip)) strip[k] = Math.max(0.05, Math.pow(strip[k], gamma));
    }
    return { math: m, desc: `sharpen gamma=${gamma.toFixed(2)}` };
  }
  if (kind < 0.42) {
    // One symbol, all columns.
    const sym = syms[Math.floor(rng() * syms.length)];
    const f = Math.exp((rng() - 0.5) * 0.9);
    for (const strip of m.weights) strip[String(sym)] = Math.max(0.05, (strip[String(sym)] ?? 1) * f);
    return { math: m, desc: `symbol ${sym} x${f.toFixed(2)}` };
  }
  if (kind < 0.58) {
    // One symbol in one column.
    const sym = syms[Math.floor(rng() * syms.length)];
    const col = Math.floor(rng() * 6);
    const f = Math.exp((rng() - 0.5) * 1.1);
    const strip = m.weights[col];
    strip[String(sym)] = Math.max(0.05, (strip[String(sym)] ?? 1) * f);
    return { math: m, desc: `col ${col} symbol ${sym} x${f.toFixed(2)}` };
  }
  if (kind < 0.72) {
    // Attach: all rungs together.
    const d = (rng() - 0.5) * 0.3;
    m.attach = m.attach.map((a) => Math.min(1, Math.max(0.05, a + d)));
    return { math: m, desc: `attach ${d >= 0 ? "+" : ""}${d.toFixed(2)}` };
  }
  if (kind < 0.9) {
    // Premium column: concentrate a premium symbol (1 or 2) into
    // one column and thin it elsewhere — builds the deep tail
    // (15+ clusters at high rungs) that sigma needs.
    const sym = rng() < 0.5 ? 1 : 2;
    const col = Math.floor(rng() * 6);
    const up = 1.8 + rng() * 1.6;
    for (let c = 0; c < 6; c++) {
      const strip = m.weights[c];
      const cur = strip[String(sym)] ?? 1;
      strip[String(sym)] = Math.max(0.05, c === col ? cur * up : cur * 0.85);
    }
    return { math: m, desc: `premium col ${col} sym ${sym} x${up.toFixed(2)}` };
  }
  // Scatter threshold pressure: scatter weight.
  const f = Math.exp((rng() - 0.5) * 0.9);
  for (const strip of m.weights) strip[String(m.scatterId)] = Math.max(0.05, (strip[String(m.scatterId)] ?? 1) * f);
  return { math: m, desc: `scatter x${f.toFixed(2)}` };
}

const [startArg, gensArg, movesArg, nArg, outArg] = process.argv.slice(2);
const generations = Number(gensArg ?? 30);
const movesPerGen = Number(movesArg ?? 20);
const screenN = Number(nArg ?? 100000);
const outFile = outArg ?? "/tmp/tune-best.json";
let incumbent: CascadeMath =
  startArg && startArg !== "default"
    ? (JSON.parse(fs.readFileSync(startArg, "utf8")) as CascadeMath)
    : clone(CASCADE_DEFAULT_MATH);
const rng = mulberry32(seedFromString(`tune-${Date.now()}`));

let best = evaluate(incumbent, screenN, "tune-g0");
console.log(`gen 0 incumbent score=${best.score.toFixed(3)} rtp=${best.rtp.toFixed(2)} sigma=${best.sigma.toFixed(1)} hit=${best.hit.toFixed(1)} p3=${best.pGe3.toFixed(2)} p5=${best.pGe5.toFixed(2)}`);
fs.writeFileSync(outFile, JSON.stringify({ math: incumbent, metrics: best }, null, 1));

for (let gen = 1; gen <= generations; gen++) {
  const seed = `tune-g${gen}`;
  // Re-score the incumbent on this generation's stream (paired).
  const incScore = evaluate(incumbent, screenN, seed);
  let genBest: { math: CascadeMath; metrics: Metrics; desc: string } | null = null;
  for (let mv = 0; mv < movesPerGen; mv++) {
    const { math, desc } = randomMove(incumbent, rng);
    const metrics = evaluate(math, screenN, seed);
    if (!genBest || metrics.score < genBest.metrics.score) genBest = { math, metrics, desc };
  }
  if (genBest && genBest.metrics.score < incScore.score) {
    incumbent = genBest.math;
    best = genBest.metrics;
    console.log(
      `gen ${gen} ACCEPT ${genBest.desc} score=${best.score.toFixed(3)} rtp=${best.rtp.toFixed(2)} sigma=${best.sigma.toFixed(1)} hit=${best.hit.toFixed(1)} p3=${best.pGe3.toFixed(2)} p5=${best.pGe5.toFixed(2)} p8=${best.pGe8.toFixed(3)}`,
    );
  } else {
    best = incScore;
    console.log(`gen ${gen} hold score=${incScore.score.toFixed(3)} rtp=${incScore.rtp.toFixed(2)} sigma=${incScore.sigma.toFixed(1)} hit=${incScore.hit.toFixed(1)} p3=${incScore.pGe3.toFixed(2)} p5=${incScore.pGe5.toFixed(2)}`);
  }
  fs.writeFileSync(outFile, JSON.stringify({ math: incumbent, metrics: best }, null, 1));
}
console.log("TUNE DONE", JSON.stringify(best));

import fs from "fs";
import { CASCADE_DEFAULT_MATH, type CascadeMath } from "../api/lib/cascade";
import { makeCascadeProcessSampler, step0Expectation } from "../api/lib/cascade-mc";
import { runSequentialMC } from "../api/lib/mc";

/** Probe a cascade math variant: `npx tsx scripts/cascade-probe.ts <math.json> [n]` */
const file = process.argv[2];
const N = Number(process.argv[3] ?? 250000);
const math: CascadeMath = file
  ? (JSON.parse(fs.readFileSync(file, "utf8")) as CascadeMath)
  : CASCADE_DEFAULT_MATH;
const sampler = makeCascadeProcessSampler(math, `probe-${file ?? "default"}`);
const res = runSequentialMC(sampler.next, {
  tolerance: 0,
  maxSpins: N,
  batchSize: N,
  expectedC: step0Expectation(math),
});
const s = sampler.summary();
const chainP = (k: number) =>
  Object.entries(s.chainHist).reduce((a, [len, c]) => (Number(len) >= k ? a + c : a), 0) / s.processes;
console.log(JSON.stringify({
  n: res.n,
  rtp: Math.round(res.mean * 10000) / 100,
  sigma: Math.round(s.rawSigma * 100) / 100,
  sigmaAdj: Math.round(res.sigma * 100) / 100,
  kappa: Math.round(res.kappa * 100) / 100,
  hit: Math.round(s.hitRate * 10000) / 100,
  pGe3: Math.round(chainP(3) * 10000) / 100,
  pGe5: Math.round(chainP(5) * 10000) / 100,
  pGe8: chainP(8),
  fsPer100: Math.round((s.totalFsSpins / s.processes) * 10000) / 100,
  maxWinX: s.maxWinX,
}));

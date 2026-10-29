import { CASCADE_DEFAULT_MATH } from "../api/lib/cascade";
import { makeCascadeProcessSampler, step0Expectation } from "../api/lib/cascade-mc";
import { runSequentialMC } from "../api/lib/mc";

const N = Number(process.argv[2] ?? 50000);
const sampler = makeCascadeProcessSampler(CASCADE_DEFAULT_MATH, "bench-default");
const t0 = Date.now();
const res = runSequentialMC(sampler.next, {
  tolerance: 0, // never early-stop: fixed-size bench
  maxSpins: N,
  batchSize: N,
  expectedC: step0Expectation(CASCADE_DEFAULT_MATH),
});
const secs = (Date.now() - t0) / 1000;
const stats = sampler.summary();
console.log(JSON.stringify({
  n: res.n,
  secs: Math.round(secs * 10) / 10,
  perSec: Math.round(res.n / secs),
  rtpRaw: res.mean,
  sigma: res.sigma,
  kappa: res.kappa,
  cvBeta: res.cvBeta,
  step0Exact: step0Expectation(CASCADE_DEFAULT_MATH),
  hitRate: stats.hitRate,
  chainHist: stats.chainHist,
  fsTriggers: stats.fsTriggers,
  fsPer100: (stats.totalFsSpins / stats.processes) * 100,
  maxWinX: stats.maxWinX,
  winsAtCap: stats.winsAtCap,
}, null, 1));

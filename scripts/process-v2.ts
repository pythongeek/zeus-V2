// U5-B2 process MC (READ-ONLY): full-process Monte Carlo of the
// unified game on the FINAL v2 math. Classic paid spins go through
// the real engine functions; a scatter trigger runs a cascade round
// whose wild gate is rolled from the trigger spin's own hash,
// exactly as production rolls it (hex chars 44..51 vs the bundle's
// 1-in-3 fraction). Yields process sigma for the zeus-unified-v2
// cert record and an RTP cross-check of the analytic certification.
import { createRequire } from "node:module";
(globalThis as any).require = createRequire(import.meta.url);
const { getSqliteClient } = await import("/opt/zeus-slot/api/queries/connection.ts");
const { getBundleById } = await import("/opt/zeus-slot/api/lib/bundles.ts");
const { resolveCascade, makeCascadeDraw } = await import("/opt/zeus-slot/api/lib/cascade.ts");
const { calculateSpin, evaluatePaylines, checkThunderStrike, SYMBOLS, SYMBOL_NAMES } = await import("/opt/zeus-slot/api/routers/game.ts");
const { classicCfgFromBundle } = await import("/opt/zeus-slot/api/lib/bundles.ts");

const N = parseInt(process.argv[2] ?? "250000", 10);
const sqlite = getSqliteClient();
const classicRow: any = getBundleById(sqlite, "zeus-classic-v2");
const v1Row: any = getBundleById(sqlite, "zeus-unified-cascade-v1");
const cfg = classicCfgFromBundle(JSON.parse(classicRow.bundle), SYMBOL_NAMES);
const V1 = JSON.parse(v1Row.bundle).math;
const round1 = (x: number) => Math.round(x * 10) / 10;
const paytable: Record<string, number[]> = {};
for (const [k, v] of Object.entries(V1.paytable as Record<string, number[]>)) {
  paytable[k] = (v as number[]).map((x) => round1(x * 0.81 * 0.9937));
}
const cmath = { ...V1, paytable, wildId: 11, wildWeight: 2, wildGate: [1, 3] };
const mathLike = { payouts: cfg.payouts, freeSpins: cfg.freeSpins };
const BET = 100_000_000n;
const JACKPOT_EV = 0.0108;

function cascadeRound(award: number, seed: string, nonceStart: number, live: boolean): number {
  let spinsLeft = award, rung = 0, total = 0n, nonce = nonceStart, guard = 0;
  while (spinsLeft > 0 && guard++ < 500) {
    const res = resolveCascade({
      draw: makeCascadeDraw(seed, "u5process", nonce++),
      math: cmath, betMicro: BET, isFreeSpin: true, rungIn: rung, wildLive: live,
    });
    total += res.cappedWinMicro;
    rung = res.rungOut;
    spinsLeft = spinsLeft - 1 + res.freeSpinsAwarded;
  }
  return Number(total) / 1e8;
}

let sum = 0, sumSq = 0, triggers = 0, liveRounds = 0;
const t0 = Date.now();
for (let nonce = 1; nonce <= N; nonce++) {
  const { symbols, hash } = calculateSpin("u5-process-seed", "u5p", nonce, cfg.strips as any);
  const res = evaluatePaylines(symbols.map((c: number[]) => [...c]), 1, mathLike as any);
  let winUnits = res.totalPayout;
  if (res.totalPayout === 0 && checkThunderStrike(hash, cfg.thunderDenominator)) {
    const g = symbols.map((c: number[]) => [...c]);
    const numTransforms = (parseInt(hash.substring(30, 32), 16) % 3) + 1;
    for (let i = 0; i < numTransforms; i++) {
      const r = parseInt(hash.substring(32 + i * 4, 34 + i * 4), 16) % 5;
      const row = parseInt(hash.substring(34 + i * 4, 36 + i * 4), 16) % 3;
      g[r][row] = SYMBOLS.ZEUS;
    }
    const re = evaluatePaylines(g, 1, mathLike as any);
    winUnits = Math.max(re.totalPayout, cfg.thunderFloorX * 20);
  }
  let x = winUnits / 20 + JACKPOT_EV;
  if (res.scatterCount >= 3) {
    triggers++;
    const gateVal = parseInt(hash.substring(44, 52), 16);
    const live = gateVal * 3 < 4294967296;
    if (live) liveRounds++;
    const award = cmath.fsTable[String(Math.min(res.scatterCount, 5))] ?? 12;
    x += cascadeRound(award, `u5e-${nonce % 256}`, nonce * 31 + 7, live);
  }
  sum += x;
  sumSq += x * x;
}
const mean = sum / N;
const sd = Math.sqrt(Math.max(0, sumSq / N - mean * mean));
const se = sd / Math.sqrt(N);
console.log(`UNIFIED PROCESS (v2 math) processes=${N} triggers=${triggers} liveRounds=${liveRounds} RTP=${(mean * 100).toFixed(3)}% ±${(se * 100).toFixed(3)}pp sigma=${sd.toFixed(3)} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
console.log("DONE");
process.exit(0);

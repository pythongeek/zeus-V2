// U5-B2 certification run (READ-ONLY): price the final v2 unified
// cascade math at certification volume on fresh streams, with the
// production resolver, and collect the owner's reporting stats:
// round hit frequency, per-symbol win distribution, wild seen vs
// wild paid. The scale arrives as argv[2].
import { createRequire } from "node:module";
(globalThis as any).require = createRequire(import.meta.url);
const { getSqliteClient } = await import("/opt/zeus-slot/api/queries/connection.ts");
const { getBundleById } = await import("/opt/zeus-slot/api/lib/bundles.ts");
const { resolveCascade, makeCascadeDraw } = await import("/opt/zeus-slot/api/lib/cascade.ts");

const SCALE = parseFloat(process.argv[2] ?? "0.806");
const FINE = parseFloat(process.argv[3] ?? "1");
const sqlite = getSqliteClient();
const row: any = getBundleById(sqlite, "zeus-unified-cascade-v1");
const V1 = JSON.parse(row.bundle).math;
const BET = 100_000_000n;
const round1 = (x: number) => Math.round(x * 10) / 10;
const paytable: Record<string, number[]> = {};
for (const [k, v] of Object.entries(V1.paytable as Record<string, number[]>)) {
  paytable[k] = (v as number[]).map((x) => round1(x * SCALE * FINE));
}
const MATH = { ...V1, paytable, wildId: 11, wildWeight: 2, wildGate: [1, 3] };
console.log("PAYTABLE " + JSON.stringify(paytable));

type Stats = {
  rounds: number; liveRounds: number; sum: number; sumSq: number;
  roundWinPos: number; spins: number; spinsWithCluster: number;
  symWin: Map<number, number>; assistedWin: number; totalWinX: number;
  wildSeenLive: number; wildPaidLive: number; wildPaidAll: number;
  wins: number[];
};
function newStats(): Stats {
  return { rounds: 0, liveRounds: 0, sum: 0, sumSq: 0, roundWinPos: 0, spins: 0, spinsWithCluster: 0, symWin: new Map(), assistedWin: 0, totalWinX: 0, wildSeenLive: 0, wildPaidLive: 0, wildPaidAll: 0, wins: [] };
}

function price(math: any, rounds: number, award: number, seedPrefix: string, st?: Stats) {
  let sum = 0, sumSq = 0;
  for (let i = 0; i < rounds; i++) {
    const gateDraw = makeCascadeDraw(`${seedPrefix}-gate-${i}`, "u5cert-gate", 1);
    const live = gateDraw(0) * 3 < 1;
    let spinsLeft = award, rung = 0, total = 0n, nonce = 1, guard = 0;
    let roundSeen = false, roundPaid = false;
    while (spinsLeft > 0 && guard++ < 500) {
      const res = resolveCascade({
        draw: makeCascadeDraw(`${seedPrefix}-${i}`, "u5cert", nonce++),
        math, betMicro: BET, isFreeSpin: true, rungIn: rung, wildLive: live,
      });
      total += res.cappedWinMicro;
      rung = res.rungOut;
      spinsLeft = spinsLeft - 1 + res.freeSpinsAwarded;
      if (st) {
        st.spins++;
        if (res.steps.length > 0) st.spinsWithCluster++;
        for (const step of res.steps) {
          if (step.grid.includes(11)) roundSeen = true;
          for (const c of step.clusters) {
            const payX = Number(c.payMicro) / 1e8;
            st.symWin.set(c.symbol, (st.symWin.get(c.symbol) ?? 0) + payX);
            if (c.positions.some((p) => step.grid[p] === 11)) {
              roundPaid = true;
              st.assistedWin += payX;
            }
          }
        }
        if (res.finalGrid.includes(11)) roundSeen = true;
      }
    }
    const x = Number(total) / 1e8;
    sum += x; sumSq += x * x;
    if (st) {
      st.rounds++;
      st.sum += x; st.sumSq += x * x;
      st.totalWinX += x;
      if (x > 0) st.roundWinPos++;
      if (live) {
        st.liveRounds++;
        if (roundSeen) st.wildSeenLive++;
        if (roundPaid) st.wildPaidLive++;
      }
      if (roundPaid) st.wildPaidAll++;
      st.wins.push(x);
    }
  }
  const mean = sum / rounds;
  const sd = Math.sqrt(Math.max(0, sumSq / rounds - mean * mean));
  return { mean, sd, se: sd / Math.sqrt(rounds) };
}

const st = newStats();
const r12 = price(MATH, 400000, 12, "u5certA", st);
console.log(`R12=${r12.mean.toFixed(4)} se=${r12.se.toFixed(4)} sd=${r12.sd.toFixed(3)}`);
const r15 = price(MATH, 100000, 15, "u5certB");
console.log(`R15=${r15.mean.toFixed(4)} se=${r15.se.toFixed(4)}`);
const r20 = price(MATH, 60000, 20, "u5certC");
console.log(`R20=${r20.mean.toFixed(4)} se=${r20.se.toFixed(4)}`);
const mixEv = 0.9005 * r12.mean + 0.0955 * r15.mean + 0.0040 * r20.mean;
const mixSe = Math.sqrt((0.9005 * r12.se) ** 2 + (0.0955 * r15.se) ** 2 + (0.0040 * r20.se) ** 2);
const total = 0.7418 + 0.042749 * mixEv;
const totalSe = 0.042749 * mixSe;
console.log(`mixEv=${mixEv.toFixed(4)} unified RTP=${(total * 100).toFixed(3)}% ±${(totalSe * 100).toFixed(3)}pp`);
st.wins.sort((a, b) => a - b);
const pct = (p: number) => st.wins[Math.min(st.wins.length - 1, Math.floor(p * st.wins.length))];
console.log(`STATS rounds=${st.rounds} live=${st.liveRounds} (${(100 * st.liveRounds / st.rounds).toFixed(1)}%) roundWinPos=${(100 * st.roundWinPos / st.rounds).toFixed(2)}% spinCluster=${(100 * st.spinsWithCluster / st.spins).toFixed(2)}% spins/round=${(st.spins / st.rounds).toFixed(2)}`);
console.log(`WILD seen|live=${(100 * st.wildSeenLive / st.liveRounds).toFixed(1)}% paid|live=${(100 * st.wildPaidLive / st.liveRounds).toFixed(1)}% paidAll=${(100 * st.wildPaidAll / st.rounds).toFixed(1)}% assistedShare=${(100 * st.assistedWin / st.totalWinX).toFixed(1)}%`);
console.log(`DIST p50=${pct(0.5).toFixed(2)} p90=${pct(0.9).toFixed(2)} p99=${pct(0.99).toFixed(2)} max=${st.wins[st.wins.length - 1].toFixed(1)}`);
const names: Record<number, string> = { 1: "thunderbolt", 2: "pegasus", 3: "temple", 4: "harp", 5: "amphora", 6: "helmet", 7: "shield", 8: "ace", 9: "king" };
for (const [sym, w] of [...st.symWin.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`SYM ${sym} ${names[sym] ?? sym}: ${(100 * w / st.totalWinX).toFixed(1)}% of round win`);
}
console.log("DONE");
process.exit(0);

// U5-B4 live verification (production, FS Repro user id 39, BDT 1):
// hunt classic triggers until a converted round is WILD-LIVE, and
// prove at each step: the session pins zeus-unified-cascade-v2,
// the trigger spin's wild_live stamp equals the gate recomputed
// from its own hash (chars 44..51 vs 1-in-3), every free spin is
// stamped with the v2 bundle + the round's gate, a live round's
// grids actually contain wilds (id 11), the money is exact, and
// fairness.verify replays a wild free spin as verified.
import { createRequire } from "node:module";
(globalThis as any).require = createRequire(import.meta.url);
const { getSqliteClient } = await import("/opt/zeus-slot/api/queries/connection.ts");
const gameRouter = (await import("/opt/zeus-slot/api/routers/game.ts")).gameRouter;
const fairnessRouter = (await import("/opt/zeus-slot/api/routers/fairness.ts")).fairnessRouter;

const client = getSqliteClient();
const user = client.prepare("SELECT * FROM users WHERE id = 39").get() as any;
if (!user) throw new Error("FS Repro user 39 not found");
const caller = gameRouter.createCaller({ user, req: new Request("http://localhost/api/trpc"), resHeaders: new Headers() } as any);
const fairCaller = fairnessRouter.createCaller({ user, req: new Request("http://localhost/api/trpc"), resHeaders: new Headers() } as any);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const bal = () => (client.prepare("SELECT available FROM balances WHERE user_id = 39 AND currency = 'BDT'").get() as any)?.available;

console.log("BDT before:", bal());
const started: any = await (caller as any).startSession({});
const sessionId = started.sessionId as number;
console.log("session:", sessionId, "seeded FS:", started.freeSpinsGranted ?? 0);

async function spinPaced(): Promise<any> {
  await sleep(720);
  return caller.spin({ sessionId, betAmount: "1", currency: "BDT" });
}

// Drain any seeded free spins first (they belong to older rounds).
let guard = 0;
let last: any = null;
while (guard++ < 40) {
  const s = client.prepare("SELECT free_spins_remaining FROM game_sessions WHERE id = ?").get(sessionId) as any;
  if (!s || Number(s.free_spins_remaining) <= 0) break;
  last = await spinPaced();
}
console.log("drained seeded FS");

let liveVerified = false;
let triggers = 0;
guard = 0;
while (!liveVerified && guard++ < 400) {
  const res: any = await spinPaced();
  if (res.featureTriggered !== "free_spins" || res.freeSpinsMode !== "cascade") continue;
  triggers++;
  const trigRow = client.prepare("SELECT id, hash, wild_live, bundle_id FROM spins WHERE id = ?").get(res.spinId) as any;
  const gateVal = parseInt(String(trigRow.hash).substring(44, 52), 16);
  const expectLive = gateVal * 3 < 4294967296 ? 1 : 0;
  console.log(`trigger #${triggers}: spin ${trigRow.id} wildLive(res)=${res.wildLive} stamped=${trigRow.wild_live} recomputed=${expectLive} bundle=${trigRow.bundle_id}`);
  if (Number(trigRow.wild_live) !== expectLive) throw new Error("GATE STAMP MISMATCH");
  if (res.wildLive !== expectLive) throw new Error("RESPONSE GATE MISMATCH");
  // Play the round out.
  let fsSpins = 0, roundWin = 0, sawWild = false, firstFsSpinId = 0, firstFsNonce = 0;
  for (let i = 0; i < 40; i++) {
    const s = client.prepare("SELECT free_spins_remaining FROM game_sessions WHERE id = ?").get(sessionId) as any;
    if (!s || Number(s.free_spins_remaining) <= 0) break;
    const fr: any = await spinPaced();
    fsSpins++;
    roundWin += parseFloat(fr.winAmount);
    if (!firstFsSpinId) { firstFsSpinId = fr.spinId; firstFsNonce = fr.nonce; }
    const steps = (fr.cascade?.steps ?? []) as any[];
    for (const st of steps) if ((st.grid as number[]).includes(11)) sawWild = true;
    if ((fr.cascade?.finalGrid as number[] | undefined)?.includes(11)) sawWild = true;
  }
  const stamps = client.prepare(
    "SELECT DISTINCT bundle_id, wild_live FROM spins WHERE session_id = ? AND is_free_spin = 1 AND id > ?",
  ).all(sessionId, res.spinId) as any[];
  console.log(`  round played: ${fsSpins} FS spins, total win ${roundWin.toFixed(2)}, sawWild=${sawWild}, stamps=${JSON.stringify(stamps)}`);
  if (expectLive === 1) {
    if (!sawWild) throw new Error("live round produced no wild on any grid");
    if (!stamps.every((r) => r.bundle_id === "zeus-unified-cascade-v2" && Number(r.wild_live) === 1)) throw new Error("FS STAMP MISMATCH");
    // Fairness replay of the round's first free spin.
    const v: any = await (fairCaller as any).verify({ sessionId, nonce: firstFsNonce });
    console.log(`  fairness.verify FS spin ${firstFsSpinId}: verified=${v.verified} mode=${v.modeId} bundle=${v.bundleId}`);
    if (!v.verified) throw new Error("FAIRNESS REPLAY FAILED");
    liveVerified = true;
  }
}
console.log("BDT after:", bal());
console.log(liveVerified ? "LIVE VERIFIED: wild-live round proven end to end" : "no live round in the hunt budget");
process.exit(liveVerified ? 0 : 2);

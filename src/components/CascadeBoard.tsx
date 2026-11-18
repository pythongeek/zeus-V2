import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useLang } from "@/i18n";
import { audio } from "@/lib/audio";

/**
 * Step 6 — cascade board + step playback + multiplier ladder.
 *
 * 2026-11-01 FX overhaul (owner request: "reels not shuffling the way
 * they should", "more advanced eye-catchy effects like blast, shower
 * of coins"):
 *  - REAL gravity tumble: when a step's winners explode, surviving
 *    symbols fall into their new rows (per-cell distance computed by
 *    column gravity) while the refills slide down as a stack from
 *    above the board — no more instant grid swaps.
 *  - The final refill renders the server's finalGrid with the same
 *    fall animation (the board previously ended a round on the
 *    exploded grid and snapped).
 *  - Win cells: flash → BLAST (shard particles + shockwave ring) with
 *    a board shake; every wining step rains coins over the board and
 *    the win counter pops as it counts up.
 *  - Scatters: landing lightning flash + electric halo; 2-scatter
 *    tease shimmers; a free-spins award fires a full-board ray burst.
 *
 * Playback phases: dropin -> (highlight -> explode -> drop)* -> idle.
 * Turbo scales every phase to 40%. With prefers-reduced-motion the
 * board jumps straight to the final grid (summary toast from parent).
 */

export interface CascadeStepData {
  grid: number[];
  clusters: Array<{ symbol: number; count: number; positions: number[]; payMicro: string }>;
  multiplier: number;
  stepWinMicro: string;
}

const SYMBOL_NAMES: Record<number, string> = {
  0: "zeus", 1: "thunderbolt", 2: "pegasus", 3: "temple", 4: "harp",
  5: "amphora", 6: "helmet", 7: "shield", 8: "ace", 9: "king", 10: "queen",
  // U5-B: the Lightning Wild (only in gated unified bonus rounds).
  11: "wild",
};
const LADDER = [1, 2, 3, 5, 10];
const COLS = 6;
const ROWS = 5;

/**
 * Pre-spin placeholder grid: a neutral mix with NO scatter (id 0).
 * The old fallback filled the board with id 0 — thirty ZEUS scatters
 * on an unplayed board, which reads as a broken (or rigged) game.
 */
const PLACEHOLDER_GRID: number[] = [
  8, 3, 4, 9, 5, 7,
  2, 6, 1, 8, 4, 9,
  3, 5, 2, 7, 8, 6,
  1, 3, 9, 5, 7, 4,
  2, 8, 6, 3, 1, 9,
];

type Phase = "idle" | "dropin" | "highlight" | "explode" | "drop";

/**
 * Gravity math for one cascade transition — SERVER index convention.
 * The API stores grids COLUMN-MAJOR: idx = col * ROWS + row (see the
 * refill loop in api/lib/cascade.ts). Given the grid BEFORE the
 * explosion and the exploded positions, compute how far each cell of
 * the AFTER grid had to travel (in rows). Survivors keep column
 * order and fall newRow - oldRow; refills slide in as a stack from
 * above, so every refill falls `missing` rows. Returns null when the
 * server grid doesn't match client gravity (anomaly) — callers fall
 * back to a uniform one-row drop.
 */
function computeFallDistances(
  before: number[],
  exploded: Set<number>,
  after: number[],
): number[] | null {
  const fall = new Array<number>(before.length).fill(0);
  for (let col = 0; col < COLS; col++) {
    const survivors: Array<{ sym: number; oldRow: number }> = [];
    for (let row = 0; row < ROWS; row++) {
      const idx = col * ROWS + row;
      if (!exploded.has(idx)) survivors.push({ sym: before[idx], oldRow: row });
    }
    const missing = ROWS - survivors.length;
    // Survivors sink to the bottom of the column, in order.
    const base = ROWS - survivors.length;
    for (let k = 0; k < survivors.length; k++) {
      const newRow = base + k;
      const idx = col * ROWS + newRow;
      if (after[idx] !== survivors[k].sym) return null; // anomaly
      fall[idx] = newRow - survivors[k].oldRow;
    }
    // Refill stack enters from above the top edge.
    for (let row = 0; row < missing; row++) {
      fall[col * ROWS + row] = missing;
    }
  }
  return fall;
}

/** Server column-major idx -> screen row-major idx (the board renders
 * into a 6-col CSS grid, filled row by row). Keeping this mapping in
 * ONE place is what makes the displayed board identical to the
 * server's real grid: before 2026-11-01 the flat array was rendered
 * directly, which displayed a scrambled transpose of the true board,
 * lit winning clusters in the wrong-looking places and made every
 * tumble read wrong. */
function toScreenIdx(serverIdx: number): number {
  const col = Math.floor(serverIdx / ROWS);
  const row = serverIdx % ROWS;
  return row * COLS + col;
}

/** Reorder a server grid for row-by-row display. */
function toDisplayGrid(serverGrid: number[] | null): number[] | null {
  if (!serverGrid) return null;
  const out = new Array<number>(serverGrid.length);
  for (let i = 0; i < serverGrid.length; i++) out[toScreenIdx(i)] = serverGrid[i];
  return out;
}

/** Exploded positions of a step, in SERVER index space (the gravity
 * solver and the API both speak column-major). */
function explodedOf(step: CascadeStepData | null): Set<number> {
  return new Set(step?.clusters.flatMap((c) => c.positions) ?? []);
}

interface Particle {
  dx: string; dy: string; rot: string; size: number; delay: number; hue: string;
}

const BLAST_HUES = ["#FFD54F", "#F4D03F", "#FFB300", "#FFF3C4", "#996E20"];

export function CascadeBoard({
  steps,
  finalGrid,
  playKey,
  turbo,
  currencySymbol,
  onDone,
  scatters,
  fsAwarded,
  spinning,
}: {
  steps: CascadeStepData[] | null;
  finalGrid: number[] | null;
  playKey: number;
  turbo: boolean;
  currencySymbol: string;
  onDone: () => void;
  /** ZEUS scatters on the initial grid (server-resolved; FS trigger count). */
  scatters?: number | null;
  /** Free spins this spin awarded (0 when none). */
  fsAwarded?: number;
  /** True while a spin request is in flight: every cell streams
   * symbols downward like a slot reel until the result lands. */
  spinning?: boolean;
}) {
  const { num, t } = useLang();
  const [stepIdx, setStepIdx] = useState(0);
  const [phase, setPhase] = useState<Phase>("idle");
  // Static win highlight for the reduced-motion path (screen space).
  const [idleWinCells, setIdleWinCells] = useState<Set<number>>(new Set());
  const [shownWin, setShownWin] = useState(0);
  const doneRef = useRef(false);
  // onDone arrives as a fresh closure on every parent render;
  // keeping it in a ref stops parent re-renders from re-arming
  // the phase timers mid-playback (in the 2026-10-31 audit they
  // stretched a ~1.3s playback toward 5s).
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  const reduced = useMemo(
    () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
    [],
  );

  const activeGrid: number[] | null =
    phase === "idle"
      ? finalGrid
      : steps && steps.length > 0
        ? phase === "drop"
          ? // 2026-11-01: the drop renders the POST-explosion grid —
            // the refilled board. On the last step that is the
            // server's finalGrid (previously the board sat on the
            // exploded grid for a beat, then snapped).
            stepIdx + 1 < steps.length
            ? steps[stepIdx + 1].grid
            : (finalGrid ?? steps[stepIdx].grid)
          : steps[Math.min(stepIdx, steps.length - 1)].grid
        : finalGrid;

  // Multiplier rung FX: pop the ladder chip whenever the rung grows.
  const [rungFx, setRungFx] = useState(0);
  const prevMultRef = useRef(1);
  const rawMult =
    currentMultOf(steps, phase, stepIdx) ?? 1;
  useEffect(() => {
    if (rawMult > prevMultRef.current) setRungFx((n) => n + 1);
    prevMultRef.current = rawMult;
  }, [rawMult]);

  // Loss feedback: one soft dim pulse when a spin lands nothing.
  const [noWinFx, setNoWinFx] = useState(0);

  useEffect(() => {
    doneRef.current = false;
    setStepIdx(0);
    setShownWin(0);
    if (!steps) {
      setPhase("idle");
      return;
    }
    if (reduced) {
      // Reduced motion: no rolling, no tumble (that is the point of
      // the setting), but a winning spin must still SHOW which cells
      // paid. Hold the final grid with a static gold ring on the
      // winning cells briefly before handing control back, instead
      // of swapping instantly with no feedback at all (owner
      // report, 2026-11-18: the board read as frozen/static).
      setPhase("idle");
      const totalWin = steps.reduce((a, s) => a + parseFloat(s.stepWinMicro) / 1e8, 0);
      setShownWin(totalWin);
      const cells = new Set<number>();
      for (const s of steps) for (const c of s.clusters) for (const p of c.positions) cells.add(toScreenIdx(p));
      setIdleWinCells(cells);
      const id = setTimeout(() => {
        if (!doneRef.current) {
          doneRef.current = true;
          onDoneRef.current();
        }
      }, totalWin > 0 ? 1100 : 60);
      return () => clearTimeout(id);
    }
    setIdleWinCells(new Set());
    // Every spin's first grid DROPS IN — including losing spins
    // (steps is empty for a loss). The fast path above is ONLY for
    // reduced motion: an earlier version also fast-pathed empty
    // steps, so the ~82% of cascade spins that lose swapped the
    // board instantly with no motion at all (owner report,
    // 2026-10-31). The phase machine below ends a step-less
    // playback right after the drop-in.
    setPhase("dropin");
    audio.play("symbol-land", 0.9);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playKey, steps]);

  useEffect(() => {
    if (!steps || phase === "idle") return;
    const scale = turbo ? 0.4 : 1;
    let ms = 300;
    if (phase === "dropin") ms = 480;
    if (phase === "highlight") ms = 400;
    // Blast + shards + ring need a beat more than the old 250ms swap.
    if (phase === "explode") ms = 460;
    if (phase === "drop") ms = 420;
    const id = setTimeout(() => {
      if (phase === "dropin") {
        if (steps.length === 0) {
          // Losing spin: soft dim pulse, then the drop-in IS the whole
          // playback. The veil unmounts itself after the pulse — a
          // persistent overlay div would sit in the grid as a phantom
          // 31st child and break the board layout (found live
          // 2026-11-01).
          setNoWinFx((n) => n + 1);
          setTimeout(() => setNoWinFx(0), 750);
          setPhase("idle");
          if (!doneRef.current) {
            doneRef.current = true;
            onDoneRef.current();
          }
        } else {
          setPhase("highlight");
        }
      } else if (phase === "highlight") {
        const step = steps[stepIdx];
        if (step) {
          const stepWin = parseFloat(step.stepWinMicro) / 1e8;
          setShownWin((w) => w + stepWin);
          audio.play("win-small", Math.min(0.6 + step.multiplier * 0.12, 1.4));
          // Coin shower over the board for every paying step (the
          // bigger the win, the heavier the rain).
          if (stepWin > 0) audio.play("coin-cascade", 0.7);
        }
        setPhase("explode");
      } else if (phase === "explode") {
        audio.play("symbol-land", 0.45);
        setPhase("drop");
      } else if (phase === "drop") {
        if (stepIdx + 1 < steps.length) {
          setStepIdx(stepIdx + 1);
          setPhase("highlight");
        } else {
          // Round over: one last big coin burst for a winning round.
          const total = steps.reduce((a, s) => a + parseFloat(s.stepWinMicro) / 1e8, 0);
          if (total > 0) audio.play("coin-cascade", 1);
          setPhase("idle");
          if (!doneRef.current) {
            doneRef.current = true;
            onDoneRef.current();
          }
        }
      }
    }, ms * scale);
    return () => clearTimeout(id);
  }, [phase, stepIdx, steps, turbo]);

  // True rolling (2026-10-31): while a spin is in flight each
  // cell streams symbols downward like a slot reel. Strips are
  // decorative only — two symbols repeated, because the -50%
  // loop needs identical halves to wrap seamlessly.
  const [rollSeed, setRollSeed] = useState(0);
  useEffect(() => {
    if (spinning) setRollSeed((n) => n + 1);
  }, [spinning]);
  const rollStrips = useMemo(() => {
    if (rollSeed === 0) return null;
    const pick = () => (Math.random() < 0.03 ? 0 : 1 + Math.floor(Math.random() * 10));
    return Array.from({ length: 30 }, () => {
      const a = pick();
      let b = pick();
      if (b === a) b = (a + 3) % 11;
      return [a, b, a, b];
    });
  }, [rollSeed]);
  const rolling = !!spinning && phase === "idle" && !reduced && !!rollStrips;

  const currentStep = steps && phase !== "idle" ? steps[Math.min(stepIdx, steps.length - 1)] : null;
  // Cluster positions arrive in server column-major space; map them to
  // screen cells so the blast/ring treatment lands on the visible
  // winners (same mapping the board itself is displayed through).
  const winPositions = new Set(
    currentStep?.clusters.flatMap((c) => c.positions).map(toScreenIdx) ?? [],
  );
  const mult = currentStep?.multiplier ?? (steps && steps.length > 0 ? steps[steps.length - 1].multiplier : 1);

  // --- Gravity tumble data (drop phase) --------------------------------
  // prevGrid = the grid that just exploded; nextGrid = what renders
  // now. Distances are computed in SERVER column space, then mapped
  // to screen cells so each visible tile falls exactly the distance
  // its symbol travels.
  const fallFrom: string[] | null = useMemo(() => {
    if (phase !== "drop" || !steps || steps.length === 0) return null;
    const before = steps[Math.min(stepIdx, steps.length - 1)].grid;
    const next =
      stepIdx + 1 < steps.length ? steps[stepIdx + 1].grid : (finalGrid ?? before);
    if (!next) return null;
    const dist = computeFallDistances(before, explodedOf(currentStep), next);
    const out = new Array<string>(next.length);
    if (!dist) {
      // Anomaly fallback: uniform drop for every cell.
      for (let i = 0; i < next.length; i++) out[toScreenIdx(i)] = "-110%";
      return out;
    }
    for (let i = 0; i < dist.length; i++) out[toScreenIdx(i)] = `-${dist[i] * 100}%`;
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, stepIdx, steps, finalGrid]);

  // --- Blast particles (explode phase) ---------------------------------
  const blastCells = useMemo(() => {
    if (phase !== "explode" || winPositions.size === 0) return [];
    return [...winPositions].slice(0, 18).map((idx) => ({
      idx,
      particles: Array.from({ length: 8 }, (_, k) => {
        const ang = (k / 8) * Math.PI * 2 + (idx % 7) * 0.4;
        const dist = 26 + ((idx * 13 + k * 29) % 22); // 26-47 px, deterministic
        return {
          dx: `${Math.round(Math.cos(ang) * dist)}px`,
          dy: `${Math.round(Math.sin(ang) * dist - 8)}px`,
          rot: `${((idx + k) % 2 ? 1 : -1) * (160 + ((idx * k) % 140))}deg`,
          size: 5 + ((idx + k * 3) % 5),
          delay: (k % 4) * 24,
          hue: BLAST_HUES[(idx + k) % BLAST_HUES.length],
        } as Particle;
      }),
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, stepIdx, steps]);

  // --- Coin shower ------------------------------------------------------
  // Coins render through explode AND drop (460 + 420 ms ≈ 0.9 s) so a
  // full shower completes before the phase moves on and unmounts it.
  const coinBurst = useMemo(() => {
    if (phase !== "explode" && phase !== "drop") return null;
    const step = steps?.[Math.min(stepIdx, (steps?.length ?? 1) - 1)];
    const stepWin = step ? parseFloat(step.stepWinMicro) / 1e8 : 0;
    if (stepWin <= 0) return null;
    const count = Math.min(10 + Math.round(stepWin * 2), 26);
    return Array.from({ length: count }, (_, k) => ({
      left: 3 + ((k * 37 + stepIdx * 11) % 94), // %
      delay: (k % 7) * 70 + (k % 3) * 30, // ms
      dur: 560 + ((k * 53) % 260), // ms — fits the explode+drop window
      size: 12 + ((k * 7) % 10), // px
      dx: `${((k % 5) - 2) * 14}px`,
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, stepIdx, steps]);

  // Free-spins award: full-board ray burst + banner.
  const [fsBurstOn, setFsBurstOn] = useState(false);
  useEffect(() => {
    if ((fsAwarded ?? 0) > 0 && !reduced) {
      setFsBurstOn(true);
      audio.play("lightning-crack", 1);
      const id = setTimeout(() => setFsBurstOn(false), 2100);
      return () => clearTimeout(id);
    }
  }, [fsAwarded, reduced, playKey]);

  // Display order: server column-major -> screen row-major. ALL cell
  // rendering, win rings, blasts and fall styles key off this.
  const gridCells = toDisplayGrid(activeGrid) ?? PLACEHOLDER_GRID;
  const shaking = phase === "explode";

  return (
    <div className="w-full max-w-[520px] mx-auto select-none">
      {/* Multiplier ladder */}
      <div className="flex items-center justify-center gap-1.5 mb-2">
        {LADDER.map((rung) => {
          const active = mult >= rung;
          const justHit = active && mult === rung && rung > 1;
          return (
            <span
              key={`${rung}-${justHit ? rungFx : "s"}`}
              className={`px-2 py-0.5 rounded-full text-xs font-bold border ${
                active
                  ? "bg-[#D4AF37] text-black border-[#D4AF37] shadow-[0_0_12px_rgba(212,175,55,0.45)]"
                  : "bg-black/40 text-white/40 border-white/10"
              } ${justHit ? "animate-rung-pop" : ""}`}
            >
              ×{num(String(rung))}
            </span>
          );
        })}
        <span
          key={shownWin.toFixed(2)}
          className="ml-2 text-sm font-mono text-[#F4D03F] animate-win-pop inline-block"
        >
          {currencySymbol}
          {num(shownWin.toFixed(2))}
        </span>
      </div>
      {/* Scatter tracker: scatters are counted on the initial grid
          (that is the certified trigger); 3+ awards free spins in
          the active bundle (zeus-cascade-v1 threshold). */}
      {scatters != null && scatters >= 1 && (
        <div className="flex items-center justify-center gap-2 mb-2 animate-bounce-in">
          <span
            className={`relative px-2.5 py-0.5 rounded-full text-xs font-black tracking-wider border ${
              (fsAwarded ?? 0) > 0
                ? "bg-[#FFD54F] text-black border-[#FFD54F] animate-pulse"
                : "bg-[#2A2110]/90 text-[#FFD54F] border-[#FFD54F]/60 animate-scatter-shimmer"
            }`}
          >
            {t("scatterLanded", { n: scatters })}
          </span>
          {(fsAwarded ?? 0) === 0 && scatters === 2 && (
            <span className="text-[11px] text-[#F4D03F]/90 animate-pulse">{t("scatterOneMore")}</span>
          )}
        </div>
      )}
      {/* 6x5 grid + FX overlays. The wrapper carries the blast shake;
          the coin overlay and FS burst live inside so they clip to the
          board. The loss veil is its own keyed overlay so a losing
          spin never remounts the grid itself. */}
      <div
        className={`relative grid grid-cols-6 gap-1 sm:gap-1.5 bg-black/40 rounded-xl p-1.5 sm:p-2 border border-[#D4AF37]/20 overflow-hidden ${
          shaking ? "animate-board-shake" : ""
        }`}
      >
        {gridCells.map((sym, idx) => {
          const isWin = phase !== "idle" ? winPositions.has(idx) : idleWinCells.has(idx);
          // Symbol 0 is the ZEUS scatter: it never pays as a cluster —
          // it is the free-spins trigger, so it wears the SCATTER
          // treatment (gold pulse ring + ribbon) on every grid.
          // The pulse ring sits on the <img>, NOT this tile div: an
          // element carries ONE animation list, and the glow's
          // animation silently overrode the tile's drop-in/tumble
          // animations — scatter tiles hung still while the rest of
          // the board fell around them (found 2026-10-31).
          const isScatter = sym === 0;
          const isWild = sym === 11;
          const isBlast = phase === "explode" && isWin;
          return (
            <div
              key={idx}
              className={`relative aspect-square flex items-center justify-center rounded-md bg-[#1A1A25]/80 ${
                isScatter ? "bg-[#2A2110]/90" : isWild ? "bg-[#2A1030]/90" : ""
              } ${
                isWin && phase === "highlight"
                  ? "ring-2 ring-[#FFD54F] animate-pulse"
                  : isWin && phase === "idle"
                    ? "ring-2 ring-[#FFD54F]"
                    : ""
              } ${
                isBlast ? "blast-cell" : ""
              } ${
                phase === "dropin" ? "animate-cascade-drop" : ""
              } ${
                phase === "drop" ? "animate-cascade-fall" : ""
              }`}
              style={
                phase === "dropin"
                  ? { animationDelay: `${(idx % 6) * 22 + Math.floor(idx / 6) * 32}ms` }
                  : phase === "drop" && fallFrom
                    ? {
                        "--fall-from": fallFrom[idx],
                        animationDelay: `${(idx % 6) * 26}ms`,
                      } as CSSProperties
                    : undefined
              }
            >
              {rolling ? (
                <div className="absolute inset-0 overflow-hidden rounded-md bg-[#1A1A25]">
                  <div
                    className="animate-cascade-roll flex flex-col"
                    style={{ animationDuration: `${0.34 + (idx % 6) * 0.028 + Math.floor(idx / 6) * 0.014}s` }}
                  >
                    {rollStrips![idx].map((rs, k) => (
                      <div key={k} className="relative w-full aspect-square flex-none flex items-center justify-center">
                        <img
                          src={`/assets/symbol-${SYMBOL_NAMES[rs] ?? "zeus"}.webp`}
                          alt=""
                          className="w-[86%] h-[86%] object-contain"
                          draggable={false}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <>
                  <img
                    src={`/assets/symbol-${SYMBOL_NAMES[sym] ?? "zeus"}.webp`}
                    alt={SYMBOL_NAMES[sym] ?? "zeus"}
                    className={`${isScatter ? "w-[96%] h-[96%] scatter-glow" : isWild ? "w-[96%] h-[96%]" : "w-[86%] h-[86%]"} ${
                      isWin && phase === "highlight" ? "animate-win-flash" : ""
                    } object-contain`}
                    draggable={false}
                  />
                  {isScatter && (
                    <span className="absolute bottom-0 inset-x-0 text-center text-[7px] sm:text-[9px] font-black tracking-[0.14em] text-[#FFD54F] bg-black/75 py-px rounded-b-md">
                      {t("scatterBadge")}
                    </span>
                  )}
                  {isWild && (
                    <span className="absolute bottom-0 inset-x-0 text-center text-[7px] sm:text-[9px] font-black tracking-[0.14em] text-[#E1BEE7] bg-[#4A148C]/85 py-px rounded-b-md">
                      {t("wildBadge")}
                    </span>
                  )}
                  {/* Scatter landing flash: a one-shot electric pop as
                      the grid drops in. */}
                  {isScatter && phase === "dropin" && (
                    <span className="absolute inset-0 rounded-md animate-scatter-land pointer-events-none" />
                  )}
                </>
              )}
              {/* BLAST: shockwave ring + shards on exploding winners. */}
              {isBlast &&
                (blastCells.find((b) => b.idx === idx)?.particles ?? []).map((p, k) => (
                  <span
                  key={k} className="pointer-events-none absolute inset-0">
                    {k === 0 && <span className="absolute inset-0 rounded-md animate-blast-ring border-2 border-[#FFD54F]" />}
                    <span
                      className="absolute left-1/2 top-1/2 rounded-[2px] animate-blast-shard"
                      style={{
                        width: p.size,
                        height: p.size,
                        background: p.hue,
                        animationDelay: `${p.delay}ms`,
                        "--dx": p.dx,
                        "--dy": p.dy,
                        "--rot": p.rot,
                      } as CSSProperties}
                    />
                  </span>
                ))}
            </div>
          );
        })}
        {/* Coin shower (board-scoped, clipped). */}
        {coinBurst && (
          <div className="pointer-events-none absolute inset-0 overflow-hidden rounded-xl z-20">
            {coinBurst.map((c, k) => (
              <span
                key={k}
                className="absolute rounded-full animate-coin-fall flex items-center justify-center text-[10px]"
                style={{
                  left: `${c.left}%`,
                  width: c.size,
                  height: c.size,
                  background: "radial-gradient(circle at 35% 30%, #FFF3C4 0%, #F4D03F 45%, #B8860B 100%)",
                  border: "1px solid #8a6508",
                  boxShadow: "0 0 6px rgba(255, 213, 79, 0.55)",
                  animationDelay: `${c.delay}ms`,
                  animationDuration: `${c.dur}ms`,
                  "--dx": c.dx,
                } as CSSProperties}
              >
                <span className="text-[8px] font-black text-[#8a6508]">⚡</span>
              </span>
            ))}
          </div>
        )}
        {/* Losing-spin veil: one soft dim pulse (keyed overlay, the
            grid itself never remounts). */}
        {noWinFx > 0 && phase === "idle" && (steps?.length ?? 0) === 0 && (
          <div
            key={`nowin-${noWinFx}`}
            className="pointer-events-none absolute inset-0 rounded-xl bg-black/70 animate-nowin z-10"
          />
        )}
        {/* Free-spins award burst: rotating rays + banner. */}
        {fsBurstOn && (
          <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center overflow-hidden rounded-xl">
            <div className="absolute inset-[-40%] animate-fs-rays opacity-60" />
            <div className="relative animate-fs-burst text-center px-4 py-2 rounded-2xl bg-black/80 border-2 border-[#FFD54F] shadow-[0_0_40px_rgba(255,213,79,0.6)]">
              <div className="text-lg sm:text-2xl font-black tracking-wider text-[#FFD54F] drop-shadow-[0_0_12px_rgba(255,213,79,0.9)]">
                ⚡ {t("fsBurstTitle", { n: fsAwarded ?? 0 })}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Multiplier of the live playback step (falls back to the last step
 * while idle so the ladder keeps showing the round's peak). */
function currentMultOf(
  steps: CascadeStepData[] | null,
  phase: Phase,
  stepIdx: number,
): number | null {
  if (!steps || steps.length === 0) return null;
  if (phase === "idle") return steps[steps.length - 1].multiplier;
  return steps[Math.min(stepIdx, steps.length - 1)].multiplier;
}

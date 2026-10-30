import { useEffect, useMemo, useRef, useState } from "react";
import { useLang } from "@/i18n";
import { audio } from "@/lib/audio";

/**
 * Step 6 — cascade board + step playback + multiplier ladder.
 *
 * Playback follows the plan's timings: highlight 400ms -> explode
 * ~250ms -> drop/settle 300ms per step (turbo = 40%). With
 * prefers-reduced-motion the board jumps straight to the final
 * grid and the parent shows a summary toast instead. The ladder
 * shows the rung of the CURRENT step; during free spins it also
 * shows the persisted round rung.
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
};
const LADDER = [1, 2, 3, 5, 10];

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
  /** True while a spin request is in flight: tiles tumble so the
   * board is visibly alive before the result lands. */
  spinning?: boolean;
}) {
  const { num, t } = useLang();
  const [stepIdx, setStepIdx] = useState(0);
  const [phase, setPhase] = useState<Phase>("idle");
  const [shownWin, setShownWin] = useState(0);
  const doneRef = useRef(false);
  const reduced = useMemo(
    () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
    [],
  );

  const activeGrid: number[] | null =
    phase === "idle"
      ? finalGrid
      : steps && steps.length > 0
        ? phase === "drop" && stepIdx + 1 < steps.length
          ? steps[stepIdx + 1].grid
          : steps[Math.min(stepIdx, steps.length - 1)].grid
        : finalGrid;

  useEffect(() => {
    doneRef.current = false;
    setStepIdx(0);
    setShownWin(0);
    if (!steps) {
      setPhase("idle");
      return;
    }
    if (reduced) {
      setPhase("idle");
      setShownWin(steps.reduce((a, s) => a + parseFloat(s.stepWinMicro) / 1e8, 0));
      const id = setTimeout(() => {
        if (!doneRef.current) {
          doneRef.current = true;
          onDone();
        }
      }, 60);
      return () => clearTimeout(id);
    }
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
    if (phase === "dropin") ms = 550;
    if (phase === "highlight") ms = 400;
    if (phase === "explode") ms = 250;
    const id = setTimeout(() => {
      if (phase === "dropin") {
        if (steps.length === 0) {
          // Losing spin: the drop-in IS the whole playback.
          setPhase("idle");
          if (!doneRef.current) {
            doneRef.current = true;
            onDone();
          }
        } else {
          setPhase("highlight");
        }
      } else if (phase === "highlight") {
        const step = steps[stepIdx];
        if (step) {
          setShownWin((w) => w + parseFloat(step.stepWinMicro) / 1e8);
          audio.play("win-small", Math.min(0.6 + step.multiplier * 0.12, 1.4));
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
          setPhase("idle");
          if (!doneRef.current) {
            doneRef.current = true;
            onDone();
          }
        }
      }
    }, ms * scale);
    return () => clearTimeout(id);
  }, [phase, stepIdx, steps, turbo, onDone]);

  const currentStep = steps && phase !== "idle" ? steps[Math.min(stepIdx, steps.length - 1)] : null;
  const winPositions = new Set(currentStep?.clusters.flatMap((c) => c.positions) ?? []);
  const mult = currentStep?.multiplier ?? (steps && steps.length > 0 ? steps[steps.length - 1].multiplier : 1);

  return (
    <div className="w-full max-w-[520px] mx-auto select-none">
      {/* Multiplier ladder */}
      <div className="flex items-center justify-center gap-1.5 mb-2">
        {LADDER.map((rung) => (
          <span
            key={rung}
            className={`px-2 py-0.5 rounded-full text-xs font-bold border ${
              mult >= rung
                ? "bg-[#D4AF37] text-black border-[#D4AF37]"
                : "bg-black/40 text-white/40 border-white/10"
            }`}
          >
            ×{num(String(rung))}
          </span>
        ))}
        <span className="ml-2 text-sm font-mono text-[#F4D03F]">
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
            className={`px-2.5 py-0.5 rounded-full text-xs font-black tracking-wider border ${
              (fsAwarded ?? 0) > 0
                ? "bg-[#FFD54F] text-black border-[#FFD54F] animate-pulse"
                : "bg-[#2A2110]/90 text-[#FFD54F] border-[#FFD54F]/60"
            }`}
          >
            {t("scatterLanded", { n: scatters })}
          </span>
          {(fsAwarded ?? 0) === 0 && scatters === 2 && (
            <span className="text-[11px] text-[#F4D03F]/90">{t("scatterOneMore")}</span>
          )}
        </div>
      )}
      {/* 6x5 grid */}
      <div className="grid grid-cols-6 gap-1 sm:gap-1.5 bg-black/40 rounded-xl p-1.5 sm:p-2 border border-[#D4AF37]/20">
        {(activeGrid ?? PLACEHOLDER_GRID).map((sym, idx) => {
          const isWin = phase !== "idle" && winPositions.has(idx);
          // Symbol 0 is the ZEUS scatter: it never pays as a cluster —
          // it is the free-spins trigger, so it wears the SCATTER
          // treatment (gold pulse ring + ribbon) on every grid.
          // The pulse ring sits on the <img>, NOT this tile div: an
          // element carries ONE animation list, and the glow's
          // animation silently overrode the tile's drop-in/tumble
          // animations — scatter tiles hung still while the rest of
          // the board fell around them (found 2026-10-31).
          const isScatter = sym === 0;
          return (
            <div
              key={idx}
              className={`relative aspect-square flex items-center justify-center rounded-md bg-[#1A1A25]/80 ${
                isScatter ? "bg-[#2A2110]/90" : ""
              } ${
                isWin && phase === "highlight" ? "ring-2 ring-[#FFD54F] animate-pulse" : ""
              } ${isWin && phase === "explode" ? "scale-125 opacity-30 transition-all duration-200" : "transition-all duration-200"} ${
                phase === "dropin" ? "animate-cascade-drop" : ""
              } ${spinning && phase === "idle" ? "animate-cascade-tumble" : ""}`}
              style={
                phase === "dropin"
                  ? { animationDelay: `${(idx % 6) * 30 + Math.floor(idx / 6) * 45}ms` }
                  : spinning && phase === "idle"
                    ? { animationDelay: `${(idx % 6) * 45}ms` }
                    : undefined
              }
            >
              <img
                src={`/assets/symbol-${SYMBOL_NAMES[sym] ?? "zeus"}.webp`}
                alt={SYMBOL_NAMES[sym] ?? "zeus"}
                className={`${isScatter ? "w-[96%] h-[96%] scatter-glow" : "w-[86%] h-[86%]"} object-contain`}
                draggable={false}
              />
              {isScatter && (
                <span className="absolute bottom-0 inset-x-0 text-center text-[7px] sm:text-[9px] font-black tracking-[0.14em] text-[#FFD54F] bg-black/75 py-px rounded-b-md">
                  {t("scatterBadge")}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

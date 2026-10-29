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

type Phase = "idle" | "highlight" | "explode" | "drop";

export function CascadeBoard({
  steps,
  finalGrid,
  playKey,
  turbo,
  currencySymbol,
  onDone,
}: {
  steps: CascadeStepData[] | null;
  finalGrid: number[] | null;
  playKey: number;
  turbo: boolean;
  currencySymbol: string;
  onDone: () => void;
}) {
  const { num } = useLang();
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
    if (reduced || steps.length === 0) {
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
    setPhase("highlight");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playKey]);

  useEffect(() => {
    if (!steps || phase === "idle") return;
    const scale = turbo ? 0.4 : 1;
    let ms = 300;
    if (phase === "highlight") ms = 400;
    if (phase === "explode") ms = 250;
    const id = setTimeout(() => {
      if (phase === "highlight") {
        const step = steps[stepIdx];
        if (step) {
          setShownWin((w) => w + parseFloat(step.stepWinMicro) / 1e8);
          audio.play("win-small", Math.min(0.6 + step.multiplier * 0.12, 1.4));
        }
        setPhase("explode");
      } else if (phase === "explode") {
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
      {/* 6x5 grid */}
      <div className="grid grid-cols-6 gap-1 sm:gap-1.5 bg-black/40 rounded-xl p-1.5 sm:p-2 border border-[#D4AF37]/20">
        {(activeGrid ?? Array(30).fill(0)).map((sym, idx) => {
          const isWin = phase !== "idle" && winPositions.has(idx);
          return (
            <div
              key={idx}
              className={`relative aspect-square flex items-center justify-center rounded-md bg-[#1A1A25]/80 ${
                isWin && phase === "highlight" ? "ring-2 ring-[#FFD54F] animate-pulse" : ""
              } ${isWin && phase === "explode" ? "scale-125 opacity-30 transition-all duration-200" : "transition-all duration-200"}`}
            >
              <img
                src={`/assets/symbol-${SYMBOL_NAMES[sym] ?? "zeus"}.webp`}
                alt={SYMBOL_NAMES[sym] ?? "zeus"}
                className="w-[86%] h-[86%] object-contain"
                draggable={false}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

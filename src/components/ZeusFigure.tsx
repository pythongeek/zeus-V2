import { useMemo } from "react";

/**
 * The stage Zeus (owner request 2026-10-30): the figure is alive on
 * the stage — idle breathing/float with a storm aura and flickering
 * hand-lightning, a tense rock while reels spin, a golden aura during
 * free spins, and on big wins he lunges and hurls a lightning bolt
 * across the stage toward the board. Pure CSS/SVG over the existing
 * character art — no new assets, no canvas. Lite mode and
 * prefers-reduced-motion render him still.
 */
export type ZeusMood = "idle" | "spin" | "freespins" | "strike";

function BoltShape({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return (
    <svg viewBox="0 0 24 40" className={className} style={style} aria-hidden="true">
      <path
        d="M13 1 L4 22 L10.5 22 L8 39 L20 15 L13.5 15 L18 1 Z"
        fill="#FFD54F"
        stroke="#FFF3C4"
        strokeWidth="1"
      />
    </svg>
  );
}

export function ZeusFigure({
  mood,
  strikeKey,
  lite,
  className,
}: {
  mood: ZeusMood;
  strikeKey: number;
  lite: boolean;
  className?: string;
}) {
  const reduced = useMemo(
    () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
    [],
  );
  const still = lite || reduced;

  const imgClass = still
    ? ""
    : mood === "strike"
      ? "zeus-strike"
      : mood === "spin"
        ? "zeus-spin"
        : "zeus-idle";

  return (
    <div className={`relative pointer-events-none select-none ${className ?? ""}`} aria-hidden="true">
      {/* Free-spin aura */}
      {mood === "freespins" && !still && (
        <div className="absolute inset-0 -m-3 rounded-full bg-[radial-gradient(circle,rgba(255,213,79,0.35)_0%,transparent_65%)] animate-pulse" />
      )}
      <img
        src="/assets/zeus-character.webp"
        alt=""
        className={`relative w-full h-full object-contain ${imgClass} ${mood === "freespins" ? "brightness-110" : ""}`}
        draggable={false}
      />
      {/* Ambient hand lightning */}
      {!still && mood !== "strike" && (
        <>
          <BoltShape className="bolt-flicker absolute w-[16%] left-[6%] bottom-[16%] opacity-80" />
          <BoltShape
            className="bolt-flicker absolute w-[11%] right-[10%] bottom-[30%] opacity-60"
            style={{ animationDelay: "1.3s" }}
          />
        </>
      )}
      {/* Big-win thunder throw: bolt streaks from Zeus toward the board */}
      {mood === "strike" && !still && (
        <div key={strikeKey} className="absolute left-[38%] top-[26%] w-[290%] aspect-[3/2] z-30">
          <svg viewBox="0 0 300 200" className="w-full h-full overflow-visible">
            <path
              d="M6 14 L96 62 L78 70 L168 116 L148 124 L238 178"
              fill="none"
              stroke="#FFE082"
              strokeWidth="6"
              strokeLinejoin="round"
              strokeLinecap="round"
              pathLength={100}
              className="bolt-strike-path"
              style={{ filter: "drop-shadow(0 0 10px rgba(255,213,79,0.95)) drop-shadow(0 0 26px rgba(120,180,255,0.7))" }}
            />
            <path
              d="M6 14 L96 62 L78 70 L168 116 L148 124 L238 178"
              fill="none"
              stroke="#FFFFFF"
              strokeWidth="2"
              strokeLinejoin="round"
              strokeLinecap="round"
              pathLength={100}
              className="bolt-strike-path"
            />
          </svg>
          <div className="strike-glow-pop absolute right-[6%] bottom-[2%] w-24 h-24 rounded-full bg-[radial-gradient(circle,rgba(255,240,180,0.95)_0%,rgba(255,213,79,0.35)_45%,transparent_70%)]" />
        </div>
      )}
    </div>
  );
}

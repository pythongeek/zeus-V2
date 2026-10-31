import { useMemo } from "react";

/**
 * The stage Zeus (owner request 2026-10-30): the figure is alive on
 * the stage — idle breathing/float with a storm aura and flickering
 * hand-lightning, a tense rock while reels spin, a golden aura during
 * free spins, and on big wins he lunges and hurls a lightning bolt
 * across the stage toward the board. Pure CSS/SVG over the character
 * art — since 2026-10-30 the figure uses a transparent-background
 * cutout (zeus-character-cutout.webp, background removed from the
 * original painting) so he stands ON the stage instead of blocking
 * it with a rectangular picture. Lite mode and
 * prefers-reduced-motion render him still.
 */
export type ZeusMood = "idle" | "spin" | "freespins" | "strike" | "scatter";

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
      : mood === "scatter"
        ? "zeus-scatter"
        : mood === "spin"
          ? "zeus-spin"
          : "zeus-idle";

  return (
    <div className={`relative pointer-events-none select-none ${className ?? ""}`} aria-hidden="true">
      {/* Permanent stage aura + pedestal glow (owner polish,
          2026-10-31): he should read as a presence on the stage,
          not a sticker — a soft storm-gold halo behind him at all
          times (the stronger pulsing aura still layers on top in
          free spins) and a warm pool of light at his feet. */}
      <div className="absolute inset-0 -m-4 rounded-full bg-[radial-gradient(circle,rgba(140,200,255,0.22)_0%,rgba(212,175,55,0.10)_48%,transparent_70%)]" />
      <div className="absolute bottom-0 inset-x-1 h-3 rounded-[50%] bg-[radial-gradient(ellipse_at_center,rgba(255,213,79,0.35)_0%,transparent_70%)] blur-[2px]" />
      {/* Free-spin aura */}
      {mood === "freespins" && !still && (
        <div className="absolute inset-0 -m-3 rounded-full bg-[radial-gradient(circle,rgba(255,213,79,0.35)_0%,transparent_65%)] animate-pulse" />
      )}
      {/* Facing (owner, 2026-10-31): the cutout's gaze and staff
          read LEFT; the stage figure is mirrored so Zeus faces
          RIGHT, toward the board he overlooks. The flip wraps the
          art and the hand lightning together (their anchor points
          are painted for the cutout, so they mirror along and stay
          on his hands); his CSS pose animations use translate /
          rotate / scale only, so they compose cleanly inside the
          mirror. The thunder-throw overlay further down is stage
          geometry (it streaks across the board) and stays
          unflipped. */}
      <div className="absolute inset-0 [transform:scaleX(-1)]">
        <img
          src="/assets/zeus-character-cutout.webp"
          alt=""
          className={`relative w-full h-full object-contain ${imgClass} ${mood === "freespins" ? "brightness-110" : ""} ${still ? "drop-shadow-[0_2px_16px_rgba(120,180,255,0.45)]" : ""}`}
          draggable={false}
        />
        {/* Ambient hand lightning — positions track the cutout's
            hands: staff grip upper-left, free fist mid-right (in
            the art's own, pre-mirror coordinates). */}
        {!still && mood !== "strike" && (
          <>
            <BoltShape className={`${mood === "scatter" ? "bolt-flare" : "bolt-flicker"} absolute w-[15%] left-[3%] bottom-[57%] opacity-80`} />
            <BoltShape
              className={`${mood === "scatter" ? "bolt-flare" : "bolt-flicker"} absolute w-[10%] right-[22%] bottom-[44%] opacity-60`}
              style={{ animationDelay: "1.3s" }}
            />
          </>
        )}
      </div>
      {/* Thunder throw: bolt streaks from Zeus toward the board —
          big wins (strike) and 2+ scatter settles (scatter) alike,
          so the god visibly answers the board's big moments. */}
      {(mood === "strike" || mood === "scatter") && !still && (
        <div key={strikeKey} className="absolute left-[52%] top-[38%] w-[290%] aspect-[3/2] z-30">
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

import { useMemo } from "react";

/**
 * The stage Zeus. Since 2026-11-19 (second pass) he is a sharp
 * 3D-render Zeus (owner asked for a sharper, realistic 3D look
 * and for the figure to sit inside the game's golden frame): a
 * transparent cutout built locally (isnet figure mask +
 * colour-keyed recovery of the spearhead lightning halo the
 * mask dropped, contrast/sharpness baked into the asset),
 * standing ON the stage instead of blocking it with a rectangular
 * picture. He is alive in the same moods as before: idle float
 * with a storm aura and flickering hand lightning, a tense rock
 * while reels spin, a golden aura during free spins, and on big
 * wins he lunges and hurls a lightning bolt from his spear across
 * the stage toward the board.
 *
 * Two presentations (owner, 2026-11-19, following the industry
 * pattern of Gates of Olympus and its sequels, where Zeus stands
 * full-body beside the reels on desktop and shrinks to a compact
 * presence over the grid on mobile):
 * - stage (desktop): the full-body figure at the board's left
 *   edge, spear raised on the board side, throw streak included.
 * - compact (mobile): a waist-up bust cropped from the same art,
 *   looming over the board's top-right corner; the cross-stage
 *   throw becomes a spear flare + glow pop at his hand, so the
 *   one-screen mobile layout keeps its space.
 * Lite mode and prefers-reduced-motion render him still.
 */
export type ZeusMood = "idle" | "spin" | "freespins" | "strike" | "scatter" | "flare";

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
  flareKey,
  lite,
  compact,
  className,
}: {
  mood: ZeusMood;
  strikeKey: number;
  flareKey?: number;
  lite: boolean;
  compact?: boolean;
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
        : mood === "flare"
          ? "zeus-flare"
          : mood === "spin"
            ? "zeus-spin"
            : "zeus-idle";

  return (
    <div
      className={`relative pointer-events-none select-none ${compact ? "overflow-hidden" : ""} ${className ?? ""}`}
      aria-hidden="true"
    >
      {/* Permanent stage aura (owner polish, 2026-10-31): he reads
          as a presence on the stage, not a sticker — a soft
          storm-gold halo behind him at all times (the stronger
          pulsing aura still layers on top in free spins). The
          pedestal pool of light at his feet is stage-only: a
          waist-up bust has no feet to light. */}
      <div className="absolute inset-0 -m-4 rounded-full bg-[radial-gradient(circle,rgba(140,200,255,0.22)_0%,rgba(212,175,55,0.10)_48%,transparent_70%)]" />
      {!compact && (
        <>
          {/* Cloud pedestal (2026-11-19, competitor pattern: in
              7x7 Zeus and Zeus Royale he stands ON the clouds of
              Olympus, never on bare ground) — two soft vapour
              ellipses under his feet, the gold pool on top. */}
          <div className="absolute bottom-0 inset-x-0 h-10 rounded-[50%] bg-[radial-gradient(ellipse_at_center,rgba(190,210,240,0.28)_0%,rgba(140,170,220,0.10)_55%,transparent_75%)] blur-[5px]" />
          <div className="absolute bottom-3 left-[16%] w-[55%] h-7 rounded-[50%] bg-[radial-gradient(ellipse_at_center,rgba(225,236,252,0.30)_0%,transparent_70%)] blur-[4px]" />
          <div className="absolute bottom-0 inset-x-1 h-3 rounded-[50%] bg-[radial-gradient(ellipse_at_center,rgba(255,213,79,0.35)_0%,transparent_70%)] blur-[2px]" />
        </>
      )}
      {/* Free-spin aura */}
      {mood === "freespins" && !still && (
        <div className="absolute inset-0 -m-3 rounded-full bg-[radial-gradient(circle,rgba(255,213,79,0.35)_0%,transparent_65%)] animate-pulse" />
      )}
      {/* The Storm art needs no mirror: his spear is already raised
          on the board side (image right) and his gaze is near
          frontal. Compact crops the same art to a waist-up bust
          (scaled from the top inside the clipped frame). */}
      <div className="absolute inset-0">
        <img
          src="/assets/zeus-3d-cutout.webp"
          alt=""
          className={`relative w-full h-full object-contain ${compact ? "scale-[1.55] origin-[50%_0%]" : ""} ${imgClass} ${mood === "freespins" ? "brightness-110" : ""} ${still ? "drop-shadow-[0_2px_16px_rgba(120,180,255,0.45)]" : ""}`}
          draggable={false}
        />
        {/* Ambient hand lightning — positions track the Storm
            art's hands: the spear grip upper-right, the free fist
            mid-left. In compact the fist sits below the crop, so
            only the spear bolt rides along. */}
        {!still && mood !== "strike" && (
          <>
            <BoltShape className={`${mood === "scatter" || mood === "flare" ? "bolt-flare" : "bolt-flicker"} absolute w-[13%] right-[10%] top-[2%] opacity-80`} />
            {!compact && (
              <BoltShape
                className={`${mood === "scatter" || mood === "flare" ? "bolt-flare" : "bolt-flicker"} absolute w-[9%] left-[15%] bottom-[33%] opacity-60`}
                style={{ animationDelay: "1.3s" }}
              />
            )}
          </>
        )}
      </div>
      {/* Thunder throw (stage only): the bolt streaks from his
          spear toward the board — big wins (strike) and 2+ scatter
          settles (scatter) alike, so the god visibly answers the
          board's big moments. */}
      {!compact && (mood === "strike" || mood === "scatter") && !still && (
        <div key={strikeKey} className="absolute left-[76%] top-[0%] w-[290%] aspect-[3/2] z-30">
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
      {/* Win flare glow: ordinary wins (below the celebration
          tiers) pop a soft burst at the spear, so he visibly
          answers every paying spin, not only the big ones. */}
      {mood === "flare" && !still && (
        <div
          key={flareKey}
          className={`strike-glow-pop absolute rounded-full bg-[radial-gradient(circle,rgba(255,240,180,0.9)_0%,rgba(140,200,255,0.35)_45%,transparent_70%)] ${compact ? "right-[9%] top-[1%] w-11 h-11" : "right-[8%] top-[0%] w-20 h-20"}`}
        />
      )}
      {/* Compact strike: no room for the cross-stage streak, so
          the spear itself flares and a glow pops at his hand. */}
      {compact && (mood === "strike" || mood === "scatter") && !still && (
        <div key={strikeKey} className="absolute right-[8%] top-[0%] w-[46%] aspect-square z-30">
          <BoltShape className="bolt-flare absolute inset-0 w-full h-full opacity-95" />
          <div className="strike-glow-pop absolute inset-0 rounded-full bg-[radial-gradient(circle,rgba(255,240,180,0.9)_0%,rgba(255,213,79,0.35)_45%,transparent_70%)]" />
        </div>
      )}
    </div>
  );
}

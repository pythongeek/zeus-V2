import { useEffect, useMemo, useRef, useState } from "react";
import gsap from "gsap";
import { Button } from "@/components/ui/button";

export type CelebrationTier = "big" | "mega" | "jackpot";

export interface CelebrationData {
  tier: CelebrationTier;
  title: string;
  amount: number;
  amountText: (n: number) => string;
  bdtText: (n: number) => string;
}

interface Coin {
  id: number;
  x: number; // % horizontal origin
  delay: number;
  color: string;
  size: number;
  drift: number; // horizontal drift px
}

const TIER_CONFIG = {
  big: { coins: 64, duration: 3.2, shake: 6, flash: 0.25 },
  mega: { coins: 120, duration: 4.2, shake: 12, flash: 0.4 },
  jackpot: { coins: 180, duration: 5.5, shake: 20, flash: 0.6 },
} as const;

const COIN_COLORS = ["#D4AF37", "#F4D03F", "#FFD700", "#B8860B"];

export function Celebration({ data, onDone }: { data: CelebrationData; onDone: () => void }) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const titleRef = useRef<HTMLDivElement | null>(null);
  const amountRef = useRef<HTMLDivElement | null>(null);
  const zeusRef = useRef<HTMLDivElement | null>(null);
  const [shown, setShown] = useState(0);

  const cfg = TIER_CONFIG[data.tier];
  const reduced =
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Stable coin field (no Math.random in render)
  const coins = useMemo<Coin[]>(() => {
    return Array.from({ length: cfg.coins }, (_, i) => ({
      id: i,
      x: 4 + Math.random() * 92,
      delay: Math.random() * 1.1,
      color: COIN_COLORS[i % COIN_COLORS.length],
      size: 7 + Math.random() * 12,
      drift: (Math.random() - 0.5) * 220,
    }));
  }, [cfg.coins]);

  const letters = useMemo(() => Array.from(data.title), [data.title]);

  // Amount count-up
  useEffect(() => {
    if (reduced) {
      setShown(data.amount);
      return;
    }
    const start = performance.now();
    const dur = cfg.duration * 700;
    let raf = 0;
    const tick = (now: number) => {
      const p = Math.min((now - start) / dur, 1);
      const eased = 1 - Math.pow(1 - p, 3);
      setShown(data.amount * eased);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [data.amount, cfg.duration, reduced]);

  // GSAP master timeline
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const ctx = gsap.context(() => {
      if (reduced) {
        gsap.fromTo(root, { opacity: 0 }, { opacity: 1, duration: 0.3 });
        return;
      }

      const tl = gsap.timeline({
        onComplete: () => {
          // auto-dismiss after a beat
          gsap.to(root, {
            opacity: 0,
            duration: 0.5,
            delay: data.tier === "jackpot" ? 1.6 : 0.8,
            onComplete: onDone,
          });
        },
      });

      // Overlay + screen shake
      tl.fromTo(root, { opacity: 0 }, { opacity: 1, duration: 0.25 });
      tl.fromTo(
        root,
        { x: 0 },
        { x: "+=0", duration: 0.6 },
        "<",
      );
      // shake via keyframes on the whole root
      gsap.to(root, {
        keyframes: [
          { x: -cfg.shake, y: cfg.shake / 2, duration: 0.05 },
          { x: cfg.shake, y: -cfg.shake / 2, duration: 0.05 },
          { x: -cfg.shake / 2, y: -cfg.shake / 3, duration: 0.05 },
          { x: cfg.shake / 2, y: cfg.shake / 3, duration: 0.05 },
          { x: 0, y: 0, duration: 0.08 },
        ],
        delay: 0.25,
      });

      // Title letters slam
      if (titleRef.current) {
        const els = titleRef.current.children;
        tl.fromTo(
          els,
          { scale: 3.2, opacity: 0, y: -60, rotate: () => gsap.utils.random(-14, 14) },
          {
            scale: 1,
            opacity: 1,
            y: 0,
            rotate: 0,
            duration: 0.45,
            ease: "back.out(2)",
            stagger: 0.07,
          },
          0.15,
        );
        tl.to(
          els,
          { scale: 1.06, duration: 0.5, yoyo: true, repeat: -1, ease: "sine.inOut", stagger: 0.05 },
          ">",
        );
      }

      // Amount pop
      if (amountRef.current) {
        tl.fromTo(
          amountRef.current,
          { scale: 0, opacity: 0 },
          { scale: 1, opacity: 1, duration: 0.5, ease: "back.out(1.8)" },
          0.8,
        );
      }

      // Coin rain: each coin falls from above its origin with drift
      root.querySelectorAll<HTMLElement>("[data-coin]").forEach((coin) => {
        const drift = parseFloat(coin.dataset.drift || "0");
        tl.fromTo(
          coin,
          { y: -80 - Math.random() * 120, opacity: 0, rotate: 0 },
          {
            y: window.innerHeight + 120,
            x: `+=${drift}`,
            opacity: 1,
            rotate: gsap.utils.random(360, 900),
            duration: 2 + Math.random() * 2,
            ease: "power1.in",
            repeat: data.tier === "jackpot" ? 1 : 0,
            delay: parseFloat(coin.dataset.delay || "0"),
          },
          0.4,
        );
      });

      // Mega/Jackpot: Zeus rises with aura
      if (data.tier !== "big" && zeusRef.current) {
        tl.fromTo(
          zeusRef.current,
          { y: 260, opacity: 0, scale: 0.8 },
          { y: 0, opacity: data.tier === "jackpot" ? 0.9 : 0.75, scale: 1, duration: data.tier === "jackpot" ? 1.1 : 0.9, ease: "power2.out" },
          0.5,
        );
      }
    }, root);

    return () => ctx.revert();
  }, [data.tier, data.title, cfg.shake, cfg.duration, onDone, reduced]);

  return (
    <div
      ref={rootRef}
      className="fixed inset-0 z-[60] flex items-center justify-center overflow-hidden"
      style={{
        background:
          data.tier === "jackpot"
            ? "radial-gradient(ellipse at center, rgba(60,40,0,0.92) 0%, rgba(0,0,0,0.96) 70%)"
            : "rgba(0,0,0,0.78)",
        backdropFilter: "blur(2px)",
      }}
      onClick={onDone}
      role="alertdialog"
      aria-label={data.title}
    >
      {/* Flash-burst climax (all tiers): the white-gold burst
          from the reference video, timed to the title slam. */}
      <div
        className="absolute inset-0 pointer-events-none celebration-burst"
        style={{
          background:
            "radial-gradient(circle at center, rgba(255,246,200,0.95) 0%, rgba(255,213,79,0.55) 32%, transparent 62%)",
        }}
      />

      {/* Lightning flash ring for jackpot/mega */}
      {data.tier !== "big" && (
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            background:
              "radial-gradient(circle at center, rgba(255,255,255,0.5) 0%, transparent 40%)",
            animation: "lightning-flash-anim 0.8s ease-out 2",
          }}
        />
      )}

      {/* Zeus rises for jackpot */}
      {data.tier !== "big" && (
        <div
          ref={zeusRef}
          className={`absolute bottom-0 left-1/2 -translate-x-1/2 ${data.tier === "jackpot" ? "w-64 h-96" : "w-52 h-80"} opacity-90 pointer-events-none`}
        >
          <img
            src="/assets/zeus-character-cutout.webp"
            alt=""
            className="w-full h-full object-contain [transform:scaleX(-1)]"
            style={{ filter: "drop-shadow(0 0 40px rgba(212,175,55,0.8))" }}
          />
        </div>
      )}

      {/* Coin rain */}
      {coins.map((c) => (
        <div
          key={c.id}
          data-coin
          data-delay={c.delay}
          data-drift={c.drift}
          className="absolute rounded-full pointer-events-none"
          style={{
            left: `${c.x}%`,
            top: 0,
            width: c.size,
            height: c.size,
            background: `radial-gradient(circle at 30% 30%, #FFF3C4, ${c.color})`,
            boxShadow: `0 0 ${c.size}px ${c.color}`,
            opacity: 0,
          }}
        />
      ))}

      {/* Center content */}
      <div className="relative z-10 text-center px-4">
        <div
          ref={titleRef}
          className="flex items-center justify-center gap-1 mb-4 flex-wrap"
          style={{ fontFamily: "Cinzel, serif" }}
        >
          {letters.map((ch, i) => (
            <span
              key={i}
              className="inline-block text-6xl md:text-8xl font-black"
              style={{
                color: data.tier === "jackpot" ? "#FFF3C4" : "#D4AF37",
                textShadow:
                  "0 2px 0 #8A6D1F, 0 4px 0 #6E5616, 0 7px 0 rgba(0,0,0,0.45), 0 0 34px rgba(212,175,55,0.9), 0 0 70px rgba(212,175,55,0.5)",
                WebkitTextStroke: "1px rgba(122,84,8,0.55)",
                opacity: 0,
              }}
            >
              {ch === " " ? "\u00A0" : ch}
            </span>
          ))}
        </div>

        <div ref={amountRef} className="opacity-0">
          <div className="text-4xl md:text-5xl font-mono font-bold text-[#00E676] mb-2">
            {data.amountText(shown)}
          </div>
          <div className="text-lg text-[#9E9EAE]">{data.bdtText(shown)}</div>
        </div>

        <Button
          onClick={onDone}
          className="mt-8 bg-[#D4AF37] text-black hover:bg-[#F4D03F] font-semibold px-10"
        >
          {reduced ? "OK" : "Awesome!"}
        </Button>
      </div>
    </div>
  );
}

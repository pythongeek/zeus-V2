import { useEffect, useState } from "react";
import { trpc } from "@/providers/trpc";
import { useLang } from "@/i18n";
import { useGameStore } from "@/stores/gameStore";

/**
 * Step 9 — live win ticker. Renders ONLY real settled wins served by
 * social.recentWins (>= ticker_min_multiplier x bet, names masked
 * server-side). Empty feed renders nothing — never fabricated.
 * Polling pauses while the tab is hidden.
 */
export function LiveTicker() {
  const { t, num } = useLang();
  const activeCurrency = useGameStore((s) => s.activeCurrency);
  const config = useGameStore((s) => s.config) as Record<string, any> | null;
  const [hidden, setHidden] = useState<boolean>(typeof document !== "undefined" ? document.hidden : false);

  useEffect(() => {
    const onVis = () => setHidden(document.hidden);
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  const enabled = (config?.ticker_enabled ?? true) !== false;
  const query = trpc.social.recentWins.useQuery(
    { limit: 20 },
    { enabled: enabled && !hidden, refetchInterval: hidden ? false : 4000, staleTime: 3000 },
  );
  const wins = query.data?.wins ?? [];
  if (!enabled || wins.length === 0) return null;

  const rates: Record<string, number> = (config?.fx_rates as Record<string, number>) ?? {};
  const premium = Number(config?.usdt_bdt_premium ?? 0);
  const displayRate = (cur: string) => {
    const base = rates[cur] ?? (cur === "USDT" ? 110 : 1);
    return cur === "USDT" ? base + premium : base;
  };
  const symbol = (cur: string) => (cur === "BDT" ? "৳" : cur === "USDT" ? "$" : "");

  return (
    <div className="relative z-20 bg-black/40 border-y border-[#D4AF37]/25 px-3 py-1.5 overflow-hidden">
      <div className="flex items-center gap-4 whitespace-nowrap overflow-x-auto scrollbar-none">
        <span className="text-[#D4AF37] text-xs font-semibold uppercase tracking-wide shrink-0">
          ⚡ {t("liveWinsTitle")}
        </span>
        {wins.map((w, i) => {
          const rate = displayRate(activeCurrency);
          const shown = rate > 0 ? w.bdtEquivalent / rate : w.usdtEquivalent;
          const text = t("liveWinItem")
            .replace("{name}", w.maskedName)
            .replace("{amount}", `${symbol(activeCurrency)}${num(shown.toFixed(2))}`)
            .replace("{mult}", num(String(w.multiplier)));
          return (
            <span
              key={`${w.maskedName}-${i}-${w.createdAt}`}
              className={`text-xs shrink-0 ${w.gold ? "text-[#FFD700] font-semibold" : "text-white/80"}`}
            >
              {text}
            </span>
          );
        })}
      </div>
    </div>
  );
}

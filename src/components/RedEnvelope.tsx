import { useEffect, useState } from "react";
import { trpc } from "@/providers/trpc";
import { useLang } from "@/i18n";
import { useAuth } from "@/hooks/useAuth";
import { toast } from "sonner";

/**
 * Step 11 — red envelope banner. Scheduled: shows the drop time and
 * pool. Live: countdown + claim. The claim credits a 1x-wagering
 * bonus (24h expiry). Renders nothing when no drop is coming.
 */
export function RedEnvelope() {
  const { t, num, lang } = useLang();
  const { user } = useAuth();
  const [hidden, setHidden] = useState<boolean>(typeof document !== "undefined" ? document.hidden : false);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    const onVis = () => setHidden(document.hidden);
    document.addEventListener("visibilitychange", onVis);
    const iv = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      clearInterval(iv);
    };
  }, []);

  const query = trpc.promo.activeEnvelope.useQuery(undefined, {
    enabled: !hidden,
    refetchInterval: hidden ? false : 5000,
    staleTime: 3000,
  });
  const env = query.data?.envelope ?? null;
  const myClaim = trpc.promo.myClaim.useQuery(
    { envelopeId: env?.id ?? 0 },
    { enabled: !!env && !!user, staleTime: 5000 },
  );
  const claim = trpc.promo.claim.useMutation({
    onSuccess: (r) => {
      toast.success(
        t("redEnvClaimed").replace("{amount}", `${r.currency === "BDT" ? "৳" : ""}${num(parseFloat(r.amount).toFixed(2))} ${r.currency}`),
      );
      myClaim.refetch();
      query.refetch();
    },
    onError: (e) => toast.error(e.message),
  });

  if (!env) return null;
  const sym = env.currency === "BDT" ? "৳" : env.currency === "USDT" ? "$" : "";
  const poolText = `${sym}${num(parseFloat(env.poolAmount).toLocaleString("en-US"))}`;
  const claimed = myClaim.data?.claim;

  if (env.status === "scheduled") {
    const time = new Date(env.scheduledAt * 1000).toLocaleString(lang === "bn" ? "bn-BD" : "en-GB");
    return (
      <div className="relative z-20 bg-gradient-to-r from-red-900/70 via-red-800/60 to-red-900/70 border-y border-red-500/30 px-3 py-1.5 text-center">
        <span className="text-red-100 text-xs sm:text-sm">
          🧧 {t("redEnvTitle")} · {t("redEnvDropsAt").replace("{time}", time).replace("{pool}", poolText)}
        </span>
      </div>
    );
  }
  if (env.status !== "live") return null;
  const secsLeft = Math.max(0, env.scheduledAt + env.windowSeconds - now);
  return (
    <div className="relative z-20 bg-gradient-to-r from-red-800 via-red-600 to-red-800 border-y border-yellow-400/50 px-3 py-2">
      <div className="flex items-center justify-center gap-3 flex-wrap">
        <span className="text-white text-xs sm:text-sm font-semibold">
          🧧 {t("redEnvTitle")} · {t("redEnvLive").replace("{secs}", num(String(secsLeft)))}
        </span>
        {claimed ? (
          <span className="text-yellow-200 text-xs sm:text-sm">
            {t("redEnvClaimed").replace("{amount}", `${sym}${num(parseFloat(claimed.amount).toFixed(2))}`)}
          </span>
        ) : user ? (
          <button
            className="bg-yellow-400 text-red-900 text-xs sm:text-sm font-bold px-3 py-1 rounded-full hover:bg-yellow-300 disabled:opacity-50"
            disabled={claim.isPending}
            onClick={() => claim.mutate({ envelopeId: env.id })}
          >
            {t("redEnvClaim")}
          </button>
        ) : (
          <span className="text-red-100 text-xs">{t("redEnvLogin")}</span>
        )}
      </div>
    </div>
  );
}

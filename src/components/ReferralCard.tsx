import { useState } from "react";
import { trpc } from "@/providers/trpc";
import { useLang } from "@/i18n";
import { useAuth } from "@/hooks/useAuth";
import { toast } from "sonner";

/**
 * Step 14 — referral card: your code, your referees, your earnings.
 * Earnings are 10% of referee GGR for 90 days, settled weekly;
 * pending amounts vest to cash at the threshold. New accounts
 * (<= 24h) can enter a referrer's code here — binding is one-time.
 */
export function ReferralCard() {
  const { t, num } = useLang();
  const { user } = useAuth();
  const [codeInput, setCodeInput] = useState("");
  const data = trpc.promo.getReferral.useQuery(undefined, { enabled: !!user, staleTime: 30000 });
  const bind = trpc.promo.bindReferral.useMutation({
    onSuccess: () => {
      toast.success(t("refBoundOk"));
      data.refetch();
    },
    onError: (e) => toast.error(e.message),
  });
  if (!user || !data.data || data.data.enabled === false) return null;
  const d = data.data;
  const link = `${window.location.origin}/?ref=${d.code}`;

  return (
    <div className="relative z-20 px-3 py-2 bg-black/30 border-b border-white/5">
      <div className="max-w-[900px] mx-auto flex flex-col gap-1.5">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-semibold text-[#D4AF37]">🤝 {t("refTitle")}</span>
          <span className="text-xs text-white/70">
            {t("refYourCode")}: <span className="font-mono font-bold text-white">{d.code}</span>
          </span>
          <button
            className="text-xs bg-white/10 hover:bg-white/20 text-white px-2 py-0.5 rounded"
            onClick={() => {
              navigator.clipboard?.writeText(link).catch(() => {});
              toast.success(t("refCopied"));
            }}
          >
            {t("refCopyLink")}
          </button>
          <span className="text-xs text-white/50">
            {t("refTerms", {
              pct: num(String(d.terms.pct)),
              days: num(String(d.terms.windowDays)),
              vest: num(String(d.terms.vestMinBdt)),
            })}
          </span>
        </div>
        <div className="flex items-center gap-3 flex-wrap text-xs text-white/60">
          <span>
            {t("refReferees")}: {num(String(d.referees.length))}
          </span>
          {d.earned.map((e) => (
            <span key={e.currency}>
              {t("refEarned")}: {num(parseFloat(e.total).toFixed(2))} {e.currency}
            </span>
          ))}
          {d.pending.map((p) => (
            <span key={p.currency} className="text-amber-300/80">
              {t("refPending")}: {num(parseFloat(p.amount).toFixed(2))} {p.currency}
            </span>
          ))}
          {d.paid.map((p) => (
            <span key={p.currency} className="text-emerald-300/80">
              {t("refPaid")}: {num(parseFloat(p.total).toFixed(2))} {p.currency}
            </span>
          ))}
        </div>
        {d.canBind && (
          <div className="flex items-center gap-2">
            <input
              value={codeInput}
              onChange={(e) => setCodeInput(e.target.value.toUpperCase().slice(0, 8))}
              placeholder={t("refEnterCode")}
              className="bg-[#12121A] border border-[#2A2A35] rounded px-2 py-1 text-xs font-mono text-white w-32"
            />
            <button
              className="text-xs bg-[#D4AF37] text-black font-semibold px-2.5 py-1 rounded disabled:opacity-50"
              disabled={codeInput.length !== 8 || bind.isPending}
              onClick={() => bind.mutate({ code: codeInput })}
            >
              {t("refBind")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

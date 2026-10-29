import { trpc } from "@/providers/trpc";
import { useLang } from "@/i18n";
import { useAuth } from "@/hooks/useAuth";
import { toast } from "sonner";

/**
 * Step 12 — reload bonus offers in the deposit panel. Opt-in is
 * explicit and happens BEFORE the deposit; the bonus attaches when
 * the deposit is approved (the Binance rail is asynchronous, so
 * there is no countdown pressure — the opt-in stays armed for
 * days). Terms are printed on the card, in the player's language.
 */
export function ReloadOffers() {
  const { t, num, lang } = useLang();
  const { user } = useAuth();
  const offers = trpc.promo.listReloadOffers.useQuery(undefined, { staleTime: 30000 });
  const optin = trpc.promo.myReloadOptin.useQuery(undefined, { enabled: !!user, staleTime: 5000 });
  const optIn = trpc.promo.optInReload.useMutation({
    onSuccess: () => {
      toast.success(t("reloadArmedToast"));
      optin.refetch();
    },
    onError: (e) => toast.error(e.message),
  });
  const list = offers.data?.offers ?? [];
  if (list.length === 0) return null;
  const armedId = optin.data?.optin?.offerId;

  return (
    <div className="space-y-2">
      <div className="text-xs font-semibold text-[#D4AF37]">{t("reloadTitle")}</div>
      {list.map((o) => (
        <div key={o.id} className="text-xs bg-[#12121A] border border-[#2A2A35] rounded p-3 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-semibold text-white">{lang === "bn" ? o.nameBn : o.nameEn}</span>
            {armedId === o.id ? (
              <span className="text-emerald-300 font-semibold">{t("reloadArmed")}</span>
            ) : user ? (
              <button
                className="bg-[#D4AF37] text-black font-semibold px-3 py-1 rounded hover:bg-[#F4D03F] disabled:opacity-50"
                disabled={optIn.isPending}
                onClick={() => optIn.mutate({ offerId: o.id })}
              >
                {t("reloadOptIn")}
              </button>
            ) : null}
          </div>
          <div className="text-[#9E9EAC]">
            {t("reloadTerms", {
              min: num(String(o.minDepositUsdt)),
              max: num(String(o.maxBonus)),
              cur: o.currency === "ANY" ? "USDT/BDT" : o.currency,
              wager: num(String(o.wagering)),
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

import { useState } from "react";
import { trpc } from "@/providers/trpc";
import { useLang } from "@/i18n";
import { useAuth } from "@/hooks/useAuth";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

/**
 * Step 13 — VIP status strip + lucky wheel dialog. The wheel draw
 * is server-side (the client only animates); one free spin arrives
 * every Monday (Asia/Dhaka), plus one per VIP level-up. No spins
 * are purchasable — there is deliberately no buy path here.
 */
export function VipWheel() {
  const { t, num, lang } = useLang();
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [spinning, setSpinning] = useState(false);
  const [rotation, setRotation] = useState(0);

  const vip = trpc.promo.getVipStatus.useQuery(undefined, { enabled: !!user, staleTime: 30000 });
  const wheel = trpc.promo.getWheel.useQuery(undefined, { enabled: !!user && open, staleTime: 5000 });
  const spin = trpc.promo.spinWheel.useMutation({
    onSuccess: (r) => {
      setRotation((prev) => prev + 1800 + Math.floor(Math.random() * 360));
      setTimeout(() => {
        setSpinning(false);
        toast.success(
          `🎡 ${lang === "bn" ? r.prize.labelBn : r.prize.labelEn}`,
        );
        wheel.refetch();
        vip.refetch();
      }, 2600);
    },
    onError: (e) => {
      setSpinning(false);
      toast.error(e.message);
    },
  });

  if (!user) return null;
  const v = vip.data;
  const prizes = wheel.data?.prizes ?? [];
  const available = wheel.data?.availableSpins ?? 0;
  const seg = prizes.length > 0 ? 360 / prizes.length : 360;
  const gradient =
    prizes.length > 0
      ? `conic-gradient(${prizes
          .map((_, i) => `${i % 2 === 0 ? "#7f1d1d" : "#b45309"} ${i * seg}deg ${(i + 1) * seg}deg`)
          .join(", ")})`
      : "#7f1d1d";

  return (
    <>
      <div className="relative z-20 px-3 py-1.5 bg-black/30 border-b border-white/5 flex items-center gap-3 flex-wrap justify-center">
        {v?.tier && (
          <span className="text-xs text-[#D4AF37] font-semibold">
            VIP {lang === "bn" ? v.tier.nameBn : v.tier.nameEn} · {t("vipRakeback")} {num(String(v.tier.rakebackPct))}%
          </span>
        )}
        {v && (
          <span className="text-xs text-white/60">
            {t("vipTurnover")}: ৳{num(Math.floor(v.turnoverBdt).toLocaleString("en-US"))}
            {v.nextTier
              ? ` · ${t("vipNextTier")}: ${lang === "bn" ? v.nextTier.nameBn : v.nextTier.nameEn} ৳${num(v.nextTier.thresholdBdt.toLocaleString("en-US"))}`
              : ""}
          </span>
        )}
        {v && v.nextTier && (
          <span className="w-24 h-1.5 bg-white/10 rounded overflow-hidden inline-block">
            <span className="block h-full bg-[#D4AF37]" style={{ width: `${v.progressPct}%` }} />
          </span>
        )}
        <button
          className="text-xs bg-red-800 hover:bg-red-700 text-white font-semibold px-2.5 py-1 rounded-full"
          onClick={() => setOpen(true)}
        >
          🎡 {t("wheelTitle")}
        </button>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="bg-[#14141D] border-[#2A2A35] text-white max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-[#D4AF37]">🎡 {t("wheelTitle")}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col items-center gap-4">
            <div
              className="w-56 h-56 rounded-full border-4 border-[#D4AF37] relative transition-transform duration-[2600ms] ease-out"
              style={{ background: gradient, transform: `rotate(${rotation}deg)` }}
            >
              {prizes.map((p, i) => (
                <span
                  key={i}
                  className="absolute left-1/2 top-1/2 text-[10px] font-semibold text-white"
                  style={{
                    transform: `translate(-50%, -50%) rotate(${i * seg + seg / 2}deg) translateY(-86px)`,
                  }}
                >
                  {lang === "bn" ? p.labelBn : p.labelEn}
                </span>
              ))}
              <span className="absolute left-1/2 top-0 -translate-x-1/2 -translate-y-1 text-[#D4AF37] text-lg">▼</span>
            </div>
            <div className="text-sm text-white/80">
              {t("wheelSpins")}: {num(String(available))}
              {(wheel.data?.tokenBalance ?? 0) > 0 &&
                ` · ${t("wheelTokens")}: ${num(String(wheel.data?.tokenBalance ?? 0))}`}
            </div>
            <Button
              className="bg-[#D4AF37] text-black hover:bg-[#F4D03F]"
              disabled={available <= 0 || spinning}
              onClick={() => {
                setSpinning(true);
                spin.mutate();
              }}
            >
              {available > 0 ? t("wheelSpin") : t("wheelNoSpins")}
            </Button>
            {(wheel.data?.history ?? []).length > 0 && (
              <div className="w-full text-xs text-white/50 space-y-1">
                {(wheel.data?.history ?? []).map((h: any, i: number) => (
                  <div key={i} className="flex justify-between border-b border-white/5 py-0.5">
                    <span>{h.prize_label}</span>
                    <span>{new Date(h.used_at * 1000).toLocaleDateString(lang === "bn" ? "bn-BD" : "en-GB")}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

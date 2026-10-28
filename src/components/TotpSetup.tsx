import { useState } from "react";
import { trpc } from "@/providers/trpc";
import { useLang } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ShieldCheck, ShieldAlert } from "lucide-react";
import { toast } from "sonner";

/**
 * AP1: admin 2FA enrollment / management card.
 * States: not enrolled -> (setup) QR + secret -> (enable) one-time
 * recovery codes; enrolled -> status + disable (code-confirmed).
 * Used by the forced /security page and the admin System section.
 */
export function TotpSetup({ onEnabled }: { onEnabled?: () => void }) {
  const { t } = useLang();
  const utils = trpc.useUtils();
  const status = trpc.authLocal.totpStatus.useQuery(undefined, { retry: false });
  const setup = trpc.authLocal.totpSetup.useMutation();
  const enable = trpc.authLocal.totpEnable.useMutation();
  const disable = trpc.authLocal.totpDisable.useMutation();

  const [setupData, setSetupData] = useState<{ secret: string; qrDataUrl: string } | null>(null);
  const [code, setCode] = useState("");
  const [disableCode, setDisableCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);

  const enabled = !!status.data?.enabled;
  const required = !!status.data?.required;

  const startSetup = async () => {
    try {
      const res = await setup.mutateAsync();
      setSetupData({ secret: res.secret, qrDataUrl: res.qrDataUrl });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  const confirmEnable = async () => {
    try {
      const res = await enable.mutateAsync({ code: code.trim() });
      setRecoveryCodes(res.recoveryCodes);
      setSetupData(null);
      setCode("");
      await utils.authLocal.totpStatus.invalidate();
      await utils.auth.me.invalidate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  const confirmDisable = async () => {
    try {
      await disable.mutateAsync({ code: disableCode.trim() });
      setDisableCode("");
      toast.success(t("totpEnabledOk"));
      await utils.authLocal.totpStatus.invalidate();
      await utils.auth.me.invalidate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  if (status.isLoading) return <div className="text-sm text-slate-400">…</div>;

  if (recoveryCodes) {
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2 text-emerald-400 text-sm font-semibold">
          <ShieldCheck className="h-4 w-4" /> {t("totpRecoveryTitle")}
        </div>
        <p className="text-xs text-slate-400">{t("totpRecoveryNote")}</p>
        <div className="grid grid-cols-2 gap-2 font-mono text-sm">
          {recoveryCodes.map((c) => (
            <div key={c} className="rounded bg-slate-950 border border-slate-800 px-3 py-2 text-center text-amber-300">
              {c}
            </div>
          ))}
        </div>
        <Button
          className="w-full bg-amber-500 hover:bg-amber-400 text-black font-semibold"
          onClick={() => {
            setRecoveryCodes(null);
            onEnabled?.();
          }}
        >
          {t("totpSavedBtn")}
        </Button>
      </div>
    );
  }

  if (enabled) {
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2 text-emerald-400 text-sm font-semibold">
          <ShieldCheck className="h-4 w-4" /> {t("totpEnabledOk")}
        </div>
        {!required && (
          <div className="space-y-2">
            <p className="text-xs text-slate-400">{t("totpDisableDesc")}</p>
            <div className="flex gap-2">
              <Input
                value={disableCode}
                onChange={(e) => setDisableCode(e.target.value)}
                placeholder="123456"
                inputMode="numeric"
                className="bg-slate-950 border-slate-700 text-slate-200"
              />
              <Button
                variant="outline"
                className="border-red-500/40 text-red-400 hover:bg-red-500/10 shrink-0"
                disabled={disable.isPending || disableCode.trim().length < 6}
                onClick={confirmDisable}
              >
                {t("totpDisableBtn")}
              </Button>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-start gap-2 text-sm text-slate-300">
        <ShieldAlert className="h-4 w-4 mt-0.5 text-amber-400 shrink-0" />
        <p>{t("totpSetupIntro")}</p>
      </div>
      {!setupData ? (
        <Button
          className="w-full bg-amber-500 hover:bg-amber-400 text-black font-semibold"
          disabled={setup.isPending}
          onClick={startSetup}
        >
          {t("totpSetupBtn")}
        </Button>
      ) : (
        <div className="space-y-3">
          <div className="flex justify-center">
            <img
              src={setupData.qrDataUrl}
              alt="TOTP QR"
              className="rounded-lg border border-slate-700 bg-white p-1 w-[220px] h-[220px]"
            />
          </div>
          <div className="text-center">
            <div className="text-xs text-slate-500">{t("totpSecretLabel")}</div>
            <div className="font-mono text-sm text-amber-300 break-all">{setupData.secret}</div>
          </div>
          <div className="flex gap-2">
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="123456"
              inputMode="numeric"
              className="bg-slate-950 border-slate-700 text-slate-200"
            />
            <Button
              className="bg-emerald-600 hover:bg-emerald-500 text-white shrink-0"
              disabled={enable.isPending || code.trim().length < 6}
              onClick={confirmEnable}
            >
              {t("totpEnableBtn")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

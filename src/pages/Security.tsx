import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ShieldCheck, LogOut } from "lucide-react";
import { useEffect } from "react";
import { useNavigate } from "react-router";
import { trpc } from "@/providers/trpc";
import { useLang } from "@/i18n";
import { useAuth } from "@/hooks/useAuth";
import { TotpSetup } from "@/components/TotpSetup";

/**
 * AP1: forced 2FA enrollment page. Admins whose session is
 * setup-scoped (admin_2fa_required on, not yet enrolled) are routed
 * here by the Game/Admin guards; the server refuses admin procedures
 * until enrollment completes and upgrades the session.
 */
export default function Security() {
  const { t } = useLang();
  const navigate = useNavigate();
  const utils = trpc.useUtils();
  const { logout, user } = useAuth();

  // AP1b: this page is only for setup-scoped sessions. Anyone else
  // landing here (e.g. a player caught by a stale-cache redirect
  // right after an account switch) goes straight back to the game.
  useEffect(() => {
    if (user && (user as { authScope?: string }).authScope !== "setup") {
      navigate("/");
    }
  }, [user, navigate]);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-6">
      <Card className="w-full max-w-md bg-slate-900/80 border-slate-800">
        <CardHeader className="text-center">
          <CardTitle className="flex items-center justify-center gap-2 text-amber-400">
            <ShieldCheck className="h-5 w-5" /> {t("totpRequiredTitle")}
          </CardTitle>
          <CardDescription className="text-slate-400">
            {t("totpRequiredDesc")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <TotpSetup
            onEnabled={async () => {
              await utils.invalidate();
              navigate("/");
            }}
          />
          <Button
            variant="ghost"
            className="w-full text-slate-400 hover:text-slate-200"
            onClick={() => logout()}
          >
            <LogOut className="h-4 w-4 mr-2" /> {t("signOut")}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

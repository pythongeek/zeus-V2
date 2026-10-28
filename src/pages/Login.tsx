import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { trpc } from "@/providers/trpc";
import { toast } from "sonner";
import { useState } from "react";
import { useNavigate } from "react-router";
import { useMagicLogin } from "@/hooks/useMagicLogin";
import { useLang, LanguageToggle } from "@/i18n";
import { Zap, Mail, Phone, User, Lock } from "lucide-react";

function AuthForm() {
  useMagicLogin();
  const navigate = useNavigate();
  const utils = trpc.useUtils();
  const { t } = useLang();

  const register = trpc.authLocal.register.useMutation();
  const login = trpc.authLocal.login.useMutation();
  const verifyTotp = trpc.authLocal.verifyTotp.useMutation();
  // AP1: admin accounts with 2FA get a code step after the password.
  const [totpStep, setTotpStep] = useState(false);

  const afterAuth = async (msg: string) => {
    toast.success(msg);
    await utils.invalidate();
    navigate("/");
  };

  const onRegister = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const name = String(fd.get("name") || "").trim();
    const identifier = String(fd.get("identifier") || "").trim();
    const password = String(fd.get("password") || "");

    if (!name || name.length < 2) {
      toast.error(t("errEnterName"));
      return;
    }
    if (!identifier) {
      toast.error(t("errEnterIdentifier"));
      return;
    }

    // F3: 18+ confirmation is required (server enforces it too).
    if (fd.get("ageConfirmed") !== "on") {
      toast.error(t("ageConfirmRequired"));
      return;
    }
    const isEmail = identifier.includes("@");
    const payload = isEmail
      ? { name, email: identifier, password, ageConfirmed: true as const }
      : { name, phone: identifier, password, ageConfirmed: true as const };

    try {
      await register.mutateAsync(payload);
      await afterAuth(t("createdToast"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("registerFailed"));
    }
  };

  const onLogin = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const identifier = String(fd.get("identifier") || "").trim();
    const password = String(fd.get("password") || "");

    try {
      const res = await login.mutateAsync({ identifier, password });
      if ((res as { requiresTotp?: boolean }).requiresTotp) {
        setTotpStep(true);
        return;
      }
      await afterAuth(t("welcomeBackToast"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("loginFailed"));
    }
  };

  const onVerifyTotp = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const code = String(fd.get("code") || "").trim();
    try {
      await verifyTotp.mutateAsync({ code });
      await afterAuth(t("welcomeBackToast"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("loginFailed"));
    }
  };

  const inputCls = "pl-9 bg-[#0D0D16] border-[#2E2E3E] text-white placeholder:text-[#5E5E72]";
  const labelCls = "text-[#C9C9D6]";

  if (totpStep) {
    return (
      <form onSubmit={onVerifyTotp} className="space-y-4">
        <div className="text-center space-y-1">
          <div className="text-base font-semibold text-white">{t("totpTitle")}</div>
          <p className="text-xs text-[#8A8AA0]">{t("totpLoginDesc")}</p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="totp-code" className={labelCls}>{t("totpCodeLabel")}</Label>
          <Input
            id="totp-code"
            name="code"
            placeholder="123456"
            inputMode="numeric"
            autoComplete="one-time-code"
            className="bg-[#0D0D16] border-[#2E2E3E] text-white placeholder:text-[#5E5E72] text-center font-mono tracking-widest"
            required
          />
        </div>
        <Button
          type="submit"
          className="w-full bg-[#D4AF37] text-black hover:bg-[#F4D03F] font-semibold"
          disabled={verifyTotp.isPending}
        >
          {t("totpVerifyBtn")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="w-full text-[#8A8AA0] hover:text-white"
          onClick={() => setTotpStep(false)}
        >
          {t("totpBackToLogin")}
        </Button>
      </form>
    );
  }

  return (
    <Tabs defaultValue="login" className="w-full">
      <TabsList className="grid w-full grid-cols-2 mb-6">
        <TabsTrigger value="login">{t("tabLogin")}</TabsTrigger>
        <TabsTrigger value="register">{t("tabRegister")}</TabsTrigger>
      </TabsList>

      <TabsContent value="login">
        <form onSubmit={onLogin} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="login-identifier" className={labelCls}>{t("identifierLabel")}</Label>
            <div className="relative">
              <Mail className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                id="login-identifier"
                name="identifier"
                placeholder={t("identifierPlaceholder")}
                className={inputCls}
                required
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="login-password" className={labelCls}>{t("secretLabel")}</Label>
            <div className="relative">
              <Lock className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                id="login-password"
                name="password"
                type="password"
                placeholder={t("secretPlaceholderLogin")}
                className={inputCls}
                required
              />
            </div>
          </div>
          <Button
            type="submit"
            className="w-full bg-[#D4AF37] text-black hover:bg-[#F4D03F] font-semibold"
            disabled={login.isPending}
          >
            {login.isPending ? t("loginButtonBusy") : t("loginButton")}
          </Button>
        </form>
      </TabsContent>

      <TabsContent value="register">
        <form onSubmit={onRegister} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="reg-name" className={labelCls}>{t("nameLabel")}</Label>
            <div className="relative">
              <User className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                id="reg-name"
                name="name"
                placeholder={t("namePlaceholder")}
                className={inputCls}
                required
                minLength={2}
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="reg-identifier" className={labelCls}>{t("identifierLabel")}</Label>
            <div className="relative">
              <Phone className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                id="reg-identifier"
                name="identifier"
                placeholder={t("identifierPlaceholder")}
                className={inputCls}
                required
              />
            </div>
            <p className="text-xs text-[#8A8AA0]">{t("identifierHint")}</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="reg-password" className={labelCls}>{t("secretLabel")}</Label>
            <div className="relative">
              <Lock className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                id="reg-password"
                name="password"
                type="password"
                placeholder={t("secretPlaceholderRegister")}
                className={inputCls}
                required
                minLength={8}
              />
            </div>
            <p className="text-xs text-[#8A8AA0]">{t("secretHint")}</p>
          </div>
          <label className="flex items-start gap-2 text-xs text-[#8A8AA0] cursor-pointer">
            <input
              type="checkbox"
              name="ageConfirmed"
              required
              className="mt-0.5 accent-[#D4AF37]"
            />
            <span>{t("ageConfirmLabel")}</span>
          </label>
          <Button
            type="submit"
            className="w-full bg-[#D4AF37] text-black hover:bg-[#F4D03F] font-semibold"
            disabled={register.isPending}
          >
            {register.isPending ? t("registerButtonBusy") : t("registerButton")}
          </Button>
        </form>
      </TabsContent>
    </Tabs>
  );
}

export default function Login() {
  const { t } = useLang();
  return (
    <div className="min-h-screen flex items-center justify-center bg-[#0A0A0F] px-4 relative">
      <div className="absolute top-4 right-4 z-10">
        <div className="flex gap-4 text-xs text-[#8A8AA0]">
          <a href="/terms" className="hover:text-[#D4AF37]">{t("termsTitle")}</a>
          <a href="/privacy" className="hover:text-[#D4AF37]">{t("privacyTitle")}</a>
          <a href="/responsible-gaming" className="hover:text-[#D4AF37]">{t("rgTitle")}</a>
        </div>
        <LanguageToggle className="border-[#3A3A4A] bg-[#12121C] text-[#D4AF37] hover:bg-[#D4AF37]/10" />
      </div>
      <Card className="w-full max-w-md border-[#D4AF37]/30 bg-[#12121A]">
        <CardHeader className="text-center space-y-2">
          <div className="mx-auto mb-2 flex h-14 w-14 items-center justify-center rounded-full bg-[#D4AF37]/10">
            <Zap className="h-7 w-7 text-[#D4AF37]" />
          </div>
          <CardTitle className="text-2xl font-bold text-[#D4AF37] tracking-wide">
            ZEUS THUNDER SLOTS
          </CardTitle>
          <p className="text-sm text-[#9E9EAE]">{t("brandTagline")}</p>
        </CardHeader>
        <CardContent>
          <AuthForm />
        </CardContent>
      </Card>
    </div>
  );
}

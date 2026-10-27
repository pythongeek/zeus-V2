import { useEffect } from "react";
import { trpc } from "@/providers/trpc";
import { toast } from "sonner";
import { useNavigate } from "react-router";

/**
 * One-time magic login link support: /login?token=...&email=...
 * Redeems the link against authMagic.redeemToken and lands on the game.
 */
export function useMagicLogin() {
  const navigate = useNavigate();
  const utils = trpc.useUtils();
  const redeem = trpc.authMagic.redeemToken.useMutation();

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const email = params.get("email");
    const code = params.get("token");
    if (!email || !code) return;

    redeem
      .mutateAsync({ email, token: code })
      .then(async (res) => {
        toast.success(`Welcome back, ${res.user.name ?? res.user.email}!`);
        await utils.invalidate();
        navigate("/");
      })
      .catch(() => toast.error("This login link is invalid or has expired."));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

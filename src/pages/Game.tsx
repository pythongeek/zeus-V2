import { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate } from "react-router";
import { useGameStore } from "@/stores/gameStore";
import { useAuth } from "@/hooks/useAuth";
import { trpc } from "@/providers/trpc";
import { ReelEngine, type WinLine } from "@/game/ReelEngine";
import { useLang, LanguageToggle } from "@/i18n";
import { Celebration, type CelebrationData, type CelebrationTier } from "@/components/Celebration";
import { LiveTicker } from "@/components/LiveTicker";
import { RedEnvelope } from "@/components/RedEnvelope";
import { ReloadOffers } from "@/components/ReloadOffers";
import { VipWheel } from "@/components/VipWheel";
import { CascadeBoard, type CascadeStepData } from "@/components/CascadeBoard";
import { ZeusFigure, type ZeusMood } from "@/components/ZeusFigure";
import { ReferralCard } from "@/components/ReferralCard";
import { audio } from "@/lib/audio";
import { ladderFor, stepBet, snapToLadder } from "@/lib/betting";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Shield,
  Wallet,
  Settings,
  Volume2,
  VolumeX,
  Zap,
  RotateCcw,
  History,
  Info,
  TrendingUp,
  Gift,
  Sparkles,
  LogOut,
  Copy,
} from "lucide-react";


const CURRENCY_NAMES: Record<string, string> = {
  BTC: "Bitcoin (BTC)",
  ETH: "Ethereum (ETH)",
  USDT: "Tether (USDT)",
  BDT: "Bangladesh Taka (BDT)",
};

// Step 4: display rate = base FX + the USDT premium when set.
function fxRate(currency: string, config: Record<string, any> | null | undefined): number {
  const base = BDT_RATES[currency] || 1;
  if (currency !== "USDT") return base;
  const premium = Number(config?.usdt_bdt_premium ?? 0);
  return premium ? base + premium : base;
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  BTC: "\u20BF",
  ETH: "\u039E",
  USDT: "USDT",
  BDT: "\u09F3",
};

const BDT_RATES: Record<string, number> = {
  BTC: 11000000,
  ETH: 550000,
  USDT: 110,
  BDT: 1,
};

// U1: a symbol cell must never render blank. The artwork sits on top of
// a gold-letter tile; while it loads, or if it fails outright, the tile
// keeps the board readable (the owner's phone showed empty black cells).
const SYMBOL_MARKS: Record<string, string> = {
  zeus: "ZE", thunderbolt: "\u03DF", pegasus: "PE", temple: "TE",
  harp: "HA", amphora: "AM", helmet: "HE", shield: "SH",
  ace: "A", king: "K", queen: "Q",
};

function SymbolTile({ symbol, spinning, win }: { symbol: string; spinning: boolean; win: boolean }) {
  const [failed, setFailed] = useState(false);
  const { t } = useLang();
  const isScatter = symbol === "thunderbolt";
  return (
    <div className={`relative w-full h-full rounded-md bg-gradient-to-b from-[#23202F] to-[#12101C] border overflow-hidden ${isScatter ? "border-[#FFD54F]/80" : "border-[#2A2A35]"}`}>
      <span
        className="absolute inset-0 flex items-center justify-center font-bold text-[#D4AF37]/80"
        style={{ fontFamily: "Cinzel, serif", fontSize: "1.5rem" }}
      >
        {SYMBOL_MARKS[symbol] ?? "?"}
      </span>
      {!failed && (
        <img
          src={`/assets/symbol-${symbol}.webp`}
          alt={symbol}
          onError={() => setFailed(true)}
          className={`absolute inset-0 w-full h-full object-contain ${
            spinning ? "blur-[2px]" : ""
          } ${win ? "scale-110 drop-shadow-[0_0_14px_rgba(255,213,79,0.95)]" : ""}`}
          draggable={false}
        />
      )}
      {isScatter && (
        <span className="absolute bottom-0 inset-x-0 z-10 text-center text-[7px] sm:text-[9px] font-black tracking-[0.14em] text-[#FFD54F] bg-black/75 py-px">
          {t("scatterBadge")}
        </span>
      )}
    </div>
  );
}

// U4: lightweight symbol for the Lite scroll strips (no tile chrome —
// the strip is decoration while a reel is still spinning).
function ScrollSymbol({ symbol }: { symbol: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className="relative w-full h-full">
      <span
        className="absolute inset-0 flex items-center justify-center font-bold text-[#D4AF37]/70"
        style={{ fontFamily: "Cinzel, serif", fontSize: "1.4rem" }}
      >
        {SYMBOL_MARKS[symbol] ?? "?"}
      </span>
      {!failed && (
        <img
          src={`/assets/symbol-${symbol}.webp`}
          alt=""
          onError={() => setFailed(true)}
          className="absolute inset-0 w-full h-full object-contain blur-[1px]"
          draggable={false}
        />
      )}
    </div>
  );
}

const SCROLL_KEYS = ["ace", "zeus", "helmet", "queen", "thunderbolt", "harp", "king", "shield", "pegasus", "amphora", "temple"];

// Deterministic per-reel scroll sequence (duplicated for a seamless
// -50% loop). Pure decoration: the server decides the final symbols.
function liteScrollSymbols(reel: number): string[] {
  const seq: string[] = [];
  for (let i = 0; i < 9; i++) seq.push(SCROLL_KEYS[(i * 3 + reel * 4) % SCROLL_KEYS.length]);
  return [...seq, ...seq];
}

// F3: Responsible-gaming settings — limits + self-exclusion (server-enforced
// by api/lib/limits.ts; this is only the player's control surface).
function RgSettings() {
  const { t } = useLang();
  const utils = trpc.useUtils();
  const limitsQuery = trpc.balance.getLimits.useQuery(undefined, {
    staleTime: 30000,
  });
  const [dep, setDep] = useState("");
  const [loss, setLoss] = useState("");
  const [sess, setSess] = useState("");
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    const data = limitsQuery.data;
    if (data && !hydrated) {
      setDep(data.limits.depositLimitDaily ?? "");
      setLoss(data.limits.lossLimitDaily ?? "");
      setSess(
        data.limits.sessionLimitMinutes != null
          ? String(data.limits.sessionLimitMinutes)
          : "",
      );
      setHydrated(true);
    }
  }, [limitsQuery.data, hydrated]);

  const update = trpc.balance.updateLimits.useMutation({
    onSuccess: async () => {
      toast.success(t("rgSaved"));
      await utils.balance.getLimits.invalidate();
    },
    onError: (err) => toast.error(err.message),
  });

  const numOrNull = (v: string): string | null => {
    const n = parseFloat(v);
    return v.trim() !== "" && Number.isFinite(n) && n > 0 ? String(n) : null;
  };

  const handleSave = () => {
    const sessNum = parseInt(sess, 10);
    update.mutate({
      depositLimitDaily: numOrNull(dep),
      lossLimitDaily: numOrNull(loss),
      sessionLimitMinutes:
        sess.trim() !== "" && Number.isFinite(sessNum) ? sessNum : null,
    });
  };

  const handleExclude = (days: number) => {
    if (!window.confirm(t("rgSelfExcludeConfirm", { d: days }))) return;
    update.mutate({ selfExcludeDays: days });
  };

  const data = limitsQuery.data;
  const excludedUntil = data?.limits.selfExcludedUntil ?? 0;
  const isExcluded = excludedUntil * 1000 > Date.now();

  return (
    <div className="bg-[#1A1A25] rounded-lg p-3 space-y-3">
      <div className="text-sm font-semibold text-[#D4AF37]">{t("rgTitle")}</div>
      {isExcluded ? (
        <div className="text-xs text-red-400">
          {t("rgExcludedUntil", {
            date: new Date(excludedUntil * 1000).toLocaleDateString(),
          })}
        </div>
      ) : (
        <>
          <label className="block">
            <span className="text-xs text-[#9E9EAC]">{t("rgDepositLimit")}</span>
            <Input
              value={dep}
              onChange={(e) => setDep(e.target.value)}
              inputMode="decimal"
              placeholder={t("rgNoLimit")}
              className="bg-[#0A0A0F] border-[#2A2A35] text-white mt-1 h-8 text-sm"
            />
          </label>
          <label className="block">
            <span className="text-xs text-[#9E9EAC]">{t("rgLossLimit")}</span>
            <Input
              value={loss}
              onChange={(e) => setLoss(e.target.value)}
              inputMode="decimal"
              placeholder={t("rgNoLimit")}
              className="bg-[#0A0A0F] border-[#2A2A35] text-white mt-1 h-8 text-sm"
            />
          </label>
          <label className="block">
            <span className="text-xs text-[#9E9EAC]">{t("rgSessionLimit")}</span>
            <Input
              value={sess}
              onChange={(e) => setSess(e.target.value)}
              inputMode="numeric"
              placeholder={t("rgNoLimit")}
              className="bg-[#0A0A0F] border-[#2A2A35] text-white mt-1 h-8 text-sm"
            />
          </label>
          {data && (
            <div className="text-xs text-[#5E5E6E]">
              {t("rgUsageToday", {
                dep: data.usage.depositsTodayUsdt.toFixed(2),
                loss: Math.max(0, data.usage.netLossTodayUsdt).toFixed(2),
              })}
            </div>
          )}
          <p className="text-xs text-[#5E5E6E]">{t("rgLimitsNote")}</p>
          <Button
            size="sm"
            onClick={handleSave}
            disabled={update.isPending}
            className="bg-[#D4AF37] text-black hover:bg-[#F4D03F] font-semibold w-full"
          >
            {t("rgSave")}
          </Button>
          <div className="border-t border-[#2A2A35] pt-3">
            <div className="text-xs text-[#9E9EAC] mb-1">{t("rgSelfExclude")}</div>
            <p className="text-xs text-[#5E5E6E] mb-2">{t("rgSelfExcludeDesc")}</p>
            <div className="flex gap-2">
              {[7, 30, 180].map((d) => (
                <Button
                  key={d}
                  size="sm"
                  variant="outline"
                  disabled={update.isPending}
                  onClick={() => handleExclude(d)}
                  className="border-red-500/40 text-red-400 hover:bg-red-500/10 text-xs"
                >
                  {t("rgDays", { d })}
                </Button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function BuyFeatureButton() {
  const { t, num } = useLang();
  const store = useGameStore();
  const [armed, setArmed] = useState(false);
  const info = trpc.game.buyFeatureInfo.useQuery(undefined, {
    enabled: !!store.session,
    staleTime: 30000,
  });
  const buy = trpc.game.buyFeature.useMutation({
    onSuccess: (r) => {
      toast.success(t("buyFeatureDone"));
      store.setFreeSpinsRemaining(r.freeSpinsGranted);
      setArmed(false);
      info.refetch();
    },
    onError: (e) => {
      toast.error(e.message);
      setArmed(false);
    },
  });
  if (!info.data?.available || store.freeSpinsRemaining > 0 || !store.session) return null;
  const d = info.data;
  const priceAmount = store.betAmount * d.priceX;
  return (
    <button
      className="w-full bg-gradient-to-r from-amber-600 to-amber-500 hover:from-amber-500 hover:to-amber-400 text-black rounded-lg py-2 px-3 disabled:opacity-50"
      disabled={store.gameState === "spinning" || buy.isPending}
      onClick={() => {
        if (!armed) {
          setArmed(true);
          setTimeout(() => setArmed(false), 5000);
          return;
        }
        buy.mutate({
          sessionId: store.session!.sessionId,
          betAmount: String(store.betAmount),
          currency: store.activeCurrency,
        });
      }}
    >
      <span className="block text-sm font-bold">
        {armed
          ? t("buyFeatureConfirm")
              .replace("{spins}", num(String(d.freeSpins)))
              .replace("{amount}", `${num(priceAmount.toFixed(2))} ${store.activeCurrency}`)
              .replace("{rtp}", num((d.impliedBonusRtp * 100).toFixed(1)))
          : t("buyFeature").replace("{price}", num(String(d.priceX)))}
      </span>
      {!armed && (
        <span className="block text-[11px] font-medium opacity-80">
          {t("buyFeatureRtp").replace("{rtp}", num((d.impliedBonusRtp * 100).toFixed(1)))}
        </span>
      )}
    </button>
  );
}

export default function Game() {
  const store = useGameStore();
  const { t, num, lang } = useLang();
  const { isAuthenticated, user, logout, refresh } = useAuth({
    redirectOnUnauthenticated: true,
    redirectPath: "/login",
  });
  const navigate = useNavigate();
  // AP1: a setup-scoped admin session must complete 2FA enrollment
  // first. AP1b: the /me cache can still hold the PREVIOUS account
  // right after a login switch (observed live: a player landed on
  // /security once after an admin session), so confirm with a fresh
  // fetch before redirecting.
  useEffect(() => {
    if ((user as { authScope?: string } | null)?.authScope !== "setup") return;
    let cancelled = false;
    refresh().then((res) => {
      if (
        !cancelled &&
        (res.data as { authScope?: string } | undefined)?.authScope === "setup"
      ) {
        navigate("/security");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [user, navigate, refresh]);
  const [reelSymbols, setReelSymbols] = useState<string[][]>([
    ["ace", "king", "queen"],
    ["shield", "helmet", "amphora"],
    ["harp", "temple", "pegasus"],
    ["thunderbolt", "zeus", "thunderbolt"],
    ["ace", "king", "queen"],
  ]);
  const [displayedWin, setDisplayedWin] = useState(0);
  // U4: last completed round, for the always-on result strip
  const [lastResult, setLastResult] = useState<{ win: number; bet: number; currency: string } | null>(null);
  const [showBigWin, setShowBigWin] = useState(false);
  // D2: winning cells for the CSS/lite reels + free-spin session win total
  const [winCells, setWinCells] = useState<Set<string>>(new Set());
  // U4: Lite-board stop progress — reels below this count show finals
  const [liteStopped, setLiteStopped] = useState(5);
  const fsWinTotalRef = useRef(0);
  // In-flight startSession promise — see handleStartSession.
  const sessionStartRef = useRef<Promise<any> | null>(null);
  // Step 6: cascade playback state.
  const [cascadeSteps, setCascadeSteps] = useState<CascadeStepData[] | null>(null);
  const [cascadeSpinning, setCascadeSpinning] = useState(false);
  const [cascadeFinal, setCascadeFinal] = useState<number[] | null>(null);
  const [cascadePlayKey, setCascadePlayKey] = useState(0);
  const cascadeDoneRef = useRef<(() => void) | null>(null);
  const autoSpinDoneRef = useRef(0);
  const playStartedAtRef = useRef<number>(Date.now());
  const realityShownRef = useRef(0);
  const lastModeRef = useRef<"classic" | "cascade">("classic");
  const [bigWinText, setBigWinText] = useState("");
  const [lightningFlash, setLightningFlash] = useState(false);
  const [celebration, setCelebration] = useState<CelebrationData | null>(null);
  // Stage Zeus + scatter presentation (2026-10-30): cascade scatter
  // count from the server result, classic scatter count from the
  // settled grid, and the thunder-throw / board-shake triggers.
  const [cascadeScatters, setCascadeScatters] = useState<number | null>(null);
  const [cascadeFsAwarded, setCascadeFsAwarded] = useState(0);
  const [lastScatter, setLastScatter] = useState(0);
  const [strikeKey, setStrikeKey] = useState(0);
  const [boardShake, setBoardShake] = useState(false);
  const [recentSpins, setRecentSpins] = useState<Array<{ id: number; winAmount: string; betAmount: string; currency: string; isWin: boolean; createdAt: Date }>>([]);
  const autoSpinTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Reel engine (Pixi canvas) — with CSS fallback if WebGL/init fails
  const reelsHostRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<ReelEngine | null>(null);
  const reelSymbolsRef = useRef<string[][]>([]);
  const [engineFailed, setEngineFailed] = useState(false);
  const [boardReady, setBoardReady] = useState(false);
  const winLineColors = [0xd4af37, 0x00e676, 0x4fc3f7, 0xff5252, 0xba68c8];

  // Create/destroy the engine with auth state
  useEffect(() => {
    if (!isAuthenticated || store.liteMode || !reelsHostRef.current || engineRef.current || engineFailed) return;
    let cancelled = false;
    try {
      setBoardReady(false);
      const engine = new ReelEngine(reelsHostRef.current, 5);
      engine
        .init()
        .then(() => {
          if (cancelled) {
            engine.destroy();
            return;
          }
          engine.setSymbols(reelSymbolsRef.current);
          engineRef.current = engine;
          setBoardReady(true);
        })
        .catch((err) => {
          console.error("ReelEngine init failed — falling back to CSS reels", err);
          setEngineFailed(true);
        });
      return () => {
        cancelled = true;
        if (engineRef.current === engine) engineRef.current = null;
        engine.destroy();
      };
    } catch (err) {
      console.error("ReelEngine construction failed — falling back to CSS reels", err);
      setEngineFailed(true);
    }
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, engineFailed, store.liteMode]);

  // Keep ref in sync with grid state
  // Base-game music: "Crown of the Storm" (owner-supplied own
  // composition, 2026-10-30) — a seamless 158s loop normalised to a
  // mild -20 LUFS bed. Start it at the first interaction instead of
  // waiting for the first spin so the base game has consistent
  // music; startLoop is idempotent and no-ops until the engine is
  // unlocked, and the file loads lazily (never in the page's
  // critical path). The spin handler kicks the same loop as before.
  useEffect(() => {
    if (!isAuthenticated) return;
    const kick = () => audio.startLoop("music", ["bgm-main.opus", "bgm-main.m4a"], "music", 1);
    kick();
    window.addEventListener("pointerdown", kick);
    return () => window.removeEventListener("pointerdown", kick);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated]);

  // D1: free-spin music bed while free spins remain.
  useEffect(() => {
    if (store.freeSpinsRemaining > 0) {
      audio.startLoop("musicFs", ["bgm-freespins.opus", "bgm-freespins.m4a"], "music", 0.9);
    } else {
      audio.stopLoop("musicFs");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.freeSpinsRemaining]);

  // Win celebrations (big / mega / jackpot tiers): the "Throne of
  // the Storm" sting plays while the celebration overlay is up and
  // fades out as soon as it closes.
  useEffect(() => {
    if (celebration) audio.playCelebrationSting();
    else audio.stopCelebrationSting();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [celebration]);

  // C4: FPS guard — if this device cannot hold a smooth frame rate with
  // the Pixi renderer, drop to Lite mode (CSS reels) automatically.
  const fpsGuardDoneRef = useRef(false);
  useEffect(() => {
    if (store.liteMode || engineFailed || fpsGuardDoneRef.current || !isAuthenticated) return;
    let frames = 0;
    let slowWindows = 0;
    let raf = 0;
    let windowStart = performance.now();
    const tick = (now: number) => {
      frames++;
      if (now - windowStart >= 1000) {
        slowWindows = frames < 35 ? slowWindows + 1 : 0;
        frames = 0;
        windowStart = now;
        if (slowWindows >= 3) {
          fpsGuardDoneRef.current = true;
          store.setLiteMode(true, false);
          toast.info(t("liteModeAuto"));
          return;
        }
      }
      raf = requestAnimationFrame(tick);
    };
    // U1: never measure during page load — startup jank (bundle parse,
    // texture upload, first layout) used to trip this guard on healthy
    // phones. Start after a grace period; cleanup clears both handles.
    const startTimer = setTimeout(() => {
      windowStart = performance.now();
      raf = requestAnimationFrame(tick);
    }, 3500);
    return () => { clearTimeout(startTimer); cancelAnimationFrame(raf); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated, store.liteMode, engineFailed]);

  useEffect(() => {
    reelSymbolsRef.current = reelSymbols;
  }, [reelSymbols]);

  // tRPC queries and mutations
  const userBalancesQuery = trpc.balance.get.useQuery();
  const jackpotsQuery = trpc.jackpot.getPools.useQuery(undefined, { refetchInterval: 10000 });
  const startSession = trpc.game.startSession.useMutation();
  const spin = trpc.game.spin.useMutation();

  // Wallet flows
  const [walletMode, setWalletMode] = useState<"deposit" | "withdraw" | null>(null);
  const [depCurrency, setDepCurrency] = useState<"USDT" | "BDT">("USDT");
  const [depAmount, setDepAmount] = useState("");
  const [depReference, setDepReference] = useState("");
  const [depositResult, setDepositResult] = useState<{ amount: string; currency: string; payId: string; payName: string | null; method?: string } | null>(null);
  // Deposit v2 (owner, 2026-10-30): two rails + a two-step flow —
  // pick rail and amount first, then a pay screen modelled on the
  // Binance Pay hosted page (big QR, download, open-app).
  const [depMethod, setDepMethod] = useState<"binance" | "redotpay">("binance");
  const [depStep, setDepStep] = useState<"amount" | "pay">("amount");
  const [wdCurrency, setWdCurrency] = useState<"BTC" | "ETH" | "USDT">("USDT");
  const [wdAmount, setWdAmount] = useState("");
  const [wdAddress, setWdAddress] = useState("");
  const depositMutation = trpc.balance.deposit.useMutation();
  const withdrawMutation = trpc.balance.withdraw.useMutation();

  const handleDeposit = async () => {
    const amt = parseFloat(depAmount);
    if (!amt || amt <= 0) {
      toast.error(t("errInvalidDeposit"));
      return;
    }
    if (depReference.trim().length < 4) {
      toast.error(t("errDepositReference"));
      return;
    }
    try {
      const res = await depositMutation.mutateAsync({ currency: depCurrency, amount: depAmount, reference: depReference.trim(), method: depMethod });
      setDepositResult(res);
      toast.success(t("depositPending"));
      setDepAmount("");
      setDepReference("");
      setDepStep("amount");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("depositFailed"));
    }
  };

  // U3: unlock audio on the first touch/click/keypress anywhere —
  // mobile browsers only start an AudioContext inside a gesture, and
  // waiting for the spin handler meant early cues never sounded.
  useEffect(() => {
    const unlock = () => { audio.unlock(); };
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("keydown", unlock);
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, []);

  // Keep the audio engine in sync with persisted prefs
  useEffect(() => {
    audio.setMaster(store.masterVolume);
  }, [store.masterVolume]);
  useEffect(() => {
    audio.setEnabled(store.audioEnabled);
  }, [store.audioEnabled]);
  useEffect(() => {
    audio.setChannel("music", store.musicVolume);
  }, [store.musicVolume]);
  useEffect(() => {
    audio.setMusicEnabled(store.musicEnabled);
  }, [store.musicEnabled]);
  useEffect(() => {
    audio.setChannel("sfx", store.sfxVolume);
  }, [store.sfxVolume]);

  const handleWithdraw = async () => {
    const amt = parseFloat(wdAmount);
    if (!amt || amt <= 0) {
      toast.error(t("errInvalidWithdraw"));
      return;
    }
    if (wdAddress.trim().length < 26) {
      toast.error(t("errInvalidAddress"));
      return;
    }
    try {
      await withdrawMutation.mutateAsync({
        currency: wdCurrency,
        amount: wdAmount,
        toAddress: wdAddress.trim(),
      });
      toast.success(t("withdrawRequested"));
      setWdAmount("");
      setWdAddress("");
      setWalletMode(null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("withdrawFailed"));
    }
  };

  // Sync balance data from backend
  useEffect(() => {
    if (userBalancesQuery.data) {
      store.setBalances(userBalancesQuery.data);
    }
  }, [userBalancesQuery.data]);

  // Sync jackpot pools from backend
  useEffect(() => {
    if (jackpotsQuery.data) {
      store.setJackpots(jackpotsQuery.data);
    }
  }, [jackpotsQuery.data]);

  // B2: admin-controlled public config — bet limits, feature toggles,
  // timings, announcement/maintenance, first-visit sound defaults.
  // Step 16: slow networks (2G) get Lite mode automatically —
  // session-only unless the player saved their own preference.
  useEffect(() => {
    try {
      const conn = (navigator as any).connection;
      const slow = conn && (conn.effectiveType === "2g" || conn.effectiveType === "slow-2g");
      if (slow && localStorage.getItem("zeus.lite") === null) {
        store.setLiteMode(true, false);
      }
    } catch { /* connection API unavailable */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Step 17: 30-minute reality check while a session is live.
  useEffect(() => {
    const iv = setInterval(() => {
      if (!store.session) return;
      const mins = Math.floor((Date.now() - playStartedAtRef.current) / 60000);
      if (mins >= 30 && mins - realityShownRef.current >= 30) {
        realityShownRef.current = mins;
        toast.info(t("realityCheck").replace("{mins}", String(mins)));
      }
    }, 60000);
    return () => clearInterval(iv);
  }, [store.session, t]);

  const configQuery = trpc.game.getConfig.useQuery(undefined, { staleTime: 30000 });
  // E1: the paytable dialog renders the LIVE math from the server.
  const paytableQuery = trpc.game.getPaytable.useQuery(undefined, { enabled: store.showPaytable, staleTime: 60000 });
  useEffect(() => {
    const cfg = configQuery.data as Record<string, any> | undefined;
    if (!cfg) return;
    store.setConfig(cfg);
    const enabledList = cfg.currencies_enabled as string[] | undefined;
    if (Array.isArray(enabledList) && enabledList.length > 0 && !enabledList.includes(store.activeCurrency)) {
      store.setActiveCurrency(enabledList[0] as any);
    }
    const patch: Record<string, number> = {};
    if (typeof cfg.min_bet === "string") patch.minBet = parseFloat(cfg.min_bet);
    if (typeof cfg.max_bet === "string") patch.maxBet = parseFloat(cfg.max_bet);
    if (Object.keys(patch).length) useGameStore.setState(patch);
    // Step 1: if the current bet sits off the active currency's ladder
    // (e.g. a USDT-scale amount while BDT is selected), snap it on.
    const activeLadder = ladderFor(cfg, store.activeCurrency);
    if (!activeLadder.some((s) => Math.abs(s - store.betAmount) < 1e-9)) {
      store.setBetAmount(snapToLadder(store.betAmount, activeLadder));
    }
    if (!localStorage.getItem("zeus-audio-init")) {
      if (typeof cfg.sfx_volume_default === "number") store.setSfxVolume(cfg.sfx_volume_default);
      if (typeof cfg.music_volume_default === "number") store.setMusicVolume(cfg.music_volume_default);
      localStorage.setItem("zeus-audio-init", "1");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configQuery.data]);

  // Initialize session on mount — only when authenticated
  useEffect(() => {
    if (isAuthenticated && !store.session) {
      handleStartSession();
    }
  }, [isAuthenticated]);

  const handleStartSession = async () => {
    // Overlapping starts are dangerous: startSession completes the
    // user's previous session server-side, so two starts in flight
    // can complete each other's session and race the store onto a
    // dead one — after which every spin fails with "Active session
    // not found" until a manual reload (seen live 2026-10-29 and
    // 2026-10-31). Share one in-flight start; return the session.
    if (sessionStartRef.current) return sessionStartRef.current;
    const p = (async () => {
      try {
        const result = await startSession.mutateAsync({ clientSeed: store.clientSeed });
        const session = {
          sessionId: result.sessionId,
          serverSeedHash: result.serverSeedHash,
          clientSeed: result.clientSeed,
          startingNonce: result.startingNonce,
        };
        store.setSession(session);
        // Wheel-token free spins are granted INTO the new session by
        // startSession; seed the counter from its response so the
        // player sees them (and the FS music bed starts) before the
        // first spin, not only after a spin response reveals them.
        store.setFreeSpinsRemaining(result.freeSpinsGranted);
        return session;
      } catch (e: any) {
        console.error("Failed to start session:", e);
        toast.error(e?.message || t("sessionFailed"));
        return null;
      } finally {
        sessionStartRef.current = null;
      }
    })();
    sessionStartRef.current = p;
    return p;
  };

  const handleSpin = useCallback(async () => {
    const debug = new URLSearchParams(window.location.search).has("debug");
    if (debug) {
      document.title = `Z click state=${store.gameState} sess=${store.session?.sessionId ?? "none"} bal=${store.balances.find((b) => b.currency === store.activeCurrency)?.available ?? "?"} eng=${engineRef.current ? "ok" : engineFailed ? "fallback" : "null"}`;
    }
    if (store.gameState === "spinning") return;
    if (!store.session) {
      await handleStartSession();
      return;
    }

    // BUG-009: Client-side balance pre-validation — skipped during free
    // spins: they are never charged and play at the locked bet (A5).
    if (store.freeSpinsRemaining <= 0) {
      const currentBalance = store.balances.find(b => b.currency === store.activeCurrency);
      if (!currentBalance || currentBalance.available < store.betAmount) {
        toast.error(t("insufficientBalance", { cur: store.activeCurrency }));
        return;
      }
    }

    // The session this spin runs on. Starts as the store's
    // session; spinWithRecovery may replace it with a fresh one,
    // and the post-spin nonce bookkeeping must spread THIS object,
    // not the stale closure snapshot, or the dead id comes back.
    let liveSession = store.session;
    // One transparent recovery for a replaced session: if the
    // server says the session is gone (startSession completed it
    // — a second tab or a reload race can do that to this page),
    // start a fresh session and retry ONCE with a new requestId.
    // The rejected attempt wrote nothing (the session check is
    // the spin transaction's first statement), so the retry
    // cannot double-bet. Never recover while free spins remain:
    // those live on the dead session, and silently turning a
    // free spin into a paid one would be worse than the error.
    const spinWithRecovery = async (args: Parameters<typeof spin.mutateAsync>[0]) => {
      try {
        return await spin.mutateAsync({ ...args, sessionId: liveSession.sessionId });
      } catch (e: any) {
        if (
          store.freeSpinsRemaining > 0 ||
          !String(e?.message ?? "").includes("Active session not found")
        ) {
          throw e;
        }
        const fresh = await handleStartSession();
        if (!fresh) throw e;
        liveSession = fresh;
        return await spin.mutateAsync({
          ...args,
          sessionId: fresh.sessionId,
          requestId: crypto.randomUUID(),
        });
      }
    };

    // Step 6: cascade path — server resolves, board plays back.
    const wantCascade =
      store.freeSpinsRemaining > 0 ? lastModeRef.current === "cascade" : store.mode === "cascade";
    if (wantCascade) {
      store.setGameState("spinning");
      store.setLastWin(0);
      setLastResult(null);
      audio.unlock();
      audio.play("ui-click");
      // Cascade gets the full spin soundscape too (2026-10-31: this
      // branch previously played nothing but the click — no reel
      // sound, no ambience, and the music never ducked).
      audio.startLoop("ambience", "storm-bed.wav", "music", 0.7);
      audio.startLoop("music", ["bgm-main.opus", "bgm-main.m4a"], "music", 1);
      audio.startLoop("reels", "reel-spin-loop.wav", "sfx", 0.8);
      audio.duckMusic(true);
      setCascadeSpinning(true);
      const spinStartedAt = Date.now();
      try {
        const result = await spinWithRecovery({
          sessionId: liveSession.sessionId,
          betAmount: String(store.betAmount),
          currency: store.activeCurrency,
          mode: "cascade",
          requestId: crypto.randomUUID(),
        });
        // The result often lands in ~200ms on a fast connection —
        // too fast for the tumbling tiles and the reel loop to
        // register at all, so the board appeared to swap instantly
        // (owner report, 2026-10-31). Hold the in-flight
        // presentation for a minimum beat first, mirroring
        // classic's fixed reel-stop schedule; the board playback
        // takes over from here.
        const minFlightMs = store.turboMode ? 300 : 700;
        const flightLeftMs = minFlightMs - (Date.now() - spinStartedAt);
        if (flightLeftMs > 0) await new Promise((r) => setTimeout(r, flightLeftMs));
        audio.stopLoop("reels");
        setCascadeSpinning(false);
        store.setSession({ ...liveSession, startingNonce: result.nonce });
        lastModeRef.current = (result.mode as "classic" | "cascade") ?? "cascade";
        if (result.mode === "cascade" && result.cascade) {
          setCascadeScatters(typeof result.cascade.scatters === "number" ? result.cascade.scatters : null);
          setCascadeFsAwarded(result.freeSpinsAwarded ?? 0);
          setCascadeSteps(result.cascade.steps as CascadeStepData[]);
          setCascadeFinal(result.cascade.finalGrid as number[]);
          setCascadePlayKey((k) => k + 1);
          await new Promise<void>((resolve) => {
            cascadeDoneRef.current = resolve;
            setTimeout(resolve, 30000); // playback can never hang the game
          });
          cascadeDoneRef.current = null;
          if (
            typeof window !== "undefined" &&
            window.matchMedia?.("(prefers-reduced-motion: reduce)").matches &&
            parseFloat(result.winAmount) > 0
          ) {
            toast.success(
              t("cascadeSummary")
                .replace("{chains}", String(result.cascade.chainLength))
                .replace("{amount}", `${result.winAmount} ${result.currencyUsed}`),
            );
          }
        }
        handleSpinComplete(result);
      } catch (e: any) {
        console.error("Cascade spin failed:", e);
        toast.error(e?.message || t("spinFailed"));
        audio.stopLoop("reels");
        audio.duckMusic(false);
        setCascadeSpinning(false);
        store.setGameState("idle");
      }
      return;
    }

    store.setGameState("spinning");
    store.setLastWin(0);
    setLiteStopped(0);
    setLastResult(null);
    audio.unlock();
    audio.play("ui-click");
    audio.startLoop("ambience", "storm-bed.wav", "music", 0.7);
    audio.startLoop("music", ["bgm-main.opus", "bgm-main.m4a"], "music", 1);
    audio.startLoop("reels", "reel-spin-loop.wav", "sfx", 0.8);
    // Owner (2026-10-31): while the reels roll the background music
    // pauses (ducks to a whisper) so the reel sounds own the mix.
    audio.duckMusic(true);
    engineRef.current?.clearWinLines();
    setWinCells(new Set());
    if (debug) document.title = `Z firing sess=${store.session.sessionId}`;

    // Start the Pixi reel engine immediately
    engineRef.current?.spin(reelSymbolsRef.current, {
      turbo: store.turboMode,
      stopDelays: store.turboMode ? (store.config?.turbo_delays ?? [120, 180, 240, 300, 360]) : (store.config?.normal_delays ?? [350, 500, 650, 800, 950]),
    });

    try {
      const result = await spinWithRecovery({
        sessionId: liveSession.sessionId,
        betAmount: String(store.betAmount),
        currency: store.activeCurrency,
        requestId: crypto.randomUUID(),
      });
      if (debug) document.title = `Z result win=${result.winAmount}`;

      // Update session nonce
      store.setSession({
        ...liveSession,
        startingNonce: result.nonce,
      });

      const finalSymbols: string[][] = result.symbols;
      setReelSymbols(finalSymbols);
      engineRef.current?.setFinalSymbols(finalSymbols);

      // Scatter anticipation: 2+ thunderbolts across reels 1-4 => tease reel 5
      const scattersEarly = finalSymbols
        .slice(0, 4)
        .filter((col) => col.includes("thunderbolt")).length;
      const scatterOnReel5 = finalSymbols[4]?.includes("thunderbolt") ?? false;
      const anticipate = scattersEarly >= 2;

      const baseDelays: number[] = store.turboMode ? (store.config?.turbo_delays ?? [120, 180, 240, 300, 360]) : (store.config?.normal_delays ?? [350, 500, 650, 800, 950]);
      const engine = engineRef.current;
      // Step 7: near-miss tease — presentation ONLY, on the server's
      // settled-outcome flag (exactly 2 scatters). The result is
      // already final; the last reel simply lands later (1,800ms
      // tease; 900ms in turbo). Kill-flagged by near_miss_enabled.
      const nearMissTease =
        !!(result as any).nearMiss && (store.config as any)?.near_miss_enabled !== false;

      baseDelays.forEach((delay, i) => {
        // Reel stops are scheduled from the RESULT's arrival, never
        // from the click: the old elapsed-compensation collapsed the
        // whole spin — reels and their sound — to zero whenever the
        // network round-trip outlasted the stop delays, which is
        // exactly what players on slower connections hit (owner
        // report, 2026-10-31). The reels spin open-endedly until
        // stopped, so this stays in sync visually.
        let at = delay;
        if (anticipate && i === 4 && scatterOnReel5) {
          // Dramatic slow-down: engine already slows reel 5; extend its stop
          at += store.turboMode ? 400 : 700;
        }
        if (nearMissTease && i === 4) {
          at = Math.max(at, store.turboMode ? 900 : 1800);
        }
        setTimeout(() => {
          setLiteStopped(i + 1);
          if ((anticipate || nearMissTease) && i === 3) {
            engine?.setAnticipation(4);
            audio.startLoop("anticipation", "anticipation-loop.wav", "sfx", 0.9);
          }
          engine?.stopReel(i);
          audio.play(`reel-stop-${i + 1}`);
          if (i === 4) {
            engine?.setAnticipation(null);
            audio.stopLoop("reels");
            audio.stopLoop("anticipation");
            // Wait for bounce-settle before evaluating results
            const settleMs = store.turboMode ? 160 : 260;
            setTimeout(() => handleSpinComplete(result), settleMs);
          }
        }, at);
      });
    } catch (e: any) {
      console.error("Spin failed:", e);
      if (debug) document.title = `Z spinERR ${e?.message ?? "?"}`;
      toast.error(e?.message || t("spinFailed"));
      audio.stopLoop("reels");
      audio.stopLoop("anticipation");
      audio.duckMusic(false);
      store.setGameState("idle");
    }
  // store.mode and store.freeSpinsRemaining MUST be deps: without
  // them the first spin after switching modes ran the PREVIOUS mode's
  // path from the stale closure (mode switch doesn't touch the other
  // deps, and gameState only flips once the wrong spin is already
  // running) — the board kept showing the old mode while the result
  // text and balance moved. Caught in live verification 2026-10-30.
  }, [store.session, store.betAmount, store.activeCurrency, store.turboMode, store.gameState, store.mode, store.freeSpinsRemaining, t]);

  const handleSpinComplete = (result: any) => {
    // The spin has settled in both modes: the music swells back.
    audio.duckMusic(false);
    store.setLastSpin(result);
    // Classic scatter count from the settled grid (cascade shows its
    // own count on the board, from the server's initial-grid count).
    if (result.mode === "cascade") {
      setLastScatter(0);
    } else if (Array.isArray(result.symbols)) {
      const flat = (result.symbols as any[]).flat();
      setLastScatter(flat.filter((s) => s === "thunderbolt").length);
    }
    const winAmount = parseFloat(result.winAmount);
    store.setLastWin(winAmount);
    // A losing spin gets a soft landing thud in both modes (owner,
    // 2026-10-31: losses were completely silent before).
    if (winAmount <= 0) audio.play("lose-soft", 0.8);
    setLastResult({
      win: winAmount,
      bet: typeof result.betAmount === "string" ? parseFloat(result.betAmount) : store.betAmount,
      currency: store.activeCurrency,
    });

    // Sync active currency balance with result.newBalance
    const updatedNewBal = parseFloat(result.newBalance);
    const bdtRate = fxRate(store.activeCurrency, store.config);
    const hasCurrency = store.balances.some(b => b.currency === store.activeCurrency);
    if (hasCurrency) {
      store.setBalances(
        store.balances.map(b =>
          b.currency === store.activeCurrency
            ? { ...b, available: updatedNewBal, bdtEquivalent: updatedNewBal * bdtRate }
            : b
        )
      );
    } else {
      store.setBalances([
        ...store.balances,
        {
          currency: store.activeCurrency,
          available: updatedNewBal,
          locked: 0,
          bonus: 0,
          bdtEquivalent: updatedNewBal * bdtRate,
        },
      ]);
    }

    // Add to recent spins
    setRecentSpins(prev => [{
      id: Date.now(),
      winAmount: result.winAmount,
      betAmount: String(store.betAmount),
      currency: store.activeCurrency,
      isWin: winAmount > 0,
      createdAt: new Date(),
    }, ...prev].slice(0, 20));

    // Special Feature & Win Animation Triggers
    if (result.featureTriggered === "thunder_strike") {
      // D2: strobe sequence — strike, afterglow, second strike.
      audio.play("lightning-crack");
      setBigWinText(t("thunderStrikeBonus"));
      setShowBigWin(true);
      setLightningFlash(true);
      setTimeout(() => setLightningFlash(false), 220);
      setTimeout(() => { setLightningFlash(true); audio.play("lightning-crack", 0.6); }, 380);
      setTimeout(() => setLightningFlash(false), 1050);
    } else if (result.featureTriggered === "free_spins") {
      setLightningFlash(true);
      audio.play("win-small", 1.2);
      setBigWinText(t("freeSpinsUnlocked", { n: result.freeSpinsAwarded }));
      setShowBigWin(true);
      setTimeout(() => setLightningFlash(false), 800);
    }

    if (winAmount > 0) {
      // Draw animated win lines on the Pixi canvas
      if (result.winLines?.length && engineRef.current) {
        const winLines: WinLine[] = result.winLines
          .filter((line: any) => Array.isArray(line.positions) && line.positions.length >= 2)
          .map((line: any, idx: number) => ({
            positions: line.positions as Array<[number, number]>,
            color: winLineColors[idx % winLineColors.length],
            payout: line.payout ? parseFloat(line.payout) : undefined,
          }));
        engineRef.current.showWinLines(winLines);
      }
      if (result.winLines?.length) {
        setWinCells(new Set(
          (result.winLines as any[])
            .filter((line: any) => Array.isArray(line.positions))
            .flatMap((line: any) => line.positions.map(([r, row]: [number, number]) => `${r}:${row}`)),
        ));
      }

      // Big win detection — tiered celebrations
      const cur = store.activeCurrency;
      const rate = fxRate(cur, store.config);
      const amountText = (n: number) => `${CURRENCY_SYMBOLS[cur]}${n.toFixed(4)}`;
      const bdtText = (n: number) => `৳${(n * rate).toLocaleString(lang === "bn" ? "bn-BD" : "en-US")}`;
      const ratio = store.betAmount > 0 ? winAmount / store.betAmount : 0;
      // D3: celebration thresholds + the on/off switch come from admin
      // config (B2). Defaults (50x big / 100x mega) match the shipped
      // behaviour and the server's isBigWin definition exactly.
      const celebrationsOff = store.config?.celebrations_enabled === false;
      const bigX = typeof store.config?.big_win_threshold_x === "number" ? store.config.big_win_threshold_x : 50;
      const megaX = typeof store.config?.mega_win_threshold_x === "number" ? store.config.mega_win_threshold_x : 100;
      if (result.isJackpot) {
        audio.play("lightning-crack");
        audio.play("win-jackpot");
        audio.play("coin-cascade");
        audio.play("thunder-distant", 0.8);
        setLightningFlash(true);
        setTimeout(() => setLightningFlash(false), 800);
        if (!celebrationsOff) {
          setCelebration({ tier: "jackpot" as CelebrationTier, title: t("jackpotWin"), amount: winAmount, amountText, bdtText });
          store.setBigWinAmount(winAmount);
          store.setBigWinAnimation(true);
        }
      } else if (ratio >= bigX) {
        audio.play("lightning-crack");
        audio.play(ratio >= megaX ? "win-mega" : "win-big");
        audio.play("coin-cascade", 0.7);
        setLightningFlash(true);
        setTimeout(() => setLightningFlash(false), 800);
        if (!celebrationsOff) {
          const tier: CelebrationTier = ratio >= megaX ? "mega" : "big";
          setCelebration({ tier, title: tier === "mega" ? t("megaWin") : t("bigWin"), amount: winAmount, amountText, bdtText });
          store.setBigWinAmount(winAmount);
          store.setBigWinAnimation(true);
        } else {
          store.setGameState("winning");
        }
      } else {
        if (winAmount > 0) audio.play("win-small");
        else audio.play("symbol-land");
        store.setGameState("winning");
      }

      // Animate win counter
      animateWinCounter(0, winAmount, 1000);

      // Free spins (A5: the server owns the state — remaining comes from
      // the response, never from local award math; retriggers add up).
      if (typeof result.freeSpinsRemaining === "number") {
        store.setFreeSpinsRemaining(result.freeSpinsRemaining);
        if (result.freeSpinsAwarded > 0) {
          store.setFreeSpinsTotal(
            result.isFreeSpin
              ? store.freeSpinsTotal + result.freeSpinsAwarded
              : result.freeSpinsAwarded,
          );
        }
        if (result.isFreeSpin) fsWinTotalRef.current += winAmount;
        if (result.freeSpinsAwarded > 0 && !result.isFreeSpin) fsWinTotalRef.current = 0;
        if (result.freeSpinsRemaining === 0) {
          store.setFreeSpinsTotal(0);
          // D2: free-spin outro theatre — celebrate the session total.
          if (fsWinTotalRef.current > 0) {
            setBigWinText(t("freeSpinsComplete", { amount: fsWinTotalRef.current.toFixed(2), cur: store.activeCurrency }));
            // The banner's amount line renders displayedWin, which
            // still holds the LAST spin's counter (0.0000 when the
            // final free spin lost) — point it at the round total
            // the banner text announces, or the two contradict.
            setDisplayedWin(fsWinTotalRef.current);
            setShowBigWin(true);
            fsWinTotalRef.current = 0;
          }
        }
      }
    } else {
      store.setGameState("idle");
    }

    // Free-spin auto-consume (A5): while the server says free spins
    // remain, keep spinning (they are free) until the count reaches zero.
    if (!store.isAutoSpinning && (result.freeSpinsRemaining ?? 0) > 0) {
      autoSpinTimer.current = setTimeout(() => {
        store.setGameState("idle");
        handleSpin();
      }, 1600);
    }

    // Auto spin handling — Step 17: pause every 25 spins; the
    // player restarts it manually (a real confirmation, not a
    // timer). The 100 cap comes from the auto_spin_options config.
    if (store.isAutoSpinning) {
      autoSpinDoneRef.current += 1;
      const nextCount = store.autoSpinCount - 1;
      if (nextCount > 0 && autoSpinDoneRef.current % 25 === 0) {
        store.setAutoSpinCount(nextCount);
        store.setIsAutoSpinning(false);
        toast.info(t("autoSpinPaused"));
      } else if (nextCount > 0) {
        store.setAutoSpinCount(nextCount);
        autoSpinTimer.current = setTimeout(() => {
          store.setGameState("idle");
          handleSpin();
        }, 1500);
      } else {
        store.setIsAutoSpinning(false);
        store.setAutoSpinCount(0);
      }
    }
  };

  const animateWinCounter = (start: number, end: number, duration: number) => {
    const startTime = performance.now();
    const animate = (currentTime: number) => {
      const elapsed = currentTime - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplayedWin(start + (end - start) * eased);
      if (progress < 1) requestAnimationFrame(animate);
    };
    requestAnimationFrame(animate);
  };

  const closeBigWin = () => {
    setShowBigWin(false);
    store.setBigWinAnimation(false);
    store.setGameState("idle");
  };

  // The celebration overlay must release the game exactly like
  // closeBigWin does: the celebration branch of handleSpinComplete
  // leaves gameState at "spinning" (blocking further spins), and
  // until now onDone only cleared the overlay — after a big / mega
  // / jackpot celebration with no banner stacked behind it, the
  // game stayed locked until a page reload. Found live 2026-10-31
  // during the celebration-sting verification.
  const closeCelebration = () => {
    setCelebration(null);
    store.setBigWinAnimation(false);
    // While free spins remain, the auto-consume timer owns the
    // game state (it idles and re-spins) — do not clobber it.
    if (store.freeSpinsRemaining <= 0) store.setGameState("idle");
  };

  // Keyboard shortcut
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.code === "Space" && store.gameState === "idle") {
        e.preventDefault();
        handleSpin();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [handleSpin, store.gameState]);

  // Stage Zeus mood: he throws thunder whenever a celebration or the
  // feature overlay fires; the board shakes with the strike.
  const zeusMood: ZeusMood =
    celebration || showBigWin
      ? "strike"
      : store.gameState === "spinning"
        ? "spin"
        : store.freeSpinsRemaining > 0
          ? "freespins"
          : "idle";
  useEffect(() => {
    if (celebration || showBigWin) {
      setStrikeKey((k) => k + 1);
      setBoardShake(true);
      const id = setTimeout(() => setBoardShake(false), 700);
      return () => clearTimeout(id);
    }
  }, [celebration, showBigWin]);

  const activeBalance = store.balances.find(b => b.currency === store.activeCurrency);
  const bdtEquivalent = activeBalance ? activeBalance.available * (BDT_RATES[store.activeCurrency] || 1) : 0;

  // U2: only currencies the admin actually enabled may be offered (BTC/ETH
  // were hardcoded in the selector while the server rejects them), and BDT
  // amounts are grouped for the active language with digits converted by
  // num() — previously the jackpot sub-line divided by 1e6 ("0.0M") and
  // BDT lines ignored the UI language.
  const enabledCurrencies = ((store.config?.currencies_enabled as string[] | undefined) ?? ["USDT", "BDT"]).filter((c) => c in CURRENCY_NAMES);
  const fmtBdt = (n: number) => num(n.toLocaleString(lang === "bn" ? "bn-BD" : "en-US", { maximumFractionDigits: 0 }));
  // Deposit v2 rails: the selected rail's public config (the server
  // re-resolves the destination from the same settings — the client
  // values are display only).
  const depCfg = (store.config ?? {}) as Record<string, any>;
  const depRail = depMethod === "redotpay"
    ? { id: depCfg.redot_pay_id as string | undefined, name: depCfg.redot_pay_name as string | undefined, qr: depCfg.redot_qr_image as string | undefined, link: undefined as string | undefined }
    : { id: depCfg.binance_pay_id as string | undefined, name: depCfg.binance_pay_name as string | undefined, qr: depCfg.binance_qr_image as string | undefined, link: depCfg.binance_pay_link as string | undefined };
  const depAnyRail = Boolean(depCfg.binance_pay_id || depCfg.redot_pay_id);
  const depMin = (depCfg.deposit_min as Record<string, string> | undefined)?.[depCurrency];
  const depMax = (depCfg.deposit_max as Record<string, string> | undefined)?.[depCurrency];

  return (
    <div className="min-h-screen bg-[#0A0A0F] text-white overflow-hidden relative">
      {/* Lightning flash overlay */}
      {lightningFlash && (
        <div className="absolute inset-0 bg-white/30 z-50 pointer-events-none animate-pulse" />
      )}

      {/* Background */}
      <div
        className="absolute inset-0 bg-cover bg-center opacity-60"
        style={{ backgroundImage: "url(/assets/bg-storm.jpg)" }}
      />
      <div className="absolute inset-0 bg-gradient-to-b from-transparent via-[#0A0A0F]/50 to-[#0A0A0F]" />

      {/* Animated particles */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        {Array.from({ length: 30 }).map((_, i) => (
          <div
            key={i}
            className="absolute w-1 h-1 bg-[#D4AF37]/40 rounded-full animate-float"
            style={{
              left: `${Math.random() * 100}%`,
              top: `${Math.random() * 100}%`,
              animationDelay: `${Math.random() * 5}s`,
              animationDuration: `${3 + Math.random() * 4}s`,
            }}
          />
        ))}
      </div>

      {/* Header — U2: sticky and responsive. On phones it wraps into
          two tidy rows so the balance and wallet are ALWAYS visible and
          reachable (previously one rigid desktop row pushed them
          off-screen); on desktop it stays a single polished bar. */}
      <header className="sticky top-0 z-40 bg-[#0A0A0F]/95 backdrop-blur-xl border-b border-[#2A2A35]">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 sm:px-4 py-2.5">
        <div className="flex items-center gap-2.5 mr-auto">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-[#F4D03F] via-[#D4AF37] to-[#996E20] flex items-center justify-center shadow-[0_0_18px_rgba(212,175,55,0.35)] shrink-0">
            <Zap className="w-5 h-5 text-black" fill="currentColor" />
          </div>
          <span className="text-lg sm:text-xl font-bold tracking-wider text-white whitespace-nowrap" style={{ fontFamily: "Cinzel, serif" }}>
            ZEUS <span className="text-[#D4AF37]">THUNDER</span>
          </span>
          <Badge variant="outline" className="hidden md:inline-flex bg-green-500/10 border-green-500/30 text-green-400 text-xs">
            <Shield className="w-3 h-3 mr-1" />
            {t("fairBadge")}
          </Badge>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <LanguageToggle className="border-[#2A2A35] bg-[#1A1A25] text-[#D4AF37] hover:bg-[#D4AF37]/10" />
          {/* Currency selector */}
          <select
            value={store.activeCurrency}
            onChange={(e) => {
              const next = e.target.value as typeof store.activeCurrency;
              store.setActiveCurrency(next);
              store.setBetAmount(snapToLadder(store.betAmount, ladderFor(store.config, next)));
            }}
            className="bg-[#1A1A25] border border-[#2A2A35] rounded-lg px-2.5 py-1.5 text-sm text-white focus:outline-none focus:border-[#D4AF37] max-w-[148px] sm:max-w-none"
          >
            {enabledCurrencies.map((c) => (
              <option key={c} value={c}>{t(`curName${c}` as "curNameUSDT")}</option>
            ))}
          </select>

          {/* Balance pill — amount first, BDT equivalent under it, and
              the wallet action as the gold button inside the pill so it
              can never be pushed off-screen on a phone. */}
          <div className="flex items-center gap-2.5 bg-gradient-to-b from-[#1E1E2A] to-[#14141E] border border-[#D4AF37]/35 rounded-xl pl-3 pr-1.5 py-1.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]">
            <div className="text-right leading-tight">
              <div className="text-sm font-mono font-bold text-white whitespace-nowrap">
                <span className="text-[#D4AF37] text-[11px] font-sans font-bold mr-1">{store.activeCurrency}</span>{num(activeBalance?.available.toFixed(2) || "0.00")}
              </div>
              <div className="text-[11px] text-[#9E9EAC] whitespace-nowrap">≈ ৳{fmtBdt(bdtEquivalent)}</div>
            </div>
            <button
              onClick={() => store.setShowWallet(true)}
              aria-label={t("wallet")}
              className="w-8 h-8 rounded-lg bg-[#D4AF37] text-black flex items-center justify-center hover:bg-[#F4D03F] shrink-0"
            >
              <Wallet className="w-4 h-4" />
            </button>
          </div>

          {/* Buttons */}
          <Button
            variant="outline"
            size="icon"
            onClick={() => store.setAudioEnabled(!store.audioEnabled)}
            className="border-[#2A2A35] bg-[#1A1A25] hover:bg-[#D4AF37]/20 hover:border-[#D4AF37]"
          >
            {store.audioEnabled ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4" />}
          </Button>
          <Button
            variant="outline"
            size="icon"
            onClick={() => store.setShowSettings(true)}
            className="border-[#2A2A35] bg-[#1A1A25] hover:bg-[#D4AF37]/20 hover:border-[#D4AF37]"
          >
            <Settings className="w-4 h-4" />
          </Button>
        </div>
        </div>
      </header>

      {/* B2: announcement banner + maintenance overlay (admin config) */}
      {store.config?.announcement ? (
        <div className="relative z-20 bg-[#D4AF37] text-black text-center text-sm font-medium px-4 py-2">
          {store.config.announcement}
        </div>
      ) : null}
      {store.config?.promo_text ? (
        <div className="relative z-20 bg-[#14141D] text-[#D4AF37] text-center text-sm font-medium px-4 py-2 border-b border-[#D4AF37]/30">
          {store.config.promo_text}
        </div>
      ) : null}
      {store.config?.maintenance_mode ? (
        <div className="fixed inset-0 z-50 bg-[#0A0A0F]/95 flex flex-col items-center justify-center gap-3 px-6 text-center">
          <div className="text-3xl font-bold text-[#D4AF37]">{t("maintenanceTitle")}</div>
          <p className="text-[#B8B8C8] max-w-md">{store.config?.maintenance_message ? store.config.maintenance_message : t("maintenanceBody")}</p>
        </div>
      ) : null}

      {/* Step 11: red envelope drop banner (renders only while a
          drop is live, so the stage stays clean otherwise) */}
      <RedEnvelope />

      {/* Main Game Area */}
      <div className="relative z-10 flex flex-col items-center justify-center min-h-[calc(100vh-72px)] px-3 py-4 sm:px-4 sm:py-6">
        {/* Jackpot Meters */}
        <div className="flex gap-2 sm:gap-4 mb-2.5 sm:mb-6 w-full max-w-[900px]">
          {((store.config?.features?.jackpots ?? true) ? store.jackpots : []).map((jp) => (
            <div
              key={jp.tier}
              className={`flex-1 min-w-0 overflow-hidden px-1.5 sm:px-5 py-1.5 sm:py-2 rounded-xl border bg-[#1A1A25]/80 backdrop-blur text-center ${
                jp.tier === "mega" ? "border-[#D4AF37] shadow-[0_0_24px_rgba(212,175,55,0.15)]" :
                jp.tier === "major" ? "border-[#C0C0C0]" : "border-[#CD7F32]"
              }`}
            >
              <div className="text-[10px] sm:text-xs uppercase tracking-wider text-[#9E9EAC]">{jp.tier === "mega" ? t("jackpotTierMega") : jp.tier === "major" ? t("jackpotTierMajor") : t("jackpotTierMini")}</div>
              <div className="text-[12px] sm:text-lg font-mono font-bold text-[#D4AF37] whitespace-nowrap">
                {num(jp.amount.toFixed(2))} {jp.currency ?? "USDT"}
              </div>
              <div className="text-[11px] sm:text-xs text-[#9E9EAC] whitespace-nowrap">৳{fmtBdt(jp.bdtEquivalent)}</div>
            </div>
          ))}
        </div>

        {/* Stage header: Zeus alive above the board's left edge,
            overlooking play; he reacts to spins and throws thunder
            on big wins. The ZEUS THUNDER title plaque that sat
            beside him was removed 2026-10-31 (owner request); the
            header also shrinks on phones so the board and the
            controls fit one screen. */}
        <div className="relative z-30 w-full max-w-[900px] h-[54px] sm:h-[118px]">
          <ZeusFigure
            mood={zeusMood}
            strikeKey={strikeKey}
            lite={store.liteMode}
            className="absolute left-0 sm:left-3 -bottom-3 sm:-bottom-4 w-[72px] h-[86px] sm:w-[132px] sm:h-[156px]"
          />
        </div>

        {/* Step 6: mode selector (classic default) + disclosure */}
        {(store.config as any)?.cascade_enabled ? (
          <div className="w-full max-w-[520px] mx-auto mb-2 sm:mb-3 space-y-2">
            <div className="flex rounded-full overflow-hidden border border-[#D4AF37]/40">
              {(["classic", "cascade"] as const).map((m) => (
                <button
                  key={m}
                  disabled={store.gameState === "spinning" || store.freeSpinsRemaining > 0}
                  onClick={() => { store.setMode(m); setLastResult(null); setLastScatter(0); }}
                  className={`flex-1 py-2 sm:py-1.5 text-xs sm:text-sm font-semibold disabled:opacity-60 ${
                    store.mode === m ? "bg-[#D4AF37] text-black" : "bg-black/40 text-[#B8B8C8]"
                  }`}
                >
                  {m === "classic" ? t("modeClassic") : `⚡ ${t("modeCascade")}`}
                </button>
              ))}
            </div>
            {store.mode === "cascade" && (
              <>
              <BuyFeatureButton />
              <p className="text-[11px] leading-snug text-[#9E9EAC] text-center px-1">
                {t("cascadeDisclosure").replace(
                  "{rtp}",
                  (() => {
                    const modes = (store.config as any)?.modes as Array<any> | undefined;
                    const rtp = modes?.find((x) => x.modeId === "cascade")?.certRtp;
                    return typeof rtp === "number" ? (rtp * 100).toFixed(1) : "96.5";
                  })(),
                )}
              </p>
              </>
            )}
          </div>
        ) : null}

        {/* Slot Machine Frame */}
        <div className={`relative bg-gradient-to-b from-[#1A1626] to-[#12121A]/98 border-2 border-[#D4AF37]/60 rounded-2xl p-1.5 shadow-[0_0_60px_rgba(212,175,55,0.2),inset_0_1px_0_rgba(255,255,255,0.06)] max-w-[900px] w-full ${boardShake ? "animate-board-shake" : ""}`}>
          {/* Greek key pattern border */}
          <div className="absolute inset-0 rounded-2xl border border-[#996E20]/40 pointer-events-none" />
          {/* Corner bolts */}
          {["top-1.5 left-1.5", "top-1.5 right-1.5", "bottom-1.5 left-1.5", "bottom-1.5 right-1.5"].map((pos) => (
            <div key={pos} className={`absolute ${pos} w-2.5 h-2.5 rounded-full bg-gradient-to-br from-[#F4D03F] to-[#996E20] shadow-[0_0_6px_rgba(212,175,55,0.6)]`} />
          ))}

          {/* Reels Container — Pixi-powered reel engine (with CSS fallback) */}
          <div className="bg-[#0A0A0F] rounded-xl p-2">
            {store.mode === "cascade" ? (
              <CascadeBoard
                steps={cascadeSteps}
                finalGrid={cascadeFinal}
                playKey={cascadePlayKey}
                turbo={store.turboMode}
                currencySymbol={CURRENCY_SYMBOLS[store.activeCurrency] ?? ""}
                onDone={() => cascadeDoneRef.current?.()}
                scatters={cascadeScatters}
                fsAwarded={cascadeFsAwarded}
                spinning={cascadeSpinning}
              />
            ) : engineFailed || store.liteMode ? (
              <div className="grid grid-cols-5 gap-1">
                {reelSymbols.map((reel, reelIndex) => (
                  <div key={reelIndex} className="relative overflow-hidden bg-[#0D0D14] rounded-lg">
                    {store.gameState === "spinning" && reelIndex >= liteStopped ? (
                      <div className="relative w-full aspect-[1/3] overflow-hidden">
                        <div className="animate-reel-scroll flex flex-col">
                          {liteScrollSymbols(reelIndex).map((sym, i) => (
                            <div key={i} className="relative w-full aspect-square flex items-center justify-center p-1">
                              <ScrollSymbol symbol={sym} />
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : (
                      <div className={`flex flex-col ${store.gameState === "spinning" && reelIndex === liteStopped - 1 ? "animate-reel-land" : ""}`}>
                        {reel.map((symbol, rowIndex) => (
                          <div key={rowIndex} className={`relative w-full aspect-square flex items-center justify-center p-1 ${symbol === "thunderbolt" ? "scatter-glow rounded-lg" : ""} ${winCells.has(`${reelIndex}:${rowIndex}`) ? "ring-2 ring-[#FFD54F] rounded-lg animate-pulse" : ""}`}>
                            <SymbolTile symbol={symbol} spinning={false} win={winCells.has(`${reelIndex}:${rowIndex}`)} />
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div className="relative">
                <div ref={reelsHostRef} className="w-full aspect-[5/3] min-h-[220px]" />
                {!boardReady && (
                  <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-[#0A0A0F]/85 rounded-lg">
                    <div className="w-10 h-10 rounded-full border-2 border-[#2A2A35] border-t-[#D4AF37] animate-spin" />
                    <div className="text-xs tracking-widest text-[#9E9EAC]">{t("loading")}</div>
                  </div>
                )}
                {/* Scatter badges over the settled Pixi board: the
                    thunderbolt is the free-spins trigger and must read
                    as SCATTER, like on the Lite board. */}
                {boardReady && store.gameState !== "spinning" && (
                  <div className="absolute inset-0 z-10 grid grid-cols-5 grid-rows-3 pointer-events-none">
                    {Array.from({ length: 3 }).flatMap((_, row) =>
                      Array.from({ length: 5 }).map((_, reel) => (
                        <div key={`${reel}:${row}`} className="relative">
                          {reelSymbols[reel]?.[row] === "thunderbolt" && (
                            <>
                              <span className="absolute inset-x-[6%] top-[6%] bottom-[12%] scatter-glow rounded-md" />
                              <span className="absolute bottom-[7%] inset-x-[10%] text-center text-[7px] sm:text-[9px] font-black tracking-[0.14em] text-[#FFD54F] bg-black/70 py-px rounded">
                                {t("scatterBadge")}
                              </span>
                            </>
                          )}
                        </div>
                      )),
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Payline indicators (left) */}
          <div className="absolute left-0 top-1/2 -translate-x-full -translate-y-1/2 flex flex-col gap-1 pr-1 hidden md:flex">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="w-2 h-2 rounded-full bg-[#2A2A35]" />
            ))}
          </div>
        </div>

        {/* Round result — U4: EVERY spin gets visible feedback. Before,
            only a win showed anything here; a losing spin changed nothing
            on screen but a small history pill, so the game felt dead. */}
        <div className="mt-2.5 sm:mt-4 min-h-[44px] sm:min-h-[54px] text-center">
          {lastResult && store.gameState !== "spinning" && (
            lastResult.win > 0 ? (
              <div className="animate-bounce-in">
                <div className="text-[#00E676] font-mono text-2xl font-bold">
                  +{num(displayedWin.toFixed(2))} {lastResult.currency}
                </div>
                <div className="text-sm text-[#9E9EAC]">
                  ≈ ৳{fmtBdt(displayedWin * (BDT_RATES[lastResult.currency] || 1))}
                </div>
              </div>
            ) : (
              <div>
                <div className="text-sm font-bold tracking-[0.25em] text-[#9E9EAC]">{t("noWin")}</div>
                <div className="text-xs text-[#5E5E6E] mt-1">
                  −{num(lastResult.bet.toFixed(2))} {lastResult.currency}
                </div>
              </div>
            )
          )}
          {/* Classic scatter tracker (cascade shows its own on the board) */}
          {lastScatter >= 1 && store.gameState !== "spinning" && store.mode === "classic" && (
            <div className="mt-1.5 flex items-center justify-center gap-2">
              <span className="px-2.5 py-0.5 rounded-full text-xs font-black tracking-wider bg-[#2A2110]/90 text-[#FFD54F] border border-[#FFD54F]/60">
                {t("scatterLanded", { n: lastScatter })}
              </span>
              {lastScatter === 2 && (
                <span className="text-[11px] text-[#F4D03F]/90">{t("scatterOneMore")}</span>
              )}
            </div>
          )}
        </div>

        {/* Control Panel — clean two-row layout (reference style):
            bet + info row on top, turbo / SPIN / auto centred below. */}
        {/* On phones this panel sticks to the viewport bottom
            (safe-area aware) so SPIN is always within thumb reach,
            even on short screens; the sections below scroll under
            it. Desktop keeps the static panel. */}
        <div className="mt-2.5 sm:mt-4 bg-[#12121A]/95 border border-[#2A2A35] rounded-xl p-3 sm:p-4 max-w-[900px] w-full max-sm:sticky max-sm:bottom-[max(0.5rem,env(safe-area-inset-bottom))] max-sm:z-40 max-sm:shadow-[0_-10px_36px_rgba(0,0,0,0.6)]">
          <div className="flex flex-wrap items-end justify-between gap-3">
            {/* Bet Controls */}
            <div className="flex items-center gap-3">
              <div>
                <div className="text-xs text-[#5E5E6E] mb-1">{t("betAmount")}</div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => store.setBetAmount(stepBet(store.betAmount, ladderFor(store.config, store.activeCurrency), "down"))}
                    className="border-[#2A2A35] bg-[#1A1A25] hover:bg-[#D4AF37]/20 text-xs"
                  >
                    −
                  </Button>
                  <div className="flex items-baseline justify-center gap-1.5 bg-[#0A0A0F] border border-[#2A2A35] rounded-lg px-3 py-2 min-w-[128px]">
                    <span className="text-[10px] font-bold tracking-wider text-[#D4AF37]">{store.activeCurrency}</span>
                    <span className="font-mono font-semibold text-white whitespace-nowrap">
                      {num(store.betAmount.toFixed(2))}
                    </span>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => store.setBetAmount(stepBet(store.betAmount, ladderFor(store.config, store.activeCurrency), "up"))}
                    className="border-[#2A2A35] bg-[#1A1A25] hover:bg-[#D4AF37]/20 text-xs"
                  >
                    +
                  </Button>
                </div>
              </div>

              <div className="flex flex-col gap-1">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => { const l = ladderFor(store.config, store.activeCurrency); store.setBetAmount(l[0]); }}
                  className="border-[#2A2A35] bg-[#1A1A25] hover:bg-[#D4AF37]/20 text-xs h-6"
                >
                  {t("betMin")}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => { const l = ladderFor(store.config, store.activeCurrency); store.setBetAmount(l[l.length - 1]); }}
                  className="border-[#2A2A35] bg-[#1A1A25] hover:bg-[#D4AF37]/20 text-xs h-6"
                >
                  {t("betMax")}
                </Button>
              </div>
            </div>

            {/* Info Buttons */}
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => store.setShowPaytable(true)}
                className="border-[#2A2A35] bg-[#1A1A25] hover:bg-[#D4AF37]/20"
              >
                <Info className="w-4 h-4 mr-1" />
                {t("paytable")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => store.setShowFairness(true)}
                className="border-[#2A2A35] bg-[#1A1A25] hover:bg-[#D4AF37]/20"
              >
                <Shield className="w-4 h-4 mr-1" />
                {t("fair")}
              </Button>
            </div>
          </div>

          {/* Spin row: round turbo/lite toggles, SPIN centre, auto right */}
          <div className="mt-3 sm:mt-4 flex items-center justify-center gap-5 sm:gap-9">
            <div className="flex flex-col gap-2">
              <button
                onClick={() => store.setTurboMode(!store.turboMode)}
                title={t("turbo")}
                className={`w-11 h-11 rounded-full border flex items-center justify-center transition-all ${
                  store.turboMode
                    ? "bg-[#4FC3F7]/20 border-[#4FC3F7] text-[#4FC3F7]"
                    : "border-[#2A2A35] bg-[#1A1A25] text-[#B8B8C8] hover:border-[#D4AF37]"
                }`}
              >
                <Zap className="w-5 h-5" />
              </button>
              <button
                onClick={() => store.setLiteMode(!store.liteMode)}
                title={t("liteMode")}
                className={`w-11 h-11 rounded-full border flex items-center justify-center transition-all ${
                  store.liteMode
                    ? "bg-[#4FC3F7]/20 border-[#4FC3F7] text-[#4FC3F7]"
                    : "border-[#2A2A35] bg-[#1A1A25] text-[#B8B8C8] hover:border-[#D4AF37]"
                }`}
              >
                <Sparkles className="w-5 h-5" />
              </button>
            </div>

            {/* Main Spin Button */}
            <div className="flex flex-col items-center gap-1">
              <button
                id="spin-btn"
                onClick={handleSpin}
                disabled={store.gameState === "spinning"}
                className={`relative w-24 h-24 sm:w-28 sm:h-28 rounded-full transition-all duration-200 ${
                  store.gameState === "spinning"
                    ? "opacity-70 scale-95 cursor-not-allowed"
                    : "hover:scale-105 hover:shadow-[0_0_30px_rgba(212,175,55,0.5)] active:scale-95"
                }`}
              >
                <img
                  src="/assets/btn-spin.webp"
                  alt={t("spinAlt")}
                  className={`w-full h-full object-contain ${
                    store.gameState === "spinning" ? "animate-spin-slow" : ""
                  }`}
                  draggable={false}
                />
              </button>
              <span className="text-[10px] font-bold tracking-[0.3em] text-[#D4AF37]">{t("spinAlt")}</span>
            </div>

            {/* Auto Spin */}
            <div className="flex flex-col items-center gap-1.5">
              <select
                value={store.autoSpinCount}
                onChange={(e) => {
                  const count = parseInt(e.target.value);
                  store.setAutoSpinCount(count);
                  store.setIsAutoSpinning(count > 0);
                }}
                className="bg-[#1A1A25] border border-[#2A2A35] rounded-full px-3 py-2.5 text-xs text-white focus:outline-none"
                disabled={store.gameState === "spinning"}
              >
                <option value={0}>{t("autoOff")}</option>
                {((store.config?.auto_spin_options as number[] | undefined) ?? [10, 25, 50, 100]).map((n) => (
                  <option key={n} value={n}>{t("autoSpins", { n })}</option>
                ))}
              </select>
              <span className="text-[9px] font-bold tracking-[0.25em] text-[#9E9EAC]">{t("autoLabel")}</span>
            </div>
          </div>
        </div>

        {/* Debug celebration triggers (only with ?debug=1) */}
      {new URLSearchParams(window.location.search).has("debug") && (
        <div className="fixed bottom-2 left-2 z-[70] flex gap-1">
          {(["big", "mega", "jackpot"] as const).map((tier) => (
            <button key={tier} onClick={() => setCelebration({ tier, title: tier === "big" ? t("bigWin") : tier === "mega" ? t("megaWin") : t("jackpotWin"), amount: 123.4567, amountText: (n: number) => `USDT${n.toFixed(2)}`, bdtText: (n: number) => `৳${n.toLocaleString(lang === "bn" ? "bn-BD" : "en-US")}` })} className="px-2 py-1 text-[10px] rounded bg-slate-800 text-slate-300 border border-slate-600">
              {tier}
            </button>
          ))}
        </div>
      )}

      {/* Recent Spins */}
        {recentSpins.length > 0 && (
          <div className="mt-4 bg-[#12121A]/80 border border-[#2A2A35] rounded-xl p-3 max-w-[900px] w-full">
            <div className="flex items-center gap-2 mb-2">
              <History className="w-4 h-4 text-[#5E5E6E]" />
              <span className="text-xs text-[#5E5E6E] uppercase tracking-wider">{t("recentSpins")}</span>
            </div>
            <div className="flex gap-2 overflow-x-auto pb-1">
              {recentSpins.slice(0, 10).map((s) => (
                <div
                  key={s.id}
                  className={`flex-shrink-0 px-3 py-1.5 rounded-lg text-xs font-mono ${
                    s.isWin
                      ? "bg-[#00E676]/10 border border-[#00E676]/30 text-[#00E676]"
                      : "bg-[#1A1A25] border border-[#2A2A35] text-[#5E5E6E]"
                  }`}
                >
                  {s.isWin ? "+" : ""}{num(parseFloat(s.winAmount).toFixed(2))} {s.currency}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Lounge cards below the stage — the play area stays clean
            (ticker / VIP / referral live here now, 2026-10-30). */}
        <div className="w-full max-w-[900px] mt-4 space-y-3">
          <LiveTicker />
          <VipWheel />
          <ReferralCard />
        </div>
      </div>

      {/* Tiered Win Celebration (GSAP) */}
      {celebration && (
        <Celebration data={celebration} onDone={closeCelebration} />
      )}

      {/* Feature Announcement Overlay (thunder strike / free spins) */}
      {showBigWin && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={closeBigWin}>
          <div className="text-center animate-bounce-in">
            <div className="text-6xl font-bold text-[#D4AF37] mb-4" style={{
              fontFamily: "Cinzel, serif",
              textShadow: "0 0 40px rgba(212,175,55,0.6), 0 0 80px rgba(212,175,55,0.3)"
            }}>
              {bigWinText}
            </div>
            <div className="text-4xl font-mono text-[#00E676] mb-2">
              {CURRENCY_SYMBOLS[store.activeCurrency]}{displayedWin.toFixed(4)}
            </div>
            <div className="text-lg text-[#5E5E6E]">
              ৳{(displayedWin * (BDT_RATES[store.activeCurrency] || 1)).toLocaleString(lang === "bn" ? "bn-BD" : "en-US")}
            </div>
            <Button
              onClick={closeBigWin}
              className="mt-6 bg-[#D4AF37] text-black hover:bg-[#F4D03F] font-semibold px-8"
            >
              Awesome!
            </Button>
          </div>
          {/* Confetti-like particles */}
          {Array.from({ length: 20 }).map((_, i) => (
            <div
              key={i}
              className="absolute w-3 h-3 rounded-full animate-confetti"
              style={{
                left: `${Math.random() * 100}%`,
                top: `-10px`,
                backgroundColor: ["#D4AF37", "#00E676", "#4FC3F7", "#F4D03F"][i % 4],
                animationDelay: `${Math.random() * 2}s`,
                animationDuration: `${2 + Math.random() * 2}s`,
              }}
            />
          ))}
        </div>
      )}

      {/* Paytable Dialog */}
      <Dialog open={store.showPaytable} onOpenChange={store.setShowPaytable}>
        <DialogContent className="bg-[#12121A] border-[#2A2A35] text-white max-w-lg max-h-[80vh]">
          <DialogHeader>
            <DialogTitle className="text-[#D4AF37] flex items-center gap-2" style={{ fontFamily: "Cinzel, serif" }}>
              <Sparkles className="w-5 h-5" />
              {t("paytable")}
            </DialogTitle>
          </DialogHeader>
          <ScrollArea className="max-h-[60vh]">
            <div className="space-y-3">
              {(paytableQuery.data?.symbols ?? []).map((item: any) => (
                <div key={item.name} className="flex items-center gap-3 bg-[#1A1A25] rounded-lg p-3">
                  <img
                    src={`/assets/symbol-${item.name}.webp`}
                    alt={t(`sym_${item.name}` as any)}
                    className="w-12 h-12 object-contain"
                  />
                  <div className="flex-1">
                    <div className="text-sm font-semibold text-white">{t(`sym_${item.name}` as any)}</div>
                    {item.isWild && <div className="text-xs text-[#4FC3F7]">{t("specialWild")}</div>}
                    {item.isScatter && <div className="text-xs text-[#4FC3F7]">{t("specialScatter")}</div>}
                    {item.isScatter && paytableQuery.data?.freeSpins && (
                      <div className="text-xs text-[#00E676]">
                        {t("scatterAwards", { a: (paytableQuery.data.freeSpins as any)["3"], b: (paytableQuery.data.freeSpins as any)["4"], c: (paytableQuery.data.freeSpins as any)["5"] })}
                      </div>
                    )}
                    {item.payouts && (
                      <div className="flex gap-3 mt-1">
                        <span className="text-xs text-[#5E5E6E]">3x: <span className="text-[#D4AF37]">{item.payouts["3"]}x</span></span>
                        <span className="text-xs text-[#5E5E6E]">4x: <span className="text-[#D4AF37]">{item.payouts["4"]}x</span></span>
                        <span className="text-xs text-[#5E5E6E]">5x: <span className="text-[#D4AF37]">{item.payouts["5"]}x</span></span>
                      </div>
                    )}
                  </div>
                </div>
              ))}
              <p className="text-xs text-[#5E5E6E] px-1">{t("paytableNote")}</p>
              <div className="bg-[#1A1A25] rounded-lg p-4 mt-4">
                <div className="flex justify-between text-sm">
                  <span className="text-[#5E5E6E]">{t("rtpLabel")}</span>
                  <span className="text-[#00E676] font-semibold">{paytableQuery.data?.rtp ?? 96}%</span>
                </div>
                <div className="flex justify-between text-sm mt-2">
                  <span className="text-[#5E5E6E]">{t("volatilityLabel")}</span>
                  <Badge variant="outline" className="border-purple-500/30 text-purple-400">{t("volatilityHigh")}</Badge>
                </div>
                <div className="flex justify-between text-sm mt-2">
                  <span className="text-[#5E5E6E]">{t("paylinesLabel")}</span>
                  <span className="text-white font-semibold">{paytableQuery.data?.paylines ?? 20} {t("fixedWord")}</span>
                </div>
              </div>
            </div>
          </ScrollArea>
        </DialogContent>
      </Dialog>

      {/* Fairness Dialog */}
      <Dialog open={store.showFairness} onOpenChange={store.setShowFairness}>
        <DialogContent className="bg-[#12121A] border-[#2A2A35] text-white max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-[#00E676] flex items-center gap-2">
              <Shield className="w-5 h-5" />
              {t("fairnessTitle")}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-[#9E9EAC]">
              {t("fairnessDesc")}
            </p>
            <div className="bg-[#1A1A25] rounded-lg p-4 space-y-3">
              <div>
                <div className="text-xs text-[#5E5E6E] mb-1">{t("serverSeedHash")}</div>
                <div className="font-mono text-xs text-white break-all bg-[#0A0A0F] rounded p-2">
                  {store.session?.serverSeedHash || t("startSessionToSeeHash")}
                </div>
              </div>
              <div>
                <div className="text-xs text-[#5E5E6E] mb-1">{t("clientSeed")}</div>
                <div className="flex gap-2">
                  <Input
                    value={store.clientSeed}
                    onChange={(e) => store.setClientSeed(e.target.value)}
                    className="bg-[#0A0A0F] border-[#2A2A35] text-white font-mono text-xs"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => store.setClientSeed(crypto.randomUUID().replace(/-/g, "").substring(0, 16))}
                    className="border-[#2A2A35] hover:bg-[#D4AF37]/20"
                  >
                    <RotateCcw className="w-4 h-4" />
                  </Button>
                </div>
              </div>
              <div>
                <div className="text-xs text-[#5E5E6E] mb-1">{t("nextNonce")}</div>
                <div className="font-mono text-sm text-white">
                  {store.session ? store.session.startingNonce + 1 : 0}
                </div>
              </div>
            </div>
            <div className="bg-[#0A0A0F] rounded-lg p-4">
              <div className="text-xs text-[#5E5E6E] mb-2">{t("verificationCode")}</div>
              <pre className="text-xs text-[#4FC3F7] font-mono overflow-x-auto">
{`// Verify a spin result
const hash = sha256(
  serverSeed + 
  clientSeed + 
  nonce
);

// First 10 bytes = 5 reel positions
for (let i = 0; i < 5; i++) {
  const value = parseInt(
    hash.substring(i*4, i*4+4), 16
  );
  reelStops[i] = value % reelLength;
}`}
              </pre>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Wallet Dialog */}
      <Dialog open={store.showWallet} onOpenChange={store.setShowWallet}>
        <DialogContent className="bg-[#12121A] border-[#2A2A35] text-white max-w-md">
          <DialogHeader>
            <DialogTitle className="text-[#D4AF37] flex items-center gap-2">
              <Wallet className="w-5 h-5" />
              {t("wallet")}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {store.balances.map((balance) => (
              <div key={balance.currency} className="bg-[#1A1A25] rounded-lg p-4 flex items-center justify-between">
                <div>
                  <div className="text-sm font-semibold text-white">{balance.currency}</div>
                  <div className="text-xs text-[#5E5E6E]">
                    ৳{(balance.available * fxRate(balance.currency, store.config)).toLocaleString(lang === "bn" ? "bn-BD" : "en-US")}
                  </div>
                </div>
                <div className="text-right">
                  <div className="font-mono text-lg text-white">
                    {balance.available.toFixed(4)}
                  </div>
                  <div className="text-xs text-[#5E5E6E]">{balance.currency}</div>
                  {(balance.bonus ?? 0) > 0 && (
                    <div className="text-xs text-[#D4AF37]">
                      {t("bonusBalance")}: {balance.bonus.toFixed(4)}
                    </div>
                  )}
                  {(balance.rebatePending ?? 0) > 0 && (
                    <div className="text-xs text-emerald-300/80">
                      {t("rebatePending").replace("{bdt}", num((balance.rebatePendingBdt ?? 0).toFixed(0)))}
                    </div>
                  )}
                </div>
              </div>
            ))}
            <div className="flex gap-2">
              <Button className="flex-1 bg-[#D4AF37] text-black hover:bg-[#F4D03F]" onClick={() => { setWalletMode("deposit"); setDepStep("amount"); }}>
                <TrendingUp className="w-4 h-4 mr-2" />
                {t("deposit")}
              </Button>
              <Button variant="outline" className="flex-1 border-[#2A2A35] hover:bg-[#D4AF37]/20" onClick={() => setWalletMode("withdraw")}>
                <Gift className="w-4 h-4 mr-2" />
                {t("withdraw")}
              </Button>
            </div>

            {walletMode === "deposit" && (
              <div className="bg-[#1A1A25] rounded-lg p-4 space-y-3">
                <div className="text-sm font-semibold text-[#D4AF37]">{t("requestDepositTitle")}</div>
                {(store.config as any)?.deposit_boost_enabled && (
                  <div className="text-xs bg-[#D4AF37]/10 border border-[#D4AF37]/40 text-[#F4D03F] rounded p-3 space-y-1">
                    <div>
                      {t("depositBoostBanner", {
                        pct: num(Number((store.config as any)?.deposit_boost_pct ?? 0)),
                        cur: String((store.config as any)?.deposit_boost_currency ?? "USDT"),
                      })}
                    </div>
                    {Number((store.config as any)?.usdt_bdt_premium ?? 0) > 0 && (
                      <div>
                        {t("depositPremiumRate", {
                          rate: num((BDT_RATES.USDT || 110) + Number((store.config as any)?.usdt_bdt_premium ?? 0)),
                        })}
                      </div>
                    )}
                  </div>
                )}
                <ReloadOffers />
                {!depAnyRail ? (
                  <div className="text-xs text-[#9E9EAC]">{t("depositsUnavailable")}</div>
                ) : depStep === "amount" ? (
                  <>
                    {/* Rail picker: brand tiles like the big-book
                        deposit grids (owner reference, 2026-10-30). */}
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        disabled={!depCfg.binance_pay_id}
                        onClick={() => setDepMethod("binance")}
                        className={`rounded-lg py-3 px-2 font-extrabold tracking-wide text-sm transition-all disabled:opacity-40 ${
                          depMethod === "binance"
                            ? "bg-[#F0B90B] text-black ring-2 ring-[#F0B90B]/60"
                            : "bg-[#F0B90B]/70 text-black/80 hover:bg-[#F0B90B]"
                        }`}
                      >
                        ◆ BINANCE <span className="font-semibold">PAY</span>
                      </button>
                      <button
                        type="button"
                        disabled={!depCfg.redot_pay_id}
                        onClick={() => setDepMethod("redotpay")}
                        className={`rounded-lg py-3 px-2 font-extrabold tracking-wide text-sm transition-all disabled:opacity-40 ${
                          depMethod === "redotpay"
                            ? "bg-[#14141C] text-[#FF3B4E] ring-2 ring-[#E8262D]/70 border border-[#E8262D]/60"
                            : "bg-[#14141C] text-[#FF3B4E]/70 border border-[#2A2A35] hover:border-[#E8262D]/50"
                        }`}
                      >
                        RedotPay
                      </button>
                    </div>
                    <div className="flex gap-2">
                      <select
                        value={depCurrency}
                        onChange={(e) => setDepCurrency(e.target.value as "USDT" | "BDT")}
                        className="bg-[#12121A] border border-[#2A2A35] rounded px-2 text-sm text-white"
                      >
                        {((store.config?.currencies_enabled as string[] | undefined) ?? ["USDT", "BDT"])
                          .filter((c) => c === "USDT" || c === "BDT")
                          .map((c) => (
                            <option key={c} value={c}>{c}</option>
                          ))}
                      </select>
                      <Input
                        type="number"
                        step="any"
                        min="0"
                        placeholder={t("amountPlaceholder")}
                        value={depAmount}
                        onChange={(e) => setDepAmount(e.target.value)}
                        className="flex-1 bg-[#12121A] border-[#2A2A35]"
                      />
                    </div>
                    {(depMin || depMax) && (
                      <div className="text-[11px] text-[#5E5E6E]">
                        {t("depositAmountRange", { min: depMin ? `${num(depMin)} ${depCurrency}` : "—", max: depMax ? `${num(depMax)} ${depCurrency}` : "—" })}
                      </div>
                    )}
                    {!depRail.id && (
                      <div className="text-xs text-[#9E9EAC]">{t("depositsUnavailable")}</div>
                    )}
                    <Button
                      size="sm"
                      className="w-full bg-[#00E676] text-black hover:bg-[#00E676]/80"
                      disabled={!depAmount || !depRail.id}
                      onClick={() => {
                        const amt = parseFloat(depAmount);
                        if (!amt || amt <= 0) {
                          toast.error(t("errInvalidDeposit"));
                          return;
                        }
                        setDepStep("pay");
                      }}
                    >
                      {t("depositContinue")}
                    </Button>
                  </>
                ) : (
                  <>
                    {/* Pay screen, modelled on the Binance Pay hosted
                        page (owner reference, 2026-10-30): amount,
                        brand, big QR card, download / open-app, then
                        the reference + I-have-paid submission. */}
                    <button
                      type="button"
                      onClick={() => setDepStep("amount")}
                      className="text-xs text-[#9E9EAC] hover:text-white"
                    >
                      ← {t("depositBack")}
                    </button>
                    <div className="text-center space-y-1">
                      <div className="text-[11px] uppercase tracking-[0.25em] text-[#9E9EAC]">{t("payLabel")}</div>
                      <div className="text-3xl font-extrabold text-white">
                        {num(depAmount)} <span className="text-lg text-[#D4AF37]">{depCurrency}</span>
                      </div>
                      {depMethod === "binance" ? (
                        <div className="text-lg font-extrabold tracking-wide text-[#F0B90B]">
                          ◆ BINANCE <span className="text-white">PAY</span>
                        </div>
                      ) : (
                        <div className="text-lg font-extrabold tracking-wide text-[#FF3B4E]">RedotPay</div>
                      )}
                    </div>
                    {depRail.qr ? (
                      <div className="flex flex-col items-center gap-2">
                        <div className="bg-white rounded-2xl p-3 w-56 max-w-full shadow-[0_8px_30px_rgba(0,0,0,0.45)]">
                          <img src={depRail.qr} alt="" className="w-full h-auto" loading="lazy" />
                        </div>
                        <div className="text-xs font-semibold text-white">
                          {depMethod === "binance" ? t("depositScanBinance") : t("depositScanRedot")}
                        </div>
                      </div>
                    ) : null}
                    <div className="text-xs bg-[#12121A] border border-[#2A2A35] rounded p-3 space-y-1">
                      <div className="text-[#5E5E6E]">{t("depositSendTo")}</div>
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-[#D4AF37] break-all text-sm">
                          {depMethod === "binance" ? t("depositPayIdLabel") : t("depositRedotIdLabel")}: {depRail.id}
                        </span>
                        <button
                          type="button"
                          className="text-[#9E9EAC] hover:text-white shrink-0"
                          onClick={() => {
                            navigator.clipboard?.writeText(String(depRail.id ?? ""));
                            toast.success(t("copied"));
                          }}
                        >
                          <Copy className="w-3.5 h-3.5" />
                        </button>
                      </div>
                      {depRail.name ? (
                        <div className="text-[#9E9EAC]">{t("depositPayName")}: {depRail.name}</div>
                      ) : null}
                      <div className="text-[#5E5E6E]">{t("depositVerifyNote")}</div>
                    </div>
                    {depRail.qr && (
                      <a
                        href={depRail.qr}
                        download
                        className="block w-full text-center rounded-lg py-2.5 font-bold text-sm bg-[#F0B90B] text-black hover:bg-[#F4D03F]"
                      >
                        {t("downloadQr")}
                      </a>
                    )}
                    {depMethod === "binance" && depRail.link && (
                      <a
                        href={depRail.link}
                        target="_blank"
                        rel="noreferrer"
                        className="block w-full text-center rounded-lg py-2.5 font-bold text-sm bg-[#1E2329] text-white border border-[#2A2A35] hover:bg-[#2A2A35]"
                      >
                        ◆ {t("openBinanceApp")}
                      </a>
                    )}
                    <Input
                      placeholder={t("depositReferencePlaceholder")}
                      value={depReference}
                      onChange={(e) => setDepReference(e.target.value)}
                      className="bg-[#12121A] border-[#2A2A35]"
                    />
                    <Button
                      size="sm"
                      className="w-full bg-[#00E676] text-black hover:bg-[#00E676]/80"
                      disabled={depositMutation.isPending}
                      onClick={handleDeposit}
                    >
                      {depositMutation.isPending ? "..." : t("iHavePaid")}
                    </Button>
                  </>
                )}
                {depositResult && (
                  <div className="text-xs bg-[#12121A] border border-[#2A2A35] rounded p-3 space-y-1">
                    <div className="text-[#00E676]">{t("depositPending")}</div>
                    <div className="text-[#5E5E6E]">{t("depositSendNote")}</div>
                  </div>
                )}
              </div>
            )}

            {walletMode === "withdraw" && (
              <div className="bg-[#1A1A25] rounded-lg p-4 space-y-3">
                <div className="text-sm font-semibold text-[#D4AF37]">{t("requestWithdrawTitle")}</div>
                <div className="flex gap-2">
                  <select
                    value={wdCurrency}
                    onChange={(e) => setWdCurrency(e.target.value as "BTC" | "ETH" | "USDT")}
                    className="bg-[#12121A] border border-[#2A2A35] rounded px-2 text-sm text-white"
                  >
                    <option value="BTC">BTC</option>
                    <option value="ETH">ETH</option>
                    <option value="USDT">USDT</option>
                  </select>
                  <Input
                    type="number"
                    step="any"
                    min="0"
                    placeholder={t("amountPlaceholder")}
                    value={wdAmount}
                    onChange={(e) => setWdAmount(e.target.value)}
                    className="flex-1 bg-[#12121A] border-[#2A2A35]"
                  />
                </div>
                <Input
                  placeholder={t("addressPlaceholder")}
                  value={wdAddress}
                  onChange={(e) => setWdAddress(e.target.value)}
                  className="bg-[#12121A] border-[#2A2A35] font-mono text-xs"
                />
                <Button
                  size="sm"
                  className="w-full bg-[#D4AF37] text-black hover:bg-[#F4D03F]"
                  disabled={withdrawMutation.isPending || !wdAmount || !wdAddress}
                  onClick={handleWithdraw}
                >
                  {withdrawMutation.isPending ? "..." : t("withdraw")}
                </Button>
                <p className="text-xs text-[#5E5E6E]">
                  {t("withdrawNote")}
                </p>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Settings Dialog */}
      <Dialog open={store.showSettings} onOpenChange={store.setShowSettings}>
        <DialogContent className="bg-[#12121A] border-[#2A2A35] text-white max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-white flex items-center gap-2">
              <Settings className="w-5 h-5" />
              {t("settings")}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <div className="text-sm text-[#9E9EAC] mb-2">{t("masterVolume")}</div>
              <Slider
                value={[store.masterVolume]}
                onValueChange={(v) => store.setMasterVolume(v[0])}
                max={100}
                step={1}
                className="w-full"
              />
              <div className="text-xs text-[#5E5E6E] mt-1">{store.masterVolume}%</div>
            </div>
            <div>
              <div className="text-sm text-[#9E9EAC] mb-2">{t("music")}</div>
              <Slider
                value={[store.musicVolume]}
                onValueChange={(v) => { store.setMusicVolume(v[0]); audio.setChannel("music", v[0]); }}
                max={100}
                step={1}
                className="w-full"
              />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-[#9E9EAC]">{t("bgMusic")}</span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => store.setMusicEnabled(!store.musicEnabled)}
                className={`border-[#2A2A35] ${store.musicEnabled ? "bg-[#00E676]/20 text-[#00E676]" : ""}`}
              >
                {store.musicEnabled ? t("on") : t("off")}
              </Button>
            </div>
            <div>
              <div className="text-sm text-[#9E9EAC] mb-2">{t("soundEffects")}</div>
              <Slider
                value={[store.sfxVolume]}
                onValueChange={(v) => { store.setSfxVolume(v[0]); audio.setChannel("sfx", v[0]); }}
                max={100}
                step={1}
                className="w-full"
              />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-[#9E9EAC]">{t("soundEffects")}</span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => store.setAudioEnabled(!store.audioEnabled)}
                className={`border-[#2A2A35] ${store.audioEnabled ? "bg-[#00E676]/20 text-[#00E676]" : ""}`}
              >
                {store.audioEnabled ? t("on") : t("off")}
              </Button>
            </div>
            <div className="bg-[#1A1A25] rounded-lg p-3">
              <div className="text-xs text-[#5E5E6E]">{t("settings")}</div>
              <div className="text-sm text-white mt-1">
                Primary: {store.activeCurrency} | BDT shown as equivalent
              </div>
            </div>
            <RgSettings />
            {/* P0.1: account actions — until now a signed-in player had
                NO way to sign out of the game at all. */}
            {user && (
              <div className="bg-[#1A1A25] rounded-lg p-3 space-y-3">
                <div>
                  <div className="text-xs text-[#5E5E6E]">{t("signedInAs")}</div>
                  <div className="text-sm text-white mt-0.5 truncate">
                    {user.name} <span className="text-[#9E9EAC]">· {user.email}</span>
                  </div>
                </div>
                <div className="flex gap-2">
                  {(user.role === "admin" || user.role === "super_admin") && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="flex-1 border-[#D4AF37]/50 text-[#D4AF37] hover:bg-[#D4AF37]/10"
                      onClick={() => { store.setShowSettings(false); navigate("/admin"); }}
                    >
                      <Shield className="w-4 h-4 mr-2" />
                      {t("adminPanel")}
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    className="flex-1 border-[#2A2A35] text-red-400 hover:bg-red-500/10 hover:text-red-300"
                    onClick={() => logout()}
                  >
                    <LogOut className="w-4 h-4 mr-2" />
                    {t("signOut")}
                  </Button>
                </div>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

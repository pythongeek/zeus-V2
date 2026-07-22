import { useState, useEffect, useCallback, useRef } from "react";
import { useGameStore } from "@/stores/gameStore";
import { trpc } from "@/providers/trpc";
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
} from "lucide-react";

const SYMBOL_IMAGES: Record<string, string> = {
  zeus: "/assets/symbol-zeus.png",
  thunderbolt: "/assets/symbol-thunderbolt.png",
  pegasus: "/assets/symbol-pegasus.png",
  temple: "/assets/symbol-temple.png",
  harp: "/assets/symbol-harp.png",
  amphora: "/assets/symbol-amphora.png",
  helmet: "/assets/symbol-helmet.png",
  shield: "/assets/symbol-shield.png",
  ace: "/assets/symbol-ace.png",
  king: "/assets/symbol-king.png",
  queen: "/assets/symbol-queen.png",
};

const PAYTABLE_DATA = [
  { symbol: "zeus", name: "ZEUS (Wild)", payouts: { 3: "50x", 4: "200x", 5: "1000x" }, special: "Substitutes all except Scatter" },
  { symbol: "thunderbolt", name: "Thunderbolt (Scatter)", payouts: { 3: "2x + 10 FS", 4: "5x + 15 FS", 5: "20x + 25 FS" }, special: "Triggers Free Spins" },
  { symbol: "pegasus", name: "Pegasus", payouts: { 3: "30x", 4: "100x", 5: "500x" }, special: "" },
  { symbol: "temple", name: "Temple", payouts: { 3: "25x", 4: "80x", 5: "400x" }, special: "" },
  { symbol: "harp", name: "Golden Harp", payouts: { 3: "20x", 4: "60x", 5: "300x" }, special: "" },
  { symbol: "amphora", name: "Amphora", payouts: { 3: "15x", 4: "40x", 5: "200x" }, special: "" },
  { symbol: "helmet", name: "Helmet", payouts: { 3: "10x", 4: "30x", 5: "150x" }, special: "" },
  { symbol: "shield", name: "Shield", payouts: { 3: "8x", 4: "25x", 5: "100x" }, special: "" },
  { symbol: "ace", name: "Ace", payouts: { 3: "5x", 4: "15x", 5: "60x" }, special: "" },
  { symbol: "king", name: "King", payouts: { 3: "5x", 4: "15x", 5: "60x" }, special: "" },
  { symbol: "queen", name: "Queen", payouts: { 3: "4x", 4: "10x", 5: "50x" }, special: "" },
];

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

export default function Game() {
  const store = useGameStore();
  const [spinningReels, setSpinningReels] = useState<boolean[]>([false, false, false, false, false]);
  const [reelSymbols, setReelSymbols] = useState<string[][]>([
    ["ace", "king", "queen"],
    ["shield", "helmet", "amphora"],
    ["harp", "temple", "pegasus"],
    ["thunderbolt", "zeus", "thunderbolt"],
    ["ace", "king", "queen"],
  ]);
  const [displayedWin, setDisplayedWin] = useState(0);
  const [showBigWin, setShowBigWin] = useState(false);
  const [bigWinText, setBigWinText] = useState("");
  const [lightningFlash, setLightningFlash] = useState(false);
  const [winningPositions, setWinningPositions] = useState<Array<[number, number]>>([]);
  const [recentSpins, setRecentSpins] = useState<Array<{ id: number; winAmount: string; betAmount: string; currency: string; isWin: boolean; createdAt: Date }>>([]);
  const autoSpinTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // tRPC queries and mutations
  const startSession = trpc.game.startSession.useMutation();
  const spin = trpc.game.spin.useMutation();

  // Initialize session on mount
  useEffect(() => {
    if (!store.session) {
      handleStartSession();
    }
  }, []);

  const handleStartSession = async () => {
    try {
      const result = await startSession.mutateAsync({ clientSeed: store.clientSeed });
      store.setSession({
        sessionId: result.sessionId,
        serverSeedHash: result.serverSeedHash,
        clientSeed: result.clientSeed,
        startingNonce: result.startingNonce,
      });
    } catch (e) {
      console.error("Failed to start session:", e);
    }
  };

  const handleSpin = useCallback(async () => {
    if (store.gameState === "spinning") return;
    if (!store.session) {
      await handleStartSession();
      return;
    }

    store.setGameState("spinning");
    store.setLastWin(0);
    setWinningPositions([]);

    // Start reel spin animation
    setSpinningReels([true, true, true, true, true]);

    try {
      const result = await spin.mutateAsync({
        sessionId: store.session.sessionId,
        betAmount: String(store.betAmount),
        currency: store.activeCurrency,
      });

      // Update session nonce
      store.setSession({
        ...store.session,
        startingNonce: result.nonce,
      });

      // Stop reels sequentially
      const stopDelays = store.turboMode ? [300, 300, 300, 300, 300] : [400, 600, 800, 1000, 1200];

      stopDelays.forEach((delay, i) => {
        setTimeout(() => {
          setSpinningReels(prev => {
            const next = [...prev];
            next[i] = false;
            return next;
          });

          // Update symbols for this reel
          if (result.symbols[i]) {
            setReelSymbols(prev => {
              const next = [...prev];
              next[i] = result.symbols[i];
              return next;
            });
          }

          // Last reel stopped
          if (i === 4) {
            setTimeout(() => {
              handleSpinComplete(result);
            }, 200);
          }
        }, delay);
      });
    } catch (e) {
      console.error("Spin failed:", e);
      store.setGameState("idle");
      setSpinningReels([false, false, false, false, false]);
    }
  }, [store.session, store.betAmount, store.activeCurrency, store.turboMode, store.gameState]);

  const handleSpinComplete = (result: any) => {
    store.setLastSpin(result);
    const winAmount = parseFloat(result.winAmount);
    store.setLastWin(winAmount);

    // Update balance
    const currentBalance = store.balances.find(b => b.currency === store.activeCurrency);
    if (currentBalance) {
      const newBalances = store.balances.map(b =>
        b.currency === store.activeCurrency
          ? { ...b, available: parseFloat(result.newBalance) }
          : b
      );
      store.setBalances(newBalances);
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

    if (winAmount > 0) {
      // Collect winning positions
      const allWinningPositions: Array<[number, number]> = [];
      if (result.winLines) {
        result.winLines.forEach((line: any) => {
          if (line.positions) {
            allWinningPositions.push(...line.positions);
          }
        });
      }
      setWinningPositions(allWinningPositions);

      // Big win detection
      if (result.isJackpot) {
        setBigWinText(result.jackpotTier?.toUpperCase() + " JACKPOT!");
        setShowBigWin(true);
        store.setBigWinAmount(winAmount);
        store.setBigWinAnimation(true);
        setLightningFlash(true);
        setTimeout(() => setLightningFlash(false), 500);
      } else if (result.isBigWin) {
        setBigWinText("BIG WIN!");
        setShowBigWin(true);
        store.setBigWinAmount(winAmount);
        store.setBigWinAnimation(true);
        setLightningFlash(true);
        setTimeout(() => setLightningFlash(false), 500);
      } else {
        store.setGameState("winning");
      }

      // Animate win counter
      animateWinCounter(0, winAmount, 1000);

      // Free spins
      if (result.freeSpinsAwarded > 0) {
        store.setFreeSpinsRemaining(result.freeSpinsAwarded);
        store.setFreeSpinsTotal(result.freeSpinsAwarded);
      }
    } else {
      store.setGameState("idle");
    }

    // Auto spin handling
    if (store.isAutoSpinning) {
      const nextCount = store.autoSpinCount - 1;
      if (nextCount > 0) {
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

  const activeBalance = store.balances.find(b => b.currency === store.activeCurrency);
  const bdtEquivalent = activeBalance ? activeBalance.available * (BDT_RATES[store.activeCurrency] || 1) : 0;

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

      {/* Header */}
      <header className="relative z-40 flex items-center justify-between px-4 py-3 bg-[#0A0A0F]/90 backdrop-blur-xl border-b border-[#2A2A35]">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <Zap className="w-7 h-7 text-[#D4AF37]" />
            <span className="text-xl font-bold tracking-wider text-[#D4AF37]" style={{ fontFamily: "Cinzel, serif" }}>
              THUNDER
            </span>
          </div>
          <Badge variant="outline" className="bg-green-500/10 border-green-500/30 text-green-400 text-xs">
            <Shield className="w-3 h-3 mr-1" />
            FAIR
          </Badge>
        </div>

        <div className="flex items-center gap-3">
          {/* Currency selector */}
          <select
            value={store.activeCurrency}
            onChange={(e) => store.setActiveCurrency(e.target.value as any)}
            className="bg-[#1A1A25] border border-[#2A2A35] rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:border-[#D4AF37]"
          >
            <option value="BTC">Bitcoin (BTC)</option>
            <option value="ETH">Ethereum (ETH)</option>
            <option value="USDT">Tether (USDT)</option>
            <option value="BDT">Bangladesh Taka (BDT)</option>
          </select>

          {/* Balance */}
          <div className="bg-[#1A1A25] border border-[#2A2A35] rounded-lg px-4 py-2 text-right">
            <div className="text-sm font-mono font-semibold text-white">
              {CURRENCY_SYMBOLS[store.activeCurrency]}{activeBalance?.available.toFixed(4) || "0.0000"}
            </div>
            <div className="text-xs text-[#5E5E6E]">
              ৳{bdtEquivalent.toLocaleString("bn-BD")}
            </div>
          </div>

          {/* Buttons */}
          <Button
            variant="outline"
            size="icon"
            onClick={() => store.setShowWallet(true)}
            className="border-[#2A2A35] bg-[#1A1A25] hover:bg-[#D4AF37]/20 hover:border-[#D4AF37]"
          >
            <Wallet className="w-4 h-4 text-[#D4AF37]" />
          </Button>
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
      </header>

      {/* Main Game Area */}
      <div className="relative z-10 flex flex-col items-center justify-center min-h-[calc(100vh-72px)] px-4 py-6">
        {/* Jackpot Meters */}
        <div className="flex gap-6 mb-6">
          {store.jackpots.map((jp) => (
            <div
              key={jp.tier}
              className={`px-5 py-2 rounded-lg border bg-[#1A1A25]/80 backdrop-blur ${
                jp.tier === "mega" ? "border-[#D4AF37]" :
                jp.tier === "major" ? "border-[#C0C0C0]" : "border-[#CD7F32]"
              }`}
            >
              <div className="text-xs uppercase tracking-wider text-[#5E5E6E]">{jp.tier}</div>
              <div className="text-lg font-mono font-bold text-[#D4AF37]">
                {jp.amount.toFixed(3)} BTC
              </div>
              <div className="text-xs text-[#5E5E6E]">৳{(jp.bdtEquivalent / 1000000).toFixed(1)}M</div>
            </div>
          ))}
        </div>

        {/* Game Title */}
        <div className="text-center mb-4">
          <h1 className="text-3xl font-bold text-[#D4AF37] tracking-widest" style={{ fontFamily: "Cinzel, serif" }}>
            ZEUS THUNDER
          </h1>
          <p className="text-xs text-[#5E5E6E] tracking-widest mt-1">PROVABLY FAIR • 20 PAYLINES • HIGH VOLATILITY</p>
        </div>

        {/* Zeus Character (decorative) */}
        <div className="absolute right-8 top-20 w-48 h-72 opacity-40 pointer-events-none hidden lg:block">
          <img src="/assets/zeus-character.png" alt="Zeus" className="w-full h-full object-contain" />
        </div>

        {/* Slot Machine Frame */}
        <div className="relative bg-[#12121A]/95 border-2 border-[#D4AF37]/50 rounded-xl p-1 shadow-[0_0_40px_rgba(212,175,55,0.15)] max-w-[900px] w-full">
          {/* Greek key pattern border */}
          <div className="absolute inset-0 rounded-xl border border-[#996E20]/30 pointer-events-none" />

          {/* Reels Container */}
          <div className="bg-[#0A0A0F] rounded-lg p-2">
            <div className="grid grid-cols-5 gap-1">
              {reelSymbols.map((reel, reelIndex) => (
                <div key={reelIndex} className="relative overflow-hidden bg-[#0D0D14] rounded-lg">
                  {/* Reel symbols */}
                  <div className={`flex flex-col ${spinningReels[reelIndex] ? "animate-spin-reel" : ""}`}>
                    {reel.map((symbol, rowIndex) => {
                      const isWinning = winningPositions.some(
                        ([r, row]) => r === reelIndex && row === rowIndex
                      );
                      return (
                        <div
                          key={rowIndex}
                          className={`relative w-full aspect-square flex items-center justify-center p-1 transition-all duration-300 ${
                            isWinning ? "scale-105 z-10" : ""
                          }`}
                        >
                          {/* Win glow effect */}
                          {isWinning && (
                            <div className="absolute inset-0 bg-[#00E676]/20 rounded-lg animate-pulse shadow-[0_0_20px_rgba(0,230,118,0.4)]" />
                          )}
                          <img
                            src={SYMBOL_IMAGES[symbol] || `/assets/symbol-${symbol}.png`}
                            alt={symbol}
                            className={`w-full h-full object-contain ${
                              spinningReels[reelIndex] ? "blur-[2px] scale-y-110" : ""
                            } transition-all duration-200`}
                            draggable={false}
                          />
                        </div>
                      );
                    })}
                  </div>

                  {/* Spinning overlay */}
                  {spinningReels[reelIndex] && (
                    <div className="absolute inset-0 bg-gradient-to-b from-transparent via-white/5 to-transparent animate-shimmer" />
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Payline indicators (left) */}
          <div className="absolute left-0 top-1/2 -translate-x-full -translate-y-1/2 flex flex-col gap-1 pr-1 hidden md:flex">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="w-2 h-2 rounded-full bg-[#2A2A35]" />
            ))}
          </div>
        </div>

        {/* Win Display */}
        {displayedWin > 0 && (
          <div className="mt-4 text-center animate-bounce-in">
            <div className="text-[#00E676] font-mono text-2xl font-bold">
              +{CURRENCY_SYMBOLS[store.activeCurrency]}{displayedWin.toFixed(4)}
            </div>
            <div className="text-sm text-[#5E5E6E]">
              ৳{(displayedWin * (BDT_RATES[store.activeCurrency] || 1)).toLocaleString("bn-BD")}
            </div>
          </div>
        )}

        {/* Control Panel */}
        <div className="mt-6 bg-[#12121A]/95 border border-[#2A2A35] rounded-xl p-4 max-w-[900px] w-full">
          <div className="flex flex-wrap items-center justify-between gap-4">
            {/* Bet Controls */}
            <div className="flex items-center gap-3">
              <div>
                <div className="text-xs text-[#5E5E6E] mb-1">BET AMOUNT</div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => store.setBetAmount(Math.max(store.minBet, store.betAmount / 2))}
                    className="border-[#2A2A35] bg-[#1A1A25] hover:bg-[#D4AF37]/20 text-xs"
                  >
                    ½
                  </Button>
                  <div className="bg-[#0A0A0F] border border-[#2A2A35] rounded-lg px-4 py-2 min-w-[120px] text-center">
                    <span className="font-mono font-semibold text-white">
                      {CURRENCY_SYMBOLS[store.activeCurrency]}{store.betAmount.toFixed(2)}
                    </span>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => store.setBetAmount(Math.min(store.maxBet, store.betAmount * 2))}
                    className="border-[#2A2A35] bg-[#1A1A25] hover:bg-[#D4AF37]/20 text-xs"
                  >
                    2×
                  </Button>
                </div>
              </div>

              <div className="flex flex-col gap-1">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => store.setBetAmount(store.minBet)}
                  className="border-[#2A2A35] bg-[#1A1A25] hover:bg-[#D4AF37]/20 text-xs h-6"
                >
                  MIN
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => store.setBetAmount(store.maxBet)}
                  className="border-[#2A2A35] bg-[#1A1A25] hover:bg-[#D4AF37]/20 text-xs h-6"
                >
                  MAX
                </Button>
              </div>
            </div>

            {/* Spin Button */}
            <div className="flex items-center gap-3">
              {/* Auto Spin */}
              <div className="flex flex-col gap-1">
                <select
                  value={store.autoSpinCount}
                  onChange={(e) => {
                    const count = parseInt(e.target.value);
                    store.setAutoSpinCount(count);
                    store.setIsAutoSpinning(count > 0);
                  }}
                  className="bg-[#1A1A25] border border-[#2A2A35] rounded-lg px-2 py-1 text-xs text-white focus:outline-none"
                  disabled={store.gameState === "spinning"}
                >
                  <option value={0}>Auto: Off</option>
                  <option value={10}>10 Spins</option>
                  <option value={25}>25 Spins</option>
                  <option value={50}>50 Spins</option>
                  <option value={100}>100 Spins</option>
                </select>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => store.setTurboMode(!store.turboMode)}
                  className={`border-[#2A2A35] text-xs h-6 ${
                    store.turboMode ? "bg-[#4FC3F7]/20 border-[#4FC3F7] text-[#4FC3F7]" : "bg-[#1A1A25]"
                  }`}
                >
                  <Zap className="w-3 h-3 mr-1" />
                  Turbo
                </Button>
              </div>

              {/* Main Spin Button */}
              <button
                onClick={handleSpin}
                disabled={store.gameState === "spinning"}
                className={`relative w-20 h-20 rounded-full transition-all duration-200 ${
                  store.gameState === "spinning"
                    ? "opacity-70 scale-95 cursor-not-allowed"
                    : "hover:scale-105 hover:shadow-[0_0_30px_rgba(212,175,55,0.5)] active:scale-95"
                }`}
              >
                <img
                  src="/assets/btn-spin.png"
                  alt="Spin"
                  className={`w-full h-full object-contain ${
                    store.gameState === "spinning" ? "animate-spin-slow" : ""
                  }`}
                  draggable={false}
                />
              </button>
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
                Paytable
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => store.setShowFairness(true)}
                className="border-[#2A2A35] bg-[#1A1A25] hover:bg-[#D4AF37]/20"
              >
                <Shield className="w-4 h-4 mr-1" />
                Fair
              </Button>
            </div>
          </div>
        </div>

        {/* Recent Spins */}
        {recentSpins.length > 0 && (
          <div className="mt-4 bg-[#12121A]/80 border border-[#2A2A35] rounded-xl p-3 max-w-[900px] w-full">
            <div className="flex items-center gap-2 mb-2">
              <History className="w-4 h-4 text-[#5E5E6E]" />
              <span className="text-xs text-[#5E5E6E] uppercase tracking-wider">Recent Spins</span>
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
                  {s.isWin ? "+" : ""}{parseFloat(s.winAmount).toFixed(2)} {s.currency}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Big Win Overlay */}
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
              ৳{(displayedWin * (BDT_RATES[store.activeCurrency] || 1)).toLocaleString("bn-BD")}
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
              PAYTABLE
            </DialogTitle>
          </DialogHeader>
          <ScrollArea className="max-h-[60vh]">
            <div className="space-y-3">
              {PAYTABLE_DATA.map((item) => (
                <div key={item.symbol} className="flex items-center gap-3 bg-[#1A1A25] rounded-lg p-3">
                  <img
                    src={`/assets/symbol-${item.symbol}.png`}
                    alt={item.name}
                    className="w-12 h-12 object-contain"
                  />
                  <div className="flex-1">
                    <div className="text-sm font-semibold text-white">{item.name}</div>
                    {item.special && <div className="text-xs text-[#4FC3F7]">{item.special}</div>}
                    <div className="flex gap-3 mt-1">
                      <span className="text-xs text-[#5E5E6E]">3x: <span className="text-[#D4AF37]">{item.payouts[3]}</span></span>
                      <span className="text-xs text-[#5E5E6E]">4x: <span className="text-[#D4AF37]">{item.payouts[4]}</span></span>
                      <span className="text-xs text-[#5E5E6E]">5x: <span className="text-[#D4AF37]">{item.payouts[5]}</span></span>
                    </div>
                  </div>
                </div>
              ))}
              <div className="bg-[#1A1A25] rounded-lg p-4 mt-4">
                <div className="flex justify-between text-sm">
                  <span className="text-[#5E5E6E]">Return to Player (RTP)</span>
                  <span className="text-[#00E676] font-semibold">96.5%</span>
                </div>
                <div className="flex justify-between text-sm mt-2">
                  <span className="text-[#5E5E6E]">Volatility</span>
                  <Badge variant="outline" className="border-purple-500/30 text-purple-400">HIGH</Badge>
                </div>
                <div className="flex justify-between text-sm mt-2">
                  <span className="text-[#5E5E6E]">Paylines</span>
                  <span className="text-white font-semibold">20 Fixed</span>
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
              Provably Fair Verification
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-[#9E9EAC]">
              Every spin result is determined by a SHA-256 hash of your client seed + our server seed + nonce.
              You can verify any spin independently.
            </p>
            <div className="bg-[#1A1A25] rounded-lg p-4 space-y-3">
              <div>
                <div className="text-xs text-[#5E5E6E] mb-1">Server Seed Hash</div>
                <div className="font-mono text-xs text-white break-all bg-[#0A0A0F] rounded p-2">
                  {store.session?.serverSeedHash || "Start a session to see hash"}
                </div>
              </div>
              <div>
                <div className="text-xs text-[#5E5E6E] mb-1">Client Seed</div>
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
                <div className="text-xs text-[#5E5E6E] mb-1">Next Nonce</div>
                <div className="font-mono text-sm text-white">
                  {store.session ? store.session.startingNonce + 1 : 0}
                </div>
              </div>
            </div>
            <div className="bg-[#0A0A0F] rounded-lg p-4">
              <div className="text-xs text-[#5E5E6E] mb-2">Verification Code (JavaScript)</div>
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
              Wallet
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {store.balances.map((balance) => (
              <div key={balance.currency} className="bg-[#1A1A25] rounded-lg p-4 flex items-center justify-between">
                <div>
                  <div className="text-sm font-semibold text-white">{balance.currency}</div>
                  <div className="text-xs text-[#5E5E6E]">
                    ৳{(balance.available * (BDT_RATES[balance.currency] || 1)).toLocaleString("bn-BD")}
                  </div>
                </div>
                <div className="text-right">
                  <div className="font-mono text-lg text-white">
                    {balance.available.toFixed(4)}
                  </div>
                  <div className="text-xs text-[#5E5E6E]">{balance.currency}</div>
                </div>
              </div>
            ))}
            <div className="flex gap-2">
              <Button className="flex-1 bg-[#D4AF37] text-black hover:bg-[#F4D03F]">
                <TrendingUp className="w-4 h-4 mr-2" />
                Deposit
              </Button>
              <Button variant="outline" className="flex-1 border-[#2A2A35] hover:bg-[#D4AF37]/20">
                <Gift className="w-4 h-4 mr-2" />
                Withdraw
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Settings Dialog */}
      <Dialog open={store.showSettings} onOpenChange={store.setShowSettings}>
        <DialogContent className="bg-[#12121A] border-[#2A2A35] text-white max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-white flex items-center gap-2">
              <Settings className="w-5 h-5" />
              Settings
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <div className="text-sm text-[#9E9EAC] mb-2">Master Volume</div>
              <Slider
                value={[store.masterVolume]}
                onValueChange={(v) => store.setMasterVolume(v[0])}
                max={100}
                step={1}
                className="w-full"
              />
              <div className="text-xs text-[#5E5E6E] mt-1">{store.masterVolume}%</div>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-[#9E9EAC]">Sound Effects</span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => store.setAudioEnabled(!store.audioEnabled)}
                className={`border-[#2A2A35] ${store.audioEnabled ? "bg-[#00E676]/20 text-[#00E676]" : ""}`}
              >
                {store.audioEnabled ? "On" : "Off"}
              </Button>
            </div>
            <div className="bg-[#1A1A25] rounded-lg p-3">
              <div className="text-xs text-[#5E5E6E]">Currency Display</div>
              <div className="text-sm text-white mt-1">
                Primary: {store.activeCurrency} | BDT shown as equivalent
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

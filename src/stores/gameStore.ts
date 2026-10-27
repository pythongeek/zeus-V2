import { create } from "zustand";

export type GameState = "idle" | "spinning" | "winning" | "bonus" | "freespins";
export type Currency = "BTC" | "ETH" | "USDT" | "BDT";

interface WinLine {
  lineIndex: number;
  symbol: number;
  count: number;
  payout: number;
  positions: Array<[number, number]>;
}

interface SpinResult {
  reelPositions: number[];
  symbols: string[][];
  winAmount: string;
  winLines: WinLine[];
  isBigWin: boolean;
  isJackpot: boolean;
  featureTriggered: "none" | "free_spins" | "thunder_strike";
  freeSpinsAwarded: number;
  hash: string;
  newBalance: string;
  jackpotTier?: string | null;
}

interface GameSession {
  sessionId: number;
  serverSeedHash: string;
  clientSeed: string;
  startingNonce: number;
}

interface Balance {
  currency: Currency;
  available: number;
  locked: number;
  bdtEquivalent: number;
}

interface GameStore {
  // Game state
  gameState: GameState;
  setGameState: (state: GameState) => void;

  // Session
  session: GameSession | null;
  setSession: (session: GameSession | null) => void;

  // Balance
  balances: Balance[];
  setBalances: (balances: Balance[]) => void;
  activeCurrency: Currency;
  setActiveCurrency: (currency: Currency) => void;

  // Betting
  betAmount: number;
  setBetAmount: (amount: number) => void;
  minBet: number;
  maxBet: number;

  // Spin results
  lastSpin: SpinResult | null;
  setLastSpin: (spin: SpinResult | null) => void;
  lastWin: number;
  setLastWin: (win: number) => void;

  // Reels
  reelSymbols: string[][];
  setReelSymbols: (symbols: string[][]) => void;

  // Free spins
  freeSpinsRemaining: number;
  setFreeSpinsRemaining: (count: number) => void;
  freeSpinsTotal: number;
  setFreeSpinsTotal: (count: number) => void;

  // Auto spin
  autoSpinCount: number;
  setAutoSpinCount: (count: number) => void;
  isAutoSpinning: boolean;
  setIsAutoSpinning: (spinning: boolean) => void;

  // Turbo mode
  turboMode: boolean;
  setTurboMode: (turbo: boolean) => void;
  // C4: Lite mode — CSS reels instead of the Pixi canvas (persisted)
  liteMode: boolean;
  setLiteMode: (lite: boolean) => void;

  // Audio
  audioEnabled: boolean;
  setAudioEnabled: (enabled: boolean) => void;
  masterVolume: number;
  setMasterVolume: (volume: number) => void;
  musicVolume: number;
  setMusicVolume: (volume: number) => void;
  sfxVolume: number;
  setSfxVolume: (volume: number) => void;

  // UI
  showPaytable: boolean;
  setShowPaytable: (show: boolean) => void;
  showFairness: boolean;
  setShowFairness: (show: boolean) => void;
  showWallet: boolean;
  setShowWallet: (show: boolean) => void;
  showSettings: boolean;
  setShowSettings: (show: boolean) => void;
  bigWinAnimation: boolean;
  setBigWinAnimation: (show: boolean) => void;
  bigWinAmount: number;
  setBigWinAmount: (amount: number) => void;

  // Provably fair
  clientSeed: string;
  setClientSeed: (seed: string) => void;

  // Jackpot
  jackpots: { tier: string; amount: number; bdtEquivalent: number; currency?: string }[];
  setJackpots: (jackpots: { tier: string; amount: number; bdtEquivalent: number; currency?: string }[]) => void;
  // B2: public admin-controlled config from game.getConfig (null until loaded)
  config: Record<string, any> | null;
  setConfig: (config: Record<string, any>) => void;
}

export const useGameStore = create<GameStore>((set) => ({
  gameState: "idle",
  setGameState: (state) => set({ gameState: state }),

  session: null,
  setSession: (session) => set({ session }),

  balances: [],
  setBalances: (balances) => set({ balances }),
  activeCurrency: "USDT",
  setActiveCurrency: (currency) => set({ activeCurrency: currency }),

  betAmount: 1.0,
  setBetAmount: (amount) => set({ betAmount: amount }),
  minBet: 0.1,
  maxBet: 1000,

  lastSpin: null,
  setLastSpin: (spin) => set({ lastSpin: spin }),
  lastWin: 0,
  setLastWin: (win) => set({ lastWin: win }),

  reelSymbols: [],
  setReelSymbols: (symbols) => set({ reelSymbols: symbols }),

  freeSpinsRemaining: 0,
  setFreeSpinsRemaining: (count) => set({ freeSpinsRemaining: count }),
  freeSpinsTotal: 0,
  setFreeSpinsTotal: (count) => set({ freeSpinsTotal: count }),

  autoSpinCount: 0,
  setAutoSpinCount: (count) => set({ autoSpinCount: count }),
  isAutoSpinning: false,
  setIsAutoSpinning: (spinning) => set({ isAutoSpinning: spinning }),

  turboMode: false,
  setTurboMode: (turbo) => set({ turboMode: turbo }),
  liteMode: typeof localStorage !== "undefined" && localStorage.getItem("zeus.lite") === "1",
  setLiteMode: (lite) => {
    try { localStorage.setItem("zeus.lite", lite ? "1" : "0"); } catch { /* storage unavailable */ }
    set({ liteMode: lite });
  },

  audioEnabled: true,
  setAudioEnabled: (enabled) => set({ audioEnabled: enabled }),
  masterVolume: 50,
  setMasterVolume: (volume) => set({ masterVolume: volume }),
  musicVolume: 55,
  setMusicVolume: (volume) => set({ musicVolume: volume }),
  sfxVolume: 80,
  setSfxVolume: (volume) => set({ sfxVolume: volume }),

  showPaytable: false,
  setShowPaytable: (show) => set({ showPaytable: show }),
  showFairness: false,
  setShowFairness: (show) => set({ showFairness: show }),
  showWallet: false,
  setShowWallet: (show) => set({ showWallet: show }),
  showSettings: false,
  setShowSettings: (show) => set({ showSettings: show }),
  bigWinAnimation: false,
  setBigWinAnimation: (show) => set({ bigWinAnimation: show }),
  bigWinAmount: 0,
  setBigWinAmount: (amount) => set({ bigWinAmount: amount }),

  clientSeed: crypto.randomUUID().replace(/-/g, "").substring(0, 16),
  setClientSeed: (seed) => set({ clientSeed: seed }),

  jackpots: [],
  setJackpots: (jackpots) => set({ jackpots }),
  config: null,
  setConfig: (config) => set({ config }),
}));

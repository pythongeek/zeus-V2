# System Specification & Architecture (Zeus Slot Game)

## Overview
Zeus Slot is a full-stack Greek Mythology slot game built with React + TypeScript (Vite) on the frontend, tRPC + Hono/Node.js on the backend server, Drizzle ORM + SQLite/PostgreSQL on the database layer, and a Provably Fair SHA-256 RNG engine.

---

## Full-Stack Feature Audit Status

| Feature / UI Element | Component / ID | Execution Path | Status |
| :--- | :--- | :--- | :--- |
| **Spin Button** | `#spin-button` | `Game.tsx` ➔ `handleSpin()` ➔ `trpc.game.spin.useMutation` ➔ `gameRouter.spin` ➔ Drizzle DB `spins` + `balances` ➔ Sequential Reel Stop | `[FUNCTIONAL]` |
| **Auto Spin** | `#auto-spin-btn` | `Game.tsx` ➔ `handleAutoSpinToggle()` ➔ `useEffect` timer loop ➔ `handleSpin()` | `[FUNCTIONAL]` |
| **Turbo Mode** | `#turbo-mode-toggle` | `Game.tsx` ➔ `store.setTurboMode` ➔ `stopDelays = [300, 300, 300, 300, 300]` | `[FUNCTIONAL]` |
| **Bet Adjustment** | `#bet-increase` / `#bet-decrease` | `Game.tsx` ➔ `store.setBetAmount` ➔ `trpc.game.spin` input payload | `[FUNCTIONAL]` |
| **Currency Switcher** | `#currency-select` | `Game.tsx` ➔ `store.setActiveCurrency` ➔ `trpc.balance.get` / `trpc.game.spin` | `[FUNCTIONAL]` |
| **Provably Fair Modal** | `#fairness-modal` | `FairnessModal.tsx` ➔ `trpc.fairness.verify` ➔ `fairnessRouter.verify` ➔ SHA-256 Hash Audit | `[FUNCTIONAL]` |
| **Jackpot Pool Counter** | `#jackpot-banner` | `Game.tsx` ➔ `trpc.jackpot.getPool` ➔ `jackpotRouter.getPool` ➔ Drizzle DB `jackpotPool` | `[FUNCTIONAL]` |
| **User Authentication** | OAuth Callback / Session Cookie | `auth.ts` ➔ `authenticateRequest` ➔ `verifySessionToken` ➔ `findUserByUnionId` (with `demo_user` fallback) | `[FUNCTIONAL]` |
| **Paytable Dialog** | `#paytable-btn` | `Game.tsx` ➔ `Dialog` overlay with `PAYTABLE_DATA` | `[FUNCTIONAL]` |
| **Sound Effects / Audio** | `#sound-toggle` | State flag in `gameStore` (WebAudio engine placeholder) | `[MOCK_ONLY]` |

---

## Core Execution Paths

### 1. Spin Execution Path (`#spin-button`)
```
[DOM: #spin-button]
  │
  ├── onClick ➔ handleSpin()
  │     ├── Sets gameState = "spinning"
  │     ├── Sets spinningReels = [true, true, true, true, true]
  │     └── Invokes trpc.game.spin.mutateAsync({ sessionId, betAmount, currency })
  │
[API Server: tRPC /game/spin]
  │
  ├── gameRouter.spin handler
  │     ├── Validates active session & user balance in DB
  │     ├── Calculates provably fair spin (SHA256(serverSeed + clientSeed + nonce))
  │     ├── Evaluates 20 paylines & scatter bonus multipliers
  │     ├── Updates balances table & inserts spin log in spins table
  │     └── Returns { symbols, linePayouts, totalWin, nonce, hash }
  │
[DOM / UI Update]
  │
  ├── Stops reel animations sequentially (300ms turbo / 400-1200ms normal)
  ├── Displays winning payline positions & big win overlay if payout > 10x
  └── Updates displayed user balance & spin history
```

---

## Known Mocks & Verification Backlog
1. **Audio Sound FX**: Currently toggles a boolean flag in Zustand `useGameStore`. Real WebAudio assets pending.
2. **Deposit & Withdrawal Processing**: Real crypto node webhooks are simulated via database balance updates.

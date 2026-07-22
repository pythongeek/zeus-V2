import { authRouter } from "./auth-router";
import { createRouter, publicQuery } from "./middleware";
import { gameRouter } from "./routers/game";
import { balanceRouter } from "./routers/balance";
import { fairnessRouter } from "./routers/fairness";
import { jackpotRouter } from "./routers/jackpot";

export const appRouter = createRouter({
  ping: publicQuery.query(() => ({ ok: true, ts: Date.now() })),
  auth: authRouter,
  game: gameRouter,
  balance: balanceRouter,
  fairness: fairnessRouter,
  jackpot: jackpotRouter,
});

export type AppRouter = typeof appRouter;

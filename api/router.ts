import { authRouter } from "./auth-router";
import { authLocalRouter } from "./auth-local";
import { authMagicRouter } from "./auth-magic";
import { createRouter, publicQuery } from "./middleware";
import { gameRouter } from "./routers/game";
import { balanceRouter } from "./routers/balance";
import { fairnessRouter } from "./routers/fairness";
import { jackpotRouter } from "./routers/jackpot";
import { adminRouter } from "./routers/admin";

export const appRouter = createRouter({
  ping: publicQuery.query(() => ({ ok: true, ts: Date.now() })),
  auth: authRouter,
  authLocal: authLocalRouter,
  authMagic: authMagicRouter,
  game: gameRouter,
  balance: balanceRouter,
  fairness: fairnessRouter,
  jackpot: jackpotRouter,
  admin: adminRouter,
});

export type AppRouter = typeof appRouter;

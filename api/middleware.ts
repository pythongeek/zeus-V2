import { ErrorMessages } from "@contracts/constants";
import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import type { TrpcContext } from "./context";

// Business-rule failures are thrown as plain Errors with these messages.
// They are EXPECTED client mistakes and must surface as 400 + message,
// never as scary 500s. (Central mapping — avoids touching every router.)
const USER_FACING_EXACT = new Set([
  "Email or phone is required",
  "Password must be at least 8 characters",
  "Password too long",
  "Password must contain a letter",
  "Password must contain a digit",
  "An account with this email already exists",
  "An account with this phone already exists",
  "Invalid credentials",
  "Invalid email/phone or password",
  "Account disabled",
  "This account has no password set",
  "Current password is incorrect",
  "Invalid amount",
  "Insufficient balance",
  "Invalid bet amount",
  "Active session not found for this user",
  "Session not found",
  "Free spins still active: finish them before ending the session",
  "Game is under maintenance",
  "Currency not enabled",
  "Too many attempts — please wait a few minutes and try again",
  "You are spinning too fast — please slow down",
  "Unable to register from this client — please use a regular browser",
  "Withdrawal below minimum",
  "Withdrawal above maximum",
  "Spin could not be recorded — please try again",
  "Deposit transaction not found",
  "Withdrawal transaction not found",
  "User balance row missing",
]);
const USER_FACING_PREFIXES = [
  "Bet must be between ",
  "Transaction is ",
  "Locked balance ",
];

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
  errorFormatter({ shape, error }) {
    if (error.code === "INTERNAL_SERVER_ERROR") {
      const userFacing =
        USER_FACING_EXACT.has(error.message) ||
        USER_FACING_PREFIXES.some((p) => error.message.startsWith(p));
      if (userFacing) {
        return {
          ...shape,
          data: { ...shape.data, code: "BAD_REQUEST", httpStatus: 400 },
        };
      }
    }
    return shape;
  },
});

export const createRouter = t.router;
export const publicQuery = t.procedure;

const requireAuth = t.middleware(async (opts) => {
  const { ctx, next } = opts;

  if (!ctx.user) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: ErrorMessages.unauthenticated,
    });
  }

  return next({ ctx: { ...ctx, user: ctx.user } });
});

function requireRole(role: string) {
  return t.middleware(async (opts) => {
    const { ctx, next } = opts;

    if (!ctx.user || ctx.user.role !== role) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: ErrorMessages.insufficientRole,
      });
    }

    return next({ ctx: { ...ctx, user: ctx.user } });
  });
}

export const authedQuery = t.procedure.use(requireAuth);
export const adminQuery = authedQuery.use(requireRole("admin"));

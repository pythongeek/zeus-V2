import { z } from "zod";
import { TRPCError } from "@trpc/server";
import * as crypto from "crypto";
import * as cookie from "cookie";
import { Session } from "@contracts/constants";
import { getSessionCookieOptions } from "./lib/cookies";
import { createRouter, adminQuery, publicQuery } from "./middleware";
import { signSessionToken } from "./kimi/session";
import { getDb } from "./queries/connection";
import { users, verificationCodes } from "@db/schema";
import { eq, and } from "drizzle-orm";
import type { TrpcContext } from "./context";

const TOKEN_TTL_MS = 15 * 60 * 1000;

function hashToken(token: string, identifier: string): string {
  return crypto.createHmac("sha256", identifier).update(token).digest("hex");
}

async function issueSession(ctx: TrpcContext, unionId: string) {
  const token = await signSessionToken({
    unionId,
    clientId: "zeus-local",
  });
  const opts = getSessionCookieOptions(ctx.req.headers);
  ctx.resHeaders.append(
    "set-cookie",
    cookie.serialize(Session.cookieName, token, {
      httpOnly: opts.httpOnly,
      path: opts.path,
      sameSite: (opts.sameSite?.toLowerCase() ?? "lax") as "lax" | "none",
      secure: opts.secure,
      maxAge: Session.maxAgeMs / 1000,
    }),
  );
}

export const authMagicRouter = createRouter({
  /** Admin: create a one-time passwordless login link for a user. */
  createLoginLink: adminQuery
    .input(z.object({ email: z.string().email() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      const email = input.email.trim().toLowerCase();

      const user = await db
        .select({ id: users.id, unionId: users.unionId, isActive: users.isActive })
        .from(users)
        .where(eq(users.email, email))
        .then(rows => rows[0]);

      if (!user) throw new TRPCError({ code: "NOT_FOUND", message: "No account with that email" });
      if (!user.isActive) throw new TRPCError({ code: "FORBIDDEN", message: "Account disabled" });

      // Invalidate previous unconsumed links for this identity
      await db
        .update(verificationCodes)
        .set({ consumed: true })
        .where(
          and(
            eq(verificationCodes.identifier, email),
            eq(verificationCodes.purpose, "login"),
            eq(verificationCodes.consumed, false),
          ),
        );

      const token = crypto.randomBytes(32).toString("hex");
      await db.insert(verificationCodes).values({
        identifier: email,
        channel: "email",
        codeHash: hashToken(token, email),
        purpose: "login",
        expiresAt: new Date(Date.now() + TOKEN_TTL_MS),
      });

      return {
        url: `/login?token=${token}&email=${encodeURIComponent(email)}`,
        expiresInSeconds: TOKEN_TTL_MS / 1000,
      };
    }),

  /** Public: redeem a one-time link -> session cookie. */
  redeemToken: publicQuery
    .input(z.object({ email: z.string().email(), token: z.string().min(32).max(128) }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const email = input.email.trim().toLowerCase();

      const rows = await db
        .select()
        .from(verificationCodes)
        .where(
          and(
            eq(verificationCodes.identifier, email),
            eq(verificationCodes.purpose, "login"),
            eq(verificationCodes.consumed, false),
          ),
        );

      const now = Date.now();
      let matched: { id: number } | null = null;
      for (const row of rows) {
        if (row.expiresAt.getTime() < now) continue;
        const expected = Buffer.from(row.codeHash, "hex");
        const actual = Buffer.from(hashToken(input.token, email), "hex");
        if (expected.length === actual.length && crypto.timingSafeEqual(expected, actual)) {
          matched = { id: row.id };
          break;
        }
      }

      if (!matched) {
        throw new TRPCError({ code: "UNAUTHORIZED", message: "Invalid or expired login link" });
      }

      await db
        .update(verificationCodes)
        .set({ consumed: true })
        .where(eq(verificationCodes.id, matched.id));

      const user = await db
        .select()
        .from(users)
        .where(eq(users.email, email))
        .then(rows => rows[0]);

      if (!user) throw new TRPCError({ code: "NOT_FOUND", message: "Account not found" });
      if (!user.isActive) throw new TRPCError({ code: "FORBIDDEN", message: "Account disabled" });

      await db
        .update(users)
        .set({ lastSignInAt: new Date() })
        .where(eq(users.id, user.id));

      await issueSession(ctx, user.unionId);

      return {
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
        },
      };
    }),
});

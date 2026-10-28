import { z } from "zod";
import * as cookie from "cookie";
import { Session } from "@contracts/constants";
import { getSessionCookieOptions } from "./lib/cookies";
import { createRouter, publicQuery } from "./middleware";
import { signSessionToken } from "./kimi/session";
import { hashPassword, verifyPassword } from "./lib/password";
import { getDb } from "./queries/connection";
import { clientIp, looksLikeBot, rateLimit } from "./lib/rate-limit";
import { users } from "@db/schema";
import { eq, or } from "drizzle-orm";
import type { TrpcContext } from "./context";

function normalizeEmail(email?: string): string | undefined {
  const v = email?.trim().toLowerCase();
  return v || undefined;
}

function normalizePhone(phone?: string): string | undefined {
  const v = phone?.replace(/[\s\-()]/g, "").trim();
  return v || undefined;
}

function validatePasswordStrength(password: string): string | null {
  if (password.length < 8) return "Password must be at least 8 characters";
  if (password.length > 128) return "Password too long";
  if (!/[a-zA-Z]/.test(password)) return "Password must contain a letter";
  if (!/\d/.test(password)) return "Password must contain a digit";
  return null;
}

function sessionResponse(user: { id: number; unionId: string; name: string | null; email: string | null; phone: string | null; role: string }) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    role: user.role,
  };
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

export const authLocalRouter = createRouter({
  /** Register with email OR phone + password. */
  register: publicQuery
    .input(
      z.object({
        name: z.string().min(2).max(50),
        email: z.string().email().optional(),
        phone: z
          .string()
          .regex(/^\+?\d{10,15}$/, "Phone must be 10-15 digits, optionally with +")
          .optional(),
        // F3: 18+ confirmation is mandatory at registration.
        ageConfirmed: z.literal(true, {
          message: "You must confirm you are 18 or older to register",
        }),
        password: z.string().min(8).max(128),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // F1: bot shield + per-IP registration brake.
      if (looksLikeBot(ctx.req)) {
        throw new Error("Unable to register from this client — please use a regular browser");
      }
      if (!rateLimit(`register:${clientIp(ctx.req)}`, 5, 60 * 60 * 1000)) {
        throw new Error("Too many attempts — please wait a few minutes and try again");
      }
      const email = normalizeEmail(input.email);
      const phone = normalizePhone(input.phone);

      if (!email && !phone) {
        throw new Error("Email or phone is required");
      }

      const pwError = validatePasswordStrength(input.password);
      if (pwError) throw new Error(pwError);

      const db = getDb();

      // Uniqueness check (friendly error before hitting the unique index)
      const existing = await db
        .select({ id: users.id, email: users.email, phone: users.phone })
        .from(users)
        .where(
          or(
            email ? eq(users.email, email) : undefined,
            phone ? eq(users.phone, phone) : undefined,
          ),
        )
        .then(rows => rows[0]);

      if (existing) {
        if (email && existing.email === email) throw new Error("An account with this email already exists");
        throw new Error("An account with this phone already exists");
      }

      // unionId stays as the stable identity key for sessions; local accounts
      // use a namespaced id so they can never collide with OAuth ids.
      const unionId = email ? `local:email:${email}` : `local:phone:${phone}`;

      const [created] = await db
        .insert(users)
        .values({
          unionId,
          name: input.name.trim(),
          email: email ?? null,
          phone: phone ?? null,
          passwordHash: hashPassword(input.password),
          role: "user",
          lastSignInAt: new Date(),
        })
        .returning();

      await issueSession(ctx, created.unionId);

      return { user: sessionResponse(created) };
    }),

  /** Login with email or phone + password. */
  login: publicQuery
    .input(
      z.object({
        identifier: z.string().min(3).max(120), // email or phone
        password: z.string().min(1).max(128),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // F1: per IP+identifier login brake (counted before the credential
      // check so credential stuffing stalls at the door).
      if (!rateLimit(`login:${clientIp(ctx.req)}:${input.identifier.toLowerCase()}`, 10, 5 * 60 * 1000)) {
        throw new Error("Too many attempts — please wait a few minutes and try again");
      }
      const db = getDb();
      const email = normalizeEmail(input.identifier);
      const phone = normalizePhone(input.identifier);
      const looksEmail = input.identifier.includes("@");

      const row = await db
        .select()
        .from(users)
        .where(
          or(
            email ? eq(users.email, email) : undefined,
            phone && !looksEmail ? eq(users.phone, phone) : undefined,
          ),
        )
        .then(rows => rows[0]);

      // Uniform error: never reveal whether the account exists.
      const failed = new Error("Invalid credentials");
      if (!row || !row.passwordHash) throw failed;
      if (!verifyPassword(input.password, row.passwordHash)) throw failed;
      if (!row.isActive) throw new Error("Account disabled");

      await db
        .update(users)
        .set({ lastSignInAt: new Date() })
        .where(eq(users.id, row.id));

      await issueSession(ctx, row.unionId);

      return { user: sessionResponse(row) };
    }),

  /** Change password (requires an authenticated session). */
  changePassword: publicQuery
    .input(
      z.object({
        currentPassword: z.string().min(1),
        newPassword: z.string().min(8).max(128),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user) throw new Error("Authentication required");
      const db = getDb();
      const row = await db
        .select()
        .from(users)
        .where(eq(users.id, ctx.user.id))
        .then(rows => rows[0]);

      if (!row?.passwordHash) throw new Error("This account has no password set");
      if (!verifyPassword(input.currentPassword, row.passwordHash)) {
        throw new Error("Current password is incorrect");
      }
      const pwError = validatePasswordStrength(input.newPassword);
      if (pwError) throw new Error(pwError);

      await db
        .update(users)
        .set({ passwordHash: hashPassword(input.newPassword), updatedAt: new Date() })
        .where(eq(users.id, row.id));

      return { success: true };
    }),
});

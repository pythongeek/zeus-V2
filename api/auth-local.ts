import { z } from "zod";
import * as cookie from "cookie";
import QRCode from "qrcode";
import { Session } from "@contracts/constants";
import { getSessionCookieOptions } from "./lib/cookies";
import { createRouter, publicQuery, authedQuery } from "./middleware";
import { signSessionToken } from "./kimi/session";
import { hashPassword, verifyPassword } from "./lib/password";
import { getDb } from "./queries/connection";
import { clientIp, looksLikeBot, rateLimit } from "./lib/rate-limit";
import { getSetting } from "./lib/settings";
import {
  generateTotpSecret,
  verifyTotp as verifyTotpCode,
  otpauthUrl,
  encryptSecret,
  decryptSecret,
  generateRecoveryCodes,
  hashRecoveryCode,
  signPendingToken,
  verifyPendingToken,
  TOTP_PENDING_COOKIE,
} from "./lib/totp";
import { users, auditLog, totpRecoveryCodes } from "@db/schema";
import { eq, or, and, isNull } from "drizzle-orm";
import type { TrpcContext } from "./context";

async function writeAudit(
  ctx: TrpcContext,
  userId: number | null,
  action: string,
  details: Record<string, unknown>,
) {
  const db = getDb();
  await db.insert(auditLog).values({
    userId,
    action,
    details,
    ipAddress: ctx.req.headers.get("x-forwarded-for") ?? null,
    userAgent: ctx.req.headers.get("user-agent") ?? null,
  });
}

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

async function issueSession(
  ctx: TrpcContext,
  unionId: string,
  scope?: "setup",
) {
  // AP3: stamp the token with the account's current session epoch.
  const db = getDb();
  const epochRow = await db
    .select({ sessionEpoch: users.sessionEpoch })
    .from(users)
    .where(eq(users.unionId, unionId))
    .then(rows => rows[0]);
  const token = await signSessionToken({
    unionId,
    clientId: "zeus-local",
    epoch: epochRow?.sessionEpoch ?? 0,
    ...(scope ? { scope } : {}),
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
      // AP3: failed attempts are audited (identifier only) for the
      // admin Access view; auditing must never break login itself.
      const failed = new Error("Invalid credentials");
      if (!row || !row.passwordHash || !verifyPassword(input.password, row.passwordHash)) {
        try {
          await writeAudit(ctx, row?.id ?? null, "auth.loginFailed", {
            identifier: input.identifier,
          });
        } catch { /* audit is best-effort on the failure path */ }
        throw failed;
      }
      if (!row.isActive) throw new Error("Account disabled");
      try {
        await writeAudit(ctx, row.id, "auth.login", {});
      } catch { /* best-effort */ }

      await db
        .update(users)
        .set({ lastSignInAt: new Date() })
        .where(eq(users.id, row.id));

      // AP1: admin two-factor branching. Players are never affected.
      const isAdminTier = row.role !== "user";
      if (isAdminTier && row.totpEnabled) {
        // Password was step 1 only. Issue the 5-minute pending cookie;
        // the full session is minted by verifyTotp after a valid code.
        const pending = await signPendingToken(row.unionId);
        const opts = getSessionCookieOptions(ctx.req.headers);
        ctx.resHeaders.append(
          "set-cookie",
          cookie.serialize(TOTP_PENDING_COOKIE, pending, {
            httpOnly: true,
            path: "/",
            sameSite: (opts.sameSite?.toLowerCase() ?? "lax") as "lax" | "none",
            secure: opts.secure,
            maxAge: 300,
          }),
        );
        return { user: sessionResponse(row), requiresTotp: true };
      }
      if (isAdminTier && getSetting<boolean>("admin_2fa_required")) {
        // Enforcement on but not enrolled: a setup-scoped session that
        // can reach only the enrollment endpoints (middleware-enforced).
        await issueSession(ctx, row.unionId, "setup");
        return { user: sessionResponse(row), requiresSetup: true };
      }

      await issueSession(ctx, row.unionId);

      return { user: sessionResponse(row) };
    }),

  /**
   * AP1: step 2 of admin login — exchange the pending cookie + a
   * TOTP or recovery code for a full session.
   */
  verifyTotp: publicQuery
    .input(z.object({ code: z.string().min(4).max(20) }))
    .mutation(async ({ ctx, input }) => {
      const cookies = cookie.parse(ctx.req.headers.get("cookie") ?? "");
      const pending = cookies[TOTP_PENDING_COOKIE];
      const unionId = pending ? await verifyPendingToken(pending) : null;
      if (!unionId) throw new Error("Two-factor session expired — please log in again");
      if (!rateLimit(`totp:${clientIp(ctx.req)}:${unionId}`, 5, 5 * 60 * 1000)) {
        throw new Error("Too many attempts — please wait a few minutes and try again");
      }
      const db = getDb();
      const row = await db
        .select()
        .from(users)
        .where(eq(users.unionId, unionId))
        .then(rows => rows[0]);
      if (!row?.totpEnabled || !row.totpSecret) {
        throw new Error("Two-factor is not set up yet");
      }
      let ok = verifyTotpCode(decryptSecret(row.totpSecret), input.code);
      if (!ok) {
        // One-time recovery code path (hashes only are stored).
        const rc = await db
          .select()
          .from(totpRecoveryCodes)
          .where(
            and(
              eq(totpRecoveryCodes.userId, row.id),
              eq(totpRecoveryCodes.codeHash, hashRecoveryCode(input.code)),
              isNull(totpRecoveryCodes.usedAt),
            ),
          )
          .then(rows => rows[0]);
        if (rc) {
          await db
            .update(totpRecoveryCodes)
            .set({ usedAt: new Date() })
            .where(eq(totpRecoveryCodes.id, rc.id));
          ok = true;
        }
      }
      if (!ok) throw new Error("Invalid two-factor code");

      const opts = getSessionCookieOptions(ctx.req.headers);
      ctx.resHeaders.append(
        "set-cookie",
        cookie.serialize(TOTP_PENDING_COOKIE, "", {
          httpOnly: true,
          path: "/",
          sameSite: (opts.sameSite?.toLowerCase() ?? "lax") as "lax" | "none",
          secure: opts.secure,
          maxAge: 0,
        }),
      );
      await writeAudit(ctx, row.id, "auth.totpVerified", {});
      await issueSession(ctx, row.unionId);
      return { user: sessionResponse(row) };
    }),

  /** AP1: current 2FA state for the signed-in account. */
  totpStatus: authedQuery.query(async ({ ctx }) => {
    const db = getDb();
    const row = await db
      .select({ totpEnabled: users.totpEnabled })
      .from(users)
      .where(eq(users.id, ctx.user.id))
      .then(rows => rows[0]);
    return {
      enabled: !!row?.totpEnabled,
      required: !!getSetting<boolean>("admin_2fa_required"),
      scope: (ctx.user as { authScope?: string }).authScope === "setup" ? "setup" : "full",
    };
  }),

  /**
   * AP1: begin (or restart) enrollment. Generates a fresh secret and
   * returns it with a QR code; nothing is enforced until totpEnable
   * verifies a code from the authenticator app.
   */
  totpSetup: authedQuery.mutation(async ({ ctx }) => {
    if (ctx.user.role === "user") {
      throw new Error("Two-factor setup is for admin accounts only");
    }
    const db = getDb();
    const row = await db
      .select()
      .from(users)
      .where(eq(users.id, ctx.user.id))
      .then(rows => rows[0]);
    if (!row) throw new Error("Authentication required");
    if (row.totpEnabled) throw new Error("Two-factor is already enabled");
    const secret = generateTotpSecret();
    await db
      .update(users)
      .set({ totpSecret: encryptSecret(secret), updatedAt: new Date() })
      .where(eq(users.id, row.id));
    const url = otpauthUrl(secret, row.email ?? row.phone ?? `admin-${row.id}`);
    const qrDataUrl = await QRCode.toDataURL(url, { margin: 1, width: 260 });
    return { secret, otpauthUrl: url, qrDataUrl };
  }),

  /**
   * AP1: complete enrollment — first valid code flips totpEnabled on
   * and mints the one-time recovery codes (shown exactly once).
   * A setup-scoped session is upgraded to a full session here.
   */
  totpEnable: authedQuery
    .input(z.object({ code: z.string().min(6).max(8) }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const row = await db
        .select()
        .from(users)
        .where(eq(users.id, ctx.user.id))
        .then(rows => rows[0]);
      if (!row?.totpSecret) throw new Error("Two-factor is not set up yet");
      if (row.totpEnabled) throw new Error("Two-factor is already enabled");
      if (!verifyTotpCode(decryptSecret(row.totpSecret), input.code)) {
        throw new Error("Invalid two-factor code");
      }
      await db
        .update(users)
        .set({ totpEnabled: true, updatedAt: new Date() })
        .where(eq(users.id, row.id));
      await db
        .delete(totpRecoveryCodes)
        .where(eq(totpRecoveryCodes.userId, row.id));
      const codes = generateRecoveryCodes(10);
      for (const code of codes) {
        await db.insert(totpRecoveryCodes).values({
          userId: row.id,
          codeHash: hashRecoveryCode(code),
        });
      }
      await writeAudit(ctx, row.id, "auth.totpEnabled", {});
      if ((ctx.user as { authScope?: string }).authScope === "setup") {
        await issueSession(ctx, row.unionId);
      }
      return { recoveryCodes: codes };
    }),

  /** AP1: disable 2FA (requires a current code; blocked while enforced). */
  totpDisable: authedQuery
    .input(z.object({ code: z.string().min(6).max(20) }))
    .mutation(async ({ ctx, input }) => {
      if ((ctx.user as { authScope?: string }).authScope === "setup") {
        throw new Error("Admin two-factor setup is required before using the admin panel");
      }
      if (getSetting<boolean>("admin_2fa_required")) {
        throw new Error("Two-factor cannot be disabled while it is required for all admins");
      }
      const db = getDb();
      const row = await db
        .select()
        .from(users)
        .where(eq(users.id, ctx.user.id))
        .then(rows => rows[0]);
      if (!row?.totpEnabled || !row.totpSecret) {
        throw new Error("Two-factor is not set up yet");
      }
      if (!verifyTotpCode(decryptSecret(row.totpSecret), input.code)) {
        throw new Error("Invalid two-factor code");
      }
      await db
        .update(users)
        .set({ totpEnabled: false, totpSecret: null, updatedAt: new Date() })
        .where(eq(users.id, row.id));
      await db
        .delete(totpRecoveryCodes)
        .where(eq(totpRecoveryCodes.userId, row.id));
      await writeAudit(ctx, row.id, "auth.totpDisabled", {});
      return { success: true };
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

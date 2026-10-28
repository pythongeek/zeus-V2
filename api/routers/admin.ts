import { z } from "zod";
import { createRouter, adminFullQuery as adminQuery, superAdminQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { users, spins, jackpotPool, auditLog, transactions, balances } from "../../db/schema";
import { parseMoney, fmtMoney, canonicalMoney } from "../lib/money";
import { getAllSettings, setSetting } from "../lib/settings";
import { count, sum, desc, eq, and, or, inArray } from "drizzle-orm";
import type { TrpcContext } from "../context";

// Record every admin mutation for accountability. Failures to log are
// reported but never silently swallowed.
async function writeAudit(
  ctx: TrpcContext,
  action: string,
  details: Record<string, unknown>,
) {
  const db = getDb();
  await db.insert(auditLog).values({
    userId: ctx.user?.id ?? null,
    action,
    details,
    ipAddress: ctx.req.headers.get("x-forwarded-for") ?? null,
    userAgent: ctx.req.headers.get("user-agent") ?? null,
  });
}

export const adminRouter = createRouter({
  getStats: adminQuery.query(async () => {
    const db = getDb();

    const userRes = await db.select({ value: count() }).from(users);
    const totalUsersCount = userRes[0]?.value || 0;

    const spinRes = await db.select({
      spins: count(),
      wagered: sum(spins.betAmount),
      won: sum(spins.winAmount)
    }).from(spins);

    const totalSpinsCount = spinRes[0]?.spins || 0;
    const wagered = parseFloat(spinRes[0]?.wagered || "0");
    const won = parseFloat(spinRes[0]?.won || "0");

    const houseProfit = wagered - won;
    const houseRtp = wagered > 0 ? ((won / wagered) * 100).toFixed(2) : "0.00";

    // No fabricated demo numbers: all zeros are real values for a fresh DB.
    return {
      totalUsers: totalUsersCount,
      totalSpins: totalSpinsCount,
      totalWagered: wagered,
      totalWon: won,
      houseProfit,
      houseRtp: `${houseRtp}%`,
      activeSessions: 0,
    };
  }),

  getUsers: adminQuery.query(async () => {
    const db = getDb();
    const allUsers = await db.select().from(users).orderBy(desc(users.createdAt)).limit(50);
    return allUsers.map(u => ({
      id: u.id,
      unionId: u.unionId,
      name: u.name,
      avatar: u.avatar,
      role: u.role,
      isActive: u.isActive,
      lastSignInAt: u.lastSignInAt,
      createdAt: u.createdAt,
    }));
  }),

  // AP2: role management is a super-admin power, and the panel must
  // never be left without at least one super admin.
  updateUserRole: superAdminQuery
    .input(z.object({
      userId: z.number(),
      role: z.enum(["user", "admin", "super_admin"]),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const target = await db
        .select({ role: users.role })
        .from(users)
        .where(eq(users.id, input.userId))
        .then(rows => rows[0]);
      if (!target) throw new Error("User not found");
      if (target.role === "super_admin" && input.role !== "super_admin") {
        const supers = await db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.role, "super_admin"));
        if (supers.length <= 1) {
          throw new Error("At least one super admin must remain");
        }
      }
      await db.update(users).set({ role: input.role }).where(eq(users.id, input.userId));
      await writeAudit(ctx, "admin.updateUserRole", { ...input });
      return { success: true, userId: input.userId, role: input.role };
    }),

  updateUserActive: adminQuery
    .input(z.object({
      userId: z.number(),
      isActive: z.boolean(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      await db.update(users).set({ isActive: input.isActive }).where(eq(users.id, input.userId));
      await writeAudit(ctx, "admin.updateUserActive", { ...input });
      return { success: true, userId: input.userId, isActive: input.isActive };
    }),

  // AP2: pool amounts are owner-tier control.
  updateJackpot: superAdminQuery
    .input(z.object({
      tier: z.enum(["mini", "major", "mega"]),
      amount: z.number().positive(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      await db.update(jackpotPool)
        .set({ currentAmount: canonicalMoney(input.amount) })
        .where(eq(jackpotPool.tier, input.tier));
      await writeAudit(ctx, "admin.updateJackpot", { ...input });
      return { success: true, tier: input.tier, amount: input.amount };
    }),

  // ===== Money queue: deposit / withdrawal approvals =====

  listPendingTransactions: adminQuery.query(async () => {
    const db = getDb();
    const rows = await db
      .select({
        id: transactions.id,
        userId: transactions.userId,
        userName: users.name,
        userEmail: users.email,
        userPhone: users.phone,
        type: transactions.type,
        currency: transactions.currency,
        amount: transactions.amount,
        fee: transactions.fee,
        status: transactions.status,
        toAddress: transactions.toAddress,
        txHash: transactions.txHash,
        createdAt: transactions.createdAt,
      })
      .from(transactions)
      .leftJoin(users, eq(users.id, transactions.userId))
      .where(eq(transactions.status, "pending"))
      .orderBy(desc(transactions.createdAt))
      .limit(100);
    return rows;
  }),

  approveDeposit: adminQuery
    .input(z.object({ txId: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const tx = await db.select().from(transactions)
        .where(and(eq(transactions.id, input.txId), eq(transactions.type, "deposit")))
        .then(rows => rows[0]);
      if (!tx) throw new Error("Deposit transaction not found");
      if (tx.status !== "pending") throw new Error(`Transaction is ${tx.status}, not pending`);

      const amountMicro = parseMoney(tx.amount);

      await db.update(transactions)
        .set({ status: "confirmed", processedAt: new Date() })
        .where(eq(transactions.id, tx.id));

      const bal = await db.select().from(balances)
        .where(and(eq(balances.userId, tx.userId), eq(balances.currency, tx.currency)))
        .then(rows => rows[0]);

      if (bal) {
        await db.update(balances)
          .set({
            available: fmtMoney(parseMoney(bal.available) + amountMicro),
            totalDeposited: fmtMoney(parseMoney(bal.totalDeposited || "0") + amountMicro),
            updatedAt: new Date(),
          })
          .where(eq(balances.id, bal.id));
      } else {
        await db.insert(balances).values({
          userId: tx.userId,
          currency: tx.currency,
          available: canonicalMoney(tx.amount),
          totalDeposited: canonicalMoney(tx.amount),
        });
      }

      await writeAudit(ctx, "admin.approveDeposit", {
        txId: tx.id, userId: tx.userId, amount: tx.amount, currency: tx.currency,
      });
      return { success: true, txId: tx.id };
    }),

  approveWithdraw: adminQuery
    .input(z.object({ txId: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const tx = await db.select().from(transactions)
        .where(and(eq(transactions.id, input.txId), eq(transactions.type, "withdrawal")))
        .then(rows => rows[0]);
      if (!tx) throw new Error("Withdrawal transaction not found");
      if (tx.status !== "pending") throw new Error(`Transaction is ${tx.status}, not pending`);

      const amountMicro = parseMoney(tx.amount);

      // Locked funds leave the system; withdrawal total is recorded.
      const bal = await db.select().from(balances)
        .where(and(eq(balances.userId, tx.userId), eq(balances.currency, tx.currency)))
        .then(rows => rows[0]);
      if (!bal) throw new Error("User balance row missing");

      const lockedMicro = parseMoney(bal.locked || "0");
      if (lockedMicro < amountMicro) {
        throw new Error(`Locked balance ${bal.locked} is less than withdrawal ${tx.amount} — refusing`);
      }

      await db.update(balances)
        .set({
          locked: fmtMoney(lockedMicro - amountMicro),
          totalWithdrawn: fmtMoney(parseMoney(bal.totalWithdrawn || "0") + amountMicro),
          updatedAt: new Date(),
        })
        .where(eq(balances.id, bal.id));

      await db.update(transactions)
        .set({ status: "confirmed", processedAt: new Date() })
        .where(eq(transactions.id, tx.id));

      await writeAudit(ctx, "admin.approveWithdraw", {
        txId: tx.id, userId: tx.userId, amount: tx.amount, currency: tx.currency, toAddress: tx.toAddress,
      });
      return { success: true, txId: tx.id };
    }),

  rejectWithdraw: adminQuery
    .input(z.object({ txId: z.number(), reason: z.string().max(200).optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const tx = await db.select().from(transactions)
        .where(and(eq(transactions.id, input.txId), eq(transactions.type, "withdrawal")))
        .then(rows => rows[0]);
      if (!tx) throw new Error("Withdrawal transaction not found");
      if (tx.status !== "pending") throw new Error(`Transaction is ${tx.status}, not pending`);

      const amountMicro = parseMoney(tx.amount);

      // Refund: locked funds return to available.
      const bal = await db.select().from(balances)
        .where(and(eq(balances.userId, tx.userId), eq(balances.currency, tx.currency)))
        .then(rows => rows[0]);
      if (!bal) throw new Error("User balance row missing");

      const lockedMicro = parseMoney(bal.locked || "0");
      if (lockedMicro < amountMicro) {
        throw new Error(`Locked balance ${bal.locked} is less than withdrawal ${tx.amount} — refusing`);
      }

      await db.update(balances)
        .set({
          locked: fmtMoney(lockedMicro - amountMicro),
          available: fmtMoney(parseMoney(bal.available) + amountMicro),
          updatedAt: new Date(),
        })
        .where(eq(balances.id, bal.id));

      await db.update(transactions)
        .set({ status: "cancelled", processedAt: new Date() })
        .where(eq(transactions.id, tx.id));

      await writeAudit(ctx, "admin.rejectWithdraw", {
        txId: tx.id, userId: tx.userId, amount: tx.amount, currency: tx.currency, reason: input.reason ?? null,
      });
      return { success: true, txId: tx.id };
    }),

  // ===== B1: game settings (admin control plane) =====

  getSettings: adminQuery.query(async () => {
    return getAllSettings();
  }),

  // AP2: settings writes are a super-admin power (reads stay admin-tier).
  updateSettings: superAdminQuery
    .input(z.object({ entries: z.record(z.string(), z.unknown()) }))
    .mutation(async ({ ctx, input }) => {
      const changed: string[] = [];
      for (const [key, value] of Object.entries(input.entries)) {
        setSetting(key, value, ctx.user?.id ?? null);
        changed.push(key);
      }
      await writeAudit(ctx, "admin.updateSettings", { keys: changed });
      return { success: true, changed };
    }),

  // ===== AP3: access overview — admin accounts + auth events =====
  // Sessions are stateless JWTs, so there is no per-device session
  // list; this view shows the accounts, their 2FA state and last
  // sign-in, the recent auth event trail, and force sign-out works
  // by bumping the account's session epoch (see AP3 schema notes).
  getAccessOverview: adminQuery.query(async () => {
    const db = getDb();
    const admins = await db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        role: users.role,
        totpEnabled: users.totpEnabled,
        lastSignInAt: users.lastSignInAt,
        sessionEpoch: users.sessionEpoch,
      })
      .from(users)
      .where(or(eq(users.role, "admin"), eq(users.role, "super_admin")));
    const events = await db
      .select({
        id: auditLog.id,
        action: auditLog.action,
        details: auditLog.details,
        ipAddress: auditLog.ipAddress,
        createdAt: auditLog.createdAt,
        userEmail: users.email,
        userName: users.name,
      })
      .from(auditLog)
      .leftJoin(users, eq(auditLog.userId, users.id))
      .where(
        inArray(auditLog.action, [
          "auth.login",
          "auth.loginFailed",
          "auth.totpVerified",
          "auth.totpEnabled",
          "auth.totpDisabled",
          "auth.forceSignOut",
        ]),
      )
      .orderBy(desc(auditLog.createdAt))
      .limit(100);
    return { admins, events };
  }),

  forceSignOut: superAdminQuery
    .input(z.object({ userId: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const target = await db
        .select()
        .from(users)
        .where(eq(users.id, input.userId))
        .then(rows => rows[0]);
      if (!target) throw new Error("User not found");
      await db
        .update(users)
        .set({ sessionEpoch: (target.sessionEpoch ?? 0) + 1 })
        .where(eq(users.id, input.userId));
      await writeAudit(ctx, "auth.forceSignOut", {
        userId: input.userId,
        email: target.email,
      });
      return { success: true, userId: input.userId };
    }),

  // ===== B3: change audit log (read) =====

  getAuditLog: adminQuery
    .input(z.object({ limit: z.number().min(1).max(200).default(50) }).optional())
    .query(async ({ input }) => {
      const db = getDb();
      return db
        .select()
        .from(auditLog)
        .orderBy(desc(auditLog.createdAt))
        .limit(input?.limit ?? 50);
    }),
});

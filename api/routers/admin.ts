import { z } from "zod";
import { createRouter, adminFullQuery as adminQuery, superAdminQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { users, spins, jackpotPool, auditLog, transactions, balances, playerNotes } from "../../db/schema";
import { parseMoney, fmtMoney, canonicalMoney } from "../lib/money";
import { getAllSettings, getSetting, setSetting } from "../lib/settings";
import { toUsdt, getLimits, getUsage } from "../lib/limits";
import { hashPassword } from "../lib/password";
import { getSqliteClient } from "../queries/connection";
import crypto from "crypto";
import { decryptSecret, verifyTotp } from "../lib/totp";
import { count, sum, desc, eq, and, or, inArray, like, max as sqlMax } from "drizzle-orm";
import type { TrpcContext } from "../context";

// Record every admin mutation for accountability. Failures to log are
// reported but never silently swallowed.
function parseTags(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

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

  // ===== Section C: player management 360 =====

  // C1: player list with search (email/name/phone), status filter,
  // sorting, pagination, and USDT-equivalent balance totals.
  listPlayers: adminQuery
    .input(z.object({
      search: z.string().max(120).optional(),
      status: z.enum(["active", "frozen"]).optional(),
      sort: z.enum(["newest", "balance", "activity"]).default("newest"),
      limit: z.number().min(1).max(100).default(25),
      offset: z.number().min(0).default(0),
    }))
    .query(async ({ input }) => {
      const db = getDb();
      const conds = [];
      if (input.search) {
        const pattern = `%${input.search}%`;
        conds.push(or(like(users.email, pattern), like(users.name, pattern), like(users.phone, pattern)));
      }
      if (input.status === "active") conds.push(eq(users.isActive, true));
      if (input.status === "frozen") conds.push(eq(users.isActive, false));
      const where = conds.length ? and(...conds) : undefined;

      const totalRows = await db.select({ n: count() }).from(users).where(where);
      const total = totalRows[0]?.n ?? 0;

      // Balance/activity sorts need aggregates, so they page in JS
      // over a bounded candidate set (fine at current scale).
      const fetchLimit = input.sort === "newest" ? input.limit : 500;
      const fetchOffset = input.sort === "newest" ? input.offset : 0;
      const rows = await db
        .select()
        .from(users)
        .where(where)
        .orderBy(desc(users.createdAt))
        .limit(fetchLimit)
        .offset(fetchOffset);
      const ids = rows.map((u) => u.id);
      const bals = ids.length
        ? await db.select().from(balances).where(inArray(balances.userId, ids))
        : [];
      const lastSpins = ids.length
        ? await db
            .select({ userId: spins.userId, last: sqlMax(spins.createdAt) })
            .from(spins)
            .where(inArray(spins.userId, ids))
            .groupBy(spins.userId)
        : [];
      const balByUser = new Map<number, number>();
      for (const b of bals) {
        const v = toUsdt(parseFloat(b.available || "0") + parseFloat(b.locked || "0"), b.currency);
        balByUser.set(b.userId, (balByUser.get(b.userId) ?? 0) + v);
      }
      const spinByUser = new Map<number, any>();
      for (const r of lastSpins) spinByUser.set(r.userId, r.last);

      let enriched = rows.map((u) => ({
        id: u.id,
        name: u.name,
        email: u.email,
        phone: u.phone,
        role: u.role,
        isActive: u.isActive,
        tags: parseTags(u.tags),
        createdAt: u.createdAt,
        lastSignInAt: u.lastSignInAt,
        balanceUsdt: Math.round((balByUser.get(u.id) ?? 0) * 100) / 100,
        lastSpinAt: spinByUser.get(u.id) ?? null,
      }));
      if (input.sort === "balance") {
        enriched = enriched.sort((a, b) => b.balanceUsdt - a.balanceUsdt).slice(input.offset, input.offset + input.limit);
      } else if (input.sort === "activity") {
        enriched = enriched
          .sort((a, b) => new Date(b.lastSpinAt ?? 0).getTime() - new Date(a.lastSpinAt ?? 0).getTime())
          .slice(input.offset, input.offset + input.limit);
      }
      return { rows: enriched, total };
    }),

  // C2: everything about one player in a single payload.
  getPlayerDetail: adminQuery
    .input(z.object({ userId: z.number() }))
    .query(async ({ input }) => {
      const db = getDb();
      const user = await db.select().from(users).where(eq(users.id, input.userId)).then((r) => r[0]);
      if (!user) throw new Error("User not found");
      const bals = await db.select().from(balances).where(eq(balances.userId, input.userId));
      let depositedUsdt = 0;
      let withdrawnUsdt = 0;
      for (const b of bals) {
        depositedUsdt += toUsdt(parseFloat(b.totalDeposited || "0"), b.currency);
        withdrawnUsdt += toUsdt(parseFloat(b.totalWithdrawn || "0"), b.currency);
      }
      const spinAgg = await db
        .select({ currency: spins.currency, wagered: sum(spins.betAmount), won: sum(spins.winAmount), n: count() })
        .from(spins)
        .where(eq(spins.userId, input.userId))
        .groupBy(spins.currency);
      let wageredUsdt = 0;
      let wonUsdt = 0;
      let spinsCount = 0;
      for (const a of spinAgg) {
        wageredUsdt += toUsdt(parseFloat(a.wagered || "0"), a.currency);
        wonUsdt += toUsdt(parseFloat(a.won || "0"), a.currency);
        spinsCount += a.n || 0;
      }
      const recentSpins = await db
        .select({
          id: spins.id, betAmount: spins.betAmount, winAmount: spins.winAmount,
          currency: spins.currency, isFreeSpin: spins.isFreeSpin,
          featureTriggered: spins.featureTriggered, createdAt: spins.createdAt,
        })
        .from(spins)
        .where(eq(spins.userId, input.userId))
        .orderBy(desc(spins.createdAt))
        .limit(20);
      const recentTxs = await db
        .select()
        .from(transactions)
        .where(eq(transactions.userId, input.userId))
        .orderBy(desc(transactions.createdAt))
        .limit(20);
      const notes = getSqliteClient()
        .prepare(
          `SELECT n.id, n.note, n.created_at AS createdAt, u.email AS adminEmail
           FROM player_notes n LEFT JOIN users u ON u.id = n.admin_id
           WHERE n.user_id = ? ORDER BY n.id DESC LIMIT 50`,
        )
        .all(input.userId);
      const auditRows = await db
        .select()
        .from(auditLog)
        .orderBy(desc(auditLog.createdAt))
        .limit(300);
      const trail = auditRows
        .filter((r) => {
          // audit_log.details is a json-mode column: drizzle hands it
          // back already parsed (a string only in older rows).
          try {
            const d = typeof r.details === "string" ? JSON.parse(r.details) : (r.details ?? {});
            return (d as any).userId === input.userId;
          } catch {
            return false;
          }
        })
        .slice(0, 20)
        .map((r) => ({ id: r.id, action: r.action, details: r.details, createdAt: r.createdAt }));
      let rg: any = null;
      try {
        rg = { limits: getLimits(input.userId), usage: getUsage(input.userId) };
      } catch {
        rg = null;
      }
      return {
        profile: {
          id: user.id, name: user.name, email: user.email, phone: user.phone,
          username: user.username, role: user.role, isActive: user.isActive,
          tags: parseTags(user.tags), createdAt: user.createdAt, lastSignInAt: user.lastSignInAt,
          totpEnabled: user.role !== "user" ? user.totpEnabled : undefined,
        },
        balances: bals.map((b) => ({
          currency: b.currency, available: b.available, locked: b.locked,
          totalDeposited: b.totalDeposited, totalWithdrawn: b.totalWithdrawn,
        })),
        stats: {
          depositedUsdt: Math.round(depositedUsdt * 100) / 100,
          withdrawnUsdt: Math.round(withdrawnUsdt * 100) / 100,
          wageredUsdt: Math.round(wageredUsdt * 100) / 100,
          wonUsdt: Math.round(wonUsdt * 100) / 100,
          spinsCount,
        },
        recentSpins,
        recentTxs,
        notes,
        auditTrail: trail,
        rg,
      };
    }),

  // C3: manual balance adjustment — capped per action, reason
  // mandatory, written to the ledger as an admin_adjust leg so the
  // balance stays reproducible from the ledger chain.
  adjustPlayerBalance: adminQuery
    .input(z.object({
      userId: z.number(),
      currency: z.enum(["BTC", "ETH", "USDT", "BDT"]),
      amount: z.string().regex(/^-?\d+(\.\d{1,8})?$/),
      reason: z.string().min(3).max(200),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const target = await db.select().from(users).where(eq(users.id, input.userId)).then((r) => r[0]);
      if (!target) throw new Error("User not found");
      if (target.role !== "user") throw new Error("Balance adjustments apply to player accounts");

      const negative = input.amount.startsWith("-");
      const absMicro = parseMoney(negative ? input.amount.slice(1) : input.amount);
      if (absMicro === 0n) throw new Error("Adjustment amount must be non-zero");
      const cap = getSetting<number>("player_adjust_max_usdt") ?? 500;
      const usdtEq = toUsdt(parseFloat(negative ? input.amount.slice(1) : input.amount), input.currency);
      if (cap > 0 && usdtEq > cap) {
        throw new Error(`Adjustment exceeds the per-action cap of $${cap}`);
      }
      const signedMicro = negative ? -absMicro : absMicro;

      const sqlite = getSqliteClient();
      let balanceAfter = "";
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        const row = sqlite
          .prepare("SELECT id, available FROM balances WHERE user_id = ? AND currency = ?")
          .get(input.userId, input.currency) as any;
        const oldAvail = row ? parseMoney(row.available || "0") : 0n;
        const newAvail = oldAvail + signedMicro;
        if (newAvail < 0n) throw new Error("Adjustment would make the balance negative");
        balanceAfter = fmtMoney(newAvail);
        if (row) {
          sqlite.prepare("UPDATE balances SET available = ? WHERE id = ?").run(balanceAfter, row.id);
        } else {
          sqlite
            .prepare("INSERT INTO balances (user_id, currency, available, locked) VALUES (?, ?, ?, '0')")
            .run(input.userId, input.currency, balanceAfter);
        }
        sqlite
          .prepare("INSERT INTO ledger_entries (user_id, kind, currency, amount, balance_after) VALUES (?, 'admin_adjust', ?, ?, ?)")
          .run(input.userId, input.currency, fmtMoney(signedMicro), balanceAfter);
        sqlite.exec("COMMIT");
      } catch (e) {
        sqlite.exec("ROLLBACK");
        throw e;
      }

      await writeAudit(ctx, "admin.adjustBalance", {
        userId: input.userId, currency: input.currency, amount: input.amount,
        reason: input.reason, balanceAfter, usdtEq: Math.round(usdtEq * 100) / 100,
      });
      return { success: true, balanceAfter };
    }),

  // C4: freeze/unfreeze with a mandatory reason. Enforcement already
  // exists (login + every authenticated request reject disabled
  // accounts); this adds the guard rails and the audit reason.
  setPlayerFrozen: adminQuery
    .input(z.object({ userId: z.number(), frozen: z.boolean(), reason: z.string().min(3).max(200) }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      if (ctx.user?.id === input.userId) throw new Error("You cannot freeze your own account");
      const target = await db.select().from(users).where(eq(users.id, input.userId)).then((r) => r[0]);
      if (!target) throw new Error("User not found");
      if (target.role !== "user") throw new Error("Admin accounts cannot be frozen");
      await db.update(users).set({ isActive: !input.frozen }).where(eq(users.id, input.userId));
      await writeAudit(ctx, input.frozen ? "admin.freezePlayer" : "admin.unfreezePlayer", {
        userId: input.userId, reason: input.reason,
      });
      return { success: true, userId: input.userId, frozen: input.frozen };
    }),

  // C5: internal notes + tags.
  addPlayerNote: adminQuery
    .input(z.object({ userId: z.number(), note: z.string().min(1).max(500) }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const target = await db.select({ id: users.id }).from(users).where(eq(users.id, input.userId)).then((r) => r[0]);
      if (!target) throw new Error("User not found");
      const [row] = await db
        .insert(playerNotes)
        .values({ userId: input.userId, adminId: ctx.user?.id ?? null, note: input.note })
        .returning();
      await writeAudit(ctx, "admin.addPlayerNote", { userId: input.userId, noteId: row.id });
      return { success: true, noteId: row.id };
    }),

  setPlayerTags: adminQuery
    .input(z.object({ userId: z.number(), tags: z.array(z.string().min(1).max(24)).max(8) }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const target = await db.select({ id: users.id }).from(users).where(eq(users.id, input.userId)).then((r) => r[0]);
      if (!target) throw new Error("User not found");
      const clean = [...new Set(input.tags.map((t) => t.trim()).filter(Boolean))];
      await db.update(users).set({ tags: JSON.stringify(clean) }).where(eq(users.id, input.userId));
      await writeAudit(ctx, "admin.setPlayerTags", { userId: input.userId, tags: clean });
      return { success: true, tags: clean };
    }),

  // C6: admin-initiated password reset. Generates a one-time
  // temporary password (returned once, never stored in the audit
  // log) and bumps the session epoch so every existing session dies.
  resetPlayerPassword: superAdminQuery
    .input(z.object({ userId: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      if (ctx.user?.id === input.userId) throw new Error("Use the normal password change for your own account");
      const target = await db.select().from(users).where(eq(users.id, input.userId)).then((r) => r[0]);
      if (!target) throw new Error("User not found");
      if (target.role === "super_admin") throw new Error("Super admin passwords cannot be reset here");
      if (!target.passwordHash) throw new Error("Account has no password login");
      const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
      let temp = "";
      for (let i = 0; i < 14; i++) temp += alphabet[crypto.randomInt(alphabet.length)];
      await db
        .update(users)
        .set({ passwordHash: hashPassword(temp), sessionEpoch: (target.sessionEpoch ?? 0) + 1 })
        .where(eq(users.id, input.userId));
      await writeAudit(ctx, "admin.resetPlayerPassword", { userId: input.userId });
      return { success: true, tempPassword: temp };
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
        reviewNote: transactions.reviewNote,
        holdReason: transactions.holdReason,
        approvedBy: transactions.approvedBy,
        approvedAt: transactions.approvedAt,
        createdAt: transactions.createdAt,
      })
      .from(transactions)
      .leftJoin(users, eq(users.id, transactions.userId))
      .where(inArray(transactions.status, ["pending", "confirming"]))
      .orderBy(desc(transactions.createdAt))
      .limit(100);
    // D4: annotate each row with the policy outcome so the UI can
    // label stages and ask for a 2FA code only when one is due.
    const dualAbove = getSetting<number>("withdrawal_dual_approval_usdt") ?? 100;
    const totpAbove = getSetting<number>("withdrawal_2fa_above_usdt") ?? 1000;
    return rows.map((r) => {
      const usdtEq = toUsdt(parseFloat(r.amount), r.currency);
      return {
        ...r,
        usdtEq: Math.round(usdtEq * 100) / 100,
        requiresDual: r.type === "withdrawal" && dualAbove > 0 && usdtEq > dualAbove,
        requiresTotp: r.type === "withdrawal" && totpAbove > 0 && usdtEq > totpAbove,
      };
    });
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

  // D1: deposits can now be rejected (previously approve-only, so a
  // bad claim sat in the queue forever). No balance was ever locked
  // for a deposit, so rejection moves no money — it records the
  // refusal with a reason the player can be told.
  rejectDeposit: adminQuery
    .input(z.object({ txId: z.number(), reason: z.string().min(3).max(200) }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const tx = await db.select().from(transactions)
        .where(and(eq(transactions.id, input.txId), eq(transactions.type, "deposit")))
        .then(rows => rows[0]);
      if (!tx) throw new Error("Deposit transaction not found");
      if (tx.status !== "pending") throw new Error(`Transaction is ${tx.status}, not pending`);

      await db.update(transactions)
        .set({ status: "failed", reviewNote: input.reason, processedAt: new Date() })
        .where(eq(transactions.id, tx.id));

      await writeAudit(ctx, "admin.rejectDeposit", {
        txId: tx.id, userId: tx.userId, amount: tx.amount, currency: tx.currency, reason: input.reason,
      });
      return { success: true, txId: tx.id };
    }),

  // D1: full transaction history for the Payments section — filter
  // by status/type and free-text search across player email/name and
  // the transaction reference/address.
  listTransactions: adminQuery
    .input(z.object({
      status: z.enum(["pending", "confirming", "confirmed", "failed", "cancelled"]).optional(),
      type: z.enum(["deposit", "withdrawal"]).optional(),
      search: z.string().max(120).optional(),
      limit: z.number().min(1).max(200).default(50),
      offset: z.number().min(0).default(0),
    }))
    .query(async ({ input }) => {
      const db = getDb();
      const conds = [];
      if (input.status) conds.push(eq(transactions.status, input.status));
      if (input.type) conds.push(eq(transactions.type, input.type));
      if (input.search) {
        const pattern = `%${input.search}%`;
        conds.push(or(
          like(users.email, pattern),
          like(users.name, pattern),
          like(transactions.txHash, pattern),
          like(transactions.toAddress, pattern),
        ));
      }
      return db
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
          reviewNote: transactions.reviewNote,
          holdReason: transactions.holdReason,
          approvedBy: transactions.approvedBy,
          approvedAt: transactions.approvedAt,
          payoutRef: transactions.payoutRef,
          paidAt: transactions.paidAt,
          processedAt: transactions.processedAt,
          createdAt: transactions.createdAt,
        })
        .from(transactions)
        .leftJoin(users, eq(users.id, transactions.userId))
        .where(conds.length ? and(...conds) : undefined)
        .orderBy(desc(transactions.createdAt))
        .limit(input.limit)
        .offset(input.offset);
    }),

  // D3+D4: staged withdrawal approval.
  // - A held withdrawal cannot be approved until the hold is released.
  // - Above the dual-approval threshold, the first approval parks the
  //   withdrawal in "confirming"; a DIFFERENT admin must give the
  //   second approval, which executes the payout bookkeeping.
  // - Above the 2FA threshold, the executing approver must present a
  //   fresh authenticator code with the request.
  // Execution itself is unchanged from the original flow: locked
  // funds leave the balance, totalWithdrawn grows, status confirms.
  // The actual Binance payout is then recorded via markWithdrawalPaid.
  approveWithdraw: adminQuery
    .input(z.object({ txId: z.number(), totpCode: z.string().regex(/^\d{6}$/).optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const adminId = ctx.user?.id;
      if (!adminId) throw new Error("Unauthorized");
      const tx = await db.select().from(transactions)
        .where(and(eq(transactions.id, input.txId), eq(transactions.type, "withdrawal")))
        .then(rows => rows[0]);
      if (!tx) throw new Error("Withdrawal transaction not found");
      if (tx.status !== "pending" && tx.status !== "confirming") {
        throw new Error(`Transaction is ${tx.status}, not pending`);
      }
      if (tx.holdReason) {
        throw new Error("Withdrawal is on hold — release the hold before approving");
      }

      const usdtEq = toUsdt(parseFloat(tx.amount), tx.currency);
      const dualAbove = getSetting<number>("withdrawal_dual_approval_usdt") ?? 100;

      // Stage 1 of dual approval: record who approved first, park.
      if (tx.status === "pending" && dualAbove > 0 && usdtEq > dualAbove) {
        await db.update(transactions)
          .set({ status: "confirming", approvedBy: adminId, approvedAt: new Date() })
          .where(eq(transactions.id, tx.id));
        await writeAudit(ctx, "admin.withdrawFirstApproval", {
          txId: tx.id, userId: tx.userId, amount: tx.amount, currency: tx.currency, usdtEq,
        });
        return { success: true, txId: tx.id, stage: "awaiting-second" as const };
      }

      // Stage 2 must come from a different admin than stage 1.
      if (tx.status === "confirming" && tx.approvedBy != null && tx.approvedBy === adminId) {
        throw new Error("Dual approval requires a different admin for the second approval");
      }

      // 2FA re-confirmation for large payouts.
      const totpAbove = getSetting<number>("withdrawal_2fa_above_usdt") ?? 1000;
      if (totpAbove > 0 && usdtEq > totpAbove) {
        const me = await db.select().from(users).where(eq(users.id, adminId)).then(r => r[0]);
        if (!me?.totpEnabled || !me.totpSecret) {
          throw new Error("Enroll in two-factor authentication before approving large payouts");
        }
        if (!input.totpCode) {
          throw new Error("A two-factor code is required to approve payouts above this amount");
        }
        const secret = decryptSecret(me.totpSecret);
        if (!secret || !verifyTotp(secret, input.totpCode)) {
          throw new Error("Invalid two-factor code");
        }
      }

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
        usdtEq, firstApprovedBy: tx.approvedBy ?? null, totpConfirmed: totpAbove > 0 && usdtEq > totpAbove,
      });
      return { success: true, txId: tx.id, stage: "executed" as const };
    }),

  // D3: record the actual payout once the money has been sent —
  // approval and payment are separate facts with separate actors.
  markWithdrawalPaid: adminQuery
    .input(z.object({ txId: z.number(), payoutRef: z.string().min(3).max(120) }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const tx = await db.select().from(transactions)
        .where(and(eq(transactions.id, input.txId), eq(transactions.type, "withdrawal")))
        .then(rows => rows[0]);
      if (!tx) throw new Error("Withdrawal transaction not found");
      if (tx.status !== "confirmed") throw new Error("Only an approved withdrawal can be marked paid");
      if (tx.paidAt) throw new Error("Withdrawal already marked paid");
      await db.update(transactions)
        .set({ paidAt: new Date(), payoutRef: input.payoutRef })
        .where(eq(transactions.id, tx.id));
      await writeAudit(ctx, "admin.markWithdrawalPaid", {
        txId: tx.id, userId: tx.userId, amount: tx.amount, currency: tx.currency, payoutRef: input.payoutRef,
      });
      return { success: true, txId: tx.id };
    }),

  // D4: holds block approval until an admin releases them (or places
  // one manually). Releasing never moves money by itself.
  releaseHold: adminQuery
    .input(z.object({ txId: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const tx = await db.select().from(transactions)
        .where(eq(transactions.id, input.txId))
        .then(rows => rows[0]);
      if (!tx) throw new Error("Transaction not found");
      if (!tx.holdReason) throw new Error("Transaction is not on hold");
      await db.update(transactions)
        .set({ holdReason: null })
        .where(eq(transactions.id, tx.id));
      await writeAudit(ctx, "admin.releaseHold", {
        txId: tx.id, userId: tx.userId, amount: tx.amount, currency: tx.currency, releasedHold: tx.holdReason,
      });
      return { success: true, txId: tx.id };
    }),

  addHold: adminQuery
    .input(z.object({ txId: z.number(), reason: z.string().min(3).max(200) }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const tx = await db.select().from(transactions)
        .where(eq(transactions.id, input.txId))
        .then(rows => rows[0]);
      if (!tx) throw new Error("Transaction not found");
      if (tx.status !== "pending" && tx.status !== "confirming") {
        throw new Error("Only an open transaction can be held");
      }
      await db.update(transactions)
        .set({ holdReason: input.reason })
        .where(eq(transactions.id, tx.id));
      await writeAudit(ctx, "admin.addHold", {
        txId: tx.id, userId: tx.userId, amount: tx.amount, currency: tx.currency, reason: input.reason,
      });
      return { success: true, txId: tx.id };
    }),

  // D3: the money snapshot shown next to a queue row — balances,
  // lifetime in/out and wagering, all in USDT terms plus per-currency
  // detail, so the approver sees who they are paying.
  getPlayerMoneySummary: adminQuery
    .input(z.object({ userId: z.number() }))
    .query(async ({ input }) => {
      const db = getDb();
      const bals = await db.select().from(balances).where(eq(balances.userId, input.userId));
      const spinAgg = await db
        .select({ currency: spins.currency, wagered: sum(spins.betAmount), won: sum(spins.winAmount), n: count() })
        .from(spins)
        .where(eq(spins.userId, input.userId))
        .groupBy(spins.currency);
      const pending = await db
        .select({ n: count() })
        .from(transactions)
        .where(and(eq(transactions.userId, input.userId), inArray(transactions.status, ["pending", "confirming"])));
      let depositedUsdt = 0;
      let withdrawnUsdt = 0;
      let wageredUsdt = 0;
      for (const b of bals) {
        depositedUsdt += toUsdt(parseFloat(b.totalDeposited || "0"), b.currency);
        withdrawnUsdt += toUsdt(parseFloat(b.totalWithdrawn || "0"), b.currency);
      }
      for (const a of spinAgg) {
        wageredUsdt += toUsdt(parseFloat(a.wagered || "0"), a.currency);
      }
      return {
        balances: bals.map((b) => ({
          currency: b.currency,
          available: b.available,
          locked: b.locked,
          totalDeposited: b.totalDeposited,
          totalWithdrawn: b.totalWithdrawn,
        })),
        depositedUsdt: Math.round(depositedUsdt * 100) / 100,
        withdrawnUsdt: Math.round(withdrawnUsdt * 100) / 100,
        wageredUsdt: Math.round(wageredUsdt * 100) / 100,
        spinsCount: spinAgg.reduce((acc, a) => acc + (a.n || 0), 0),
        pendingCount: pending[0]?.n ?? 0,
      };
    }),

  rejectWithdraw: adminQuery
    .input(z.object({ txId: z.number(), reason: z.string().max(200).optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const tx = await db.select().from(transactions)
        .where(and(eq(transactions.id, input.txId), eq(transactions.type, "withdrawal")))
        .then(rows => rows[0]);
      if (!tx) throw new Error("Withdrawal transaction not found");
      if (tx.status !== "pending" && tx.status !== "confirming") {
        throw new Error(`Transaction is ${tx.status}, not pending`);
      }

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
        wasStage: tx.status, firstApprovedBy: tx.approvedBy ?? null,
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

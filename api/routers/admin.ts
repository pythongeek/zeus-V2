import { z } from "zod";
import { createRouter, adminFullQuery as adminQuery, superAdminQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { users, spins, jackpotPool, auditLog, transactions, balances, playerNotes } from "../../db/schema";
import { parseMoney, fmtMoney, canonicalMoney } from "../lib/money";
import { getAllSettings, getSetting, setSetting } from "../lib/settings";
import { toUsdt, getLimits, getUsage, dhakaDayStartSec, tsSec } from "../lib/limits";
import { getMathConfig } from "./game";
import { certifyMath as certifyBundle, type MathBundle } from "../lib/certify";
import { runReconciliation as executeReconciliation } from "../lib/reconcile";
import { depositBoostFor, computeBoostMicro } from "../lib/boosts";
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

/* ---- Section E helpers: math bundle <-> settings ---- */
function liveMathBundle(): MathBundle {
  const cfg = getMathConfig();
  const paytable: MathBundle["paytable"] = {};
  for (let id = 0; id <= 10; id++) {
    const p = cfg.payouts[id as keyof typeof cfg.payouts];
    paytable[String(id)] = { "3": p[3], "4": p[4], "5": p[5] };
  }
  return {
    paytable,
    reels: cfg.strips,
    freeSpins: cfg.freeSpins,
    thunder: { chanceDenominator: cfg.thunderDenominator, floorX: cfg.thunderFloorX },
  };
}

const mathBundleSchema = z.object({
  paytable: z.record(
    z.string(),
    z.object({
      "3": z.number().min(0).max(100000),
      "4": z.number().min(0).max(100000),
      "5": z.number().min(0).max(100000),
    }),
  ),
  reels: z.array(z.array(z.number().int().min(0).max(10)).min(10).max(200)).length(5),
  freeSpins: z.record(z.string(), z.number().int().min(0).max(1000)),
  thunder: z.object({
    chanceDenominator: z.number().int().min(1).max(100000),
    floorX: z.number().min(0).max(100),
  }),
}).superRefine((b, ctx) => {
  for (let id = 0; id <= 10; id++) {
    if (!b.paytable[String(id)]) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `paytable missing symbol ${id}` });
    }
  }
  for (const k of ["3", "4", "5"]) {
    if (b.freeSpins[k] === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `freeSpins missing ${k}` });
    }
  }
});

async function publishMathBundle(ctx: any, bundle: MathBundle, note: string | null) {
  const adminId = ctx.user!.id as number;
  const cert = certifyBundle(bundle);
  const min = getSetting<number>("rtp_publish_min");
  const max = getSetting<number>("rtp_publish_max");
  if (cert.totalPct < min || cert.totalPct > max) {
    throw new Error(
      `Certified RTP ${cert.totalPct}% is outside the publish bounds ${min}-${max}%`,
    );
  }
  setSetting("math_paytable", bundle.paytable, adminId);
  setSetting("math_reels", bundle.reels, adminId);
  setSetting("math_free_spins", bundle.freeSpins, adminId);
  setSetting("math_thunder", bundle.thunder, adminId);
  setSetting("rtp_declared", cert.totalPct, adminId);
  const info = getSqliteClient()
    .prepare(
      "INSERT INTO math_versions (bundle, total_rtp, breakdown, note, published_by) VALUES (?, ?, ?, ?, ?)",
    )
    .run(JSON.stringify(bundle), cert.totalPct, JSON.stringify(cert), note, adminId);
  setSetting("math_draft", null, adminId);
  await writeAudit(ctx, "admin.publishMath", {
    versionId: Number(info.lastInsertRowid),
    totalRtp: cert.totalPct,
    note,
  });
  return { versionId: Number(info.lastInsertRowid), totalPct: cert.totalPct, breakdown: cert };
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

  // ===== Section B: dashboard & analytics =====

  // B1: range-aware business analytics. Ranges are Dhaka calendar
  // days (today / last 7 / last 30 / all time / custom dates).
  // Timestamp columns have mixed storage history (integer epochs
  // from drizzle, text CURRENT_TIMESTAMP defaults on some tables),
  // so every comparison goes through a normalizing expression.
  getAnalytics: adminQuery
    .input(z.object({
      range: z.enum(["today", "7d", "30d", "all", "custom"]).default("30d"),
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    }))
    .query(async ({ input }) => {
      const sqlite = getSqliteClient();
      const nowSec = Math.floor(Date.now() / 1000);
      let fromSec = 0;
      let toSec = nowSec + 1;
      if (input.range === "today") {
        fromSec = dhakaDayStartSec(nowSec);
      } else if (input.range === "7d") {
        fromSec = dhakaDayStartSec(nowSec) - 6 * 86400;
      } else if (input.range === "30d") {
        fromSec = dhakaDayStartSec(nowSec) - 29 * 86400;
      } else if (input.range === "custom" && input.from && input.to) {
        fromSec = Math.floor(Date.parse(`${input.from}T00:00:00Z`) / 1000) - 6 * 3600;
        toSec = Math.floor(Date.parse(`${input.to}T00:00:00Z`) / 1000) - 6 * 3600 + 86400;
      }
      const TS = (col: string) => tsSec(col);

      const signups = sqlite
        .prepare(`SELECT COUNT(*) AS n FROM users WHERE ${TS('"createdAt"')} >= ? AND ${TS('"createdAt"')} < ?`)
        .get(fromSec, toSec) as any;

      const spinRows = sqlite
        .prepare(
          `SELECT currency, SUM(CAST(bet_amount AS REAL)) AS wagered, SUM(CAST(win_amount AS REAL)) AS won, COUNT(*) AS n
           FROM spins WHERE ${TS("created_at")} >= ? AND ${TS("created_at")} < ? GROUP BY currency`,
        )
        .all(fromSec, toSec) as any[];
      let wageredUsdt = 0;
      let wonUsdt = 0;
      let spinsCount = 0;
      for (const r of spinRows) {
        wageredUsdt += toUsdt(r.wagered || 0, r.currency);
        wonUsdt += toUsdt(r.won || 0, r.currency);
        spinsCount += r.n || 0;
      }

      const txRows = sqlite
        .prepare(
          `SELECT type, currency, SUM(CAST(amount AS REAL)) AS total FROM transactions
           WHERE status = 'confirmed' AND ${TS("created_at")} >= ? AND ${TS("created_at")} < ?
           GROUP BY type, currency`,
        )
        .all(fromSec, toSec) as any[];
      let depositsUsdt = 0;
      let withdrawalsUsdt = 0;
      for (const r of txRows) {
        if (r.type === "deposit") depositsUsdt += toUsdt(r.total || 0, r.currency);
        else withdrawalsUsdt += toUsdt(r.total || 0, r.currency);
      }

      const round2 = (n: number) => Math.round(n * 100) / 100;
      return {
        fromSec,
        toSec,
        signups: signups?.n ?? 0,
        spinsCount,
        wageredUsdt: round2(wageredUsdt),
        wonUsdt: round2(wonUsdt),
        ggrUsdt: round2(wageredUsdt - wonUsdt),
        actualRtp: wageredUsdt > 0 ? Math.round((wonUsdt / wageredUsdt) * 10000) / 100 : null,
        theoreticalRtp: getSetting<number>("rtp_declared") ?? 96,
        depositsUsdt: round2(depositsUsdt),
        withdrawalsUsdt: round2(withdrawalsUsdt),
        netCashflowUsdt: round2(depositsUsdt - withdrawalsUsdt),
      };
    }),

  // B2: daily cashflow for the last N Dhaka days (zero-filled).
  getCashflowSeries: adminQuery
    .input(z.object({ days: z.number().min(7).max(90).default(30) }))
    .query(async ({ input }) => {
      const sqlite = getSqliteClient();
      const nowSec = Math.floor(Date.now() / 1000);
      const todayStart = dhakaDayStartSec(nowSec);
      const startSec = todayStart - (input.days - 1) * 86400;
      const TS = tsSec("created_at");
      const rows = sqlite
        .prepare(
          `SELECT CAST((${TS} + 21600) / 86400 AS INTEGER) AS bucket, type, currency,
                  SUM(CAST(amount AS REAL)) AS total
           FROM transactions
           WHERE status = 'confirmed' AND ${TS} >= ?
           GROUP BY bucket, type, currency`,
        )
        .all(startSec) as any[];
      const byBucket = new Map<number, { deposits: number; withdrawals: number }>();
      for (const r of rows) {
        const cur = byBucket.get(r.bucket) ?? { deposits: 0, withdrawals: 0 };
        const v = toUsdt(r.total || 0, r.currency);
        if (r.type === "deposit") cur.deposits += v;
        else cur.withdrawals += v;
        byBucket.set(r.bucket, cur);
      }
      const series = [];
      for (let i = 0; i < input.days; i++) {
        const dayStart = startSec + i * 86400;
        const bucket = Math.floor((dayStart + 21600) / 86400);
        const v = byBucket.get(bucket) ?? { deposits: 0, withdrawals: 0 };
        series.push({
          date: new Date((dayStart + 21600) * 1000).toISOString().slice(0, 10),
          deposits: Math.round(v.deposits * 100) / 100,
          withdrawals: Math.round(v.withdrawals * 100) / 100,
        });
      }
      return series;
    }),

  // B3: top players for the range — most wagered, biggest net
  // losses, and the single biggest win.
  getTopPlayers: adminQuery
    .input(z.object({ range: z.enum(["7d", "30d", "all"]).default("30d") }))
    .query(async ({ input }) => {
      const sqlite = getSqliteClient();
      const nowSec = Math.floor(Date.now() / 1000);
      const fromSec =
        input.range === "all" ? 0 : dhakaDayStartSec(nowSec) - (input.range === "7d" ? 6 : 29) * 86400;
      const TS = tsSec("s.created_at");
      const rows = sqlite
        .prepare(
          `SELECT s.user_id AS userId, u.name, u.email, s.currency,
                  SUM(CAST(s.bet_amount AS REAL)) AS wagered, SUM(CAST(s.win_amount AS REAL)) AS won
           FROM spins s JOIN users u ON u.id = s.user_id
           WHERE u.role = 'user' AND ${TS} >= ?
           GROUP BY s.user_id, s.currency`,
        )
        .all(fromSec) as any[];
      const byUser = new Map<number, { userId: number; name: string; email: string; wagered: number; won: number }>();
      for (const r of rows) {
        const cur = byUser.get(r.userId) ?? { userId: r.userId, name: r.name, email: r.email, wagered: 0, won: 0 };
        cur.wagered += toUsdt(r.wagered || 0, r.currency);
        cur.won += toUsdt(r.won || 0, r.currency);
        byUser.set(r.userId, cur);
      }
      const players = [...byUser.values()].map((p) => ({
        ...p,
        wagered: Math.round(p.wagered * 100) / 100,
        won: Math.round(p.won * 100) / 100,
        net: Math.round((p.wagered - p.won) * 100) / 100,
      }));
      const biggestWinRow = sqlite
        .prepare(
          `SELECT s.id, s.user_id AS userId, u.name, u.email, s.currency,
                  CAST(s.win_amount AS REAL) AS win, CAST(s.bet_amount AS REAL) AS bet, s.created_at AS createdAt
           FROM spins s JOIN users u ON u.id = s.user_id
           WHERE u.role = 'user' AND ${TS} >= ?
           ORDER BY CAST(s.win_amount AS REAL) DESC LIMIT 1`,
        )
        .get(fromSec) as any;
      return {
        byWagered: [...players].sort((a, b) => b.wagered - a.wagered).slice(0, 10),
        byNetLoss: [...players].sort((a, b) => b.net - a.net).slice(0, 10),
        biggestWin: biggestWinRow
          ? {
              spinId: biggestWinRow.id, userId: biggestWinRow.userId, name: biggestWinRow.name,
              email: biggestWinRow.email, currency: biggestWinRow.currency,
              win: biggestWinRow.win, bet: biggestWinRow.bet, createdAt: biggestWinRow.createdAt,
            }
          : null,
      };
    }),

  // B4: money position right now — what the house owes, what is
  // locked for payouts, and what sits in the jackpot pools.
  getMoneyPosition: adminQuery.query(async () => {
    const db = getDb();
    const bals = await db.select().from(balances);
    let availableUsdt = 0;
    let lockedUsdt = 0;
    const byCurrency: Record<string, { available: string; locked: string }> = {};
    const rawByCurrency = new Map<string, { available: bigint; locked: bigint }>();
    for (const b of bals) {
      availableUsdt += toUsdt(parseFloat(b.available || "0"), b.currency);
      lockedUsdt += toUsdt(parseFloat(b.locked || "0"), b.currency);
      const cur = rawByCurrency.get(b.currency) ?? { available: 0n, locked: 0n };
      cur.available += parseMoney(b.available || "0");
      cur.locked += parseMoney(b.locked || "0");
      rawByCurrency.set(b.currency, cur);
    }
    for (const [currency, v] of rawByCurrency) {
      byCurrency[currency] = { available: fmtMoney(v.available), locked: fmtMoney(v.locked) };
    }
    const pools = await db.select().from(jackpotPool);
    let poolsUsdt = 0;
    for (const p of pools) poolsUsdt += parseFloat(p.currentAmount || "0");
    const pendingRows = await db
      .select()
      .from(transactions)
      .where(and(
        eq(transactions.type, "withdrawal"),
        inArray(transactions.status, ["pending", "confirming"]),
      ));
    let pendingOutUsdt = 0;
    for (const t of pendingRows) pendingOutUsdt += toUsdt(parseFloat(t.amount || "0"), t.currency);
    const round2 = (n: number) => Math.round(n * 100) / 100;
    return {
      availableUsdt: round2(availableUsdt),
      lockedUsdt: round2(lockedUsdt),
      liabilitiesUsdt: round2(availableUsdt + lockedUsdt),
      poolsUsdt: round2(poolsUsdt),
      pools: pools.map((p) => ({ tier: p.tier, currentAmount: p.currentAmount })),
      pendingWithdrawalsCount: pendingRows.length,
      pendingWithdrawalsUsdt: round2(pendingOutUsdt),
      byCurrency,
    };
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
          bonus: (b as any).bonus ?? "0",
          totalDeposited: b.totalDeposited, totalWithdrawn: b.totalWithdrawn,
        })),
        bonuses: getSqliteClient()
          .prepare(
            "SELECT id, kind, currency, amount, remaining, wagered, wagering_multiplier, status, expires_at FROM bonus_ledger WHERE user_id = ? AND status = 'active' ORDER BY id",
          )
          .all(input.userId),
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

      // G1: every available-balance movement writes a ledger leg so
      // the chain stays complete (deposits previously credited with
      // no leg, which made true reconciliation impossible).
      let newAvailable: bigint;
      if (bal) {
        newAvailable = parseMoney(bal.available) + amountMicro;
        await db.update(balances)
          .set({
            available: fmtMoney(newAvailable),
            totalDeposited: fmtMoney(parseMoney(bal.totalDeposited || "0") + amountMicro),
            updatedAt: new Date(),
          })
          .where(eq(balances.id, bal.id));
      } else {
        newAvailable = amountMicro;
        await db.insert(balances).values({
          userId: tx.userId,
          currency: tx.currency,
          available: canonicalMoney(tx.amount),
          totalDeposited: canonicalMoney(tx.amount),
        });
      }
      getSqliteClient()
        .prepare(
          "INSERT INTO ledger_entries (user_id, kind, currency, amount, balance_after) VALUES (?, 'deposit_credit', ?, ?, ?)",
        )
        .run(tx.userId, tx.currency, fmtMoney(amountMicro), fmtMoney(newAvailable));

      // Step 4: deposit boost. When a boost is active for this
      // currency/amount, grant a bonus-bucket credit recorded in
      // bonus_ledger; wagering and conversion happen on spins.
      let boostGranted: bigint | null = null;
      const boostCfg = depositBoostFor(tx.currency, amountMicro);
      if (boostCfg) {
        const bonusMicro = computeBoostMicro(amountMicro, boostCfg.pct);
        if (bonusMicro > 0n) {
          const client = getSqliteClient();
          const brow = client
            .prepare("SELECT bonus FROM balances WHERE user_id = ? AND currency = ?")
            .get(tx.userId, tx.currency) as any;
          const newBonus = (brow ? parseMoney(brow.bonus || "0") : 0n) + bonusMicro;
          const nowSec = Math.floor(Date.now() / 1000);
          client
            .prepare("UPDATE balances SET bonus = ? WHERE user_id = ? AND currency = ?")
            .run(fmtMoney(newBonus), tx.userId, tx.currency);
          client
            .prepare(
              "INSERT INTO bonus_ledger (user_id, kind, currency, amount, remaining, wagering_multiplier, wagered, status, ref_tx_id, expires_at) VALUES (?, 'deposit_boost', ?, ?, ?, ?, '0', 'active', ?, ?)",
            )
            .run(
              tx.userId,
              tx.currency,
              fmtMoney(bonusMicro),
              fmtMoney(bonusMicro),
              boostCfg.wageringMultiplier,
              tx.id,
              nowSec + boostCfg.expiryDays * 86400,
            );
          client
            .prepare(
              "INSERT INTO ledger_entries (user_id, kind, currency, amount, balance_after, bucket) VALUES (?, 'bonus_credit', ?, ?, ?, 'bonus')",
            )
            .run(tx.userId, tx.currency, fmtMoney(bonusMicro), fmtMoney(newBonus));
          boostGranted = bonusMicro;
        }
      }

      // Step 12: reload bonus. If the player armed an opt-in and
      // this approved deposit matches the offer, grant the bonus on
      // the same rails and consume the opt-in. (Binance deposits are
      // approved asynchronously, so the bonus attaches here — at
      // approval — rather than on a countdown card.)
      let reloadGranted: bigint | null = null;
      if (getSetting<boolean>("reload_enabled") !== false) {
        const { activeOffers, reloadBonusMicro } = await import("../lib/reload");
        const client = getSqliteClient();
        const nowSecR = Math.floor(Date.now() / 1000);
        const optin = client
          .prepare(
            "SELECT * FROM reload_optins WHERE user_id = ? AND status = 'armed' AND expires_at > ? ORDER BY id DESC LIMIT 1",
          )
          .get(tx.userId, nowSecR) as any;
        if (optin) {
          const offer = activeOffers(getSetting("reload_offers")).find((o) => o.id === optin.offer_id);
          if (offer) {
            const bonusMicro = reloadBonusMicro(offer, tx.currency, amountMicro);
            if (bonusMicro) {
              const brow = client
                .prepare("SELECT bonus FROM balances WHERE user_id = ? AND currency = ?")
                .get(tx.userId, tx.currency) as any;
              const newBonus = (brow ? parseMoney(brow.bonus || "0") : 0n) + bonusMicro;
              client
                .prepare("UPDATE balances SET bonus = ? WHERE user_id = ? AND currency = ?")
                .run(fmtMoney(newBonus), tx.userId, tx.currency);
              client
                .prepare(
                  "INSERT INTO bonus_ledger (user_id, kind, currency, amount, remaining, wagering_multiplier, wagered, status, ref_tx_id, expires_at) VALUES (?, 'reload', ?, ?, ?, ?, '0', 'active', ?, ?)",
                )
                .run(tx.userId, tx.currency, fmtMoney(bonusMicro), fmtMoney(bonusMicro), offer.wagering, tx.id, nowSecR + offer.expiryDays * 86400);
              client
                .prepare(
                  "INSERT INTO ledger_entries (user_id, kind, currency, amount, balance_after, bucket) VALUES (?, 'bonus_credit', ?, ?, ?, 'bonus')",
                )
                .run(tx.userId, tx.currency, fmtMoney(bonusMicro), fmtMoney(newBonus));
              client
                .prepare("UPDATE reload_optins SET status = 'consumed', deposit_tx_id = ?, consumed_at = ? WHERE id = ?")
                .run(tx.id, nowSecR, optin.id);
              reloadGranted = bonusMicro;
            }
          }
        }
      }

      await writeAudit(ctx, "admin.approveDeposit", {
        txId: tx.id, userId: tx.userId, amount: tx.amount, currency: tx.currency,
        ...(boostGranted !== null
          ? { boostGranted: fmtMoney(boostGranted), boostPct: boostCfg?.pct }
          : {}),
        ...(reloadGranted !== null ? { reloadGranted: fmtMoney(reloadGranted) } : {}),
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

      const unlockedAvailable = parseMoney(bal.available) + amountMicro;
      await db.update(balances)
        .set({
          locked: fmtMoney(lockedMicro - amountMicro),
          available: fmtMoney(unlockedAvailable),
          updatedAt: new Date(),
        })
        .where(eq(balances.id, bal.id));

      // G1: the unlock is an available-balance movement — ledger leg.
      getSqliteClient()
        .prepare(
          "INSERT INTO ledger_entries (user_id, kind, currency, amount, balance_after) VALUES (?, 'withdrawal_unlock', ?, ?, ?)",
        )
        .run(tx.userId, tx.currency, fmtMoney(amountMicro), fmtMoney(unlockedAvailable));

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

  /* ================= Section E: RTP Lab =================
   * Draft -> certify -> publish -> rollback for the game math.
   * Publishing re-certifies server-side and refuses bundles whose
   * total RTP falls outside rtp_publish_min/max. Every publish
   * (rollbacks included) appends an immutable math_versions row.
   */
  getMathLab: superAdminQuery.query(async () => {
    const live = liveMathBundle();
    const draft = getSetting<MathBundle | null>("math_draft");
    const versions = getSqliteClient()
      .prepare(
        "SELECT id, total_rtp, breakdown, note, published_by, created_at FROM math_versions ORDER BY id DESC LIMIT 20",
      )
      .all() as any[];
    return {
      live,
      draft: draft ?? null,
      bounds: {
        min: getSetting<number>("rtp_publish_min"),
        max: getSetting<number>("rtp_publish_max"),
      },
      maxWinX: getSetting<number>("max_win_x"),
      declaredRtp: getSetting<number>("rtp_declared"),
      versions: versions.map((v) => ({
        id: v.id,
        totalRtp: v.total_rtp,
        breakdown: v.breakdown ? JSON.parse(v.breakdown) : null,
        note: v.note,
        publishedBy: v.published_by,
        createdAt: v.created_at,
      })),
    };
  }),

  saveMathDraft: superAdminQuery
    .input(z.object({ bundle: mathBundleSchema }))
    .mutation(async ({ ctx, input }) => {
      setSetting("math_draft", input.bundle, ctx.user!.id);
      await writeAudit(ctx, "admin.saveMathDraft", {});
      return { saved: true };
    }),

  certifyMath: superAdminQuery
    .input(z.object({ bundle: mathBundleSchema }))
    .mutation(async ({ input }) => {
      const cert = certifyBundle(input.bundle as MathBundle);
      const min = getSetting<number>("rtp_publish_min");
      const max = getSetting<number>("rtp_publish_max");
      return { ...cert, withinBounds: cert.totalPct >= min && cert.totalPct <= max, bounds: { min, max } };
    }),

  publishMath: superAdminQuery
    .input(z.object({ bundle: mathBundleSchema, note: z.string().max(300).optional() }))
    .mutation(async ({ ctx, input }) => {
      const published = publishMathBundle(ctx, input.bundle as MathBundle, input.note ?? null);
      return published;
    }),

  rollbackMath: superAdminQuery
    .input(z.object({ versionId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const row = getSqliteClient()
        .prepare("SELECT id, bundle FROM math_versions WHERE id = ?")
        .get(input.versionId) as any;
      if (!row) throw new Error("Version not found");
      const bundle = JSON.parse(row.bundle) as MathBundle;
      const parsed = mathBundleSchema.safeParse(bundle);
      if (!parsed.success) {
        throw new Error("Stored version no longer validates");
      }
      return publishMathBundle(ctx, bundle, `Rollback to version #${row.id}`);
    }),

  /* ================= Section F1: jackpot centre ================= */
  getJackpotCentre: adminQuery.query(async () => {
    const db = getDb();
    const pools = await db.select().from(jackpotPool);
    const seeds = getSetting<Record<string, string>>("jackpot_seeds") ?? {};
    const shares = getSetting<Record<string, number>>("jackpot_shares") ?? {};
    const tiers = pools.map((p) => {
      const seed = parseFloat(seeds[p.tier] ?? p.seedAmount);
      const current = parseFloat(p.currentAmount);
      return {
        tier: p.tier,
        current,
        seed,
        sharePerMille: shares[p.tier] ?? 0,
        hitCount: p.hitCount,
        lastWonAt: (p as any).lastWonAt ?? null,
        lastWonBy: (p as any).lastWonBy ?? null,
        belowSeed: current < seed,
      };
    });
    // Stable display order: mini, major, mega.
    const order = ["mini", "major", "mega"];
    tiers.sort((a, b) => order.indexOf(a.tier) - order.indexOf(b.tier));
    return {
      tiers,
      totalCurrent: tiers.reduce((s, t) => s + t.current, 0),
      totalSharePerMille: tiers.reduce((s, t) => s + t.sharePerMille, 0),
      lowPoolAlert: getSetting<boolean>("jackpot_low_pool_alert"),
    };
  }),

  getJackpotHistory: adminQuery
    .input(z.object({ days: z.number().int().min(1).max(30).default(7) }))
    .query(async ({ input }) => {
      const since = Math.floor(Date.now() / 1000) - input.days * 86400;
      const rows = getSqliteClient()
        .prepare(
          "SELECT tier, amount, created_at FROM jackpot_pool_snapshots WHERE created_at >= ? ORDER BY created_at ASC",
        )
        .all(since) as any[];
      // Downsample to the last value per hour per tier.
      const byTier = new Map<string, Map<number, { ts: number; amount: number }>>();
      for (const r of rows) {
        const hour = Math.floor(r.created_at / 3600) * 3600;
        if (!byTier.has(r.tier)) byTier.set(r.tier, new Map());
        byTier.get(r.tier)!.set(hour, { ts: r.created_at, amount: parseFloat(r.amount) });
      }
      const out: Record<string, Array<{ ts: number; amount: number }>> = {};
      for (const [tier, buckets] of byTier) {
        out[tier] = [...buckets.values()].sort((a, b) => a.ts - b.ts);
      }
      return out;
    }),

  // AP2/F1: seeds + contribution shares are owner-tier control.
  // Changing seeds also syncs jackpot_pool.seed_amount so the
  // public payload and the reseed target never disagree.
  updateJackpotConfig: superAdminQuery
    .input(
      z.object({
        seeds: z.object({
          mini: z.number().positive().max(100000),
          major: z.number().positive().max(100000),
          mega: z.number().positive().max(100000),
        }),
        shares: z.object({
          mini: z.number().int().min(0).max(100),
          major: z.number().int().min(0).max(100),
          mega: z.number().int().min(0).max(100),
        }),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const totalShare = input.shares.mini + input.shares.major + input.shares.mega;
      if (totalShare > 100) {
        throw new Error("Total contribution cannot exceed 100 per 1000 (10%)");
      }
      const seedsSetting: Record<string, string> = {
        mini: String(input.seeds.mini),
        major: String(input.seeds.major),
        mega: String(input.seeds.mega),
      };
      setSetting("jackpot_seeds", seedsSetting, ctx.user!.id);
      setSetting("jackpot_shares", { ...input.shares }, ctx.user!.id);
      const db = getDb();
      for (const tier of ["mini", "major", "mega"] as const) {
        await db
          .update(jackpotPool)
          .set({ seedAmount: canonicalMoney(input.seeds[tier]) })
          .where(eq(jackpotPool.tier, tier));
      }
      await writeAudit(ctx, "admin.updateJackpotConfig", { ...input });
      return { success: true };
    }),

  /* ================= Section G: risk, reconciliation, alerts ================= */
  runReconciliation: adminQuery.mutation(async ({ ctx }) => {
    const result = executeReconciliation(ctx.user!.id);
    await writeAudit(ctx, "admin.runReconciliation", { ...result });
    return result;
  }),

  /* ===== Steps 10/13/14: weekly promo settlement (idempotent) ===== */
  runWeeklySettlement: adminQuery.mutation(async ({ ctx }) => {
    const { runCashback, runRakeback } = await import("../lib/settlement");
    const result = runCashback(getSqliteClient(), {});
    const rakeback = runRakeback(getSqliteClient(), {
      periodStart: result.periodStart,
      periodEnd: result.periodEnd,
    });
    await writeAudit(ctx, "admin.runWeeklySettlement", {
      periodStart: result.periodStart,
      periodEnd: result.periodEnd,
      grants: result.grants.length,
      totalByCurrency: result.totalByCurrency,
      rakebackGrants: rakeback.grants.length,
    });
    return { ...result, rakeback };
  }),

  /* ===== Step 11: red envelopes ===== */
  scheduleEnvelope: adminQuery
    .input(
      z.object({
        scheduledAt: z.number(),
        currency: z.string().min(3).max(4).default("BDT"),
        poolAmount: z.string(),
        maxClaims: z.number().min(1).max(100000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { generateSeed, hashSeed } = await import("../lib/envelopes");
      const { dhakaDayStart } = await import("../lib/settlement");
      const { toUsdt } = await import("../lib/limits");
      const client = getSqliteClient();
      const budget = Number(getSetting<number>("red_envelope_daily_budget_bdt") ?? 2000);
      const dayStart = dhakaDayStart(input.scheduledAt);
      const dayRows = client
        .prepare("SELECT currency, pool_amount FROM red_envelopes WHERE scheduled_at >= ? AND scheduled_at < ?")
        .all(dayStart, dayStart + 86400) as Array<{ currency: string; pool_amount: string }>;
      const bdtOf = (amount: string, currency: string) => toUsdt(parseFloat(amount) || 0, currency) * 110;
      const used = dayRows.reduce((acc, r) => acc + bdtOf(r.pool_amount, r.currency), 0);
      const incoming = bdtOf(input.poolAmount, input.currency);
      if (used + incoming > budget) {
        throw new Error(
          `Daily red-envelope budget exceeded: ${used.toFixed(2)} + ${incoming.toFixed(2)} > ${budget} BDT`,
        );
      }
      const seed = generateSeed();
      const info = client
        .prepare(
          "INSERT INTO red_envelopes (scheduled_at, currency, pool_amount, max_claims, seed, seed_hash, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(input.scheduledAt, input.currency, input.poolAmount, input.maxClaims, seed, hashSeed(seed), ctx.user!.id);
      await writeAudit(ctx, "admin.scheduleEnvelope", {
        envelopeId: Number(info.lastInsertRowid),
        scheduledAt: input.scheduledAt,
        poolAmount: input.poolAmount,
        currency: input.currency,
        maxClaims: input.maxClaims,
      });
      return { envelopeId: Number(info.lastInsertRowid), seedHash: hashSeed(seed) };
    }),

  listEnvelopes: adminQuery.query(async () => {
    const rows = getSqliteClient()
      .prepare("SELECT id, scheduled_at, currency, pool_amount, claimed_total, max_claims, claims_count, seed_hash, created_at FROM red_envelopes ORDER BY id DESC LIMIT 50")
      .all();
    return { envelopes: rows };
  }),

  listSettlements: adminQuery
    .input(z.object({ limit: z.number().min(1).max(200).default(50) }).optional())
    .query(async ({ input }) => {
      const rows = getSqliteClient()
        .prepare(
          `SELECT s.*, u.email FROM promo_settlements s JOIN users u ON u.id = s.user_id
           ORDER BY s.id DESC LIMIT ?`,
        )
        .all(input?.limit ?? 50);
      return { settlements: rows };
    }),

  getReconciliation: adminQuery.query(async () => {
    const client = getSqliteClient();
    const lastRun = client
      .prepare("SELECT * FROM reconciliation_runs ORDER BY id DESC LIMIT 1")
      .get() as any;
    const recentRuns = client
      .prepare("SELECT * FROM reconciliation_runs ORDER BY id DESC LIMIT 10")
      .all() as any[];
    const mismatches = client
      .prepare(
        `SELECT m.*, u.email, u.name FROM reconciliation_mismatches m
         LEFT JOIN users u ON u.id = m.user_id
         WHERE m.status = 'open' ORDER BY m.first_seen_at ASC`,
      )
      .all() as any[];
    return { lastRun: lastRun ?? null, recentRuns, mismatches };
  }),

  getAlerts: adminQuery
    .input(
      z.object({
        status: z.enum(["open", "acknowledged", "resolved", "all"]).default("open"),
        limit: z.number().int().min(1).max(200).default(50),
      }),
    )
    .query(async ({ input }) => {
      const client = getSqliteClient();
      const rows = (
        input.status === "all"
          ? client
              .prepare("SELECT * FROM admin_alerts ORDER BY id DESC LIMIT ?")
              .all(input.limit)
          : client
              .prepare("SELECT * FROM admin_alerts WHERE status = ? ORDER BY id DESC LIMIT ?")
              .all(input.status, input.limit)
      ) as any[];
      const openCount = client
        .prepare("SELECT COUNT(*) AS c FROM admin_alerts WHERE status = 'open'")
        .get() as any;
      return { alerts: rows, openCount: openCount.c };
    }),

  ackAlert: adminQuery
    .input(z.object({ alertId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const now = Math.floor(Date.now() / 1000);
      const info = getSqliteClient()
        .prepare(
          "UPDATE admin_alerts SET status = 'acknowledged', ack_by = ?, ack_at = ? WHERE id = ? AND status = 'open'",
        )
        .run(ctx.user!.id, now, input.alertId);
      if (info.changes === 0) throw new Error("Alert not found or not open");
      await writeAudit(ctx, "admin.ackAlert", { alertId: input.alertId });
      return { success: true };
    }),

  resolveAlert: adminQuery
    .input(z.object({ alertId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const now = Math.floor(Date.now() / 1000);
      const info = getSqliteClient()
        .prepare(
          "UPDATE admin_alerts SET status = 'resolved', resolved_by = ?, resolved_at = ? WHERE id = ? AND status IN ('open', 'acknowledged')",
        )
        .run(ctx.user!.id, now, input.alertId);
      if (info.changes === 0) throw new Error("Alert not found or already resolved");
      await writeAudit(ctx, "admin.resolveAlert", { alertId: input.alertId });
      return { success: true };
    }),

  getRiskSummary: adminQuery.query(async () => {
    const client = getSqliteClient();
    const alerts = client
      .prepare("SELECT COUNT(*) AS c FROM admin_alerts WHERE status = 'open'")
      .get() as any;
    const mismatches = client
      .prepare("SELECT COUNT(*) AS c FROM reconciliation_mismatches WHERE status = 'open'")
      .get() as any;
    return { openAlerts: alerts.c, openMismatches: mismatches.c };
  }),

  getRiskSignals: adminQuery.query(async () => {
    const client = getSqliteClient();
    const TS = tsSec("created_at");
    const now = Math.floor(Date.now() / 1000);

    // Accounts sharing a payout address (multi-account indicator).
    const sharedAddresses = client
      .prepare(
        `SELECT t.to_address AS address, COUNT(DISTINCT t.user_id) AS user_count,
                GROUP_CONCAT(DISTINCT t.user_id) AS user_ids
         FROM transactions t
         WHERE t.type = 'withdrawal' AND t.to_address IS NOT NULL AND t.to_address <> ''
         GROUP BY t.to_address HAVING user_count >= 2 ORDER BY user_count DESC LIMIT 20`,
      )
      .all() as any[];

    // Accounts sharing an IP (from login audit; first hop of XFF).
    const sharedIps = client
      .prepare(
        `SELECT ip AS ip_address, COUNT(DISTINCT user_id) AS user_count,
                GROUP_CONCAT(DISTINCT user_id) AS user_ids
         FROM (
           SELECT user_id, TRIM(SUBSTR(ip_address, 1, INSTR(ip_address || ',', ',') - 1)) AS ip
           FROM audit_log
           WHERE action = 'auth.login' AND ip_address IS NOT NULL AND ip_address <> '' AND user_id IS NOT NULL
         )
         GROUP BY ip HAVING user_count >= 2 ORDER BY user_count DESC LIMIT 20`,
      )
      .all() as any[];

    const userBrief = (ids: string) => {
      const list = ids.split(",").map((x) => parseInt(x, 10)).filter(Boolean);
      if (list.length === 0) return [];
      const rows = client
        .prepare(
          `SELECT id, email, name FROM users WHERE id IN (${list.map(() => "?").join(",")})`,
        )
        .all(...list) as any[];
      return rows;
    };

    // Spin-rate outliers (last 24h): flag players spinning at more
    // than 3x the active-player median, with a floor of 500 spins.
    const spinRows = client
      .prepare(
        `SELECT s.user_id, COUNT(*) AS spins FROM spins s
         WHERE ${tsSec("s.created_at")} >= ? GROUP BY s.user_id ORDER BY spins DESC`,
      )
      .all(now - 86400) as any[];
    const counts = spinRows.map((r) => r.spins).sort((a, b) => a - b);
    const median = counts.length ? counts[Math.floor(counts.length / 2)] : 0;
    const spinOutliers = spinRows
      .filter((r) => r.spins >= 500 && r.spins > 3 * Math.max(median, 1))
      .slice(0, 10)
      .map((r) => ({
        userId: r.user_id,
        spins24h: r.spins,
        median24h: median,
        users: userBrief(String(r.user_id)),
      }));

    // Win-rate outliers: >= 200 lifetime spins and player RTP > 110%.
    const winRows = client
      .prepare(
        `SELECT s.user_id, COUNT(*) AS spins,
                SUM(CAST(s.bet_amount AS REAL)) AS wagered,
                SUM(CAST(s.win_amount AS REAL)) AS won
         FROM spins s JOIN users u ON u.id = s.user_id
         WHERE u.role = 'user' AND s.is_free_spin = 0
         GROUP BY s.user_id HAVING spins >= 200 AND wagered > 0
         ORDER BY (won / wagered) DESC`,
      )
      .all() as any[];
    const winOutliers = winRows
      .filter((r) => r.won / r.wagered > 1.1)
      .slice(0, 10)
      .map((r) => ({
        userId: r.user_id,
        spins: r.spins,
        wagered: Math.round(r.wagered * 100) / 100,
        won: Math.round(r.won * 100) / 100,
        rtpPct: Math.round((r.won / r.wagered) * 10000) / 100,
        users: userBrief(String(r.user_id)),
      }));

    // Deposit-without-play: confirmed withdrawals while lifetime
    // wagered is under half of confirmed deposits (USDT terms,
    // summed per currency with FX conversion).
    const depRows = client
      .prepare(
        "SELECT user_id, currency, SUM(CAST(amount AS REAL)) AS total FROM transactions WHERE type = 'deposit' AND status = 'confirmed' GROUP BY user_id, currency",
      )
      .all() as any[];
    const wdRows = client
      .prepare(
        "SELECT user_id, currency, SUM(CAST(amount AS REAL)) AS total FROM transactions WHERE type = 'withdrawal' AND status = 'confirmed' GROUP BY user_id, currency",
      )
      .all() as any[];
    const wagRows = client
      .prepare(
        "SELECT user_id, currency, SUM(CAST(bet_amount AS REAL)) AS total FROM spins WHERE is_free_spin = 0 GROUP BY user_id, currency",
      )
      .all() as any[];
    const sumUsdt = (rows: any[]) => {
      const m = new Map<number, number>();
      for (const r of rows) m.set(r.user_id, (m.get(r.user_id) ?? 0) + toUsdt(r.total || 0, r.currency));
      return m;
    };
    const depMap = sumUsdt(depRows);
    const wdMap = sumUsdt(wdRows);
    const wagMap = sumUsdt(wagRows);
    const depositNoPlay: any[] = [];
    for (const [userId, withdrawals] of wdMap) {
      const deposits = depMap.get(userId) ?? 0;
      const wagered = wagMap.get(userId) ?? 0;
      if (withdrawals > 0 && deposits >= 100 && wagered < deposits * 0.5) {
        depositNoPlay.push({
          userId,
          depositsUsdt: Math.round(deposits * 100) / 100,
          withdrawalsUsdt: Math.round(withdrawals * 100) / 100,
          wageredUsdt: Math.round(wagered * 100) / 100,
          users: userBrief(String(userId)),
        });
      }
    }
    depositNoPlay.sort((a, b) => b.withdrawalsUsdt - a.withdrawalsUsdt);

    // Failed-login bursts per identifier (last 24h, >= 8 failures).
    const bursts = client
      .prepare(
        `SELECT json_extract(details, '$.identifier') AS identifier, COUNT(*) AS failures, MAX(created_at) AS last_at
         FROM audit_log
         WHERE action = 'auth.loginFailed' AND ${TS} >= ?
         GROUP BY identifier HAVING failures >= 8 ORDER BY failures DESC LIMIT 20`,
      )
      .all(now - 86400) as any[];

    return {
      sharedAddresses: sharedAddresses.map((r) => ({
        address: r.address,
        userCount: r.user_count,
        users: userBrief(r.user_ids),
      })),
      sharedIps: sharedIps.map((r) => ({
        ip: r.ip_address,
        userCount: r.user_count,
        users: userBrief(r.user_ids),
      })),
      spinOutliers,
      winOutliers,
      depositNoPlay: depositNoPlay.slice(0, 10),
      failedLoginBursts: bursts.map((b) => ({
        identifier: b.identifier,
        failures: b.failures,
        lastAt: b.last_at,
      })),
    };
  }),

  /* ================= Section I: system & ops ================= */
  getSystemHealth: adminQuery.query(async () => {
    const fsMod = await import("node:fs");
    const pathMod = await import("node:path");
    const { execFile } = await import("node:child_process");
    // Portable paths: everything resolves from the app directory
    // (cwd) and the app's own DB setting, with env overrides for
    // the ops locations — no hard-coded /opt/zeus-slot.
    const appDir = process.env.ZEUS_APP_DIR || process.cwd();
    const backupsDir = process.env.ZEUS_BACKUPS_DIR || "/var/backups/apps";
    const monitorStateDir = process.env.ZEUS_MONITOR_DIR || "/var/lib/zeus-monitor";
    const monitorLog = process.env.ZEUS_MONITOR_LOG || "/var/log/zeus-monitor.log";
    const serviceName = process.env.ZEUS_SERVICE_NAME || "zeus-slot";
    const run = (cmd: string, args: string[], timeout = 5000): Promise<string> =>
      new Promise((resolve) => {
        execFile(cmd, args, { timeout, maxBuffer: 1024 * 1024 }, (err, stdout) =>
          resolve(err ? "" : String(stdout)),
        );
      });

    // Version: the live git commit of the deployed tree.
    let commit: string | null = null;
    let commitDate: string | null = null;
    const gitOut = await run("git", ["-C", appDir, "log", "-1", "--format=%h|%cI"]);
    if (gitOut.trim()) {
      const [h, d] = gitOut.trim().split("|");
      commit = h ?? null;
      commitDate = d ?? null;
    }

    // DB size (main file + WAL + shm).
    let dbSizeBytes = 0;
    const dbFile =
      process.env.ZEUS_DB_PATH || pathMod.resolve(appDir, "data", "zeus.sqlite");
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        dbSizeBytes += fsMod.statSync(`${dbFile}${suffix}`).size;
      } catch { /* file may not exist */ }
    }

    // Disk headroom for the root filesystem.
    let disk: { total: number; free: number } | null = null;
    try {
      const st = (fsMod as any).statfsSync("/");
      disk = { total: Number(st.blocks) * Number(st.bsize), free: Number(st.bavail) * Number(st.bsize) };
    } catch { /* statfs unavailable */ }

    // Last backup (file + log line).
    let backup: { file: string; at: number; sizeBytes: number; logLine: string } | null = null;
    try {
      const dir = backupsDir;
      const files = fsMod
        .readdirSync(dir)
        .filter((f) => f.startsWith("zeus-nightly-") && f.endsWith(".tar.gz"))
        .sort();
      if (files.length) {
        const file = files[files.length - 1];
        const st = fsMod.statSync(`${dir}/${file}`);
        let logLine = "";
        try {
          const log = fsMod.readFileSync(`${dir}/zeus-backup.log`, "utf8").trim().split("\n");
          logLine = log[log.length - 1] ?? "";
        } catch { /* no log */ }
        backup = { file, at: Math.floor(st.mtimeMs / 1000), sizeBytes: st.size, logLine };
      }
    } catch { /* backups dir unreadable */ }

    // Monitor status (fail counter + recent log lines).
    let monitor: { failCount: number; recent: string[] } = { failCount: 0, recent: [] };
    try {
      const fc = fsMod.readFileSync(pathMod.join(monitorStateDir, "failcount"), "utf8").trim();
      monitor.failCount = parseInt(fc, 10) || 0;
    } catch { /* no state yet */ }
    try {
      const lines = fsMod.readFileSync(monitorLog, "utf8").trim().split("\n");
      monitor.recent = lines.slice(-5);
    } catch { /* no log yet */ }

    // Sanitised error tail from the service journal (24h): drop any
    // line that smells like a credential before it leaves the box.
    let errors: string[] = [];
    const journal = await run(
      "journalctl",
      ["-u", serviceName, "--since", "24 hours ago", "--no-pager", "-n", "400"],
      8000,
    );
    if (journal) {
      const SENSITIVE = /password|secret|token|api[_-]?key|authorization/i;
      errors = journal
        .split("\n")
        .filter((l) => /error|failed|exception|unhandled|ERR_/i.test(l) && !SENSITIVE.test(l))
        .map((l) => l.slice(0, 300))
        .slice(-20);
    }

    return {
      service: {
        uptimeSec: Math.floor(process.uptime()),
        startedAt: Math.floor(Date.now() / 1000) - Math.floor(process.uptime()),
        nodeVersion: process.version,
        pid: process.pid,
      },
      version: { commit, commitDate },
      db: { sizeBytes: dbSizeBytes },
      disk,
      backup,
      monitor,
      errors,
    };
  }),

  exportData: adminQuery
    .input(
      z.object({
        kind: z.enum(["players", "transactions", "spins", "settings_history"]),
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const client = getSqliteClient();
      const LIMIT = 10000;
      const esc = (v: unknown): string => {
        const s = v === null || v === undefined ? "" : String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const fmtTs = (v: unknown): string => {
        if (typeof v === "number" && v > 1e9) return new Date(v * 1000).toISOString();
        return v === null || v === undefined ? "" : String(v);
      };
      const fromSec = input.from ? Math.floor(Date.parse(`${input.from}T00:00:00Z`) / 1000) : null;
      const toSec = input.to ? Math.floor(Date.parse(`${input.to}T23:59:59Z`) / 1000) : null;
      const range = (col: string) => {
        const clauses: string[] = [];
        const params: number[] = [];
        if (fromSec !== null) { clauses.push(`${tsSec(col)} >= ?`); params.push(fromSec); }
        if (toSec !== null) { clauses.push(`${tsSec(col)} <= ?`); params.push(toSec); }
        return { sql: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
      };

      let header: string[] = [];
      let rows: unknown[][] = [];
      let truncatedFlag = false;
      if (input.kind === "players") {
        header = ["id", "name", "email", "phone", "role", "active", "tags", "created_at", "usdt_available", "usdt_locked", "bdt_available", "bdt_locked"];
        const r = range("u.created_at");
        const data = client
          .prepare(
            `SELECT u.*, b.currency, b.available, b.locked FROM users u
             LEFT JOIN balances b ON b.user_id = u.id ${r.sql} ORDER BY u.id LIMIT ?`,
          )
          .all(...r.params, LIMIT * 4) as any[];
        const byUser = new Map<number, any>();
        for (const row of data) {
          if (!byUser.has(row.id)) {
            byUser.set(row.id, {
              base: row,
              usdt_available: "0", usdt_locked: "0", bdt_available: "0", bdt_locked: "0",
            });
          }
          const agg = byUser.get(row.id);
          if (row.currency === "USDT") { agg.usdt_available = row.available; agg.usdt_locked = row.locked; }
          if (row.currency === "BDT") { agg.bdt_available = row.available; agg.bdt_locked = row.locked; }
        }
        rows = [...byUser.values()].slice(0, LIMIT).map((a) => [
          a.base.id, a.base.name, a.base.email, a.base.phone, a.base.role,
          a.base.is_active ? 1 : 0, a.base.tags ?? "", fmtTs(a.base.created_at),
          a.usdt_available, a.usdt_locked, a.bdt_available, a.bdt_locked,
        ]);
      } else if (input.kind === "transactions") {
        header = ["id", "created_at", "user_email", "type", "currency", "amount", "fee", "status", "to_address", "tx_hash", "payout_ref", "paid_at", "review_note"];
        const r = range("t.created_at");
        const data = client
          .prepare(
            `SELECT t.*, u.email FROM transactions t LEFT JOIN users u ON u.id = t.user_id ${r.sql} ORDER BY t.id DESC LIMIT ?`,
          )
          .all(...r.params, LIMIT + 1) as any[];
        rows = data.slice(0, LIMIT).map((t) => [
          t.id, fmtTs(t.created_at), t.email, t.type, t.currency, t.amount, t.fee, t.status,
          t.to_address, t.tx_hash, t.payout_ref, fmtTs(t.paid_at), t.review_note,
        ]);
        truncatedFlag = data.length > LIMIT;
      } else if (input.kind === "spins") {
        header = ["id", "created_at", "user_email", "currency", "bet_amount", "win_amount", "is_free_spin", "feature_triggered", "is_jackpot", "hash"];
        const r = range("s.created_at");
        const data = client
          .prepare(
            `SELECT s.*, u.email FROM spins s LEFT JOIN users u ON u.id = s.user_id ${r.sql} ORDER BY s.id DESC LIMIT ?`,
          )
          .all(...r.params, LIMIT + 1) as any[];
        rows = data.slice(0, LIMIT).map((sp) => [
          sp.id, fmtTs(sp.created_at), sp.email, sp.currency, sp.bet_amount, sp.win_amount,
          sp.is_free_spin, sp.feature_triggered, sp.is_jackpot, sp.hash,
        ]);
        truncatedFlag = data.length > LIMIT;
      } else {
        header = ["created_at", "admin_email", "action", "details"];
        const clauses: string[] = [];
        const params: number[] = [];
        if (fromSec !== null) { clauses.push(`${tsSec("a.created_at")} >= ?`); params.push(fromSec); }
        if (toSec !== null) { clauses.push(`${tsSec("a.created_at")} <= ?`); params.push(toSec); }
        const data = client
          .prepare(
            `SELECT a.*, u.email FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
             WHERE a.action IN ('admin.updateSettings', 'admin.publishMath', 'admin.updateJackpotConfig', 'admin.saveMathDraft')
             ${clauses.length ? `AND ${clauses.join(" AND ")}` : ""}
             ORDER BY a.id DESC LIMIT ?`,
          )
          .all(...params, LIMIT + 1) as any[];
        rows = data.slice(0, LIMIT).map((a) => [
          fmtTs(a.created_at), a.email, a.action,
          typeof a.details === "string" ? a.details : JSON.stringify(a.details),
        ]);
        truncatedFlag = data.length > LIMIT;
      }

      const csv = [header.join(","), ...rows.map((r) => r.map(esc).join(","))].join("\n");
      const wasTruncated = truncatedFlag;
      await writeAudit(ctx, "admin.exportData", { kind: input.kind, rows: rows.length, truncated: wasTruncated });
      return {
        filename: `zeus-${input.kind}-${new Date().toISOString().slice(0, 10)}.csv`,
        csv,
        rowCount: rows.length,
        truncated: wasTruncated,
      };
    }),

  // I3: alert channels live in settings (not env). The test button
  // posts from the app; the monitor reads the same settings for its
  // health alerts, falling back to the legacy env var.
  testAlertChannel: superAdminQuery.mutation(async ({ ctx }) => {
    const webhook = getSetting<string>("alert_webhook_url");
    const telegramChat = getSetting<string>("alert_telegram_chat_id");
    const message = "Zeus Slot test alert — channels are working.";
    const result: {
      webhook: { configured: boolean; ok?: boolean; status?: number; error?: string };
      telegram: { configured: boolean; ok?: boolean; error?: string };
    } = {
      webhook: { configured: !!webhook },
      telegram: { configured: !!telegramChat },
    };
    if (webhook) {
      try {
        const res = await fetch(webhook, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: message, content: message }),
          signal: AbortSignal.timeout(8000),
        });
        result.webhook.ok = res.ok;
        result.webhook.status = res.status;
      } catch (e: any) {
        result.webhook.ok = false;
        result.webhook.error = String(e?.message ?? e).slice(0, 200);
      }
    }
    if (telegramChat) {
      const token = process.env.TELEGRAM_BOT_TOKEN;
      if (!token) {
        result.telegram.ok = false;
        result.telegram.error = "TELEGRAM_BOT_TOKEN is not set in the server environment";
      } else {
        try {
          const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: telegramChat, text: message }),
            signal: AbortSignal.timeout(8000),
          });
          result.telegram.ok = res.ok;
          if (!res.ok) result.telegram.error = `Telegram API returned ${res.status}`;
        } catch (e: any) {
          result.telegram.ok = false;
          result.telegram.error = String(e?.message ?? e).slice(0, 200);
        }
      }
    }
    await writeAudit(ctx, "admin.testAlertChannel", {
      webhook: result.webhook.ok ?? false,
      telegram: result.telegram.ok ?? false,
    });
    return result;
  }),

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

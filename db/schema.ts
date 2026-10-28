import { sql } from "drizzle-orm";
import {
  sqliteTable,
  integer,
  text,
  uniqueIndex,
  index,
} from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
  unionId: text("unionId").notNull().unique(),
  name: text("name"),
  email: text("email"),
  phone: text("phone"),
  passwordHash: text("password_hash"),
  // AP1: admin two-factor auth. Secret is AES-256-GCM encrypted
  // (api/lib/totp.ts); totpEnabled flips only after a code verifies.
  totpSecret: text("totp_secret"),
  totpEnabled: integer("totp_enabled", { mode: "boolean" }).default(false).notNull(),
  // AP3: session epoch — session JWTs carry the epoch they were
  // minted at; bumping it (force sign-out) revokes every existing
  // session for the account without touching the password.
  sessionEpoch: integer("session_epoch").default(0).notNull(),
  avatar: text("avatar"),
  // AP2: super_admin is the owner tier (settings, roles, math);
  // admin is the day-to-day operations tier.
  role: text("role", { enum: ["user", "admin", "super_admin"] }).default("user").notNull(),
  walletAddress: text("wallet_address").unique(),
  username: text("username").unique(),
  nonce: text("nonce").notNull().default(""),
  isActive: integer("is_active", { mode: "boolean" }).default(true).notNull(),
  createdAt: integer("createdAt", { mode: "timestamp" }).default(sql`(CURRENT_TIMESTAMP)`).notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp" }).default(sql`(CURRENT_TIMESTAMP)`).notNull(),
  lastSignInAt: integer("lastSignInAt", { mode: "timestamp" }).default(sql`(CURRENT_TIMESTAMP)`).notNull(),
}, (table) => ({
  ukUsersEmail: uniqueIndex("uk_users_email").on(table.email),
  ukUsersPhone: uniqueIndex("uk_users_phone").on(table.phone),
}));

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

// AP1: one-time recovery codes for admin 2FA (SHA-256 hashes only).
export const totpRecoveryCodes = sqliteTable("totp_recovery_codes", {
  id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
  userId: integer("user_id", { mode: "number" }).notNull(),
  codeHash: text("code_hash").notNull(),
  usedAt: integer("used_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).default(sql`(CURRENT_TIMESTAMP)`).notNull(),
});

export const balances = sqliteTable("balances", {
  id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
  userId: integer("user_id", { mode: "number" }).notNull(),
  currency: text("currency", { enum: ["BTC", "ETH", "USDT", "BDT"] }).notNull(),
  available: text("available").default("0").notNull(),
  locked: text("locked").default("0").notNull(),
  totalDeposited: text("total_deposited").default("0").notNull(),
  totalWithdrawn: text("total_withdrawn").default("0").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).default(sql`(CURRENT_TIMESTAMP)`).notNull(),
}, (table) => ({
  ukUserCurrency: uniqueIndex("uk_user_currency").on(table.userId, table.currency),
}));

export type Balance = typeof balances.$inferSelect;

export const gameSessions = sqliteTable("game_sessions", {
  id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
  userId: integer("user_id", { mode: "number" }).notNull(),
  serverSeed: text("server_seed").notNull(),
  serverSeedHash: text("server_seed_hash").notNull(),
  clientSeed: text("client_seed").notNull(),
  nonce: integer("nonce", { mode: "number" }).default(0).notNull(),
  status: text("status", { enum: ["active", "completed", "expired"] }).default("active").notNull(),
  startedAt: integer("started_at", { mode: "timestamp" }).default(sql`(CURRENT_TIMESTAMP)`).notNull(),
  endedAt: integer("ended_at", { mode: "timestamp" }),
  totalSpins: integer("total_spins", { mode: "number" }).default(0).notNull(),
  totalWagered: text("total_wagered").default("0").notNull(),
  totalWon: text("total_won").default("0").notNull(),
  // A5: server-side free-spin state. While freeSpinsRemaining > 0 the next
  // spins are free, played at freeSpinsBet/freeSpinsCurrency (locked at
  // award time); awards during free spins add to the remaining count.
  freeSpinsRemaining: integer("free_spins_remaining", { mode: "number" }).default(0).notNull(),
  freeSpinsBet: text("free_spins_bet"),
  freeSpinsCurrency: text("free_spins_currency"),
}, (table) => ({
  idxUserActive: index("idx_user_active").on(table.userId, table.status),
  idxSeedHash: index("idx_seed_hash").on(table.serverSeedHash),
}));

export type GameSession = typeof gameSessions.$inferSelect;

export const spins = sqliteTable("spins", {
  id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
  sessionId: integer("session_id", { mode: "number" }).notNull(),
  userId: integer("user_id", { mode: "number" }).notNull(),
  nonce: integer("nonce", { mode: "number" }).notNull(),
  betAmount: text("bet_amount").notNull(),
  currency: text("currency", { enum: ["BTC", "ETH", "USDT", "BDT"] }).notNull(),
  reelPositions: text("reel_positions", { mode: "json" }).notNull(),
  symbolsShown: text("symbols_shown", { mode: "json" }).notNull(),
  winAmount: text("win_amount").default("0").notNull(),
  winLines: text("win_lines", { mode: "json" }),
  isFreeSpin: integer("is_free_spin", { mode: "boolean" }).default(false).notNull(),
  isBigWin: integer("is_big_win", { mode: "boolean" }).default(false).notNull(),
  isJackpot: integer("is_jackpot", { mode: "boolean" }).default(false).notNull(),
  featureTriggered: text("feature_triggered", { enum: ["none", "free_spins", "thunder_strike"] }).default("none").notNull(),
  freeSpinsAwarded: integer("free_spins_awarded", { mode: "number" }).default(0).notNull(),
  hash: text("hash").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).default(sql`(CURRENT_TIMESTAMP)`).notNull(),
}, (table) => ({
  ukSessionNonce: uniqueIndex("uk_session_nonce").on(table.sessionId, table.nonce),
  idxUserSpins: index("idx_user_spins").on(table.userId, table.createdAt),
  idxBigWins: index("idx_big_wins").on(table.isBigWin, table.createdAt),
}));

export type Spin = typeof spins.$inferSelect;

export const transactions = sqliteTable("transactions", {
  id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
  userId: integer("user_id", { mode: "number" }).notNull(),
  type: text("type", { enum: ["deposit", "withdrawal"] }).notNull(),
  currency: text("currency", { enum: ["BTC", "ETH", "USDT", "BDT"] }).notNull(),
  amount: text("amount").notNull(),
  fee: text("fee").default("0").notNull(),
  status: text("status", { enum: ["pending", "confirming", "confirmed", "failed", "cancelled"] }).default("pending").notNull(),
  txHash: text("tx_hash"),
  fromAddress: text("from_address"),
  toAddress: text("to_address").notNull(),
  confirmations: integer("confirmations", { mode: "number" }).default(0).notNull(),
  requiredConfirmations: integer("required_confirmations", { mode: "number" }).default(3).notNull(),
  processedAt: integer("processed_at", { mode: "timestamp" }),
  // Section D: money-operations workflow (migration 0014).
  approvedBy: integer("approved_by", { mode: "number" }),
  approvedAt: integer("approved_at", { mode: "timestamp" }),
  payoutRef: text("payout_ref"),
  paidAt: integer("paid_at", { mode: "timestamp" }),
  reviewNote: text("review_note"),
  holdReason: text("hold_reason"),
  createdAt: integer("created_at", { mode: "timestamp" }).default(sql`(CURRENT_TIMESTAMP)`).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).default(sql`(CURRENT_TIMESTAMP)`).notNull(),
}, (table) => ({
  idxUserTx: index("idx_user_tx").on(table.userId, table.type, table.status),
  idxTxHash: index("idx_tx_hash").on(table.txHash),
}));

export type Transaction = typeof transactions.$inferSelect;

export const jackpotPool = sqliteTable("jackpot_pool", {
  id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
  tier: text("tier", { enum: ["mini", "major", "mega"] }).notNull().unique(),
  seedAmount: text("seed_amount").notNull(),
  currentAmount: text("current_amount").notNull(),
  contributionRate: text("contribution_rate").notNull(),
  lastWonAt: integer("last_won_at", { mode: "timestamp" }),
  lastWonBy: integer("last_won_by", { mode: "number" }),
  hitCount: integer("hit_count", { mode: "number" }).default(0).notNull(),
});

export type JackpotPool = typeof jackpotPool.$inferSelect;

export const auditLog = sqliteTable("audit_log", {
  id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
  userId: integer("user_id", { mode: "number" }),
  action: text("action").notNull(),
  details: text("details", { mode: "json" }).notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  createdAt: integer("created_at", { mode: "timestamp" }).default(sql`(CURRENT_TIMESTAMP)`).notNull(),
}, (table) => ({
  idxUserAction: index("idx_user_action").on(table.userId, table.action),
  idxCreated: index("idx_created").on(table.createdAt),
}));

export const ledgerEntries = sqliteTable("ledger_entries", {
  id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
  userId: integer("user_id", { mode: "number" }).notNull(),
  spinId: integer("spin_id", { mode: "number" }),
  // spin_debit | spin_credit | free_spin_credit | deposit_credit |
  // withdraw_lock | withdraw_refund | admin_adjust (kept as free text so new
  // kinds never need a schema migration)
  kind: text("kind").notNull(),
  currency: text("currency").notNull(),
  amount: text("amount").notNull(), // signed: credits positive, debits negative
  balanceAfter: text("balance_after").notNull(),
  createdAt: integer("createdAt", { mode: "timestamp" }).default(sql`(CURRENT_TIMESTAMP)`).notNull(),
}, (table) => ({
  idxLedgerUser: index("idx_ledger_user").on(table.userId, table.createdAt),
  idxLedgerSpin: index("idx_ledger_spin").on(table.spinId),
}));

export type LedgerEntry = typeof ledgerEntries.$inferSelect;

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(), // JSON-encoded typed value (see api/lib/settings.ts)
  updatedAt: integer("updated_at", { mode: "timestamp" }).default(sql`(CURRENT_TIMESTAMP)`).notNull(),
  updatedBy: integer("updated_by", { mode: "number" }),
});

export type SettingRow = typeof settings.$inferSelect;

export const verificationCodes = sqliteTable("verification_codes", {
  id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
  identifier: text("identifier").notNull(),
  channel: text("channel", { enum: ["email", "phone"] }).notNull(),
  codeHash: text("code_hash").notNull(),
  purpose: text("purpose", { enum: ["register", "login", "reset"] }).notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  consumed: integer("consumed", { mode: "boolean" }).default(false).notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).default(sql`(CURRENT_TIMESTAMP)`).notNull(),
}, (table) => ({
  idxVerificationIdentifier: index("idx_verification_identifier").on(table.identifier),
}));

export type VerificationCode = typeof verificationCodes.$inferSelect;

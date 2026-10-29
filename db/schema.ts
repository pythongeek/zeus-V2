import { sql } from "drizzle-orm";
import {
  sqliteTable,
  integer,
  text,
  real,
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
  // Section C: admin tags (JSON array of short labels, migration 0015).
  tags: text("tags"),
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
  // Step 4: bonus bucket (bonus engine) — not withdrawable; funded by
  // bonus_ledger grants, spent before cash on spins, converts to
  // available when wagering completes.
  bonus: text("bonus").default("0").notNull(),
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
  freeSpinsMode: text("free_spins_mode").default("classic"),
  freeSpinsRung: integer("free_spins_rung").default(0),
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
  // Phase 0 (playbook §5.3): mode/bundle binding — which math resolved
  // this spin. Legacy rows keep bundleId null (pre-registry).
  modeId: text("mode_id").default("classic").notNull(),
  bundleId: text("bundle_id"),
  bundleSha256: text("bundle_sha256"),
  ladderRung: integer("ladder_rung"),
  nearMiss: integer("near_miss").default(0),
  createdAt: integer("created_at", { mode: "timestamp" }).default(sql`(CURRENT_TIMESTAMP)`).notNull(),
}, (table) => ({
  ukSessionNonce: uniqueIndex("uk_session_nonce").on(table.sessionId, table.nonce),
  idxUserSpins: index("idx_user_spins").on(table.userId, table.createdAt),
  idxBigWins: index("idx_big_wins").on(table.isBigWin, table.createdAt),
}));

export type Spin = typeof spins.$inferSelect;

// Phase 0: immutable, hash-pinned math bundles (playbook §5.2). A bundle
// fully determines a mode's outcomes; the only mutable state is which
// bundle is 'active' per mode. Status: draft | shadow | active | parked.
export const mathBundles = sqliteTable("math_bundles", {
  bundleId: text("bundle_id").primaryKey(),
  modeId: text("mode_id").notNull(),
  engine: text("engine").notNull(),
  bundle: text("bundle", { mode: "json" }).notNull(),
  sha256: text("sha256").notNull(),
  mathHash: text("math_hash").notNull(),
  status: text("status", { enum: ["draft", "shadow", "active", "parked"] }).default("draft").notNull(),
  cert: text("cert", { mode: "json" }),
  createdAt: integer("created_at").default(sql`(unixepoch())`).notNull(),
  activatedAt: integer("activated_at"),
});

export type MathBundle = typeof mathBundles.$inferSelect;

// Step 15 (playbook §4.1): RTP-drift tripwire state + events.
export const tripwireState = sqliteTable("tripwire_state", {
  modeId: text("mode_id").primaryKey(),
  lastSpinId: integer("last_spin_id").default(0).notNull(),
  ewma: real("ewma"),
  cusumPos: real("cusum_pos").default(0).notNull(),
  cusumNeg: real("cusum_neg").default(0).notNull(),
  spinsSeen: integer("spins_seen").default(0).notNull(),
  // The open (not yet flushed) paid-spin process: its free-spin rows
  // keep adding wins until the next paid spin of the session arrives.
  pendingSession: integer("pending_session"),
  pendingBet: real("pending_bet"),
  pendingWin: real("pending_win").default(0).notNull(),
  pendingSpinId: integer("pending_spin_id"),
  updatedAt: integer("updated_at").default(sql`(unixepoch())`).notNull(),
});

export const referrals = sqliteTable("referrals", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  referrerId: integer("referrer_id").notNull(),
  refereeId: integer("referee_id").notNull().unique(),
  code: text("code").notNull(),
  boundAt: integer("bound_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
  ip: text("ip"),
  userAgent: text("user_agent"),
  createdAt: integer("created_at").default(sql`(unixepoch())`),
});

export const referralEarnings = sqliteTable("referral_earnings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  referrerId: integer("referrer_id").notNull(),
  refereeId: integer("referee_id").notNull(),
  currency: text("currency").notNull(),
  periodStart: integer("period_start").notNull(),
  amount: text("amount").notNull(),
  ggr: text("ggr").notNull(),
  createdAt: integer("created_at").default(sql`(unixepoch())`),
});

export const referralPending = sqliteTable("referral_pending", {
  referrerId: integer("referrer_id").notNull(),
  currency: text("currency").notNull(),
  pending: text("pending").notNull().default("0"),
  updatedAt: integer("updated_at").default(sql`(unixepoch())`),
});

export const vipLevelGrants = sqliteTable("vip_level_grants", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull(),
  tierId: text("tier_id").notNull(),
  amount: text("amount").notNull(),
  currency: text("currency").notNull().default("BDT"),
  createdAt: integer("created_at").default(sql`(unixepoch())`),
});

export const wheelEntitlements = sqliteTable("wheel_entitlements", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull(),
  source: text("source").notNull(),
  periodStart: integer("period_start").notNull(),
  rollNonce: text("roll_nonce").notNull(),
  usedAt: integer("used_at"),
  prizeLabel: text("prize_label"),
  prizeKind: text("prize_kind"),
  prizeAmount: text("prize_amount"),
  createdAt: integer("created_at").default(sql`(unixepoch())`),
});

export const freeSpinTokens = sqliteTable("free_spin_tokens", {
  userId: integer("user_id").primaryKey(),
  spins: integer("spins").notNull().default(0),
  updatedAt: integer("updated_at").default(sql`(unixepoch())`),
});

export const reloadOptins = sqliteTable("reload_optins", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull(),
  offerId: text("offer_id").notNull(),
  status: text("status").notNull().default("armed"),
  depositTxId: integer("deposit_tx_id"),
  createdAt: integer("created_at").default(sql`(unixepoch())`),
  expiresAt: integer("expires_at").notNull(),
  consumedAt: integer("consumed_at"),
});

export const redEnvelopes = sqliteTable("red_envelopes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  scheduledAt: integer("scheduled_at").notNull(),
  currency: text("currency").notNull().default("BDT"),
  poolAmount: text("pool_amount").notNull(),
  claimedTotal: text("claimed_total").notNull().default("0"),
  maxClaims: integer("max_claims").notNull(),
  claimsCount: integer("claims_count").notNull().default(0),
  seed: text("seed").notNull(),
  seedHash: text("seed_hash").notNull(),
  createdBy: integer("created_by"),
  createdAt: integer("created_at").default(sql`(unixepoch())`),
});

export const redEnvelopeClaims = sqliteTable("red_envelope_claims", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  envelopeId: integer("envelope_id").notNull(),
  userId: integer("user_id").notNull(),
  amount: text("amount").notNull(),
  createdAt: integer("created_at").default(sql`(unixepoch())`),
});

export const promoSettlements = sqliteTable("promo_settlements", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  kind: text("kind").notNull(),
  userId: integer("user_id").notNull(),
  currency: text("currency").notNull(),
  periodStart: integer("period_start").notNull(),
  periodEnd: integer("period_end").notNull(),
  amount: text("amount").notNull(),
  basis: text("basis"),
  txId: integer("tx_id"),
  createdAt: integer("created_at").default(sql`(unixepoch())`),
});

export const rebateBalances = sqliteTable("rebate_balances", {
  userId: integer("user_id").notNull(),
  currency: text("currency").notNull(),
  pending: text("pending").notNull().default("0"),
  updatedAt: integer("updated_at").default(sql`(unixepoch())`),
});

export const tripwireProcesses = sqliteTable("tripwire_processes", {
  id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
  modeId: text("mode_id").notNull(),
  spinId: integer("spin_id").notNull(),
  x: real("x").notNull(),
  createdAt: integer("created_at").default(sql`(unixepoch())`).notNull(),
});

export const tripwireEvents = sqliteTable("tripwire_events", {
  id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
  modeId: text("mode_id").notNull(),
  layer: integer("layer").notNull(),
  kind: text("kind").notNull(),
  detail: text("detail"),
  spinId: integer("spin_id"),
  createdAt: integer("created_at").default(sql`(unixepoch())`).notNull(),
});

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
  // withdraw_lock | withdraw_refund | admin_adjust | bonus_credit |
  // bonus_debit | bonus_convert | bonus_expire (kept as free text so new
  // kinds never need a schema migration)
  kind: text("kind").notNull(),
  currency: text("currency").notNull(),
  amount: text("amount").notNull(), // signed: credits positive, debits negative
  balanceAfter: text("balance_after").notNull(),
  // Step 4: which balance bucket this leg's chain belongs to
  // ('available' | 'bonus'); reconciliation verifies each chain
  // against its own bucket.
  bucket: text("bucket").default("available").notNull(),
  createdAt: integer("createdAt", { mode: "timestamp" }).default(sql`(CURRENT_TIMESTAMP)`).notNull(),
}, (table) => ({
  idxLedgerUser: index("idx_ledger_user").on(table.userId, table.createdAt),
  idxLedgerSpin: index("idx_ledger_spin").on(table.spinId),
}));

export type LedgerEntry = typeof ledgerEntries.$inferSelect;

// Step 4 (migration 0019): one bonus ledger for every bonus kind —
// deposit_boost now; cashback / reload / red_envelope / referral /
// vip_wheel later. A grant is spent before cash when betting its
// currency, accrues wagering from bets in that currency, and any
// remainder converts to available once wagering completes.
export const bonusLedger = sqliteTable("bonus_ledger", {
  id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
  userId: integer("user_id", { mode: "number" }).notNull(),
  kind: text("kind").notNull(),
  currency: text("currency").notNull(),
  amount: text("amount").notNull(),
  remaining: text("remaining").notNull(),
  wageringMultiplier: integer("wagering_multiplier", { mode: "number" }).default(1).notNull(),
  wagered: text("wagered").default("0").notNull(),
  status: text("status").default("active").notNull(), // active | completed | expired
  refTxId: integer("ref_tx_id", { mode: "number" }),
  expiresAt: integer("expires_at", { mode: "number" }),
  createdAt: integer("created_at", { mode: "number" }).default(sql`(unixepoch())`).notNull(),
  updatedAt: integer("updated_at", { mode: "number" }).default(sql`(unixepoch())`).notNull(),
});

export type BonusLedgerEntry = typeof bonusLedger.$inferSelect;

// Section C: internal admin notes about a player (migration 0015).
export const playerNotes = sqliteTable("player_notes", {
  id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
  userId: integer("user_id", { mode: "number" }).notNull(),
  adminId: integer("admin_id", { mode: "number" }),
  note: text("note").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).default(sql`(unixepoch())`).notNull(),
}, (table) => ({
  idxPlayerNotesUser: index("idx_player_notes_user").on(table.userId, table.createdAt),
}));

export type PlayerNote = typeof playerNotes.$inferSelect;

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

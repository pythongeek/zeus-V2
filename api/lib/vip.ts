import crypto from "crypto";
import { fmtMoney, parseMoney } from "./money";
import { toUsdt } from "./limits";
import { grantBonusCredit, dhakaWeekStart } from "./settlement";

/**
 * Step 13 — VIP tiers, level-up grants, lucky wheel.
 *
 * Tiers ride on LIFETIME BDT-equivalent turnover (paid spins).
 * Rakeback percentages are of THEORETICAL loss (playbook tiers:
 * 5% → 15%). Level-up bonuses are one-time per tier, granted as
 * 1x-wagering BDT bonuses, plus one lucky-wheel entitlement each.
 */

type SqliteDb = {
  prepare: (sql: string) => any;
  transaction: (fn: (...args: any[]) => any) => any;
};

export interface VipTier {
  id: string;
  nameEn: string;
  nameBn: string;
  thresholdBdt: number;
  rakebackPct: number;
  levelupBonusBdt: number;
}

export function saneTiers(raw: unknown): VipTier[] {
  if (!Array.isArray(raw)) return [];
  const tiers = raw
    .filter((r: any) => r && typeof r === "object" && r.id)
    .map((r: any) => ({
      id: String(r.id),
      nameEn: String(r.nameEn ?? r.id),
      nameBn: String(r.nameBn ?? r.nameEn ?? r.id),
      thresholdBdt: Math.max(0, Number(r.thresholdBdt) || 0),
      rakebackPct: Math.max(0, Number(r.rakebackPct) || 0),
      levelupBonusBdt: Math.max(0, Number(r.levelupBonusBdt) || 0),
    }))
    .sort((a, b) => a.thresholdBdt - b.thresholdBdt);
  return tiers;
}

export function tierFor(turnoverBdt: number, tiers: VipTier[]): VipTier | null {
  let current: VipTier | null = null;
  for (const t of tiers) {
    if (turnoverBdt >= t.thresholdBdt) current = t;
  }
  return current;
}

export function nextTier(turnoverBdt: number, tiers: VipTier[]): VipTier | null {
  for (const t of tiers) {
    if (turnoverBdt < t.thresholdBdt) return t;
  }
  return null;
}

/** Lifetime paid-spin turnover in BDT equivalent (base rates). */
export function lifetimeTurnoverBdt(client: SqliteDb, userId: number): number {
  const rows = client
    .prepare(
      "SELECT currency, SUM(CAST(bet_amount AS REAL)) AS total FROM spins WHERE user_id = ? AND is_free_spin = 0 GROUP BY currency",
    )
    .all(userId) as Array<{ currency: string; total: number }>;
  return rows.reduce((acc, r) => acc + toUsdt(r.total, r.currency) * 110, 0);
}

/**
 * Grant any level-up bonuses the player has newly earned (once per
 * tier, ever). Each also mints a lucky-wheel entitlement. Runs in
 * one transaction; safe to call on every VIP-status read.
 */
export function ensureLevelGrants(
  client: SqliteDb,
  userId: number,
  tiers: VipTier[],
  nowSec: number,
): Array<{ tierId: string; amountBdt: number }> {
  const turnover = lifetimeTurnoverBdt(client, userId);
  const granted: Array<{ tierId: string; amountBdt: number }> = [];
  const run = client.transaction(() => {
    for (const tier of tiers) {
      if (tier.levelupBonusBdt <= 0) continue;
      if (turnover < tier.thresholdBdt) continue;
      const existing = client
        .prepare("SELECT id FROM vip_level_grants WHERE user_id = ? AND tier_id = ?")
        .get(userId, tier.id);
      if (existing) continue;
      const amountMicro = BigInt(Math.round(tier.levelupBonusBdt * 1e8));
      client
        .prepare("INSERT INTO vip_level_grants (user_id, tier_id, amount, currency, created_at) VALUES (?, ?, ?, 'BDT', ?)")
        .run(userId, tier.id, fmtMoney(amountMicro), nowSec);
      grantBonusCredit(client, {
        userId,
        currency: "BDT",
        amountMicro,
        kind: "vip_levelup",
        wageringMultiplier: 1,
        expiresAt: nowSec + 30 * 86400,
        nowSec,
      });
      client
        .prepare(
          "INSERT INTO wheel_entitlements (user_id, source, period_start, roll_nonce, created_at) VALUES (?, 'levelup', ?, ?, ?)",
        )
        .run(userId, nowSec, crypto.randomBytes(16).toString("hex"), nowSec);
      granted.push({ tierId: tier.id, amountBdt: tier.levelupBonusBdt });
    }
  });
  run();
  return granted;
}

/* ================= Lucky wheel ================= */

export interface WheelPrize {
  labelEn: string;
  labelBn: string;
  kind: "bonus" | "freespins";
  amount?: number;
  spins?: number;
  weight: number;
}

export function sanePrizes(raw: unknown): WheelPrize[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((r: any) => r && (r.kind === "bonus" || r.kind === "freespins") && Number(r.weight) > 0)
    .map((r: any) => ({
      labelEn: String(r.labelEn ?? "Prize"),
      labelBn: String(r.labelBn ?? r.labelEn ?? "Prize"),
      kind: r.kind,
      amount: r.amount !== undefined ? Number(r.amount) : undefined,
      spins: r.spins !== undefined ? Number(r.spins) : undefined,
      weight: Number(r.weight),
    }));
}

/** Deterministic weighted draw from the entitlement's fixed nonce. */
export function drawPrize(nonce: string, prizes: WheelPrize[]): WheelPrize | null {
  if (prizes.length === 0) return null;
  const total = prizes.reduce((a, p) => a + p.weight, 0);
  const h = crypto.createHash("sha256").update(`wheel:${nonce}`).digest();
  const bits = h.readUInt32BE(0) * 2 ** 20 + (h.readUInt32BE(4) >>> 12);
  let x = (bits / 2 ** 52) * total;
  for (const p of prizes) {
    x -= p.weight;
    if (x < 0) return p;
  }
  return prizes[prizes.length - 1];
}

/** Lazily mint this week's free wheel entitlement. */
export function ensureWeeklyEntitlement(client: SqliteDb, userId: number, nowSec: number): void {
  const weekStart = dhakaWeekStart(nowSec);
  client
    .prepare(
      "INSERT OR IGNORE INTO wheel_entitlements (user_id, source, period_start, roll_nonce, created_at) VALUES (?, 'weekly', ?, ?, ?)",
    )
    .run(userId, weekStart, crypto.randomBytes(16).toString("hex"), nowSec);
}

export function availableWheelSpins(client: SqliteDb, userId: number): number {
  const row = client
    .prepare("SELECT COUNT(*) AS c FROM wheel_entitlements WHERE user_id = ? AND used_at IS NULL")
    .get(userId) as any;
  return Number(row?.c ?? 0);
}

/** Add free-spin tokens (wheel prize) to the player's token bank. */
export function addFreeSpinTokens(client: SqliteDb, userId: number, spins: number, nowSec: number): void {
  client
    .prepare(
      `INSERT INTO free_spin_tokens (user_id, spins, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET spins = spins + excluded.spins, updated_at = excluded.updated_at`,
    )
    .run(userId, spins, nowSec);
}

export function freeSpinTokenBalance(client: SqliteDb, userId: number): number {
  const row = client.prepare("SELECT spins FROM free_spin_tokens WHERE user_id = ?").get(userId) as any;
  return Number(row?.spins ?? 0);
}

export { parseMoney };

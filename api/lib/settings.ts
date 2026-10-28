import { getSqliteClient } from "../queries/connection";
import { canonicalMoney } from "./money";

/**
 * B1: admin-controllable settings.
 *
 * Definitions live here (single source of truth): every key has a typed
 * default that preserves the behaviour the game shipped with, an EN/BN
 * label for the admin UI, and a scope — "public" keys are exposed to the
 * game client via game.getConfig; "admin" keys stay server-side.
 * Values are stored as JSON text in the settings table; reads are cached
 * for a few seconds and invalidated on write.
 */

export type SettingType = "number" | "string" | "boolean" | "json" | "money";

export interface SettingDef {
  type: SettingType;
  scope: "public" | "admin";
  def: unknown;
  labelEn: string;
  labelBn: string;
  group: string;
}

export const SETTING_DEFS: Record<string, SettingDef> = {
  min_bet: {
    type: "money", scope: "public", def: "0.1", group: "bets",
    labelEn: "Minimum bet", labelBn: "সর্বনিম্ন বেট",
  },
  max_bet: {
    type: "money", scope: "public", def: "1000", group: "bets",
    labelEn: "Maximum bet", labelBn: "সর্বোচ্চ বেট",
  },
  maintenance_mode: {
    type: "boolean", scope: "public", def: false, group: "site",
    labelEn: "Maintenance mode (blocks play)", labelBn: "রক্ষণাবেক্ষণ মোড (খেলা বন্ধ)",
  },
  announcement: {
    type: "string", scope: "public", def: "", group: "site",
    labelEn: "Announcement banner text (empty = hidden)", labelBn: "ঘোষণা ব্যানারের লেখা (খালি = লুকানো)",
  },
  support_telegram: {
    type: "string", scope: "public", def: "", group: "site",
    labelEn: "Support Telegram URL", labelBn: "সাপোর্ট টেলিগ্রাম লিংক",
  },
  support_hours: {
    type: "string", scope: "public", def: "18:00–02:00 (Dhaka)", group: "site",
    labelEn: "Support hours (display text)", labelBn: "সাপোর্টের সময় (প্রদর্শিত লেখা)",
  },
  big_win_threshold_x: {
    type: "number", scope: "public", def: 50, group: "presentation",
    labelEn: "Big Win threshold (× bet)", labelBn: "বিগ উইন থ্রেশহোল্ড (বেটের × গুণ)",
  },
  mega_win_threshold_x: {
    type: "number", scope: "public", def: 100, group: "presentation",
    labelEn: "Mega Win threshold (× bet)", labelBn: "মেগা উইন থ্রেশহোল্ড (বেটের × গুণ)",
  },
  default_language: {
    type: "string", scope: "public", def: "bn", group: "site",
    labelEn: "Default language (bn/en)", labelBn: "ডিফল্ট ভাষা (bn/en)",
  },
  // ---- B2: game math (admin-only; editing requires RTP re-certification) ----
  math_paytable: {
    type: "json", scope: "admin", group: "math",
    def: {
      "0": { "3": 50, "4": 200, "5": 1000 },
      "1": { "3": 2, "4": 5, "5": 20 },
      "2": { "3": 30, "4": 100, "5": 500 },
      "3": { "3": 25, "4": 80, "5": 400 },
      "4": { "3": 20, "4": 75, "5": 300 },
      "5": { "3": 15, "4": 40, "5": 200 },
      "6": { "3": 12, "4": 30, "5": 150 },
      "7": { "3": 10, "4": 30, "5": 100 },
      "8": { "3": 5, "4": 18, "5": 75 },
      "9": { "3": 5, "4": 18, "5": 75 },
      "10": { "3": 4, "4": 12, "5": 60 },
    },
    labelEn: "Paytable (multipliers by symbol id: 3/4/5 of a kind)", labelBn: "পেটেবল (সিম্বল আইডি অনুযায়ী গুণক: ৩/৪/৫টি)",
  },
  math_reels: {
    type: "json", scope: "admin", group: "math",
    def: [
      [0,0,1,1,2,2,2,3,3,3,4,4,4,5,5,5,5,6,6,6,6,7,7,7,7,8,8,8,8,8,9,9,9,9,9,10,10,10,10,10],
      [0,0,10,1,2,2,2,3,3,3,4,4,4,5,5,5,5,6,6,6,6,7,7,7,7,8,8,8,8,8,9,9,9,9,9,10,10,10,10,10],
      [0,0,0,1,1,2,2,2,3,3,3,4,4,4,5,5,5,5,6,6,6,6,7,7,7,7,8,8,8,8,8,9,9,9,9,9,10,10,10,10,10],
      [0,0,10,1,2,2,2,3,3,3,4,4,4,5,5,5,5,6,6,6,6,7,7,7,7,8,8,8,8,8,9,9,9,9,9,10,10,10,10,10],
      [0,0,10,1,2,2,2,3,3,3,4,4,4,5,5,5,5,6,6,6,6,7,7,7,7,8,8,8,8,8,9,9,9,9,9,10,10,10,10,10],
    ],
    labelEn: "Reel strips (symbol ids per reel)", labelBn: "রিল স্ট্রিপ (প্রতি রিলে সিম্বল আইডি)",
  },
  math_free_spins: {
    type: "json", scope: "admin", group: "math",
    def: { "3": 8, "4": 12, "5": 20 },
    labelEn: "Free spins awarded for 3/4/5 scatters", labelBn: "৩/৪/৫ স্ক্যাটারে ফ্রি স্পিন",
  },
  math_thunder: {
    type: "json", scope: "admin", group: "math",
    def: { "chanceDenominator": 200, "floorX": 5 },
    labelEn: "Thunder Strike: 1-in-N chance on zero-win spins, minimum win × bet", labelBn: "থান্ডার স্ট্রাইক: শূন্য-জয়ের স্পিনে সম্ভাবনা ও ন্যূনতম জয়",
  },
  jackpot_shares: {
    type: "json", scope: "admin", group: "math",
    def: { "mini": 5, "major": 3, "mega": 2 },
    labelEn: "Jackpot contribution per 1000 of bet (total 10 = 1%)", labelBn: "জ্যাকপট অবদান (প্রতি ১০০০ বেটে)",
  },
  jackpot_seeds: {
    type: "json", scope: "admin", group: "math",
    def: { "mini": "5", "major": "25", "mega": "100" },
    labelEn: "Jackpot seed amounts (USDT)", labelBn: "জ্যাকপট সিড পরিমাণ (USDT)",
  },
  rtp_declared: {
    type: "number", scope: "admin", def: 96.0, group: "math",
    labelEn: "Declared RTP % (update only after re-certification)", labelBn: "ঘোষিত RTP % (পুনঃসার্টিফিকেশনের পরই বদলান)",
  },
  // ---- B2: features, currencies, presentation (public) ----
  features: {
    type: "json", scope: "public", group: "features",
    def: { "freeSpins": true, "thunder": true, "jackpots": true },
    labelEn: "Feature toggles (freeSpins / thunder / jackpots)", labelBn: "ফিচার টগল (ফ্রি স্পিন / থান্ডার / জ্যাকপট)",
  },
  currencies_enabled: {
    type: "json", scope: "public", group: "currencies",
    def: ["USDT", "BDT"],
    labelEn: "Enabled currencies for play, deposits and withdrawals", labelBn: "সক্রিয় মুদ্রা (খেলা, জমা ও উত্তোলনের জন্য)",
  },
  binance_pay_id: {
    type: "string", scope: "public", group: "currencies",
    def: "",
    labelEn: "Binance PayID for deposits (shown to players)", labelBn: "ডিপোজিটের জন্য Binance PayID (খেলোয়াড়দের দেখানো হয়)",
  },
  binance_pay_name: {
    type: "string", scope: "public", group: "currencies",
    def: "",
    labelEn: "Binance account name shown with the PayID", labelBn: "PayID-এর সঙ্গে দেখানো Binance অ্যাকাউন্টের নাম",
  },
  fx_rates: {
    type: "json", scope: "public", group: "currencies",
    def: { "BTC": 11000000, "ETH": 380000, "USDT": 110, "BDT": 1 },
    labelEn: "BDT exchange rates per unit (display + conversions)", labelBn: "BDT বিনিময় হার (প্রতি ইউনিট)",
  },
  withdraw_fees: {
    type: "json", scope: "public", group: "currencies",
    def: { "BTC": "0.0001", "ETH": "0.001", "USDT": "1", "BDT": "10" },
    labelEn: "Withdrawal fee per currency", labelBn: "প্রতি মুদ্রায় উত্তোলন ফি",
  },
  withdraw_min: {
    type: "json", scope: "public", group: "currencies",
    def: { "BTC": "0.001", "ETH": "0.01", "USDT": "5", "BDT": "500" },
    labelEn: "Minimum withdrawal per currency", labelBn: "প্রতি মুদ্রায় সর্বনিম্ন উত্তোলন",
  },
  withdraw_max: {
    type: "json", scope: "public", group: "currencies",
    def: { "BTC": "1", "ETH": "10", "USDT": "10000", "BDT": "1000000" },
    labelEn: "Maximum withdrawal per currency", labelBn: "প্রতি মুদ্রায় সর্বোচ্চ উত্তোলন",
  },
  bet_steps: {
    type: "json", scope: "public", group: "bets",
    def: [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 25, 50, 100, 250, 500, 1000],
    labelEn: "Bet step ladder (for +/- controls)", labelBn: "বেট স্টেপ (＋/－ নিয়ন্ত্রণের জন্য)",
  },
  auto_spin_options: {
    type: "json", scope: "public", group: "presentation",
    def: [10, 25, 50, 100],
    labelEn: "Auto-spin count options", labelBn: "অটো-স্পিন সংখ্যার অপশন",
  },
  turbo_delays: {
    type: "json", scope: "public", group: "presentation",
    def: [120, 180, 240, 300, 360],
    labelEn: "Turbo reel stop delays (ms per reel)", labelBn: "টার্বো রিল থামার বিলম্ব (মিসে/রিল)",
  },
  normal_delays: {
    type: "json", scope: "public", group: "presentation",
    def: [350, 500, 650, 800, 950],
    labelEn: "Normal reel stop delays (ms per reel)", labelBn: "সাধারণ রিল থামার বিলম্ব (মিসে/রিল)",
  },
  celebrations_enabled: {
    type: "boolean", scope: "public", def: true, group: "presentation",
    labelEn: "Win celebrations enabled", labelBn: "জয়ের উদ্‌যাপন সক্রিয়",
  },
  sfx_volume_default: {
    type: "number", scope: "public", def: 80, group: "presentation",
    labelEn: "Default sound-effects volume (0-100, first visit)", labelBn: "ডিফল্ট সাউন্ড ইফেক্ট ভলিউম (০-১০০, প্রথম ভিজিটে)",
  },
  music_volume_default: {
    type: "number", scope: "public", def: 55, group: "presentation",
    labelEn: "Default music volume (0-100, first visit)", labelBn: "ডিফল্ট মিউজিক ভলিউম (০-১০০, প্রথম ভিজিটে)",
  },
};

const CACHE_TTL_MS = 5_000;
let cache: { at: number; values: Record<string, string> } | null = null;

function readAllRaw(): Record<string, string> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.values;
  const values: Record<string, string> = {};
  try {
    const rows = getSqliteClient()
      .prepare("SELECT key, value FROM settings")
      .all() as any[];
    for (const r of rows) values[r.key as string] = r.value as string;
  } catch {
    // Table may not exist yet (fresh DB before migrations) — defaults apply.
  }
  cache = { at: now, values };
  return values;
}

export function invalidateSettingsCache() {
  cache = null;
}

/** Typed value for a key (default when unset or unparsable). Sync. */
export function getSetting<T = unknown>(key: string): T {
  const def = SETTING_DEFS[key];
  if (!def) throw new Error(`Unknown setting: ${key}`);
  const raw = readAllRaw()[key];
  if (raw === undefined) return def.def as T;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return def.def as T;
  }
}

/** Validate + persist a value. Throws on unknown key or invalid value. */
export function setSetting(key: string, value: unknown, userId: number | null) {
  const def = SETTING_DEFS[key];
  if (!def) throw new Error(`Unknown setting: ${key}`);
  let stored: string;
  switch (def.type) {
    case "number": {
      const n = typeof value === "number" ? value : Number(value);
      if (!Number.isFinite(n)) throw new Error(`Setting ${key} must be a number`);
      stored = JSON.stringify(n);
      break;
    }
    case "boolean": {
      if (typeof value !== "boolean") throw new Error(`Setting ${key} must be true/false`);
      stored = JSON.stringify(value);
      break;
    }
    case "money": {
      stored = JSON.stringify(canonicalMoney(String(value)));
      break;
    }
    case "json": {
      // Must round-trip as JSON (objects/arrays); stored as given.
      stored = JSON.stringify(value);
      JSON.parse(stored);
      break;
    }
    default: {
      const s = String(value);
      if (s.length > 2000) throw new Error(`Setting ${key} is too long`);
      stored = JSON.stringify(s);
    }
  }
  const client = getSqliteClient();
  client
    .prepare(
      "INSERT INTO settings (key, value, updated_by) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP, updated_by = excluded.updated_by",
    )
    .run(key, stored, userId);
  invalidateSettingsCache();
}

/** All defs with current values — for the admin UI. */
export function getAllSettings() {
  const raw = readAllRaw();
  return Object.entries(SETTING_DEFS).map(([key, def]) => {
    let value: unknown = def.def;
    if (raw[key] !== undefined) {
      try {
        value = JSON.parse(raw[key]);
      } catch {
        value = def.def;
      }
    }
    return { key, ...def, value };
  });
}

/** Public subset for the game client. */
export function getPublicConfig(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, def] of Object.entries(SETTING_DEFS)) {
    if (def.scope === "public") out[key] = getSetting(key);
  }
  return out;
}

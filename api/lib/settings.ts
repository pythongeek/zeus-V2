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
  maintenance_message: {
    type: "string", scope: "public", def: "", group: "site",
    labelEn: "Maintenance message (shown on the maintenance screen; empty = default text)", labelBn: "রক্ষণাবেক্ষণের বার্তা (রক্ষণাবেক্ষণ স্ক্রিনে দেখানো হয়; খালি = ডিফল্ট লেখা)",
  },
  promo_text: {
    type: "string", scope: "public", def: "", group: "site",
    labelEn: "Promo banner text (empty = hidden)", labelBn: "প্রমো ব্যানারের লেখা (খালি = লুকানো)",
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
  jackpot_low_pool_alert: {
    type: "boolean", scope: "admin", def: true, group: "math",
    labelEn: "Alert in the Jackpot Centre when a pool sits below its seed", labelBn: "পুল সিডের নিচে থাকলে জ্যাকপট সেন্টারে সতর্কতা",
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
  // ---- Section E: RTP Lab ----
  math_draft: {
    type: "json", scope: "admin", def: null, group: "math",
    labelEn: "RTP Lab draft bundle (managed in the Lab)", labelBn: "RTP ল্যাব ড্রাফট বান্ডল (ল্যাবে পরিচালিত)",
  },
  rtp_publish_min: {
    type: "number", scope: "admin", def: 90, group: "math",
    labelEn: "RTP Lab: minimum publishable RTP %", labelBn: "RTP ল্যাব: সর্বনিম্ন প্রকাশযোগ্য RTP %",
  },
  rtp_publish_max: {
    type: "number", scope: "admin", def: 98, group: "math",
    labelEn: "RTP Lab: maximum publishable RTP %", labelBn: "RTP ল্যাব: সর্বোচ্চ প্রকাশযোগ্য RTP %",
  },
  max_win_x: {
    type: "number", scope: "admin", def: 0, group: "math",
    labelEn: "Max win cap (x bet, 0 = off; jackpots excluded)", labelBn: "সর্বোচ্চ জয়ের সীমা (বাজির ×, ০ = বন্ধ; জ্যাকপট বাদে)",
  },
  tripwire_enabled: {
    type: "boolean", scope: "admin", def: true, group: "math",
    labelEn: "RTP-drift tripwire enabled (Step 15)", labelBn: "RTP ড্রিফট ট্রিপওয়্যার চালু (ধাপ ১৫)",
  },
  tripwire_sigma_classic: {
    type: "number", scope: "admin", def: 6.5, group: "math",
    labelEn: "Tripwire: classic per-spin sigma (x bet, from certification)", labelBn: "ট্রিপওয়্যার: ক্লাসিক প্রতি-স্পিন সিগমা (বাজির ×)",
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
  // AP1: admin two-factor enforcement (Golden Toss parity). Admin
  // scope — never exposed in the public game config.
  alert_webhook_url: {
    type: "string", scope: "admin", def: "", group: "security",
    labelEn: "Alert webhook URL (monitor + critical alerts; empty = off)", labelBn: "সতর্কতা ওয়েবহুক URL (মনিটর + গুরুতর সতর্কতা; খালি = বন্ধ)",
  },
  alert_telegram_chat_id: {
    type: "string", scope: "admin", def: "", group: "security",
    labelEn: "Telegram alert chat ID (needs TELEGRAM_BOT_TOKEN in the server env)", labelBn: "টেলিগ্রাম সতর্কতার চ্যাট ID (সার্ভার env-এ TELEGRAM_BOT_TOKEN লাগবে)",
  },
  alert_big_win_usdt: {
    type: "number", scope: "admin", def: 500, group: "security",
    labelEn: "Alert threshold: single win at or above (USDT value)", labelBn: "সতর্কতার সীমা: একক জয় (USDT মূল্যে) এর বেশি হলে",
  },
  alert_big_withdrawal_usdt: {
    type: "number", scope: "admin", def: 1000, group: "security",
    labelEn: "Alert threshold: withdrawal request at or above (USDT value)", labelBn: "সতর্কতার সীমা: উত্তোলনের অনুরোধ (USDT মূল্যে) এর বেশি হলে",
  },
  admin_2fa_required: {
    type: "boolean", scope: "admin", group: "security",
    def: false,
    labelEn: "Require two-factor authentication (authenticator app) for all admin accounts", labelBn: "সব অ্যাডমিন অ্যাকাউন্টের জন্য টু-ফ্যাক্টর অথেনটিকেশন (অথেনটিকেটর অ্যাপ) বাধ্যতামূলক",
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
  // U5: same Binance Pay QR card + uni-qr link as Golden Toss, both
  // admin-editable like the PayID. The image itself is a static asset.
  binance_qr_image: {
    type: "string", scope: "public", group: "currencies",
    def: "",
    labelEn: "Binance Pay QR image path or URL shown for deposits", labelBn: "ডিপোজিটের জন্য Binance Pay QR ছবির পথ বা URL",
  },
  binance_pay_link: {
    type: "string", scope: "public", group: "currencies",
    def: "",
    labelEn: "Binance Pay link (opens the Binance app payment screen)", labelBn: "Binance Pay লিংক (Binance অ্যাপের পেমেন্ট স্ক্রিন খোলে)",
  },
  fx_rates: {
    type: "json", scope: "public", group: "currencies",
    def: { "BTC": 11000000, "ETH": 380000, "USDT": 110, "BDT": 1 },
    labelEn: "BDT exchange rates per unit (display + conversions)", labelBn: "BDT বিনিময় হার (প্রতি ইউনিট)",
  },
  // D2: deposit bounds, mirroring the withdrawal ones, plus an
  // operator daily cap (USDT terms) enforced at request time.
  deposit_min: {
    type: "json", scope: "public", group: "currencies",
    def: { "USDT": "5", "BDT": "500" },
    labelEn: "Minimum deposit per currency", labelBn: "প্রতি মুদ্রায় সর্বনিম্ন ডিপোজিট",
  },
  deposit_max: {
    type: "json", scope: "public", group: "currencies",
    def: { "USDT": "10000", "BDT": "1000000" },
    labelEn: "Maximum deposit per currency", labelBn: "প্রতি মুদ্রায় সর্বোচ্চ ডিপোজিট",
  },
  // Step 4 (BD plan): USDT deposit boost + premium display rate.
  // The boost is OFF until the operator enables it here.
  deposit_boost_enabled: {
    type: "boolean", scope: "public", group: "currencies",
    def: false,
    labelEn: "Deposit boost enabled", labelBn: "ডিপোজিট বুস্ট চালু",
  },
  deposit_boost_pct: {
    type: "number", scope: "public", group: "currencies",
    def: 5,
    labelEn: "Deposit boost % (e.g. 5 = +5%)", labelBn: "ডিপোজিট বুস্ট % (যেমন ৫ = +৫%)",
  },
  deposit_boost_currency: {
    type: "string", scope: "public", group: "currencies",
    def: "USDT",
    labelEn: "Boost applies to this currency", labelBn: "বুস্ট এই মুদ্রায় প্রযোজ্য",
  },
  deposit_boost_min_amount: {
    type: "money", scope: "admin", group: "currencies",
    def: "10",
    labelEn: "Minimum deposit for the boost", labelBn: "বুস্টের জন্য সর্বনিম্ন ডিপোজিট",
  },
  deposit_boost_wagering: {
    type: "number", scope: "admin", group: "currencies",
    def: 1,
    labelEn: "Boost wagering multiplier (1 = wager the bonus once)", labelBn: "বুস্ট ওয়েজারিং গুণক (১ = বোনাস একবার বাজি)",
  },
  deposit_boost_expiry_days: {
    type: "number", scope: "admin", group: "currencies",
    def: 30,
    labelEn: "Boost expires after (days)", labelBn: "বুস্টের মেয়াদ (দিন)",
  },
  usdt_bdt_premium: {
    type: "number", scope: "public", group: "currencies",
    def: 0,
    labelEn: "Premium BDT per USDT added to the display rate", labelBn: "ডিসপ্লে রেটে প্রতি USDT-তে প্রিমিয়াম টাকা",
  },
  deposit_daily_cap_usdt: {
    type: "number", scope: "admin", group: "currencies",
    def: 5000,
    labelEn: "Daily deposit cap per player (USDT equivalent, 0 = no cap)", labelBn: "প্রতি খেলোয়াড়ের দৈনিক ডিপোজিট সীমা (USDT সমতুল্য, 0 = সীমা নেই)",
  },
  // D4: withdrawal policy controls (Section D).
  withdrawal_dual_approval_usdt: {
    type: "number", scope: "admin", group: "currencies",
    def: 100,
    labelEn: "Dual approval above (USDT equivalent, 0 = off) — a second, different admin must confirm", labelBn: "দ্বৈত অনুমোদনের সীমা (USDT সমতুল্য, 0 = বন্ধ) — দ্বিতীয়, ভিন্ন অ্যাডমিনকে নিশ্চিত করতে হবে",
  },
  withdrawal_2fa_above_usdt: {
    type: "number", scope: "admin", group: "currencies",
    def: 1000,
    labelEn: "Two-factor re-confirm above (USDT equivalent, 0 = off) — final approver enters a fresh authenticator code", labelBn: "টু-ফ্যাক্টর পুনঃনিশ্চিতের সীমা (USDT সমতুল্য, 0 = বন্ধ) — চূড়ান্ত অনুমোদনকারীকে নতুন অথেনটিকেটর কোড দিতে হবে",
  },
  withdrawal_autohold_factor: {
    type: "number", scope: "admin", group: "currencies",
    def: 0,
    labelEn: "Auto-hold withdrawals above this × lifetime deposits (0 = off)", labelBn: "আজীবন ডিপোজিটের এই গুণিতকের বেশি উত্তোলন স্বয়ংক্রিয় হোল্ড (0 = বন্ধ)",
  },
  withdrawal_daily_cap_usdt: {
    type: "number", scope: "admin", group: "currencies",
    def: 0,
    labelEn: "Daily withdrawal cap per player (USDT equivalent, 0 = no cap)", labelBn: "প্রতি খেলোয়াড়ের দৈনিক উত্তোলন সীমা (USDT সমতুল্য, 0 = সীমা নেই)",
  },
  // Section C: per-action cap for manual balance adjustments.
  player_adjust_max_usdt: {
    type: "number", scope: "admin", group: "currencies",
    def: 500,
    labelEn: "Manual balance adjustment cap per action (USDT equivalent, 0 = no cap)", labelBn: "ম্যানুয়াল ব্যালেন্স সমন্বয়ের প্রতি-অ্যাকশন সীমা (USDT সমতুল্য, 0 = সীমা নেই)",
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
  bet_ladders: {
    type: "json", scope: "public", group: "bets",
    def: { BDT: [1, 2, 5, 10, 20, 50, 100], USDT: [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 25, 50, 100, 250, 500, 1000] },
    labelEn: "Bet ladders per currency (stepper + enforced on spin)", labelBn: "কারেন্সি অনুযায়ী বেট ল্যাডার (স্পিনে যাচাই হয়)",
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

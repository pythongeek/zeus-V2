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

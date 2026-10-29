#!/usr/bin/env node
/**
 * Weekly cashback settlement — standalone mirror of
 * api/lib/settlement.ts runCashback (same pattern as tripwire.mjs).
 * Runs from the monitor every Monday (Asia/Dhaka) after 06:00;
 * promo_settlements makes every period pay exactly once, so extra
 * runs are harmless no-ops. Week = Monday 00:00 Asia/Dhaka.
 */
import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const db = new Database(process.env.ZEUS_DB_PATH || path.join(root, "data", "zeus.sqlite"));

const setting = (key) => {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  if (!row) return undefined;
  try {
    return JSON.parse(row.value);
  } catch {
    return row.value;
  }
};
const fmt = (micro) => {
  const neg = micro < 0n;
  const abs = neg ? -micro : micro;
  return `${neg ? "-" : ""}${abs / 100000000n}.${(abs % 100000000n).toString().padStart(8, "0")}`;
};
const parse = (s) => {
  const neg = String(s).startsWith("-");
  const [i, f = ""] = String(s).replace("-", "").split(".");
  const v = BigInt(i || "0") * 100000000n + BigInt((f + "00000000").slice(0, 8));
  return neg ? -v : v;
};
const tsSec = (col) =>
  `CASE WHEN typeof(${col}) IN ('integer','real') THEN ${col} WHEN strftime('%s', ${col}) IS NOT NULL THEN CAST(strftime('%s', ${col}) AS INTEGER) ELSE CAST(${col} AS REAL) END`;

const DHAKA = 6 * 3600;
const nowSec = Math.floor(Date.now() / 1000);
const localDay = Math.floor((nowSec + DHAKA) / 86400);
const mon0 = (((localDay % 7) + 3) % 7 + 7) % 7;
const weekStart = (localDay - mon0) * 86400 - DHAKA;
const start = weekStart - 7 * 86400;
const end = weekStart;

if (setting("cashback_enabled") === false) {
  console.log("SETTLE cashback disabled — nothing to do");
  process.exit(0);
}
const pct = Number(setting("cashback_pct") ?? 5);
const pctHundredths = BigInt(Math.round(pct * 100));

const wagered = db
  .prepare(
    `SELECT user_id, currency, SUM(CAST(bet_amount AS REAL)) AS total FROM spins
     WHERE is_free_spin = 0 AND ${tsSec("created_at")} >= ? AND ${tsSec("created_at")} < ?
     GROUP BY user_id, currency`,
  )
  .all(start, end);
const won = db
  .prepare(
    `SELECT user_id, currency, SUM(CAST(win_amount AS REAL)) AS total FROM spins
     WHERE ${tsSec("created_at")} >= ? AND ${tsSec("created_at")} < ?
     GROUP BY user_id, currency`,
  )
  .all(start, end);
const wonByKey = new Map(won.map((r) => [`${r.user_id}:${r.currency}`, r.total]));

let grants = 0;
let totalMicro = 0n;
const credit = db.transaction((w, wonTotal, netLossMicro, amountMicro) => {
  const existing = db
    .prepare("SELECT id FROM promo_settlements WHERE kind = 'cashback' AND user_id = ? AND currency = ? AND period_start = ?")
    .get(w.user_id, w.currency, start);
  if (existing) return false;
  const bal = db.prepare("SELECT available, bonus FROM balances WHERE user_id = ? AND currency = ?").get(w.user_id, w.currency);
  const avail0 = parse(bal?.available ?? "0");
  const bonus0 = parse(bal?.bonus ?? "0");
  const tx = db
    .prepare(
      `INSERT INTO transactions (user_id, type, currency, amount, status, to_address, payout_ref, created_at, updated_at)
       VALUES (?, 'cashback', ?, ?, 'completed', 'internal', ?, ?, ?)`,
    )
    .run(w.user_id, w.currency, fmt(amountMicro), `cashback:${start}`, nowSec, nowSec);
  const txId = Number(tx.lastInsertRowid);
  db.prepare(
    `INSERT INTO bonus_ledger (user_id, currency, kind, amount, remaining, wagering_multiplier, wagered, status, ref_tx_id, expires_at, created_at, updated_at)
     VALUES (?, ?, 'cashback', ?, '0', 0, '0', 'completed', ?, NULL, ?, ?)`,
  ).run(w.user_id, w.currency, fmt(amountMicro), txId, nowSec, nowSec);
  const leg = db.prepare(
    `INSERT INTO ledger_entries (user_id, kind, currency, amount, balance_after, bucket)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  leg.run(w.user_id, "bonus_credit", w.currency, fmt(amountMicro), fmt(bonus0 + amountMicro), "bonus");
  leg.run(w.user_id, "bonus_convert", w.currency, fmt(-amountMicro), fmt(bonus0), "bonus");
  leg.run(w.user_id, "bonus_convert", w.currency, fmt(amountMicro), fmt(avail0 + amountMicro), "available");
  if (bal) {
    db.prepare("UPDATE balances SET available = ? WHERE user_id = ? AND currency = ?").run(fmt(avail0 + amountMicro), w.user_id, w.currency);
  } else {
    db.prepare("INSERT INTO balances (user_id, currency, available, locked, bonus) VALUES (?, ?, ?, '0', '0')").run(w.user_id, w.currency, fmt(amountMicro));
  }
  db.prepare(
    `INSERT INTO promo_settlements (kind, user_id, currency, period_start, period_end, amount, basis, tx_id, created_at)
     VALUES ('cashback', ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    w.user_id,
    w.currency,
    start,
    end,
    fmt(amountMicro),
    `wagered ${w.total.toFixed(8)} won ${wonTotal.toFixed(8)} netLoss ${(netLossMicro / 100000000n).toString()} pct ${pct}`,
    txId,
    nowSec,
  );
  return true;
});

for (const w of wagered) {
  const wonTotal = wonByKey.get(`${w.user_id}:${w.currency}`) ?? 0;
  const netLoss = w.total - wonTotal;
  if (!(netLoss > 0)) continue;
  const netLossMicro = BigInt(Math.round(netLoss * 1e8));
  const amountMicro = (netLossMicro * pctHundredths) / 10000n;
  if (amountMicro <= 0n) continue;
  if (credit(w, wonTotal, netLossMicro, amountMicro)) {
    grants += 1;
    totalMicro += amountMicro;
  }
}
console.log(`SETTLE cashback period [${start}, ${end}): ${grants} grants, total ${fmt(totalMicro)} (mixed currencies)`);

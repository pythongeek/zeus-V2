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

/* ---- Step 13 rakeback: tier% of theoretical loss, same rails ---- */
const BDT_RATES = { BTC: 11000000, ETH: 550000, USDT: 110, BDT: 1 };
const toUsdt = (amount, currency) => (amount * (BDT_RATES[currency] ?? 110)) / 110;
const tiersRaw = setting("vip_tiers");
const tiers = (Array.isArray(tiersRaw) ? tiersRaw : [
  { id: "bronze", thresholdBdt: 0, rakebackPct: 5 },
  { id: "silver", thresholdBdt: 50000, rakebackPct: 8 },
  { id: "gold", thresholdBdt: 250000, rakebackPct: 11 },
  { id: "platinum", thresholdBdt: 1000000, rakebackPct: 15 },
]).slice().sort((a, b) => a.thresholdBdt - b.thresholdBdt);
const declaredRtp = Number(setting("rtp_declared") ?? 95.95);
const theoLossFrac = Math.max(0, 1 - declaredRtp / 100);
let rbGrants = 0;
if (theoLossFrac > 0) {
  const creditRb = db.transaction((w, tier, amountMicro) => {
    const existing = db
      .prepare("SELECT id FROM promo_settlements WHERE kind = 'rakeback' AND user_id = ? AND currency = ? AND period_start = ?")
      .get(w.user_id, w.currency, start);
    if (existing) return false;
    const bal = db.prepare("SELECT available, bonus FROM balances WHERE user_id = ? AND currency = ?").get(w.user_id, w.currency);
    const avail0 = parse(bal?.available ?? "0");
    const bonus0 = parse(bal?.bonus ?? "0");
    const tx = db
      .prepare(
        `INSERT INTO transactions (user_id, type, currency, amount, status, to_address, payout_ref, created_at, updated_at)
         VALUES (?, 'rakeback', ?, ?, 'completed', 'internal', ?, ?, ?)`,
      )
      .run(w.user_id, w.currency, fmt(amountMicro), `rakeback:${start}`, nowSec, nowSec);
    const txId = Number(tx.lastInsertRowid);
    db.prepare(
      `INSERT INTO bonus_ledger (user_id, currency, kind, amount, remaining, wagering_multiplier, wagered, status, ref_tx_id, expires_at, created_at, updated_at)
       VALUES (?, ?, 'rakeback', ?, '0', 0, '0', 'completed', ?, NULL, ?, ?)`,
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
       VALUES ('rakeback', ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(w.user_id, w.currency, start, end, fmt(amountMicro), `wagered ${w.total.toFixed(8)} theoLossFrac ${theoLossFrac} tier ${tier.id} ${tier.rakebackPct}%`, txId, nowSec);
    return true;
  });
  for (const w of wagered) {
    if (!(w.total > 0)) continue;
    const lifeRows = db
      .prepare("SELECT currency, SUM(CAST(bet_amount AS REAL)) AS total FROM spins WHERE user_id = ? AND is_free_spin = 0 GROUP BY currency")
      .all(w.user_id);
    const turnoverBdt = lifeRows.reduce((acc, r) => acc + toUsdt(r.total, r.currency) * 110, 0);
    let tier = null;
    for (const tr of tiers) if (turnoverBdt >= tr.thresholdBdt) tier = tr;
    if (!tier || !(tier.rakebackPct > 0)) continue;
    const amountMicro = BigInt(Math.round(w.total * theoLossFrac * (tier.rakebackPct / 100) * 1e8));
    if (amountMicro <= 0n) continue;
    if (creditRb(w, tier, amountMicro)) rbGrants += 1;
  }
}
console.log(`SETTLE rakeback period [${start}, ${end}): ${rbGrants} grants`);

/* ---- Step 14 referral: 10% of referee GGR, 90d window, capped,
   minimum-activity gate, vested at >= 50 BDT equivalent ---- */
if (setting("referral_enabled") !== false) {
  const pct = Number(setting("referral_pct") ?? 10);
  const capBdt = Number(setting("referral_cap_bdt") ?? 5000);
  const minWageredBdt = Number(setting("referral_min_wagered_bdt") ?? 1000);
  const vestMinBdt = Number(setting("referral_vest_min_bdt") ?? 50);
  const binds = db.prepare("SELECT * FROM referrals WHERE expires_at > ?").all(start);
  let accruedCount = 0;
  for (const bind of binds) {
    const winStart = Math.max(start, bind.bound_at);
    const winEnd = Math.min(end, bind.expires_at);
    if (winEnd <= winStart) continue;
    const lifeRows = db
      .prepare(`SELECT currency, SUM(CAST(bet_amount AS REAL)) AS total FROM spins WHERE user_id = ? AND is_free_spin = 0 AND ${tsSec("created_at")} < ? GROUP BY currency`)
      .all(bind.referee_id, end);
    const lifeBdt = lifeRows.reduce((a, r) => a + toUsdt(r.total, r.currency) * 110, 0);
    if (lifeBdt < minWageredBdt) continue;
    const wag = db
      .prepare(`SELECT currency, SUM(CAST(bet_amount AS REAL)) AS total FROM spins WHERE user_id = ? AND is_free_spin = 0 AND ${tsSec("created_at")} >= ? AND ${tsSec("created_at")} < ? GROUP BY currency`)
      .all(bind.referee_id, winStart, winEnd);
    const wonRows = db
      .prepare(`SELECT currency, SUM(CAST(win_amount AS REAL)) AS total FROM spins WHERE user_id = ? AND ${tsSec("created_at")} >= ? AND ${tsSec("created_at")} < ? GROUP BY currency`)
      .all(bind.referee_id, winStart, winEnd);
    const wonByCur = new Map(wonRows.map((r) => [r.currency, r.total]));
    const prior = db.prepare("SELECT currency, amount FROM referral_earnings WHERE referee_id = ?").all(bind.referee_id);
    let accruedBdt = prior.reduce((a, r) => a + toUsdt(parseFloat(r.amount), r.currency) * 110, 0);
    for (const w of wag) {
      const ggr = w.total - (wonByCur.get(w.currency) ?? 0);
      if (!(ggr > 0)) continue;
      let earnMicro = BigInt(Math.round(ggr * (pct / 100) * 1e8));
      if (earnMicro <= 0n) continue;
      const earnBdt = toUsdt(Number(earnMicro) / 1e8, w.currency) * 110;
      if (accruedBdt + earnBdt > capBdt) {
        const remaining = capBdt - accruedBdt;
        if (remaining <= 0) continue;
        earnMicro = BigInt(Math.floor(Number(earnMicro) * (remaining / earnBdt)));
        if (earnMicro <= 0n) continue;
      }
      const ins = db
        .prepare(`INSERT OR IGNORE INTO referral_earnings (referrer_id, referee_id, currency, period_start, amount, ggr, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(bind.referrer_id, bind.referee_id, w.currency, start, fmt(earnMicro), ggr.toFixed(8), nowSec);
      if (Number(ins.changes) === 1) {
        accruedCount += 1;
        accruedBdt += toUsdt(Number(earnMicro) / 1e8, w.currency) * 110;
        const cur = db.prepare("SELECT pending FROM referral_pending WHERE referrer_id = ? AND currency = ?").get(bind.referrer_id, w.currency);
        const newPending = (cur ? parse(cur.pending) : 0n) + earnMicro;
        if (cur) {
          db.prepare("UPDATE referral_pending SET pending = ?, updated_at = ? WHERE referrer_id = ? AND currency = ?").run(fmt(newPending), nowSec, bind.referrer_id, w.currency);
        } else {
          db.prepare("INSERT INTO referral_pending (referrer_id, currency, pending, updated_at) VALUES (?, ?, ?, ?)").run(bind.referrer_id, w.currency, fmt(newPending), nowSec);
        }
      }
    }
  }
  // Vesting payouts (same wagering-free credit shape, kind referral).
  let vestedCount = 0;
  const pendings = db.prepare("SELECT * FROM referral_pending WHERE pending != '0'").all();
  for (const p of pendings) {
    const pendingMicro = parse(p.pending);
    if (pendingMicro <= 0n) continue;
    const bdtEq = toUsdt(Number(pendingMicro) / 1e8, p.currency) * 110;
    if (bdtEq < vestMinBdt) continue;
    const existing = db
      .prepare("SELECT id FROM promo_settlements WHERE kind = 'referral' AND user_id = ? AND currency = ? AND period_start = ?")
      .get(p.referrer_id, p.currency, start);
    if (existing) continue;
    const bal = db.prepare("SELECT available, bonus FROM balances WHERE user_id = ? AND currency = ?").get(p.referrer_id, p.currency);
    const avail0 = parse(bal?.available ?? "0");
    const bonus0 = parse(bal?.bonus ?? "0");
    db.transaction(() => {
      const tx = db
        .prepare(`INSERT INTO transactions (user_id, type, currency, amount, status, to_address, payout_ref, created_at, updated_at) VALUES (?, 'referral', ?, ?, 'completed', 'internal', ?, ?, ?)`)
        .run(p.referrer_id, p.currency, fmt(pendingMicro), `referral:${start}`, nowSec, nowSec);
      const txId = Number(tx.lastInsertRowid);
      db.prepare(`INSERT INTO bonus_ledger (user_id, currency, kind, amount, remaining, wagering_multiplier, wagered, status, ref_tx_id, expires_at, created_at, updated_at) VALUES (?, ?, 'referral', ?, '0', 0, '0', 'completed', ?, NULL, ?, ?)`).run(p.referrer_id, p.currency, fmt(pendingMicro), txId, nowSec, nowSec);
      const leg = db.prepare(`INSERT INTO ledger_entries (user_id, kind, currency, amount, balance_after, bucket) VALUES (?, ?, ?, ?, ?, ?)`);
      leg.run(p.referrer_id, "bonus_credit", p.currency, fmt(pendingMicro), fmt(bonus0 + pendingMicro), "bonus");
      leg.run(p.referrer_id, "bonus_convert", p.currency, fmt(-pendingMicro), fmt(bonus0), "bonus");
      leg.run(p.referrer_id, "bonus_convert", p.currency, fmt(pendingMicro), fmt(avail0 + pendingMicro), "available");
      if (bal) {
        db.prepare("UPDATE balances SET available = ? WHERE user_id = ? AND currency = ?").run(fmt(avail0 + pendingMicro), p.referrer_id, p.currency);
      } else {
        db.prepare("INSERT INTO balances (user_id, currency, available, locked, bonus) VALUES (?, ?, ?, '0', '0')").run(p.referrer_id, p.currency, fmt(pendingMicro));
      }
      db.prepare(`INSERT INTO promo_settlements (kind, user_id, currency, period_start, period_end, amount, basis, tx_id, created_at) VALUES ('referral', ?, ?, ?, ?, ?, ?, ?, ?)`).run(p.referrer_id, p.currency, start, end, fmt(pendingMicro), `vested referral earnings (${bdtEq.toFixed(2)} BDT eq)`, txId, nowSec);
      db.prepare("UPDATE referral_pending SET pending = '0', updated_at = ? WHERE referrer_id = ? AND currency = ?").run(nowSec, p.referrer_id, p.currency);
    })();
    vestedCount += 1;
  }
  console.log(`SETTLE referral period [${start}, ${end}): ${accruedCount} accruals, ${vestedCount} vested`);
}

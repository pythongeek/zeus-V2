#!/usr/bin/env node
/**
 * Section G1 — nightly reconciliation (plain-node mirror of
 * api/lib/reconcile.ts; keep the rules in step). Invoked by the
 * 5-minute monitor on its first run of each day. Verifies, for
 * every balance row: the ledger chain continuity, the chain tail
 * vs available, and locked vs open withdrawals. Findings upsert
 * into reconciliation_mismatches; new ones raise an admin alert.
 */
import Database from "/opt/zeus-slot/node_modules/better-sqlite3/lib/index.js";

const SCALE = 100000000n;
function parseMoney(value) {
  const s = String(value).trim();
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) throw new Error(`Invalid money value: ${value}`);
  const [, sign, intPart, fracPart = ""] = m;
  let micro = BigInt(intPart) * SCALE + BigInt((fracPart + "00000000").slice(0, 8));
  if (fracPart.length > 8 && fracPart[8] >= "5") micro += 1n;
  return sign === "-" ? -micro : micro;
}
function fmtMoney(micro) {
  const negative = micro < 0n;
  const abs = negative ? -micro : micro;
  const intPart = abs / SCALE;
  const frac = abs % SCALE;
  if (frac === 0n) return (negative ? "-" : "") + intPart.toString();
  const fracStr = frac.toString().padStart(8, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${intPart.toString()}.${fracStr}`;
}

const db = new Database("/opt/zeus-slot/data/zeus.sqlite");
const now = Math.floor(Date.now() / 1000);

const run = db
  .prepare("INSERT INTO reconciliation_runs (ran_by) VALUES (NULL) RETURNING id")
  .get();
const runId = run.id;

const balances = db.prepare("SELECT user_id, currency, available, locked, bonus FROM balances").all();
const legs = db
  .prepare("SELECT user_id, currency, amount, balance_after, bucket FROM ledger_entries ORDER BY user_id, currency, id")
  .all();
const openWd = db
  .prepare("SELECT user_id, currency, amount FROM transactions WHERE type = 'withdrawal' AND status IN ('pending', 'confirming')")
  .all();

const legsByKey = new Map();
for (const leg of legs) {
  const k = `${leg.user_id}|${leg.currency}|${leg.bucket || "available"}`;
  if (!legsByKey.has(k)) legsByKey.set(k, []);
  legsByKey.get(k).push(leg);
}
const openByKey = new Map();
for (const r of openWd) {
  const k = `${r.user_id}|${r.currency}`;
  openByKey.set(k, (openByKey.get(k) ?? 0n) + parseMoney(r.amount));
}

const findings = [];
for (const bal of balances) {
  const key = `${bal.user_id}|${bal.currency}`;
  const available = parseMoney(bal.available || "0");
  const locked = parseMoney(bal.locked || "0");
  const bonus = parseMoney(bal.bonus || "0");
  const checkChain = (rows, target, kinds, noneDetail, tailDetail) => {
    if (rows.length === 0) {
      if (target !== 0n) {
        findings.push({
          userId: bal.user_id, currency: bal.currency, kind: kinds.none,
          expected: "0", actual: fmtMoney(target),
          detail: noneDetail,
        });
      }
      return;
    }
    let prev = null;
    for (const leg of rows) {
      const amount = parseMoney(leg.amount);
      const after = parseMoney(leg.balance_after);
      if (prev !== null && after !== prev + amount) {
        findings.push({
          userId: bal.user_id, currency: bal.currency, kind: kinds.brk,
          expected: fmtMoney(prev + amount), actual: fmtMoney(after),
          detail: "A ledger leg's balance_after does not continue the chain",
        });
        return;
      }
      prev = after;
    }
    if (prev !== null && prev !== target) {
      findings.push({
        userId: bal.user_id, currency: bal.currency, kind: kinds.tail,
        expected: fmtMoney(prev), actual: fmtMoney(target),
        detail: tailDetail,
      });
    }
  };
  checkChain(
    legsByKey.get(`${key}|available`) ?? [],
    available,
    { none: "no_ledger", brk: "chain_break", tail: "tail_mismatch" },
    "Balance exists with no ledger history (predates the ledger or was credited outside it)",
    "Ledger chain tail does not equal the current available balance",
  );
  checkChain(
    legsByKey.get(`${key}|bonus`) ?? [],
    bonus,
    { none: "bonus_no_ledger", brk: "bonus_chain_break", tail: "bonus_tail_mismatch" },
    "Bonus balance exists with no bonus ledger history",
    "Bonus ledger chain tail does not equal the current bonus balance",
  );
  const openMicro = openByKey.get(key) ?? 0n;
  if (locked !== openMicro) {
    findings.push({
      userId: bal.user_id, currency: bal.currency, kind: "locked_mismatch",
      expected: fmtMoney(openMicro), actual: fmtMoney(locked),
      detail: "Locked balance does not equal the sum of open (pending/confirming) withdrawals",
    });
  }
}

let newCount = 0;
const apply = db.transaction(() => {
  const openRows = db
    .prepare("SELECT id, user_id, currency, kind FROM reconciliation_mismatches WHERE status = 'open'")
    .all();
  const openByKey = new Map(openRows.map((r) => [`${r.user_id}|${r.currency}|${r.kind}`, r]));
  const seen = new Set();
  for (const f of findings) {
    const key = `${f.userId}|${f.currency}|${f.kind}`;
    seen.add(key);
    const existing = openByKey.get(key);
    if (existing) {
      db.prepare("UPDATE reconciliation_mismatches SET run_id = ?, expected = ?, actual = ?, detail = ?, last_seen_at = ? WHERE id = ?")
        .run(runId, f.expected, f.actual, f.detail, now, existing.id);
    } else {
      db.prepare("INSERT INTO reconciliation_mismatches (run_id, user_id, currency, kind, expected, actual, detail) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(runId, f.userId, f.currency, f.kind, f.expected, f.actual, f.detail);
      newCount++;
      const refId = `${f.userId}:${f.currency}:${f.kind}`;
      const dup = db
        .prepare("SELECT id FROM admin_alerts WHERE kind = 'ledger_mismatch' AND ref_id = ? AND status IN ('open', 'acknowledged') LIMIT 1")
        .get(refId);
      if (!dup) {
        db.prepare("INSERT INTO admin_alerts (kind, severity, title, details, ref_user_id, ref_id) VALUES ('ledger_mismatch', 'critical', ?, ?, ?, ?)")
          .run(`Ledger mismatch: user ${f.userId} ${f.currency} (${f.kind})`, JSON.stringify(f), f.userId, refId);
      }
    }
  }
  for (const [key, row] of openByKey) {
    if (!seen.has(key)) {
      db.prepare("UPDATE reconciliation_mismatches SET status = 'resolved', resolved_at = ?, resolution_note = ? WHERE id = ?")
        .run(now, `Cleared by reconciliation run #${runId}`, row.id);
    }
  }
  db.prepare("UPDATE reconciliation_runs SET finished_at = ?, accounts_checked = ?, mismatch_count = ? WHERE id = ?")
    .run(now, balances.length, findings.length, runId);
});
apply();

console.log(
  `${new Date().toISOString()} RECON run #${runId}: ${balances.length} accounts, ${findings.length} mismatches (${newCount} new)`,
);

// I3: forward new findings to the configured alert webhook.
if (newCount > 0) {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'alert_webhook_url'").get();
    const url = row ? JSON.parse(row.value) : "";
    if (typeof url === "string" && url) {
      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: `Zeus reconciliation run #${runId}: ${newCount} NEW ledger mismatch(es) — see Admin > Risk.`,
          content: `Zeus reconciliation run #${runId}: ${newCount} NEW ledger mismatch(es) — see Admin > Risk.`,
        }),
        signal: AbortSignal.timeout(8000),
      });
    }
  } catch { /* webhook is best-effort */ }
}
db.close();

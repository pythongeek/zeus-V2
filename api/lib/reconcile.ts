import { getSqliteClient } from "../queries/connection";
import { parseMoney, fmtMoney } from "./money";

/**
 * Section G1 — reconciliation.
 *
 * The ledger (A2) records every movement of AVAILABLE balance as a
 * signed leg with the resulting balance_after, forming a chain:
 *   leg.balance_after == prev.balance_after + leg.amount
 * and the chain tail must equal balances.available. Locked funds
 * reconcile separately: balances.locked must equal the sum of
 * still-open withdrawal amounts (pending/confirming).
 *
 * Findings are upserted into reconciliation_mismatches keyed by
 * (user, currency, kind) so first-seen survives across runs; a
 * finding that disappears is auto-resolved. New findings raise a
 * G2 alert (deduped while one is open for the same account).
 *
 * scripts/reconcile.mjs mirrors this algorithm for the nightly
 * monitor run — keep the rules in step.
 */
export interface ReconFinding {
  userId: number;
  currency: string;
  kind: "chain_break" | "tail_mismatch" | "locked_mismatch" | "no_ledger"
    | "bonus_chain_break" | "bonus_tail_mismatch" | "bonus_no_ledger";
  expected: string;
  actual: string;
  detail: string;
}

export function computeReconFindings(): { findings: ReconFinding[]; accountsChecked: number } {
  const client = getSqliteClient();
  const findings: ReconFinding[] = [];

  const balances = client
    .prepare("SELECT user_id, currency, available, locked, bonus FROM balances")
    .all() as any[];
  const legs = client
    .prepare(
      "SELECT user_id, currency, amount, balance_after, bucket FROM ledger_entries ORDER BY user_id, currency, id",
    )
    .all() as any[];
  const openWithdrawals = client
    .prepare(
      "SELECT user_id, currency, amount FROM transactions WHERE type = 'withdrawal' AND status IN ('pending', 'confirming')",
    )
    .all() as any[];

  const legsByKey = new Map<string, any[]>();
  for (const leg of legs) {
    const key = `${leg.user_id}|${leg.currency}|${leg.bucket || "available"}`;
    if (!legsByKey.has(key)) legsByKey.set(key, []);
    legsByKey.get(key)!.push(leg);
  }
  const openWdByKey = new Map<string, bigint>();
  for (const r of openWithdrawals) {
    const k = `${r.user_id}|${r.currency}`;
    openWdByKey.set(k, (openWdByKey.get(k) ?? 0n) + parseMoney(r.amount));
  }

  let accountsChecked = 0;

  for (const bal of balances) {
    const key = `${bal.user_id}|${bal.currency}`;
    accountsChecked++;
    const available = parseMoney(bal.available || "0");
    const locked = parseMoney(bal.locked || "0");
    const bonus = parseMoney(bal.bonus || "0");

    // Chain check for one bucket: continuity of balance_after across
    // the bucket's legs, and the tail must equal the bucket balance.
    const checkChain = (
      rows: any[],
      target: bigint,
      kinds: { none: ReconFinding["kind"]; brk: ReconFinding["kind"]; tail: ReconFinding["kind"] },
      noneDetail: string,
      tailDetail: string,
    ) => {
      if (rows.length === 0) {
        if (target !== 0n) {
          findings.push({
            userId: bal.user_id,
            currency: bal.currency,
            kind: kinds.none,
            expected: "0",
            actual: fmtMoney(target),
            detail: noneDetail,
          });
        }
        return;
      }
      let prev: bigint | null = null;
      for (const leg of rows) {
        const amount = parseMoney(leg.amount);
        const after = parseMoney(leg.balance_after);
        if (prev !== null && after !== prev + amount) {
          findings.push({
            userId: bal.user_id,
            currency: bal.currency,
            kind: kinds.brk,
            expected: fmtMoney(prev + amount),
            actual: fmtMoney(after),
            detail: "A ledger leg's balance_after does not continue the chain",
          });
          return;
        }
        prev = after;
      }
      if (prev !== null && prev !== target) {
        findings.push({
          userId: bal.user_id,
          currency: bal.currency,
          kind: kinds.tail,
          expected: fmtMoney(prev),
          actual: fmtMoney(target),
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
    // Step 4: the bonus bucket reconciles as its own chain.
    checkChain(
      legsByKey.get(`${key}|bonus`) ?? [],
      bonus,
      { none: "bonus_no_ledger", brk: "bonus_chain_break", tail: "bonus_tail_mismatch" },
      "Bonus balance exists with no bonus ledger history",
      "Bonus ledger chain tail does not equal the current bonus balance",
    );

    // Locked vs open withdrawals.
    const openMicro = openWdByKey.get(key) ?? 0n;
    if (locked !== openMicro) {
      findings.push({
        userId: bal.user_id,
        currency: bal.currency,
        kind: "locked_mismatch",
        expected: fmtMoney(openMicro),
        actual: fmtMoney(locked),
        detail: "Locked balance does not equal the sum of open (pending/confirming) withdrawals",
      });
    }
  }

  return { findings, accountsChecked };
}

export function runReconciliation(ranBy: number | null): {
  runId: number;
  accountsChecked: number;
  mismatchCount: number;
  newCount: number;
} {
  const client = getSqliteClient();
  const run = client
    .prepare("INSERT INTO reconciliation_runs (ran_by) VALUES (?) RETURNING id")
    .get(ranBy) as any;
  const runId = run.id as number;

  const { findings, accountsChecked } = computeReconFindings();
  const now = Math.floor(Date.now() / 1000);
  let newCount = 0;

  const tx = client.transaction(() => {
    const openRows = client
      .prepare("SELECT id, user_id, currency, kind FROM reconciliation_mismatches WHERE status = 'open'")
      .all() as any[];
    const openByKey = new Map(openRows.map((r) => [`${r.user_id}|${r.currency}|${r.kind}`, r]));
    const seen = new Set<string>();

    for (const f of findings) {
      const key = `${f.userId}|${f.currency}|${f.kind}`;
      seen.add(key);
      const existing = openByKey.get(key);
      if (existing) {
        client
          .prepare(
            "UPDATE reconciliation_mismatches SET run_id = ?, expected = ?, actual = ?, detail = ?, last_seen_at = ? WHERE id = ?",
          )
          .run(runId, f.expected, f.actual, f.detail, now, existing.id);
      } else {
        client
          .prepare(
            "INSERT INTO reconciliation_mismatches (run_id, user_id, currency, kind, expected, actual, detail) VALUES (?, ?, ?, ?, ?, ?, ?)",
          )
          .run(runId, f.userId, f.currency, f.kind, f.expected, f.actual, f.detail);
        newCount++;
        // G2 alert, deduped per account+currency while unresolved.
        const refId = `${f.userId}:${f.currency}:${f.kind}`;
        const dup = client
          .prepare(
            "SELECT id FROM admin_alerts WHERE kind = 'ledger_mismatch' AND ref_id = ? AND status IN ('open', 'acknowledged') LIMIT 1",
          )
          .get(refId) as any;
        if (!dup) {
          client
            .prepare(
              "INSERT INTO admin_alerts (kind, severity, title, details, ref_user_id, ref_id) VALUES ('ledger_mismatch', 'critical', ?, ?, ?, ?)",
            )
            .run(
              `Ledger mismatch: user ${f.userId} ${f.currency} (${f.kind})`,
              JSON.stringify(f),
              f.userId,
              refId,
            );
        }
      }
    }

    // Findings that vanished have reconciled themselves.
    for (const [key, row] of openByKey) {
      if (!seen.has(key)) {
        client
          .prepare(
            "UPDATE reconciliation_mismatches SET status = 'resolved', resolved_at = ?, resolution_note = ? WHERE id = ?",
          )
          .run(now, `Cleared by reconciliation run #${runId}`, row.id);
      }
    }

    client
      .prepare(
        "UPDATE reconciliation_runs SET finished_at = ?, accounts_checked = ?, mismatch_count = ? WHERE id = ?",
      )
      .run(now, accountsChecked, findings.length, runId);
  });
  tx();

  return { runId, accountsChecked, mismatchCount: findings.length, newCount };
}

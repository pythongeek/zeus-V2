import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";

/**
 * A1/A2 (audit 2026-11-04): per-bundle RTP report math.
 * Synthetic production-shaped data: two bundles, a zero-payout FS
 * round, a paying FS round, and a sub-sample-size population — the
 * report must keep bundles separate, band correctly, and say
 * "insufficient sample" instead of implying signal.
 */

const tmpDir = fs.mkdtempSync(path.join("/tmp", "zeus-rtplab-test-"));
process.env.ZEUS_DB_PATH = path.join(tmpDir, "test.sqlite");

let computeRtpReport: any;

beforeAll(async () => {
  const Database = (await import("better-sqlite3")).default;
  const sqlite = new Database(process.env.ZEUS_DB_PATH!);
  const migrationsDir = path.resolve(process.cwd(), "db", "migrations");
  for (const file of fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()) {
    for (const stmt of fs.readFileSync(path.join(migrationsDir, file), "utf8").split("--> statement-breakpoint")) {
      if (stmt.trim()) sqlite.exec(stmt);
    }
  }
  // Registry: v1 parked (cert 95.95), v2 active (cert 96.04).
  sqlite
    .prepare(
      "INSERT INTO math_bundles (bundle_id, mode_id, engine, bundle, sha256, math_hash, status, cert) VALUES (?, 'classic', 'lines-5x3', '{}', ?, ?, 'parked', ?)",
    )
    .run("zeus-classic-v1", "h1", "mh1", JSON.stringify({ rtp_percent: 95.95 }));
  sqlite
    .prepare(
      "INSERT INTO math_bundles (bundle_id, mode_id, engine, bundle, sha256, math_hash, status, cert) VALUES (?, 'classic', 'lines-5x3', '{}', ?, ?, 'active', ?)",
    )
    .run("zeus-classic-v2", "h2", "mh2", JSON.stringify({ rtp_percent: 96.04 }));
  sqlite
    .prepare(
      "INSERT INTO math_bundles (bundle_id, mode_id, engine, bundle, sha256, math_hash, status, cert) VALUES (?, 'cascade', 'cascade', '{}', ?, ?, 'active', ?)",
    )
    .run("zeus-cascade-v1", "h3", "mh3", JSON.stringify({ result: "PASS", run: { rtp: 96.48 } }));
  sqlite
    .prepare(
      "INSERT INTO jackpot_pool (tier, seed_amount, current_amount, contribution_rate, hit_count) VALUES ('mini', '5', '7.5', '0.005', 2)",
    )
    .run();
  // (connection stays open until the end of beforeAll)

  computeRtpReport = (await import("./rtplab")).computeRtpReport;
  const ins = (await import("../queries/connection")).getSqliteClient();

  // v1: 10 paid spins, bet 1, total win 30 → 300% RTP (kept separate!).
  for (let i = 0; i < 10; i++) {
    ins
      .prepare("INSERT INTO spins (session_id, user_id, nonce, bet_amount, currency, reel_positions, symbols_shown, win_amount, hash, is_free_spin, mode_id, bundle_id) VALUES (1, 1, ?, '1', 'USDT', '[]', '[]', ?, 'h', 0, 'classic', 'zeus-classic-v1')")
      .run(i + 1, i === 0 ? "30" : "0");
  }
  // v2: 20 paid spins bet 2 (total bet 40), wins: one 20 (0.5x), one 40 (1x) → paid wins 60.
  // Plus FS: one zero round (2 spins win 0) and one paying round (2 spins win 3 total).
  for (let i = 0; i < 20; i++) {
    const win = i === 0 ? "20" : i === 1 ? "40" : "0";
    ins
      .prepare("INSERT INTO spins (session_id, user_id, nonce, bet_amount, currency, reel_positions, symbols_shown, win_amount, hash, is_free_spin, mode_id, bundle_id) VALUES (2, 1, ?, '2', 'USDT', '[]', '[]', ?, 'h', 0, 'classic', 'zeus-classic-v2')")
      .run(i + 1, win);
  }
  ins
    .prepare("INSERT INTO spins (session_id, user_id, nonce, bet_amount, currency, reel_positions, symbols_shown, win_amount, hash, is_free_spin, mode_id, bundle_id) VALUES (3, 1, 1, '2', 'USDT', '[]', '[]', '0', 'h', 1, 'classic', 'zeus-classic-v2')")
    .run();
  ins
    .prepare("INSERT INTO spins (session_id, user_id, nonce, bet_amount, currency, reel_positions, symbols_shown, win_amount, hash, is_free_spin, mode_id, bundle_id) VALUES (3, 1, 2, '2', 'USDT', '[]', '[]', '0', 'h', 1, 'classic', 'zeus-classic-v2')")
    .run();
  ins
    .prepare("INSERT INTO spins (session_id, user_id, nonce, bet_amount, currency, reel_positions, symbols_shown, win_amount, hash, is_free_spin, mode_id, bundle_id) VALUES (4, 1, 1, '2', 'USDT', '[]', '[]', '1', 'h', 1, 'classic', 'zeus-classic-v2')")
    .run();
  ins
    .prepare("INSERT INTO spins (session_id, user_id, nonce, bet_amount, currency, reel_positions, symbols_shown, win_amount, hash, is_free_spin, mode_id, bundle_id) VALUES (4, 1, 2, '2', 'USDT', '[]', '[]', '2', 'h', 1, 'classic', 'zeus-classic-v2')")
    .run();
  // cascade bundle: 5 paid spins bet 1, one win of 4 → 80% RTP.
  for (let i = 0; i < 5; i++) {
    ins
      .prepare("INSERT INTO spins (session_id, user_id, nonce, bet_amount, currency, reel_positions, symbols_shown, win_amount, hash, is_free_spin, mode_id, bundle_id) VALUES (5, 1, ?, '1', 'USDT', '[]', '[]', ?, 'h', 0, 'cascade', 'zeus-cascade-v1')")
      .run(i + 1, i === 0 ? "4" : "0");
  }
  sqlite.close();
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("A1/A2: per-bundle RTP report", () => {
  it("keeps bundles separate and computes true RTP = all wins ÷ paid bets", () => {
    const rep = computeRtpReport();
    const v1 = rep.rows.find((r: any) => r.bundleId === "zeus-classic-v1");
    const v2 = rep.rows.find((r: any) => r.bundleId === "zeus-classic-v2");
    const cas = rep.rows.find((r: any) => r.bundleId === "zeus-cascade-v1");
    expect(v1.trueRtp).toBeCloseTo(300, 1); // 30 wins / 10 paid bets
    expect(v1.certRtp).toBeCloseTo(95.95, 2);
    expect(v1.sufficient).toBe(false); // 11 spins << 5000
    // v2: paid wins 60 / paid bets 40 = 150% base; FS wins 3 → true 157.5%.
    expect(v2.baseRtp).toBeCloseTo(150, 1);
    expect(v2.trueRtp).toBeCloseTo(157.5, 1);
    expect(v2.paidSpins).toBe(20);
    expect(v2.fsSpins).toBe(4);
    expect(cas.trueRtp).toBeCloseTo(80, 1);
    expect(cas.certRtp).toBeCloseTo(96.48, 2); // cascade run.rtp shape
  });

  it("counts FS rounds and zero-payout FS rounds separately", () => {
    const rep = computeRtpReport();
    const v2 = rep.rows.find((r: any) => r.bundleId === "zeus-classic-v2");
    expect(v2.fsRounds).toBe(2);
    expect(v2.zeroFsRounds).toBe(1);
    expect(v2.hitRateFs).toBeCloseTo(50, 1); // 2 of 4 FS spins won
  });

  it("bands the true RTP from the per-spin sample and flags small samples", () => {
    const rep = computeRtpReport();
    const cas = rep.rows.find((r: any) => r.bundleId === "zeus-cascade-v1");
    expect(cas.sufficient).toBe(false);
    expect(cas.rtpLow).not.toBeNull();
    expect(cas.rtpLow!).toBeLessThanOrEqual(cas.trueRtp!);
    expect(cas.rtpHigh!).toBeGreaterThanOrEqual(cas.trueRtp!);
    // Exact band for x = [4,0,0,0,0]: sd = sqrt(3.2-0.64) = 1.6,
    // half = 1.96·1.6/√5·100 ≈ 140.246 — low clamps at 0 (80-140 < 0).
    expect(cas.rtpHigh!).toBeCloseTo(220.246, 2);
    expect(cas.rtpLow!).toBe(0);
  });

  it("reports per-day detail and jackpot pools (A8: contribution shown separately)", () => {
    const rep = computeRtpReport();
    expect(rep.days.length).toBeGreaterThan(0);
    expect(rep.jackpots[0]).toMatchObject({ tier: "mini", seed: 5, current: 7.5, hitCount: 2 });
    expect(rep.rows.every((r: any) => r.lastSpinAt !== null)).toBe(true);
  });
});

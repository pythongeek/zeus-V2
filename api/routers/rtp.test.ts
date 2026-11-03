import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs";
import path from "path";
import {
  calculateSpin,
  evaluatePaylines,
  checkThunderStrike,
  SYMBOLS,
} from "./game";
import { settingsMathConfig } from "../lib/bundles";

// The strict settings-math reader touches the settings store — give it
// an isolated migrated database like the other engine-level tests.
const tmpDir = fs.mkdtempSync(path.join("/tmp", "zeus-rtp-test-"));
process.env.ZEUS_DB_PATH = path.join(tmpDir, "test.sqlite");

beforeAll(async () => {
  const Database = (await import("better-sqlite3")).default;
  const sqlite = new Database(process.env.ZEUS_DB_PATH!);
  const migrationsDir = path.resolve(process.cwd(), "db", "migrations");
  for (const file of fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()) {
    sqlite.exec(fs.readFileSync(path.join(migrationsDir, file), "utf8"));
  }
  sqlite.close();
});

/**
 * A4 RTP certification regression.
 *
 * Simulates the REAL engine (real SHA-256 spin hashes, real evaluator,
 * real thunder check + transform derivation) over 120k spins and checks
 * the total RTP against the certified 96.0%:
 *
 *   total = (B + T + J) / (1 - f)
 *
 * B = base lines+scatter EV, T = Thunder Strike EV, f = expected free
 * spins awarded per spin (free spins replay at the same bet, hence the
 * geometric chain), J = pool-funded jackpot EV at the $1 reference bet
 * for the A6 model (1% contribution recycled + 0.08pt exact seed subsidy
 * from the 5/25/100 USDT pools at their hash probabilities).
 *
 * Certified 2026-10-28: EXACT enumeration of lines+scatter gives
 * B 68.344% and f 0.2501 (FS trigger 2.816%); Thunder Strike 2.56%
 * (2,000,000-spin Monte-Carlo); jackpot 1.08pt -> total 96.00%.
 * The old math measured B 82.3% / f 0.798 (a >400% chain) and advertised
 * a false 96.5%.
 */
const JACKPOT_EV = 0.0108;
const SPINS = 120_000;

describe("A4: RTP certification", () => {
  it(
    "total RTP matches the certified 96.0% (tolerance ±1.5pt at 120k spins)",
    () => {
      // A4/A5: the engine no longer carries fallback math constants —
      // the test reads the certified settings mirror directly.
      const math = settingsMathConfig();
      let paySum = 0; // in betPerLine units; total bet = 20
      let thunderSum = 0;
      let fsSum = 0;
      for (let nonce = 1; nonce <= SPINS; nonce++) {
        const { symbols, hash } = calculateSpin("rtp-cert-seed", "rtp", nonce, math.strips);
        const res = evaluatePaylines(symbols.map((c) => [...c]), 1, math);
        paySum += res.totalPayout;
        fsSum += res.freeSpinsAwarded;
        if (res.totalPayout === 0 && checkThunderStrike(hash)) {
          const g = symbols.map((c) => [...c]);
          const numTransforms = (parseInt(hash.substring(30, 32), 16) % 3) + 1;
          for (let i = 0; i < numTransforms; i++) {
            const r = parseInt(hash.substring(32 + i * 4, 34 + i * 4), 16) % 5;
            const row = parseInt(hash.substring(34 + i * 4, 36 + i * 4), 16) % 3;
            g[r][row] = SYMBOLS.ZEUS;
          }
          const re = evaluatePaylines(g, 1, math);
          thunderSum += Math.max(re.totalPayout, 100); // floor 5x total bet = 100 betPerLine
        }
      }
      const B = paySum / SPINS / 20;
      const T = thunderSum / SPINS / 20;
      const f = fsSum / SPINS;
      const total = (B + T + JACKPOT_EV) / (1 - f);
      // Guard rails on the components, then the headline number.
      expect(f).toBeGreaterThan(0.18);
      expect(f).toBeLessThan(0.33);
      expect(B).toBeGreaterThan(0.6);
      expect(B).toBeLessThan(0.76);
      expect(total).toBeGreaterThan(0.945);
      expect(total).toBeLessThan(0.975);
    },
    120_000,
  );
});

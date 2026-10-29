import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";

/**
 * Phase 0 MC harness (playbook §6): sequential estimator mechanics,
 * control-variate variance reduction, and the POSITIVE CONTROL —
 * the harness must reproduce the classic game's certified
 * full-process RTP (exact enumeration + certifier thunder MC)
 * inside its own confidence interval, or it certifies nothing.
 */

const tmpDir = fs.mkdtempSync(path.join("/tmp", "zeus-mc-test-"));
const dbPath = path.join(tmpDir, "test.sqlite");
process.env.ZEUS_DB_PATH = dbPath;

let mc: any;
let getMathConfig: any;

beforeAll(async () => {
  const Database = (await import("better-sqlite3")).default;
  const sqlite = new Database(dbPath);
  const migrationsDir = path.resolve(process.cwd(), "db", "migrations");
  for (const file of fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()) {
    sqlite.exec(fs.readFileSync(path.join(migrationsDir, file), "utf8"));
  }
  sqlite.close();
  mc = await import("./mc");
  getMathConfig = (await import("../routers/game")).getMathConfig;
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("sequential estimator", () => {
  it("a constant stream stops at the first batch with zero width", () => {
    const r = mc.runSequentialMC(() => ({ x: 0.96 }), { tolerance: 0.003, maxSpins: 1_000_000 });
    expect(r.stoppedBy).toBe("tolerance");
    expect(r.mean).toBeCloseTo(0.96, 10);
    expect(r.sigma).toBe(0);
    expect(r.seqHalfWidth).toBe(0);
  });

  it("the sequential bound is wider than the naive one and shrinks with n", () => {
    const rng = mc.mulberry32(42);
    const r = mc.runSequentialMC(() => ({ x: rng() * 2 }), { tolerance: 0, maxSpins: 200_000, batchSize: 50_000 });
    expect(r.stoppedBy).toBe("max");
    expect(r.mean).toBeGreaterThan(0.97);
    expect(r.mean).toBeLessThan(1.03);
    expect(r.seqHalfWidth).toBeGreaterThan(r.naiveHalfWidth);
    expect(r.naiveHalfWidth).toBeLessThan(0.01);
  });

  it("control variate removes the explained variance (kappa >> 1)", () => {
    const rng = mc.mulberry32(7);
    // c is a fair coin paying 2 (E[c] = 1 exactly); x = c + small noise.
    const r = mc.runSequentialMC(
      () => {
        const c = rng() < 0.5 ? 2 : 0;
        return { x: c + (rng() * 0.2 - 0.1), c };
      },
      { tolerance: 0, maxSpins: 100_000, expectedC: 1 },
    );
    expect(r.kappa).toBeGreaterThan(10);
    expect(r.mean).toBeGreaterThan(0.98);
    expect(r.mean).toBeLessThan(1.02);
  });
});

describe("positive control: the classic game", () => {
  it(
    "harness reproduces the certified full-process RTP inside its CI",
    () => {
      const math = getMathConfig();
      const { target, cert } = mc.classicProcessTarget(math);
      // Sanity: the certifier still reports the known production math.
      expect(cert.totalPct).toBeGreaterThan(95.4);
      expect(cert.totalPct).toBeLessThan(96.5);

      const sampler = mc.makeClassicProcessSampler(math, "positive-control");
      const r = mc.runSequentialMC(sampler, { tolerance: 0, maxSpins: 2_000_000, batchSize: 50_000 });
      console.log(
        `MC control: n=${r.n} mean=${r.mean.toFixed(4)} sigma=${r.sigma.toFixed(2)} naiveHW=${r.naiveHalfWidth.toFixed(4)} seqHW=${r.seqHalfWidth.toFixed(4)} target=${target.toFixed(4)}`,
      );
      // The certified value must sit inside the harness interval,
      // widened slightly for the certifier's own thunder-MC noise.
      expect(Math.abs(r.mean - target)).toBeLessThan(r.naiveHalfWidth + 0.006);
      expect(r.sigma).toBeGreaterThan(3);
      expect(r.sigma).toBeLessThan(15);
    },
    240_000,
  );
});

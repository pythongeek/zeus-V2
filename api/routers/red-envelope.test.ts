import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";

/**
 * Step 11 — red envelopes: PF claim amounts, one claim per wallet,
 * pool + max-claims caps, seed commitment/reveal, daily budget.
 */

const tmpDir = fs.mkdtempSync(path.join("/tmp", "zeus-env-test-"));
const dbPath = path.join(tmpDir, "test.sqlite");
process.env.ZEUS_DB_PATH = dbPath;

let promoRouter: any;
let adminRouter: any;
let envelopesLib: any;
let getDb: any;
let getSqliteClient: any;
let schema: any;
let settingsLib: any;

const nowSec = () => Math.floor(Date.now() / 1000);
let adminCtx: any;
const users: any[] = [];

function userCaller(u: any) {
  return promoRouter.createCaller({
    user: u,
    req: new Request("http://localhost/api/trpc"),
    resHeaders: new Headers(),
  });
}

beforeAll(async () => {
  const Database = (await import("better-sqlite3")).default;
  const sqlite = new Database(dbPath);
  const migrationsDir = path.resolve(process.cwd(), "db", "migrations");
  for (const file of fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()) {
    const sqlText = fs.readFileSync(path.join(migrationsDir, file), "utf8");
    for (const stmt of sqlText.split("--> statement-breakpoint")) {
      const trimmed = stmt.trim();
      if (trimmed) sqlite.exec(trimmed);
    }
  }
  sqlite.close();

  promoRouter = (await import("./promo")).promoRouter;
  adminRouter = (await import("./admin")).adminRouter;
  envelopesLib = await import("../lib/envelopes");
  getDb = (await import("../queries/connection")).getDb;
  getSqliteClient = (await import("../queries/connection")).getSqliteClient;
  schema = await import("../../db/schema");
  settingsLib = await import("../lib/settings");
  settingsLib.setSetting("binance_pay_id", "556677889", null);
  settingsLib.setSetting("red_envelope_daily_budget_bdt", 100000, null);

  const db = getDb();
  const [admin] = await db
    .insert(schema.users)
    .values({ unionId: "test:env:admin", name: "Env Admin", role: "admin" })
    .returning();
  adminCtx = {
    user: admin,
    req: new Request("http://localhost/api/trpc"),
    resHeaders: new Headers(),
  };
  for (let i = 0; i < 8; i++) {
    const [u] = await db
      .insert(schema.users)
      .values({ unionId: `test:env:u${i}`, name: `Claimer ${i}` })
      .returning();
    users.push(u);
  }
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("PF claim distribution", () => {
  it("is deterministic, in range, and low-heavy (p80 <= 88)", () => {
    const seed = envelopesLib.generateSeed();
    const amounts: number[] = [];
    for (let uid = 1; uid <= 2000; uid++) {
      const a = envelopesLib.claimAmountFloat(seed, 7, uid, 18, 888);
      expect(a).toBeGreaterThanOrEqual(18);
      expect(a).toBeLessThanOrEqual(888);
      amounts.push(a);
    }
    amounts.sort((x, y) => x - y);
    expect(amounts[Math.floor(amounts.length * 0.8)]).toBeLessThanOrEqual(88);
    // determinism: same inputs, same amount
    expect(envelopesLib.claimAmountFloat(seed, 7, 42, 18, 888)).toBe(
      envelopesLib.claimAmountFloat(seed, 7, 42, 18, 888),
    );
  });
});

describe("envelope lifecycle", () => {
  it("schedules within budget, claims once per wallet, caps claims, reveals seed after close", async () => {
    const admin = adminRouter.createCaller(adminCtx);
    // Pool >> 3 x max claim so the cap that bites is maxClaims,
    // never pool exhaustion (a high draw can drain a small pool —
    // that flaked this test ~1 run in 14).
    const sched = await admin.scheduleEnvelope({
      scheduledAt: nowSec() - 10, // already live
      currency: "BDT",
      poolAmount: "5000",
      maxClaims: 3,
    });
    expect(sched.seedHash).toMatch(/^[0-9a-f]{64}$/);

    // Public view never leaks the seed while live.
    const pub = await userCaller(users[0]).activeEnvelope();
    expect(pub.envelope?.id).toBe(sched.envelopeId);
    expect(pub.envelope?.status).toBe("live");
    expect(JSON.stringify(pub)).not.toContain("seed\":");
    const during = await userCaller(users[0]).envelopeResult({ envelopeId: sched.envelopeId });
    expect(during.seed).toBeNull();

    // Three distinct wallets claim; the fourth is capped out.
    const got: number[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await userCaller(users[i]).claim({ envelopeId: sched.envelopeId });
      const amt = parseFloat(r.amount);
      expect(amt).toBeGreaterThan(0);
      expect(amt).toBeLessThanOrEqual(888);
      got.push(amt);
    }
    await expect(userCaller(users[3]).claim({ envelopeId: sched.envelopeId })).rejects.toThrow(/fully claimed/);
    // One claim per wallet.
    await expect(userCaller(users[0]).claim({ envelopeId: sched.envelopeId })).rejects.toThrow(/Already claimed/);

    // Bonus rails: winner holds an active 1x 24h bonus for the amount.
    const grant = getSqliteClient()
      .prepare("SELECT * FROM bonus_ledger WHERE user_id = ? AND kind = 'red_envelope'")
      .get(users[0].id) as any;
    expect(parseFloat(grant.amount)).toBeCloseTo(got[0], 8);
    expect(grant.wagering_multiplier).toBe(1);
    expect(grant.expires_at - grant.created_at).toBe(86400);

    // Pool accounting never exceeds the pool.
    const env = getSqliteClient().prepare("SELECT * FROM red_envelopes WHERE id = ?").get(sched.envelopeId) as any;
    expect(parseFloat(env.claimed_total)).toBeCloseTo(got.reduce((a, b) => a + b, 0), 8);
    expect(env.claims_count).toBe(3);

    // Parallel claims from one wallet: exactly one credit.
    const sched2 = await admin.scheduleEnvelope({
      scheduledAt: nowSec() - 5,
      currency: "BDT",
      poolAmount: "900",
      maxClaims: 50,
    });
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () => userCaller(users[7]).claim({ envelopeId: sched2.envelopeId })),
    );
    expect(results.filter((r) => r.status === "fulfilled").length).toBe(1);
    const claims2 = getSqliteClient()
      .prepare("SELECT COUNT(*) AS c FROM red_envelope_claims WHERE envelope_id = ?")
      .get(sched2.envelopeId) as any;
    expect(claims2.c).toBe(1);

    // Daily budget: 5000 + 900 already scheduled today; tighten the
    // budget to 6000 and a further 700 pool must breach it. The
    // breach envelope must sit in the SAME Dhaka day as the others
    // (the budget buckets by the envelope's scheduled day) — using
    // nowSec() + 3600 crossed into tomorrow whenever the suite ran
    // after 23:00 Dhaka and the assertion silently stopped testing
    // the cap. Pin it to 01:00 into the current Dhaka day instead.
    settingsLib.setSetting("red_envelope_daily_budget_bdt", 6000, null);
    const { dhakaDayStart } = await import("../lib/settlement");
    await expect(
      admin.scheduleEnvelope({ scheduledAt: dhakaDayStart(nowSec()) + 3600, currency: "BDT", poolAmount: "700", maxClaims: 10 }),
    ).rejects.toThrow(/budget exceeded/);

    // After close, the seed reveals and verifies against the hash.
    getSqliteClient().prepare("UPDATE red_envelopes SET scheduled_at = ? WHERE id = ?").run(nowSec() - 1000, sched.envelopeId);
    const after = await userCaller(users[0]).envelopeResult({ envelopeId: sched.envelopeId });
    expect(after.status).toBe("closed");
    expect(after.seed).toBeTruthy();
    expect(envelopesLib.hashSeed(after.seed)).toBe(sched.seedHash);
    expect(after.claims.length).toBe(3);
    expect(after.claims[0].maskedName).toBe("Cl***");
  });
});

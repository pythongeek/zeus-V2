import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import crypto from "crypto";

/**
 * Phase 0 (Cascade Decision Playbook §5.2/§5.3): mode registry.
 * Bundles are canonical + hash-pinned; the active classic bundle tracks
 * the effective math (auto-versioning on drift); spins stamp the bundle
 * that resolved them; fairness reveals the binding and resolves bundles
 * by hash.
 */

const tmpDir = fs.mkdtempSync(path.join("/tmp", "zeus-phase0-test-"));
const dbPath = path.join(tmpDir, "test.sqlite");
process.env.ZEUS_DB_PATH = dbPath;

let bundles: any;
let gameRouter: any;
let fairnessRouter: any;
let getMathConfig: any;
let SYMBOL_NAMES: any;
let getDb: any;
let getSqliteClient: any;
let schema: any;
let settingsLib: any;
let passwordLib: any;

function callerFor(router: any, user: any) {
  return router.createCaller({
    user,
    req: new Request("http://localhost/api/trpc"),
    resHeaders: new Headers(),
  });
}

beforeAll(async () => {
  const Database = (await import("better-sqlite3")).default;
  const sqlite = new Database(dbPath);
  const migrationsDir = path.resolve(process.cwd(), "db", "migrations");
  for (const file of fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()) {
    sqlite.exec(fs.readFileSync(path.join(migrationsDir, file), "utf8"));
  }
  sqlite.close();

  bundles = await import("./bundles");
  const game = await import("../routers/game");
  gameRouter = game.gameRouter;
  getMathConfig = game.getMathConfig;
  SYMBOL_NAMES = game.SYMBOL_NAMES;
  fairnessRouter = (await import("../routers/fairness")).fairnessRouter;
  getDb = (await import("../queries/connection")).getDb;
  getSqliteClient = (await import("../queries/connection")).getSqliteClient;
  schema = await import("../../db/schema");
  settingsLib = await import("./settings");
  passwordLib = await import("./password");
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("canonical hashing", () => {
  it("is key-order independent and content sensitive", () => {
    const a = bundles.canonicalStringify({ b: 1, a: { d: [1, 2], c: "x" } });
    const b = bundles.canonicalStringify({ a: { c: "x", d: [1, 2] }, b: 1 });
    expect(a).toBe(b);
    expect(bundles.sha256Hex(a)).toHaveLength(64);
  });

  it("buildClassicBundle: same math same hash; one cell change rehashes", () => {
    const math = getMathConfig();
    const one = bundles.buildClassicBundle(math, SYMBOL_NAMES, "zeus-classic-v1", 95.95);
    const two = bundles.buildClassicBundle(math, SYMBOL_NAMES, "zeus-classic-v1", 95.95);
    expect(one.sha256).toBe(two.sha256);
    const mutated = JSON.parse(JSON.stringify(math));
    mutated.payouts[8] = { 3: 6, 4: 18, 5: 75 };
    const three = bundles.buildClassicBundle(mutated, SYMBOL_NAMES, "zeus-classic-v1", 95.95);
    expect(three.sha256).not.toBe(one.sha256);
    expect(three.mathHash).not.toBe(one.mathHash);
    // The bundle carries names, not ids, and the certified RTP.
    expect(one.bundle.paytable.ace).toEqual({ 3: 5, 4: 18, 5: 75 });
    expect(one.bundle.cert.rtp_percent).toBe(95.95);
  });
});

describe("registry lifecycle", () => {
  it("seeds v1 once, then auto-versions on math drift", () => {
    const sqlite = getSqliteClient();
    const math = getMathConfig();
    const rtp = settingsLib.getSetting("rtp_declared") ?? 0;
    const v1 = bundles.ensureActiveClassicBundle(sqlite, math, SYMBOL_NAMES, rtp);
    expect(v1.bundle_id).toBe("zeus-classic-v1");
    expect(v1.status).toBe("active");
    const again = bundles.ensureActiveClassicBundle(sqlite, math, SYMBOL_NAMES, rtp);
    expect(again.bundle_id).toBe("zeus-classic-v1");

    const drifted = JSON.parse(JSON.stringify(math));
    drifted.payouts[10] = { 3: 4, 4: 12, 5: 61 };
    const v2 = bundles.ensureActiveClassicBundle(sqlite, drifted, SYMBOL_NAMES, rtp);
    expect(v2.bundle_id).toBe("zeus-classic-v2");
    const old = bundles.getBundleById(sqlite, "zeus-classic-v1");
    expect(old.status).toBe("parked");
    const byHash = bundles.getBundleByHash(sqlite, v2.sha256);
    expect(byHash.bundle_id).toBe("zeus-classic-v2");
    const modes = bundles.listModes(sqlite);
    expect(modes).toEqual([
      { modeId: "classic", status: "active", bundleId: "zeus-classic-v2", sha256: v2.sha256, engine: "lines-5x3", certRtp: 0.96 },
    ]);
  });
});

describe("spin stamping + fairness binding", () => {
  it("a real spin carries mode/bundle and verify reveals the binding", async () => {
    const db = getDb();
    const suffix = Math.random().toString(36).slice(2);
    const [user] = await db
      .insert(schema.users)
      .values({
        unionId: `test:phase0:${suffix}`,
        name: "Phase0 Player",
        email: `p0-${suffix}@test.local`,
        passwordHash: passwordLib.hashPassword("P0Pw2026!"),
      })
      .returning();
    getSqliteClient()
      .prepare("INSERT INTO balances (user_id, currency, available, locked, bonus) VALUES (?, 'USDT', '100', '0', '0')")
      .run(user.id);
    const seed = crypto.randomBytes(32).toString("hex");
    const [session] = await db
      .insert(schema.gameSessions)
      .values({
        userId: user.id,
        serverSeed: seed,
        serverSeedHash: crypto.createHash("sha256").update(seed).digest("hex"),
        clientSeed: "phase0",
        nonce: 0,
        status: "active",
      })
      .returning();

    const game = callerFor(gameRouter, user);
    await game.spin({ sessionId: session.id, betAmount: "1", currency: "USDT" });

    const spin = getSqliteClient()
      .prepare("SELECT mode_id, bundle_id, bundle_sha256 FROM spins WHERE session_id = ?")
      .get(session.id) as any;
    expect(spin.mode_id).toBe("classic");
    expect(spin.bundle_id).toMatch(/^zeus-classic-v\d+$/);
    expect(spin.bundle_sha256).toHaveLength(64);

    const fair = callerFor(fairnessRouter, user);
    const v = await fair.verify({ sessionId: session.id, nonce: 1 });
    expect(v.modeId).toBe("classic");
    expect(v.bundleSha256).toBe(spin.bundle_sha256);
    const resolved = await fair.bundleByHash({ sha256: spin.bundle_sha256 });
    expect(resolved.bundleId).toBe(spin.bundle_id);
    expect(resolved.bundle.mode_id).toBe("classic");
    await expect(fair.bundleByHash({ sha256: "0".repeat(64) })).rejects.toThrow("Bundle not found");
  });
});

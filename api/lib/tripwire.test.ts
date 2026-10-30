import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import crypto from "crypto";

/**
 * Step 15 tripwire (playbook §4.1): fair stream stays silent, a hot
 * stream trips Layer 1 and flips maintenance, an unregistered bundle
 * hash is a hard-stop event, evaluation resumes without recounting,
 * and the master switch disables the whole monitor.
 */

const tmpDir = fs.mkdtempSync(path.join("/tmp", "zeus-tripwire-test-"));
const dbPath = path.join(tmpDir, "test.sqlite");
process.env.ZEUS_DB_PATH = dbPath;

let tripwire: any;
let bundles: any;
let getSqliteClient: any;
let getDb: any;
let schema: any;
let settingsLib: any;
let passwordLib: any;
let getMathConfig: any;
let SYMBOL_NAMES: any;

const PARAMS = () => ({ ...tripwire.TRIPWIRE_PARAMS, layer1MinSpins: 1000, ewmaArmSpins: 1000 });
let sessionId = 0;
let nonce = 0;
let classicSha = "";

function insertSpin(x: number, sha: string | null = classicSha, free = false) {
  nonce += 1;
  const info = getSqliteClient()
    .prepare(
      `INSERT INTO spins (session_id, user_id, nonce, bet_amount, currency, reel_positions, symbols_shown, win_amount, hash, is_free_spin, mode_id, bundle_sha256)
       VALUES (?, 1, ?, '1', 'USDT', '[]', '[]', ?, ?, ?, 'classic', ?)`,
    )
    .run(sessionId, nonce, String(x), crypto.createHash("sha256").update(`t${nonce}`).digest("hex"), free ? 1 : 0, sha);
  return Number(info.lastInsertRowid);
}

beforeAll(async () => {
  const Database = (await import("better-sqlite3")).default;
  const sqlite = new Database(dbPath);
  const migrationsDir = path.resolve(process.cwd(), "db", "migrations");
  for (const file of fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()) {
    sqlite.exec(fs.readFileSync(path.join(migrationsDir, file), "utf8"));
  }
  sqlite.close();

  tripwire = await import("./tripwire");
  bundles = await import("./bundles");
  getSqliteClient = (await import("../queries/connection")).getSqliteClient;
  getDb = (await import("../queries/connection")).getDb;
  schema = await import("../../db/schema");
  settingsLib = await import("./settings");
  passwordLib = await import("./password");
  const game = await import("../routers/game");
  getMathConfig = game.getMathConfig;
  SYMBOL_NAMES = game.SYMBOL_NAMES;

  const db = getDb();
  const [user] = await db
    .insert(schema.users)
    .values({ unionId: "test:tripwire:1", name: "TW", email: "tw@test.local", passwordHash: passwordLib.hashPassword("TwPw2026!") })
    .returning();
  const seed = crypto.randomBytes(32).toString("hex");
  const [session] = await db
    .insert(schema.gameSessions)
    .values({
      userId: user.id,
      serverSeed: seed,
      serverSeedHash: crypto.createHash("sha256").update(seed).digest("hex"),
      clientSeed: "tw",
      nonce: 0,
      status: "active",
    })
    .returning();
  sessionId = session.id;

  const row = bundles.ensureActiveClassicBundle(
    getSqliteClient(),
    getMathConfig(),
    SYMBOL_NAMES,
    settingsLib.getSetting("rtp_declared"),
  );
  classicSha = row.sha256;
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("tripwire", () => {
  it("cascade baseline comes from the certification record (cert.run)", () => {
    const cert = { result: "PASS", run: { rtp: 0.9648, sigma: 3.856 } };
    getSqliteClient()
      .prepare(
        `INSERT INTO math_bundles (bundle_id, mode_id, engine, bundle, sha256, math_hash, status, cert)
         VALUES ('zeus-cascade-v1', 'cascade', 'cascade', '{}', 'cascadesha', 'cascadesha', 'active', ?)`,
      )
      .run(JSON.stringify(cert));
    const status = tripwire.getTripwireStatus(getSqliteClient());
    const cascade = status.find((m: any) => m.modeId === "cascade");
    expect(cascade).toBeTruthy();
    expect(cascade.mu0).toBeCloseTo(0.9648, 6);
    expect(cascade.sigma0).toBeCloseTo(3.856, 6);
  });

  it("a fair stream (mean exactly mu0) stays silent", () => {
    const mu0 = settingsLib.getSetting("rtp_declared") / 100;
    for (let i = 0; i < 3000; i++) insertSpin(mu0);
    const r = tripwire.evaluateMode(getSqliteClient(), "classic", PARAMS(), true);
    expect(r.processed).toBe(3000);
    expect(r.layer1.armed).toBe(true);
    expect(r.layer1.breach).toBe(false);
    expect(r.ewma.drift).toBe(false);
    expect(r.cusum.drift).toBe(false);
    expect(r.hashEvents).toBe(0);
    expect(settingsLib.getSetting("maintenance_mode")).toBeFalsy();
  });

  it("resumes without recounting", () => {
    const r = tripwire.evaluateMode(getSqliteClient(), "classic", PARAMS(), true);
    expect(r.processed).toBe(0);
    // 3000 paid rows = 2999 flushed processes + 1 still open.
    expect(r.spinsSeen).toBe(2999);
  });

  it("free-spin rows fold into their triggering paid spin's process", () => {
    const triggerId = insertSpin(0);
    insertSpin(0.96, classicSha, true);
    insertSpin(0.96, classicSha, true);
    insertSpin(0); // next paid spin flushes the chain
    tripwire.evaluateMode(getSqliteClient(), "classic", PARAMS(), true);
    const proc = getSqliteClient()
      .prepare("SELECT x FROM tripwire_processes WHERE spin_id = ?")
      .get(triggerId) as any;
    expect(proc).toBeTruthy();
    expect(proc.x).toBeCloseTo(1.92, 10);
  });

  it("an unregistered bundle hash is a hard-stop event", () => {
    insertSpin(0, "f".repeat(64));
    const r = tripwire.evaluateMode(getSqliteClient(), "classic", PARAMS(), true);
    expect(r.hashEvents).toBe(1);
    const ev = getSqliteClient()
      .prepare("SELECT * FROM tripwire_events WHERE kind = 'unregistered_bundle'")
      .all() as any[];
    expect(ev.length).toBe(1);
    const alert = getSqliteClient()
      .prepare("SELECT * FROM admin_alerts WHERE kind = 'rtp_tripwire' AND ref_id = 'classic:L0' AND status = 'open'")
      .get() as any;
    expect(alert).toBeTruthy();
  });

  it("a hot stream trips Layer 1, flips maintenance, alerts once", () => {
    for (let i = 0; i < 3000; i++) insertSpin(1.3);
    const r = tripwire.evaluateMode(getSqliteClient(), "classic", PARAMS(), true);
    expect(r.layer1.breach).toBe(true);
    expect(settingsLib.getSetting("maintenance_mode")).toBe(true);
    const alerts = getSqliteClient()
      .prepare("SELECT * FROM admin_alerts WHERE kind = 'rtp_tripwire' AND ref_id = 'classic:L1' AND status = 'open'")
      .all() as any[];
    expect(alerts.length).toBe(1);
    // Re-evaluating does not duplicate the alert (dedupe while open).
    tripwire.evaluateMode(getSqliteClient(), "classic", PARAMS(), true);
    const after = getSqliteClient()
      .prepare("SELECT COUNT(*) AS c FROM admin_alerts WHERE kind = 'rtp_tripwire' AND ref_id = 'classic:L1' AND status = 'open'")
      .get() as any;
    expect(after.c).toBe(1);
    settingsLib.setSetting("maintenance_mode", false, null);
  });

  it("the master switch disables evaluation", () => {
    settingsLib.setSetting("tripwire_enabled", false, null);
    expect(tripwire.evaluateAllModes(getSqliteClient(), PARAMS(), true)).toEqual([]);
    settingsLib.setSetting("tripwire_enabled", true, null);
  });
});

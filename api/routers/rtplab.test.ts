import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";

/**
 * Section E2 tests: RTP Lab workflow — draft, certify, publish
 * inside owner bounds, out-of-bounds refusal, version history,
 * rollback, super-admin-only access.
 */

const tmpDir = fs.mkdtempSync(path.join("/tmp", "zeus-lab-test-"));
const dbPath = path.join(tmpDir, "test.sqlite");
process.env.ZEUS_DB_PATH = dbPath;

let adminRouter: any;
let passwordLib: any;
let getDb: any;
let schema: any;
let settingsLib: any;

function callerFor(router: any, user: any) {
  return router.createCaller({
    user,
    req: new Request("http://localhost/api/trpc"),
    resHeaders: new Headers(),
  });
}

async function makeUser(role = "user") {
  const db = getDb();
  const suffix = Math.random().toString(36).slice(2);
  const [user] = await db
    .insert(schema.users)
    .values({
      unionId: `test:lab:${suffix}`,
      name: "Lab User",
      email: `lab-${suffix}@test.local`,
      phone: `+880172${Math.floor(1000000 + Math.random() * 8999999)}`,
      role,
      passwordHash: passwordLib.hashPassword("LabPw2026!"),
    })
    .returning();
  return user;
}

let superCaller: any;
let plainCaller: any;
let defaultBundle: any;

beforeAll(async () => {
  const Database = (await import("better-sqlite3")).default;
  const sqlite = new Database(dbPath);
  const migrationsDir = path.resolve(process.cwd(), "db", "migrations");
  for (const file of fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    sqlite.exec(fs.readFileSync(path.join(migrationsDir, file), "utf8"));
  }
  sqlite.close();

  adminRouter = (await import("./admin")).adminRouter;
  passwordLib = await import("../lib/password");
  settingsLib = await import("../lib/settings");
  const conn = await import("../queries/connection");
  getDb = conn.getDb;
  schema = await import("../../db/schema");

  const superAdmin = await makeUser("super_admin");
  const plainAdmin = await makeUser("admin");
  superCaller = callerFor(adminRouter, superAdmin);
  plainCaller = callerFor(adminRouter, plainAdmin);

  const lab = await superCaller.getMathLab();
  defaultBundle = lab.live;
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("E2: RTP Lab workflow", () => {
  it("getMathLab exposes the live bundle, bounds and empty history", async () => {
    const lab = await superCaller.getMathLab();
    expect(lab.live.paytable["0"]["5"]).toBe(1000);
    expect(lab.live.reels).toHaveLength(5);
    expect(lab.bounds).toEqual({ min: 90, max: 98 });
    expect(lab.declaredRtp).toBe(96.0);
    expect(lab.versions).toHaveLength(0);
    expect(lab.draft).toBeNull();
  });

  it("draft save + read-back", async () => {
    const tweaked = structuredClone(defaultBundle);
    tweaked.paytable["10"]["5"] = 61;
    await superCaller.saveMathDraft({ bundle: tweaked });
    const lab = await superCaller.getMathLab();
    expect(lab.draft.paytable["10"]["5"]).toBe(61);
    // Live math is untouched by a draft.
    expect(lab.live.paytable["10"]["5"]).toBe(60);
  });

  it("certifyMath certifies the default bundle inside bounds", async () => {
    const cert = await superCaller.certifyMath({ bundle: defaultBundle });
    expect(cert.totalPct).toBeGreaterThan(94.5);
    expect(cert.totalPct).toBeLessThan(97.5);
    expect(cert.withinBounds).toBe(true);
    expect(cert.jackpotPct).toBe(1.08);
  }, 120_000);

  it("publish writes settings, declared RTP and a version row; clears the draft", async () => {
    const res = await superCaller.publishMath({ bundle: defaultBundle, note: "baseline publish" });
    expect(res.versionId).toBe(1);
    expect(settingsLib.getSetting("rtp_declared")).toBe(res.totalPct);
    const lab = await superCaller.getMathLab();
    expect(lab.versions).toHaveLength(1);
    expect(lab.versions[0].note).toBe("baseline publish");
    expect(lab.draft).toBeNull();
    expect(lab.declaredRtp).toBe(res.totalPct);
  }, 120_000);

  it("out-of-bounds publish is refused and changes nothing", async () => {
    const rigged = structuredClone(defaultBundle);
    rigged.paytable["0"]["5"] = 90000;
    const before = settingsLib.getSetting("rtp_declared");
    await expect(superCaller.publishMath({ bundle: rigged })).rejects.toThrow(/outside the publish bounds/);
    expect(settingsLib.getSetting("rtp_declared")).toBe(before);
    const lab = await superCaller.getMathLab();
    expect(lab.versions).toHaveLength(1);
    expect(lab.live.paytable["0"]["5"]).toBe(1000);
  }, 120_000);

  it("rollback re-publishes an older bundle as a new version", async () => {
    const res = await superCaller.rollbackMath({ versionId: 1 });
    expect(res.versionId).toBe(2);
    const lab = await superCaller.getMathLab();
    expect(lab.versions).toHaveLength(2);
    expect(lab.versions[0].note).toContain("Rollback to version #1");
  }, 120_000);

  it("plain admins cannot use the Lab", async () => {
    await expect(plainCaller.getMathLab()).rejects.toThrow();
    await expect(plainCaller.saveMathDraft({ bundle: defaultBundle })).rejects.toThrow();
  });

  it("malformed bundles are rejected", async () => {
    const bad = structuredClone(defaultBundle);
    bad.reels = bad.reels.slice(0, 4);
    await expect(superCaller.saveMathDraft({ bundle: bad })).rejects.toThrow();
    const bad2 = structuredClone(defaultBundle);
    delete bad2.paytable["7"];
    await expect(superCaller.certifyMath({ bundle: bad2 })).rejects.toThrow();
  });
});

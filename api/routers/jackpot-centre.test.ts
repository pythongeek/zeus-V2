import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";

/**
 * Section F1 tests: jackpot centre payload (seeds/shares from
 * settings, below-seed flag), config updates syncing the pool
 * seed column, super-only writes, snapshot history downsampling.
 */

const tmpDir = fs.mkdtempSync(path.join("/tmp", "zeus-jc-test-"));
const dbPath = path.join(tmpDir, "test.sqlite");
process.env.ZEUS_DB_PATH = dbPath;

let adminRouter: any;
let passwordLib: any;
let getDb: any;
let getSqliteClient: any;
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
      unionId: `test:jc:${suffix}`,
      name: "JC User",
      email: `jc-${suffix}@test.local`,
      phone: `+880173${Math.floor(1000000 + Math.random() * 8999999)}`,
      role,
      passwordHash: passwordLib.hashPassword("JcPw2026!"),
    })
    .returning();
  return user;
}

let superCaller: any;
let plainCaller: any;
let adminCaller: any;

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
  getSqliteClient = conn.getSqliteClient;
  schema = await import("../../db/schema");

  const client = getSqliteClient();
  for (const [tier, seed, cur, rate] of [
    ["mini", "5", "3.5", "0.005"],
    ["major", "25", "40", "0.003"],
    ["mega", "100", "100", "0.002"],
  ] as const) {
    client
      .prepare(
        "INSERT INTO jackpot_pool (tier, seed_amount, current_amount, contribution_rate, hit_count) VALUES (?, ?, ?, ?, 0)",
      )
      .run(tier, seed, cur, rate);
  }

  superCaller = callerFor(adminRouter, await makeUser("super_admin"));
  plainCaller = callerFor(adminRouter, await makeUser("admin"));
  adminCaller = plainCaller;
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("F1: jackpot centre", () => {
  it("centre payload joins pools with settings seeds/shares and flags below-seed", async () => {
    const centre = await adminCaller.getJackpotCentre();
    expect(centre.tiers.map((t: any) => t.tier)).toEqual(["mini", "major", "mega"]);
    const mini = centre.tiers[0];
    expect(mini.current).toBe(3.5);
    expect(mini.seed).toBe(5);
    expect(mini.sharePerMille).toBe(5);
    expect(mini.belowSeed).toBe(true); // 3.5 < seed 5
    expect(centre.tiers[1].belowSeed).toBe(false); // 40 > 25
    expect(centre.tiers[2].belowSeed).toBe(false); // 100 == 100
    expect(centre.totalSharePerMille).toBe(10);
    expect(centre.lowPoolAlert).toBe(true);
  });

  it("config update writes settings AND syncs pool seed_amount; plain admin refused", async () => {
    await expect(
      plainCaller.updateJackpotConfig({
        seeds: { mini: 6, major: 30, mega: 120 },
        shares: { mini: 5, major: 3, mega: 2 },
      }),
    ).rejects.toThrow();

    await superCaller.updateJackpotConfig({
      seeds: { mini: 6, major: 30, mega: 120 },
      shares: { mini: 6, major: 3, mega: 1 },
    });
    expect(settingsLib.getSetting("jackpot_seeds")).toEqual({ mini: "6", major: "30", mega: "120" });
    expect(settingsLib.getSetting("jackpot_shares")).toEqual({ mini: 6, major: 3, mega: 1 });
    const row = getSqliteClient()
      .prepare("SELECT seed_amount FROM jackpot_pool WHERE tier = 'mega'")
      .get() as any;
    expect(row.seed_amount).toBe("120");
    const centre = await superCaller.getJackpotCentre();
    expect(centre.tiers[0].belowSeed).toBe(true); // 3.5 < new seed 6
    expect(centre.totalSharePerMille).toBe(10);
  });

  it("history downsamples snapshots to hourly last values", async () => {
    const client = getSqliteClient();
    const now = Math.floor(Date.now() / 1000);
    const hourBase = Math.floor(now / 3600) * 3600;
    const ins = client.prepare(
      "INSERT INTO jackpot_pool_snapshots (tier, amount, created_at) VALUES ('mini', ?, ?)",
    );
    ins.run("3.5", hourBase - 3600 + 100);
    ins.run("3.6", hourBase - 3600 + 200); // same hour bucket -> last wins
    ins.run("3.9", Math.min(hourBase + 300, now)); // current hour bucket
    const hist = await adminCaller.getJackpotHistory({ days: 7 });
    expect(hist.mini).toHaveLength(2);
    expect(hist.mini[0].amount).toBe(3.6);
    expect(hist.mini[1].amount).toBe(3.9);
  });
});

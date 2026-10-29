import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import crypto from "crypto";

/**
 * Step 1 (BD production plan): per-currency bet ladders.
 * Unit level: ladder resolution + exact membership.
 * Spin level: off-ladder bets are rejected server-side with no
 * money movement; on-ladder bets settle exactly.
 */

const tmpDir = fs.mkdtempSync(path.join("/tmp", "zeus-step1-test-"));
const dbPath = path.join(tmpDir, "test.sqlite");
process.env.ZEUS_DB_PATH = dbPath;

let gameRouter: any;
let getDb: any;
let schema: any;
let betting: any;
let money: any;

function callerFor(router: any, user: any) {
  return router.createCaller({
    user,
    req: new Request("http://localhost/api/trpc"),
    resHeaders: new Headers(),
  });
}

async function makePlayer(currency: string, available: string) {
  const db = getDb();
  const suffix = Math.random().toString(36).slice(2);
  const [user] = await db
    .insert(schema.users)
    .values({ unionId: `test:step1:${suffix}`, name: "Step1 Player" })
    .returning();
  await db.insert(schema.balances).values({
    userId: user.id,
    currency,
    available,
    locked: "0",
  });
  const seed = crypto.randomBytes(32).toString("hex");
  const [session] = await db
    .insert(schema.gameSessions)
    .values({
      userId: user.id,
      serverSeed: seed,
      serverSeedHash: crypto.createHash("sha256").update(seed).digest("hex"),
      clientSeed: "step1",
      nonce: 0,
      status: "active",
    })
    .returning();
  return { user, sessionId: session.id };
}

async function balanceOf(userId: number, currency: string) {
  const db = getDb();
  const rows = await db.select().from(schema.balances);
  const row = rows.find(
    (r: any) => r.userId === userId && r.currency === currency,
  );
  return row?.available as string;
}

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

  gameRouter = (await import("./game")).gameRouter;
  getDb = (await import("../queries/connection")).getDb;
  schema = await import("../../db/schema");
  betting = await import("../lib/betting");
  money = await import("../lib/money");
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("ladder resolution + membership", () => {
  it("BDT ladder is the micro-stake ladder", () => {
    const ladder = betting.ladderFor(null, "BDT");
    expect(ladder).toEqual([1, 2, 5, 10, 20, 50, 100]);
  });

  it("USDT ladder keeps the long-standing steps (0.25 and 1000 included)", () => {
    const ladder = betting.ladderFor(null, "USDT");
    expect(ladder).toContain(0.25);
    expect(ladder).toContain(1000);
    expect(ladder?.[0]).toBe(0.1);
  });

  it("currencies without a ladder resolve to null (range check only)", () => {
    expect(betting.ladderFor(null, "BTC")).toBeNull();
    expect(betting.ladderFor(null, "ETH")).toBeNull();
  });

  it("admin setting overrides the defaults and is sanitised + sorted", () => {
    const ladder = betting.ladderFor({ BDT: [50, 5, -1, 10, "x"] }, "BDT");
    expect(ladder).toEqual([5, 10, 50]);
  });

  it("membership is exact in micro units", () => {
    const bdt = betting.ladderFor(null, "BDT");
    expect(betting.isOnLadder(bdt, money.parseMoney("5"))).toBe(true);
    expect(betting.isOnLadder(bdt, money.parseMoney("3"))).toBe(false);
    expect(betting.isOnLadder(bdt, money.parseMoney("1"))).toBe(true);
    expect(betting.isOnLadder(bdt, money.parseMoney("0.5"))).toBe(false);
    const usdt = betting.ladderFor(null, "USDT");
    expect(betting.isOnLadder(usdt, money.parseMoney("0.25"))).toBe(true);
    expect(betting.isOnLadder(usdt, money.parseMoney("0.3"))).toBe(false);
  });
});

describe("spin enforcement", () => {
  it("BDT ৳3 is rejected and no money moves", async () => {
    const { user, sessionId } = await makePlayer("BDT", "1000");
    const caller = callerFor(gameRouter, user);
    await expect(
      caller.spin({ sessionId, betAmount: "3", currency: "BDT" }),
    ).rejects.toThrow(/allowed bet steps/);
    expect(await balanceOf(user.id, "BDT")).toBe("1000");
  });

  it("BDT ৳0.5 (below ladder) and ৳101 (above ladder) are rejected", async () => {
    const { user, sessionId } = await makePlayer("BDT", "1000");
    const caller = callerFor(gameRouter, user);
    await expect(
      caller.spin({ sessionId, betAmount: "0.5", currency: "BDT" }),
    ).rejects.toThrow(/allowed bet steps/);
    await expect(
      caller.spin({ sessionId, betAmount: "101", currency: "BDT" }),
    ).rejects.toThrow(/allowed bet steps/);
    expect(await balanceOf(user.id, "BDT")).toBe("1000");
  });

  it("BDT ৳5 settles exactly: balance = before − bet + win", async () => {
    const { user, sessionId } = await makePlayer("BDT", "1000");
    const caller = callerFor(gameRouter, user);
    const r = await caller.spin({ sessionId, betAmount: "5", currency: "BDT" });
    const expected = 1000 - 5 + parseFloat(r.winAmount);
    expect(parseFloat(await balanceOf(user.id, "BDT"))).toBeCloseTo(expected, 8);
  });

  it("USDT 0.3 is rejected; USDT 0.25 (existing step) is accepted", async () => {
    const { user, sessionId } = await makePlayer("USDT", "100");
    const caller = callerFor(gameRouter, user);
    await expect(
      caller.spin({ sessionId, betAmount: "0.3", currency: "USDT" }),
    ).rejects.toThrow(/allowed bet steps/);
    expect(await balanceOf(user.id, "USDT")).toBe("100");
    const r = await caller.spin({ sessionId, betAmount: "0.25", currency: "USDT" });
    const expected = 100 - 0.25 + parseFloat(r.winAmount);
    expect(parseFloat(await balanceOf(user.id, "USDT"))).toBeCloseTo(expected, 8);
  });
});

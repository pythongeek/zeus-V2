import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import crypto from "crypto";

/**
 * A1 regression tests (Z-01):
 * - fairness.verify must NEVER reveal the server seed of an ACTIVE session
 *   (the seed determines every future spin), and must reveal it once the
 *   session is completed.
 * - game.getSessionSpins must error for a missing session instead of
 *   returning fabricated demo data.
 *
 * Runs against a throwaway SQLite DB (ZEUS_DB_PATH is set before the
 * routers — and therefore getDb() — are imported).
 */

const tmpDir = fs.mkdtempSync(path.join("/tmp", "zeus-a1-test-"));
const dbPath = path.join(tmpDir, "test.sqlite");
process.env.ZEUS_DB_PATH = dbPath;

const SERVER_SEED = "a1-test-server-seed-0123456789abcdef";
const CLIENT_SEED = "a1-client-seed";

let fairnessRouter: any;
let gameRouter: any;
let calculateSpin: any;
let SYMBOL_NAMES: any;
let getDb: any;
let schema: any;
let callerFairness: any;
let callerGame: any;
let sessionId: number;

beforeAll(async () => {
  // Create the schema in the temp DB from the real migration files,
  // exactly like the production bootstrap (api/server.ts).
  const Database = (await import("better-sqlite3")).default;
  const sqlite = new Database(dbPath);
  const migrationsDir = path.resolve(process.cwd(), "db", "migrations");
  for (const file of fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), "utf-8");
    for (const stmt of sql.split("--> statement-breakpoint")) {
      const trimmed = stmt.trim();
      if (trimmed) sqlite.exec(trimmed);
    }
  }
  sqlite.close();

  ({ fairnessRouter } = await import("./fairness"));
  ({ gameRouter, calculateSpin, SYMBOL_NAMES } = await import("./game"));
  ({ getDb } = await import("../queries/connection"));
  schema = await import("../../db/schema");

  const db = getDb();

  const [user] = await db
    .insert(schema.users)
    .values({ unionId: "test:a1", name: "A1 Test", email: "a1@test.local" })
    .returning();

  const serverSeedHash = crypto
    .createHash("sha256")
    .update(SERVER_SEED)
    .digest("hex");

  const [session] = await db
    .insert(schema.gameSessions)
    .values({
      userId: user.id,
      serverSeed: SERVER_SEED,
      serverSeedHash,
      clientSeed: CLIENT_SEED,
      nonce: 1,
      status: "active",
      totalSpins: 1,
      totalWagered: "1",
      totalWon: "0",
    })
    .returning();
  sessionId = session.id;

  const { reelStops, symbols, hash } = calculateSpin(SERVER_SEED, CLIENT_SEED, 1);
  await db.insert(schema.spins).values({
    sessionId,
    userId: user.id,
    nonce: 1,
    betAmount: "1",
    currency: "USDT",
    reelPositions: reelStops,
    symbolsShown: symbols.map((col: number[]) => col.map((s) => SYMBOL_NAMES[s])),
    winAmount: "0",
    winLines: [],
    hash,
  });

  const ctx = {
    user,
    req: new Request("http://localhost/api/trpc"),
    resHeaders: new Headers(),
  };
  callerFairness = fairnessRouter.createCaller(ctx);
  callerGame = gameRouter.createCaller(ctx);
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("A1: fairness.verify seed handling", () => {
  it("hides the server seed while the session is ACTIVE", async () => {
    const res = await callerFairness.verify({ sessionId, nonce: 1 });
    expect(res.verified).toBe(true);
    expect(res.serverSeed).toBeNull();
    expect(res.serverSeedHash).toBe(
      crypto.createHash("sha256").update(SERVER_SEED).digest("hex"),
    );
    // The seed string must not appear ANYWHERE in the payload
    // (including the human-readable calculationSteps).
    expect(JSON.stringify(res)).not.toContain(SERVER_SEED);

    // getSession follows the same rule and must parse real spin rows.
    const sess = await callerFairness.getSession({ sessionId });
    expect(sess.session.serverSeed).toBeNull();
    expect(sess.spins).toHaveLength(1);
    expect(Array.isArray(sess.spins[0].symbolsShown)).toBe(true);
  });

  it("reveals the server seed after the session COMPLETES", async () => {
    const db = getDb();
    const { eq } = await import("drizzle-orm");
    await db
      .update(schema.gameSessions)
      .set({ status: "completed" })
      .where(eq(schema.gameSessions.id, sessionId));

    const res = await callerFairness.verify({ sessionId, nonce: 1 });
    expect(res.verified).toBe(true);
    expect(res.serverSeed).toBe(SERVER_SEED);
  });
});

describe("A1: getSessionSpins demo fallback removed", () => {
  it("errors for a missing session instead of fabricating one", async () => {
    await expect(
      callerGame.getSessionSpins({ sessionId: 999999 }),
    ).rejects.toThrow("Session not found");
  });
});

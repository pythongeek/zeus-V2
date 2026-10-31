import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";

/**
 * Admin date-truthfulness regression tests (2026-10-31):
 * production stores created_at as TEXT; drizzle timestamp-mode
 * reads returned null, so the Players list said "Last spin:
 * never" for everyone and Player 360 showed 1/1/1970. Rows here
 * are inserted in the production storage form (raw SQL, TEXT
 * timestamps) and must come back as real ISO dates.
 */

const tmpDir = fs.mkdtempSync(path.join("/tmp", "zeus-dates-test-"));
const dbPath = path.join(tmpDir, "test.sqlite");
process.env.ZEUS_DB_PATH = dbPath;

let adminRouter: any;
let passwordLib: any;
let getDb: any;
let getSqliteClient: any;
let schema: any;

function callerFor(router: any, user: any) {
  return router.createCaller({
    user,
    req: new Request("http://localhost/api/trpc"),
    resHeaders: new Headers(),
  });
}

async function makeUser(role = "user", emailPrefix = "dates") {
  const db = getDb();
  const suffix = Math.random().toString(36).slice(2);
  const [user] = await db
    .insert(schema.users)
    .values({
      unionId: `test:dates:${suffix}`,
      name: "Date Player",
      email: `${emailPrefix}-${suffix}@test.local`,
      role,
      passwordHash: passwordLib.hashPassword("PlayerPw2026!"),
    })
    .returning();
  await db.insert(schema.balances).values({ userId: user.id, currency: "USDT", available: "0", locked: "0" });
  return user;
}

beforeAll(async () => {
  const Database = (await import("better-sqlite3")).default;
  const sqlite = new Database(dbPath);
  const migrationsDir = path.resolve(process.cwd(), "db", "migrations");
  for (const file of fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()) {
    const sqlText = fs.readFileSync(path.join(migrationsDir, file), "utf-8");
    for (const stmt of sqlText.split("--> statement-breakpoint")) {
      const trimmed = stmt.trim();
      if (trimmed) sqlite.exec(trimmed);
    }
  }
  sqlite.close();

  ({ adminRouter } = await import("./admin"));
  passwordLib = await import("../lib/password");
  ({ getDb, getSqliteClient } = await import("../queries/connection"));
  schema = await import("../../db/schema");
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("Admin date truthfulness", () => {
  it("returns real dates for TEXT-stored spins and audit rows", async () => {
    const admin = await makeUser("super_admin", "datesadmin");
    const player = await makeUser("user", "datesplayer");
    const caller = callerFor(adminRouter, admin);
    const raw = getSqliteClient();

    // A game session + a spin stored exactly as production stores
    // them: raw SQL, created_at left to the TEXT default.
    const sess = raw
      .prepare("INSERT INTO game_sessions (user_id, server_seed, server_seed_hash, client_seed) VALUES (?, 'seed', 'seedhash', 'clientseed') RETURNING id")
      .get(player.id) as any;
    raw.prepare(
      "INSERT INTO spins (session_id, user_id, nonce, bet_amount, currency, reel_positions, symbols_shown, hash) VALUES (?, ?, 1, '1', 'BDT', '0,0,0,0,0', '[]', 'testhash')",
    ).run(sess.id, player.id);
    // An audit row about this player, TEXT timestamp.
    raw.prepare("INSERT INTO audit_log (action, details) VALUES ('player.note', ?)").run(
      JSON.stringify({ userId: player.id }),
    );

    // listPlayers: lastSpinAt must be a real, recent ISO date.
    const lp: any = await caller.listPlayers({ limit: 25, offset: 0, sort: "newest" });
    const row = lp.rows.find((u: any) => u.id === player.id);
    expect(row).toBeTruthy();
    expect(row.lastSpinAt).toBeTruthy();
    const spinTs = Date.parse(row.lastSpinAt);
    expect(Number.isFinite(spinTs)).toBe(true);
    expect(Math.abs(Date.now() - spinTs)).toBeLessThan(10 * 60 * 1000);

    // Player 360: recent spin and audit dates must be real too.
    const detail: any = await caller.getPlayerDetail({ userId: player.id });
    expect(detail.recentSpins.length).toBe(1);
    expect(detail.recentSpins[0].createdAt).toBeTruthy();
    expect(Number.isFinite(Date.parse(detail.recentSpins[0].createdAt))).toBe(true);
    expect(detail.auditTrail.length).toBe(1);
    expect(detail.auditTrail[0].createdAt).toBeTruthy();
    expect(Number.isFinite(Date.parse(detail.auditTrail[0].createdAt))).toBe(true);
  });
});

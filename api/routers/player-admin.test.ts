import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";

/**
 * Section C tests: player management 360.
 * list/search, detail payload, capped ledger-recorded adjustments,
 * freeze enforcement at login, notes/tags, password reset.
 */

const tmpDir = fs.mkdtempSync(path.join("/tmp", "zeus-pc-test-"));
const dbPath = path.join(tmpDir, "test.sqlite");
process.env.ZEUS_DB_PATH = dbPath;

let adminRouter: any;
let authLocalRouter: any;
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

async function makeUser(role = "user", available = "0") {
  const db = getDb();
  const suffix = Math.random().toString(36).slice(2);
  const [user] = await db
    .insert(schema.users)
    .values({
      unionId: `test:pc:${suffix}`,
      name: "PC Player",
      email: `pc-${suffix}@test.local`,
      phone: `+880171${Math.floor(1000000 + Math.random() * 8999999)}`,
      role,
      passwordHash: passwordLib.hashPassword("PlayerPw2026!"),
    })
    .returning();
  await db.insert(schema.balances).values({
    userId: user.id,
    currency: "USDT",
    available,
    locked: "0",
  });
  return user;
}

beforeAll(async () => {
  const Database = (await import("better-sqlite3")).default;
  const sqlite = new Database(dbPath);
  const migrationsDir = path.resolve(process.cwd(), "db", "migrations");
  for (const file of fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    const sqlText = fs.readFileSync(path.join(migrationsDir, file), "utf-8");
    for (const stmt of sqlText.split("--> statement-breakpoint")) {
      const trimmed = stmt.trim();
      if (trimmed) sqlite.exec(trimmed);
    }
  }
  sqlite.close();

  ({ adminRouter } = await import("./admin"));
  ({ authLocalRouter } = await import("../auth-local"));
  passwordLib = await import("../lib/password");
  ({ getDb, getSqliteClient } = await import("../queries/connection"));
  schema = await import("../../db/schema");
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("C1/C2: list + detail", () => {
  it("searches by email, filters frozen, and totals balances", async () => {
    const admin = await makeUser("admin");
    const rich = await makeUser("user", "250");
    const a = callerFor(adminRouter, admin);

    const found = await a.listPlayers({ search: rich.email });
    expect(found.rows.some((r: any) => r.id === rich.id)).toBe(true);
    const row = found.rows.find((r: any) => r.id === rich.id);
    expect(row.balanceUsdt).toBe(250);

    await a.setPlayerFrozen({ userId: rich.id, frozen: true, reason: "Chargeback risk" });
    const frozen = await a.listPlayers({ status: "frozen" });
    expect(frozen.rows.some((r: any) => r.id === rich.id)).toBe(true);
    const active = await a.listPlayers({ status: "active" });
    expect(active.rows.some((r: any) => r.id === rich.id)).toBe(false);
    await a.setPlayerFrozen({ userId: rich.id, frozen: false, reason: "Cleared after review" });
  });

  it("detail returns profile, balances, stats and RG state", async () => {
    const admin = await makeUser("super_admin");
    const player = await makeUser("user", "80");
    const a = callerFor(adminRouter, admin);
    const detail = await a.getPlayerDetail({ userId: player.id });
    expect(detail.profile.email).toBe(player.email);
    expect(detail.balances.find((b: any) => b.currency === "USDT").available).toBe("80");
    expect(detail.stats.spinsCount).toBe(0);
    expect(detail.rg.limits.selfExcludedUntil).toBe(0);
    expect(Array.isArray(detail.notes)).toBe(true);
  });
});

describe("C3: balance adjustment", () => {
  it("credits and debits with a ledger leg that reproduces the balance", async () => {
    const admin = await makeUser("admin");
    const player = await makeUser("user", "100");
    const a = callerFor(adminRouter, admin);

    const credited = await a.adjustPlayerBalance({
      userId: player.id, currency: "USDT", amount: "25.5", reason: "Goodwill for a delayed payout",
    });
    expect(credited.balanceAfter).toBe("125.5");
    const leg = getSqliteClient()
      .prepare("SELECT kind, amount, balance_after FROM ledger_entries WHERE user_id = ? ORDER BY id DESC LIMIT 1")
      .get(player.id) as any;
    expect(leg.kind).toBe("admin_adjust");
    expect(leg.amount).toBe("25.5");
    expect(leg.balance_after).toBe("125.5");

    const debited = await a.adjustPlayerBalance({
      userId: player.id, currency: "USDT", amount: "-25.5", reason: "Reversing the goodwill credit",
    });
    expect(debited.balanceAfter).toBe("100");

    // Overdraft refused; zero refused; cap enforced.
    await expect(
      a.adjustPlayerBalance({ userId: player.id, currency: "USDT", amount: "-101", reason: "Too much" }),
    ).rejects.toThrow("negative");
    await expect(
      a.adjustPlayerBalance({ userId: player.id, currency: "USDT", amount: "501", reason: "Over the cap" }),
    ).rejects.toThrow("cap");
    // Credit into a currency with no balance row creates it.
    const bdt = await a.adjustPlayerBalance({
      userId: player.id, currency: "BDT", amount: "1100", reason: "BDT goodwill",
    });
    expect(bdt.balanceAfter).toBe("1100");
    // Admin accounts are not adjustable.
    await expect(
      a.adjustPlayerBalance({ userId: admin.id, currency: "USDT", amount: "10", reason: "Nope" }),
    ).rejects.toThrow("player accounts");
  });
});

describe("C4: freeze enforcement", () => {
  it("a frozen player cannot log in; guards protect admins and self", async () => {
    const admin = await makeUser("admin");
    const player = await makeUser("user", "10");
    const a = callerFor(adminRouter, admin);

    await expect(
      a.setPlayerFrozen({ userId: admin.id, frozen: true, reason: "Self test" }),
    ).rejects.toThrow("your own account");
    const otherAdmin = await makeUser("admin");
    await expect(
      a.setPlayerFrozen({ userId: otherAdmin.id, frozen: true, reason: "Admin test" }),
    ).rejects.toThrow("Admin accounts");

    await a.setPlayerFrozen({ userId: player.id, frozen: true, reason: "Suspected bonus abuse" });
    const auth = callerFor(authLocalRouter, undefined as any);
    await expect(
      auth.login({ identifier: player.email, password: "PlayerPw2026!" }),
    ).rejects.toThrow("Account disabled");

    await a.setPlayerFrozen({ userId: player.id, frozen: false, reason: "Appeal accepted" });
    const ok = await auth.login({ identifier: player.email, password: "PlayerPw2026!" });
    expect(ok.user.id).toBe(player.id);
  });
});

describe("C5/C6: notes, tags, password reset", () => {
  it("notes and tags round-trip through the detail view", async () => {
    const admin = await makeUser("admin");
    const player = await makeUser("user", "0");
    const a = callerFor(adminRouter, admin);
    await a.addPlayerNote({ userId: player.id, note: "Called about a missing deposit; verified OK." });
    await a.setPlayerTags({ userId: player.id, tags: ["vip", "watch"] });
    const detail = await a.getPlayerDetail({ userId: player.id });
    expect(detail.notes.length).toBe(1);
    expect(detail.notes[0].note).toContain("missing deposit");
    expect(detail.notes[0].adminEmail).toBe(admin.email);
    expect(detail.profile.tags).toEqual(["vip", "watch"]);
  });

  it("reset issues a working temp password and bumps the session epoch", async () => {
    const superAdmin = await makeUser("super_admin");
    const player = await makeUser("user", "0");
    const a = callerFor(adminRouter, superAdmin);
    const before = getSqliteClient()
      .prepare("SELECT session_epoch FROM users WHERE id = ?")
      .get(player.id) as any;
    const res = await a.resetPlayerPassword({ userId: player.id });
    expect(res.tempPassword.length).toBe(14);
    const after = getSqliteClient()
      .prepare("SELECT session_epoch FROM users WHERE id = ?")
      .get(player.id) as any;
    expect(after.session_epoch).toBe((before.session_epoch ?? 0) + 1);

    const auth = callerFor(authLocalRouter, undefined as any);
    await expect(
      auth.login({ identifier: player.email, password: "PlayerPw2026!" }),
    ).rejects.toThrow();
    const ok = await auth.login({ identifier: player.email, password: res.tempPassword });
    expect(ok.user.id).toBe(player.id);

    // Plain admins cannot reset passwords (super-only procedure).
    const plainAdmin = await makeUser("admin");
    await expect(
      callerFor(adminRouter, plainAdmin).resetPlayerPassword({ userId: player.id }),
    ).rejects.toThrow();
  });
});

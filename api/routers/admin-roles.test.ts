import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";

/**
 * AP2 tests: two-tier admin roles.
 * - plain "admin" keeps day-to-day reads (getStats/getSettings)
 * - settings writes, jackpot changes and role changes are
 *   super_admin only
 * - the last super_admin cannot be demoted
 * - a setup-scoped session (AP1) reaches NO admin procedure
 */

const tmpDir = fs.mkdtempSync(path.join("/tmp", "zeus-ap2-test-"));
const dbPath = path.join(tmpDir, "test.sqlite");
process.env.ZEUS_DB_PATH = dbPath;

let adminRouter: any;
let getDb: any;
let schema: any;

async function makeUser(role: string, authScope?: string) {
  const db = getDb();
  const [user] = await db
    .insert(schema.users)
    .values({
      unionId: `test:ap2:${Math.random().toString(36).slice(2)}`,
      name: "AP2 Test",
      role,
    })
    .returning();
  const caller = adminRouter.createCaller({
    user: authScope ? { ...user, authScope } : user,
    req: new Request("http://localhost/api/trpc"),
    resHeaders: new Headers(),
  });
  return { user, caller };
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
  ({ getDb } = await import("../queries/connection"));
  schema = await import("../../db/schema");
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("AP2: role tiers", () => {
  it("plain admin can read stats and settings", async () => {
    const { caller } = await makeUser("admin");
    await expect(caller.getStats()).resolves.toBeTruthy();
    await expect(caller.getSettings()).resolves.toBeTruthy();
  });

  it("plain admin cannot write settings, jackpots or roles", async () => {
    const { caller, user } = await makeUser("admin");
    await expect(
      caller.updateSettings({ entries: { announcement: "x" } }),
    ).rejects.toThrow();
    await expect(
      caller.updateJackpot({ tier: "mini", amount: 10 }),
    ).rejects.toThrow();
    await expect(
      caller.updateUserRole({ userId: user.id, role: "user" }),
    ).rejects.toThrow();
  });

  it("super_admin can write settings and roles", async () => {
    const { caller } = await makeUser("super_admin");
    const { user: plain } = await makeUser("user");
    await expect(
      caller.updateSettings({ entries: { announcement: "hello" } }),
    ).resolves.toMatchObject({ success: true });
    await expect(
      caller.updateUserRole({ userId: plain.id, role: "admin" }),
    ).resolves.toMatchObject({ success: true, role: "admin" });
  });

  it("the last super_admin cannot be demoted", async () => {
    const { caller, user } = await makeUser("super_admin");
    // Other tests created super admins too; demote every other one
    // first so this caller is the final super admin standing.
    const db = getDb();
    const all = await db.select().from(schema.users);
    const superIds = all.filter((u: any) => u.role === "super_admin").map((u: any) => u.id);
    for (const id of superIds) {
      if (id !== user.id) {
        await caller.updateUserRole({ userId: id, role: "admin" });
      }
    }
    await expect(
      caller.updateUserRole({ userId: user.id, role: "admin" }),
    ).rejects.toThrow("At least one super admin must remain");
  });

  it("players reach nothing", async () => {
    const { caller } = await makeUser("user");
    await expect(caller.getStats()).rejects.toThrow();
    await expect(caller.getSettings()).rejects.toThrow();
  });

  it("a setup-scoped admin session reaches no admin procedure (AP1)", async () => {
    const { caller } = await makeUser("super_admin", "setup");
    await expect(caller.getStats()).rejects.toThrow(
      "Admin two-factor setup is required",
    );
  });
});

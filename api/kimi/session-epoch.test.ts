import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";

/**
 * AP3 tests: session epochs.
 * - a token authenticates while its epoch matches the account's
 * - bumping the account epoch revokes previously minted tokens
 * - a fresh token at the new epoch works again
 * - legacy tokens without an epoch claim count as epoch 0
 */

const tmpDir = fs.mkdtempSync(path.join("/tmp", "zeus-ap3-test-"));
const dbPath = path.join(tmpDir, "test.sqlite");
process.env.ZEUS_DB_PATH = dbPath;

let authenticateSession: any;
let signSessionToken: any;
let getDb: any;
let schema: any;
let eq: any;

const UNION_ID = "test:ap3:epoch-user";

function headersFor(token: string): Headers {
  return new Headers({ cookie: `kimi_sid=${token}` });
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

  ({ authenticateSession } = await import("./session-auth"));
  ({ signSessionToken } = await import("./session"));
  ({ getDb } = await import("../queries/connection"));
  schema = await import("../../db/schema");
  ({ eq } = await import("drizzle-orm"));

  const db = getDb();
  await db.insert(schema.users).values({
    unionId: UNION_ID,
    name: "Epoch User",
    role: "admin",
  });
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("AP3: session epochs", () => {
  it("token at the current epoch authenticates", async () => {
    const token = await signSessionToken({ unionId: UNION_ID, clientId: "zeus-local", epoch: 0 });
    const user = await authenticateSession(headersFor(token));
    expect(user.unionId).toBe(UNION_ID);
  });

  it("legacy token without an epoch claim authenticates at epoch 0", async () => {
    const token = await signSessionToken({ unionId: UNION_ID, clientId: "zeus-local" });
    const user = await authenticateSession(headersFor(token));
    expect(user.unionId).toBe(UNION_ID);
  });

  it("bumping the epoch revokes old tokens; a new-epoch token works", async () => {
    const db = getDb();
    const oldToken = await signSessionToken({ unionId: UNION_ID, clientId: "zeus-local", epoch: 0 });
    await db
      .update(schema.users)
      .set({ sessionEpoch: 1 })
      .where(eq(schema.users.unionId, UNION_ID));
    await expect(authenticateSession(headersFor(oldToken))).rejects.toThrow("Session revoked");
    const newToken = await signSessionToken({ unionId: UNION_ID, clientId: "zeus-local", epoch: 1 });
    const user = await authenticateSession(headersFor(newToken));
    expect(user.unionId).toBe(UNION_ID);
  });
});

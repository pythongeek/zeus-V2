import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import http from "http";

/**
 * Section I tests: system health shape, CSV exports (players /
 * transactions / settings history), alert-channel test button
 * against a local capture server.
 */

const tmpDir = fs.mkdtempSync(path.join("/tmp", "zeus-i-test-"));
const dbPath = path.join(tmpDir, "test.sqlite");
process.env.ZEUS_DB_PATH = dbPath;

let adminRouter: any;
let balanceRouter: any;
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
      unionId: `test:i:${suffix}`,
      name: "I User",
      email: `i-${suffix}@test.local`,
      phone: `+880175${Math.floor(1000000 + Math.random() * 8999999)}`,
      role,
      passwordHash: passwordLib.hashPassword("IPv2026!"),
    })
    .returning();
  return user;
}

let superCaller: any;
let plainCaller: any;
let player: any;
let capture: { server: http.Server; port: number; bodies: string[] };

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
  balanceRouter = (await import("./balance")).balanceRouter;
  passwordLib = await import("../lib/password");
  settingsLib = await import("../lib/settings");
  const conn = await import("../queries/connection");
  getDb = conn.getDb;
  schema = await import("../../db/schema");

  settingsLib.setSetting("binance_pay_id", "556677889", null);
  superCaller = callerFor(adminRouter, await makeUser("super_admin"));
  plainCaller = callerFor(adminRouter, await makeUser("admin"));
  player = await makeUser();

  const bodies: string[] = [];
  const server = http.createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      bodies.push(data);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port;
  capture = { server, port, bodies };
});

afterAll(() => {
  capture.server.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("I1/I2/I3: system, exports, alert channels", () => {
  it("health endpoint returns the ops picture", async () => {
    const h = await plainCaller.getSystemHealth();
    expect(h.service.nodeVersion).toMatch(/^v\d+/);
    expect(h.service.uptimeSec).toBeGreaterThanOrEqual(0);
    expect(h.db.sizeBytes).toBeGreaterThan(0);
    expect(Array.isArray(h.errors)).toBe(true);
    expect(Array.isArray(h.monitor.recent)).toBe(true);
  });

  it("players + transactions CSV exports carry real data", async () => {
    const db = getDb();
    await db.insert(schema.balances).values({
      userId: player.id, currency: "USDT", available: "42.5", locked: "0",
    });
    const bal = callerFor(balanceRouter, player);
    await bal.deposit({ currency: "USDT", amount: "25", reference: "EXPORTREF1" });

    const players = await plainCaller.exportData({ kind: "players" });
    expect(players.csv.split("\n")[0]).toContain("usdt_available");
    expect(players.csv).toContain(player.email);
    expect(players.csv).toContain("42.5");
    expect(players.truncated).toBe(false);

    const txs = await plainCaller.exportData({ kind: "transactions" });
    expect(txs.csv).toContain("EXPORTREF1");
    expect(txs.rowCount).toBe(1);

    const none = await plainCaller.exportData({ kind: "transactions", from: "2030-01-01", to: "2030-12-31" });
    expect(none.rowCount).toBe(0);
  });

  it("settings history export records settings writes", async () => {
    await superCaller.updateSettings({ entries: { promo_text: "history probe" } });
    const hist = await plainCaller.exportData({ kind: "settings_history" });
    expect(hist.csv).toContain("admin.updateSettings");
    expect(hist.csv).toContain("promo_text");
    settingsLib.setSetting("promo_text", "", null);
  });

  it("test alert channel posts to the configured webhook; telegram reports missing token", async () => {
    await superCaller.updateSettings({
      entries: { alert_webhook_url: `http://127.0.0.1:${capture.port}/hook` },
    });
    const res = await superCaller.testAlertChannel();
    expect(res.webhook.configured).toBe(true);
    expect(res.webhook.ok).toBe(true);
    expect(res.webhook.status).toBe(200);
    expect(capture.bodies.length).toBe(1);
    expect(capture.bodies[0]).toContain("test alert");

    expect(res.telegram.configured).toBe(false);
    await superCaller.updateSettings({ entries: { alert_telegram_chat_id: "12345" } });
    const res2 = await superCaller.testAlertChannel();
    expect(res2.telegram.configured).toBe(true);
    expect(res2.telegram.ok).toBe(false);
    expect(res2.telegram.error).toContain("TELEGRAM_BOT_TOKEN");
    await superCaller.updateSettings({ entries: { alert_telegram_chat_id: "", alert_webhook_url: "" } });

    // Plain admins cannot fire the test button.
    await expect(plainCaller.testAlertChannel()).rejects.toThrow();
  });
});

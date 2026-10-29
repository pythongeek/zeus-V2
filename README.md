# Zeus Slot

Zeus Slot ("Zeus Thunder Slots") is a bilingual (Bangla + English) online slot
game: a Hono/tRPC API and React frontend in one repo, backed by file-based
SQLite, with a full admin panel (players, money operations, RTP Lab, jackpots,
risk & reconciliation, system health/exports). Production runs it as a single
Node process behind nginx.

- Live game: https://mighty-zeus.megaslot.online
- Declared RTP: **95.95%** — certified by exact enumeration in the RTP Lab
  (`api/lib/certify.ts`); the paytable and fairness dialog render from the
  live math, never from hard-coded numbers.

## Quick start (development)

```bash
npm ci                 # install (better-sqlite3 compiles natively:
                       # needs python3, make, g++ on Linux)
cp .env.example .env   # then set APP_SECRET (see below)
npm run build:vps      # build frontend + API bundle into dist/
node dist/server.js    # serves game + API on PORT (default 3100)
```

On first boot with an empty database the server applies every file in
`db/migrations/` in order and creates `data/zeus.sqlite` (override with
`ZEUS_DB_PATH`). Jackpot pools self-seed (mini 5 / major 25 / mega 100 USDT)
on first read, and all game settings fall back to the defaults in
`api/lib/settings.ts` until an admin changes them.

## Environment

Everything is configured through `.env` (see `.env.example` for the annotated
template). **`.env` is git-ignored — never commit it, and never paste its
values into issues, chats or logs.**

| Variable | Required | Notes |
| --- | --- | --- |
| `APP_SECRET` | **yes** | Session signing; min 32 chars. The app refuses to boot without it. `openssl rand -hex 32` |
| `PORT` | no | Default 3100 |
| `ZEUS_DB_PATH` | no | Default `./data/zeus.sqlite` |
| `NODE_ENV` | no | `production` in production |
| `TELEGRAM_BOT_TOKEN` | no | Needed only for Telegram alert delivery; the chat id is set in the admin panel |
| `ZEUS_ALERT_WEBHOOK` | no | Legacy fallback for the monitor; the webhook is normally set in the admin panel |
| `OWNER_UNION_ID` | no | Legacy OAuth path only (see "First admin") |

Optional ops-path overrides used by the admin health page:
`ZEUS_APP_DIR`, `ZEUS_BACKUPS_DIR`, `ZEUS_MONITOR_DIR`, `ZEUS_MONITOR_LOG`,
`ZEUS_SERVICE_NAME`.

## First admin

1. Register a normal account in the game UI with the owner's email.
2. Promote it (roles: `admin`, or `super_admin` for settings/math/jackpot
   writes — production uses `super_admin` for owner accounts):

   ```sql
   UPDATE users SET role = 'super_admin' WHERE email = 'owner@example.com';
   ```

3. Sign in and open `/admin`. Admin 2FA is **enforced**
   (`admin_2fa_required`): the first admin login lands on `/security` and
   walks through TOTP enrollment with one-time recovery codes. Keep the
   recovery codes somewhere safe and offline.

(The `OWNER_UNION_ID` env promotes matching *OAuth* sign-ups automatically;
local email accounts use the SQL promotion above.)

## Go-live checklist (fresh deploy)

- [ ] `.env` created with a fresh `APP_SECRET`; file permissions `600`
- [ ] `npm run build:vps` done; service running (see `deploy/`)
- [ ] First admin promoted + enrolled in 2FA (above)
- [ ] Admin → Site/Payments: set the **Binance Pay** PayID, display name, QR
      image and pay link — a fresh database has them empty and deposits show
      "unavailable" until set
- [ ] Seed the **house float** (player balances must be covered; watch
      Admin → Dashboard → Money position)
- [ ] Admin → System → Alert channels: set the alert webhook and **Send test
      alert**; set the Telegram chat id if used
- [ ] Backup + monitor cron installed (see `deploy/crontab.txt`); run
      `scripts/backup.sh` once by hand and confirm the archive appears
- [ ] Admin → Risk: run **Reconciliation** once — a clean deploy reports all
      accounts reconciled

## Database & migrations

- One SQLite file (WAL mode). Money is stored as decimal strings and handled
  as integers at 1e8 scale (`api/lib/money.ts`) — never floats.
- Every balance movement writes a ledger leg (`ledger_entries`); the Risk
  section reconciles chains against balances nightly and on demand.
- Schema changes ship as hand-written, sequentially numbered SQL files in
  `db/migrations/`:
  - **Fresh DB:** the server bootstrap applies all files automatically.
  - **Existing DB:** back up first, then
    `node scripts/migrate.mjs` applies only the files not yet recorded in
    the `_migrations` table. Databases that predate the runner (production)
    are baselined once with `node scripts/migrate.mjs --baseline`.
  - `npm run db:generate` (drizzle-kit) is only a drafting aid for diffs;
    review and renumber its output to the next sequential file.

## Operations

Deployment artifacts that mirror production live in `deploy/`:

- `deploy/zeus-slot.service` — systemd unit (uses `EnvironmentFile=.env` and
  the bundled Node at `runtime/bin/node`; a system Node ≥ 20 works too —
  `package.json` `engines` is the contract)
- `deploy/nginx-mighty-zeus.conf` — the game subdomain vhost (TLS via Certbot)
- `deploy/crontab.txt` — nightly backup (03:15) + 5-minute health monitor.
  The monitor also snapshots jackpot pools, raises low-pool alerts, and runs
  the nightly reconciliation once a day, posting new mismatches to the
  configured alert webhook.

Backups land in `/var/backups/apps/zeus-nightly-*.tar.gz` (7 kept), each with
a consistent online-backup copy of the database. The admin **System** page
shows service/backup/monitor status, a sanitised error tail, CSV exports
(players, transactions, spins, settings history) and the alert-channel
settings + test button.

## Tests

```bash
npm run check   # tsc across app + server
npm test        # vitest — 115 tests: money, ledger, RTP certification,
                # money ops, players, risk/reconciliation, system
```

Tests run against throwaway SQLite files and need no setup: `vitest.config.ts`
supplies a labelled test-only `APP_SECRET` when `.env` doesn't.

## Repository layout

```
api/            Hono server: routers/ (tRPC), lib/ (money, certify, totp,
                settings, reconcile), kimi/ (session auth), queries/
src/            React app: pages/ (Game, Admin, Login, Legal, Security),
                game/ (Pixi reel engine), i18n/ (EN/BN strings)
db/             drizzle schema + hand-written migrations
contracts/      shared constants/types between API and client
scripts/        backup, monitor, reconciliation, migration runner
deploy/         systemd unit, nginx vhost, crontab (production copies)
public/assets/  WebP art + WAV audio (all served with immutable caching)
```

The legacy Cloudflare Worker entry (`api/worker.ts`, `api/boot.ts`) is kept
for local dev-server use only; production runs `api/server.ts` via
`npm run build:vps` → `dist/server.js`.

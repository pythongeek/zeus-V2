#!/bin/bash
# Zeus Slot health monitor — run every 5 minutes from cron.
# Checks: service active, local health, public health, disk headroom,
# DB present. Three consecutive failures raise an alert (log line +
# optional webhook via ZEUS_ALERT_WEBHOOK in /opt/zeus-slot/.env).
set -uo pipefail

STATE_DIR="/var/lib/zeus-monitor"
STATE_FILE="$STATE_DIR/failcount"
LOG_FILE="/var/log/zeus-monitor.log"
mkdir -p "$STATE_DIR"
touch "$LOG_FILE"

fail=0
reasons=""

systemctl is-active --quiet zeus-slot || { fail=1; reasons="$reasons service-inactive"; }
curl -sf --max-time 5 http://127.0.0.1:3100/api/health >/dev/null || { fail=1; reasons="$reasons local-health"; }
curl -sf --max-time 10 https://mighty-zeus.megaslot.online/api/health >/dev/null || { fail=1; reasons="$reasons public-health"; }
[ -f /opt/zeus-slot/data/zeus.sqlite ] || { fail=1; reasons="$reasons db-missing"; }
DISK_PCT=$(df / --output=pcent | tail -1 | tr -dc '0-9')
[ "${DISK_PCT:-0}" -lt 85 ] || { fail=1; reasons="$reasons disk-${DISK_PCT}%"; }

# F1: jackpot pool snapshots for the admin history chart (best-effort;
# 5-min cadence from this cron, 30-day retention).
/opt/zeus-slot/runtime/bin/node -e "
try {
  const Database = require('/opt/zeus-slot/node_modules/better-sqlite3');
  const db = new Database('/opt/zeus-slot/data/zeus.sqlite');
  const pools = db.prepare('SELECT tier, current_amount FROM jackpot_pool').all();
  const ins = db.prepare('INSERT INTO jackpot_pool_snapshots (tier, amount) VALUES (?, ?)');
  for (const p of pools) ins.run(p.tier, p.current_amount);
  db.prepare('DELETE FROM jackpot_pool_snapshots WHERE created_at < unixepoch() - 30*86400').run();
  try {
    const poolsNow = db.prepare('SELECT tier, seed_amount, current_amount FROM jackpot_pool').all();
    for (const p of poolsNow) {
      if (parseFloat(p.current_amount) < parseFloat(p.seed_amount)) {
        const dup = db.prepare("SELECT id FROM admin_alerts WHERE kind = 'low_pool' AND ref_id = ? AND status IN ('open', 'acknowledged') LIMIT 1").get(p.tier);
        if (!dup) {
          db.prepare("INSERT INTO admin_alerts (kind, severity, title, details, ref_id) VALUES ('low_pool', 'warning', ?, ?, ?)").run(
            'Jackpot pool below seed: ' + p.tier,
            JSON.stringify({ tier: p.tier, current: p.current_amount, seed: p.seed_amount }),
            p.tier,
          );
        }
      }
    }
  } catch (e) { /* alerts table may predate migration 0018 */ }
  db.close();
} catch (e) { /* snapshots are best-effort */ }
" >/dev/null 2>&1 || true

# G1: nightly reconciliation on the first monitor run of the day.
RECON_STATE="/var/lib/zeus-monitor/last-recon-date"
TODAY="$(date +%F)"
if [ "$(cat "$RECON_STATE" 2>/dev/null)" != "$TODAY" ]; then
  if /opt/zeus-slot/runtime/bin/node /opt/zeus-slot/scripts/reconcile.mjs >> "$LOG_FILE" 2>&1; then
    echo "$TODAY" > "$RECON_STATE"
  fi
fi

# Step 15 (playbook 4.1): nightly RTP-drift tripwire on the first
# monitor run of the day (two-layer monitor + bundle-hash audit).
TRIPWIRE_STATE="/var/lib/zeus-monitor/last-tripwire-date"
if [ "$(cat "$TRIPWIRE_STATE" 2>/dev/null)" != "$TODAY" ]; then
  if /opt/zeus-slot/runtime/bin/node /opt/zeus-slot/scripts/tripwire.mjs >> "$LOG_FILE" 2>&1; then
    echo "$TODAY" > "$TRIPWIRE_STATE"
  fi
fi

COUNT=$(cat "$STATE_FILE" 2>/dev/null || echo 0)
if [ "$fail" -eq 0 ]; then
  if [ "$COUNT" != "0" ]; then
    echo "$(date -Iseconds) RECOVERED after $COUNT failed checks" >> "$LOG_FILE"
  fi
  echo 0 > "$STATE_FILE"
  exit 0
fi

COUNT=$((COUNT + 1))
echo "$COUNT" > "$STATE_FILE"
echo "$(date -Iseconds) FAIL #$COUNT:$reasons" >> "$LOG_FILE"

if [ "$COUNT" -ge 3 ]; then
  MSG="Zeus Slot ALERT: health failing ($COUNT consecutive):$reasons — $(hostname)"
  echo "$(date -Iseconds) ALERT raised:$reasons" >> "$LOG_FILE"
  # I3: webhook lives in admin settings now; the env var is the fallback.
  WEBHOOK=$(/opt/zeus-slot/runtime/bin/node -e "
try {
  const Database = require('/opt/zeus-slot/node_modules/better-sqlite3');
  const db = new Database('/opt/zeus-slot/data/zeus.sqlite', { readonly: true });
  const row = db.prepare(\"SELECT value FROM settings WHERE key = 'alert_webhook_url'\").get();
  db.close();
  if (row) { const v = JSON.parse(row.value); if (typeof v === 'string' && v) console.log(v); }
} catch (e) {}
" 2>/dev/null || true)
  if [ -z "${WEBHOOK:-}" ]; then
    WEBHOOK=$(grep -E '^ZEUS_ALERT_WEBHOOK=' /opt/zeus-slot/.env 2>/dev/null | cut -d= -f2- || true)
  fi
  if [ -n "${WEBHOOK:-}" ]; then
    curl -s --max-time 10 -d "$MSG" "$WEBHOOK" >/dev/null 2>&1 || true
  fi
fi
exit 0

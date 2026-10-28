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
  WEBHOOK=$(grep -E '^ZEUS_ALERT_WEBHOOK=' /opt/zeus-slot/.env 2>/dev/null | cut -d= -f2- || true)
  if [ -n "${WEBHOOK:-}" ]; then
    curl -s --max-time 10 -d "$MSG" "$WEBHOOK" >/dev/null 2>&1 || true
  fi
fi
exit 0

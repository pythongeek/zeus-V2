#!/bin/bash
# Zeus Slot nightly backup: consistent SQLite copy (online backup API)
# + code/config tarball. Retention: newest 7 archives.
set -euo pipefail

APP_DIR="/opt/zeus-slot"
BACKUP_DIR="/var/backups/apps"
TS=$(date +%Y%m%d-%H%M%S)
OUT="$BACKUP_DIR/zeus-nightly-$TS.tar.gz"
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

mkdir -p "$BACKUP_DIR"

python3 - "$APP_DIR/data/zeus.sqlite" "$TMPDIR/zeus.sqlite" <<'PYEOF'
import sqlite3, sys
src = sqlite3.connect(sys.argv[1])
dst = sqlite3.connect(sys.argv[2])
src.backup(dst)
dst.close(); src.close()
PYEOF

tar --exclude="zeus-slot/node_modules" \
    --exclude="zeus-slot/dist" \
    --exclude="zeus-slot/runtime" \
    --exclude="zeus-slot/.git" \
    --exclude="zeus-slot/data" \
    -czf "$OUT" -C "$TMPDIR" zeus.sqlite -C /opt zeus-slot

# retention: keep the newest 7 nightly archives
ls -1t "$BACKUP_DIR"/zeus-nightly-*.tar.gz 2>/dev/null | tail -n +8 | xargs -r rm -f

echo "$(date -Iseconds) zeus backup ok -> $OUT ($(du -h "$OUT" | cut -f1))"

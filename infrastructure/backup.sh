#!/bin/sh
# Backs up a self-hosted kolo server run with compose.selfhost.yml: the PostgreSQL database (custom format) and the
# server identity key. Both are needed: a restored database with a different key makes every till reconnect.
# Usage: infrastructure/backup.sh [backup-directory]   (default ./kolo-backups). Keep copies off this machine.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
compose="docker compose -f $here/compose.selfhost.yml"
target=${1:-./kolo-backups}
stamp=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$target"
umask 077
$compose exec -T postgres pg_dump -U kolo -d kolo --format=custom --no-owner > "$target/kolo-$stamp.dump"
$compose exec -T server cat /var/lib/kolo/server-key.json > "$target/kolo-$stamp.server-key.json"
# A quick integrity check: the dump must list its tables and the key must parse.
$compose exec -T postgres pg_restore --list < "$target/kolo-$stamp.dump" > /dev/null
grep -q '"private_key"' "$target/kolo-$stamp.server-key.json"
echo "Backup written: $target/kolo-$stamp.dump and $target/kolo-$stamp.server-key.json"

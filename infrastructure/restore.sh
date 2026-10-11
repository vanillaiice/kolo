#!/bin/sh
# Restores a backup made by backup.sh into the compose.selfhost.yml deployment, replacing its database and identity.
# Usage: infrastructure/restore.sh <backup.dump> <backup.server-key.json>
# It stops the server, recreates the database from the dump, puts the identity key back and starts the server again,
# which then migrates forward if the backup came from an older version. Tills keep everything they hold and resend
# whatever the server is missing on their next pass.
set -eu
[ $# -eq 2 ] || { echo "Usage: $0 <backup.dump> <backup.server-key.json>" >&2; exit 2; }
here=$(cd "$(dirname "$0")" && pwd)
compose="docker compose -f $here/compose.selfhost.yml"
grep -q '"private_key"' "$2" || { echo "$2 is not a kolo server key" >&2; exit 2; }
$compose stop server
$compose exec -T postgres dropdb -U kolo --if-exists --force kolo
$compose exec -T postgres createdb -U kolo kolo
$compose exec -T postgres pg_restore -U kolo -d kolo --no-owner --exit-on-error < "$1"
# Write the key into the identity volume with the server's own image, as its user, with owner-only permissions.
$compose run --rm -T --no-deps --entrypoint sh server -c 'umask 077 && cat > /var/lib/kolo/server-key.json' < "$2"
$compose up -d server
echo "Restored. Check: curl -s http://127.0.0.1:\${KOLO_SYNC_PORT:-8080}/readyz"

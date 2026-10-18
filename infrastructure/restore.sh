#!/bin/sh
# Restores a backup made by backup.sh into the compose.selfhost.yml deployment, replacing its database and identity.
# Usage: infrastructure/restore.sh <backup.dump> <backup.server-key.json>
# Nothing is changed until both files check out: the key must load the way the server loads it and the dump must be a
# pg_dump archive. The dump is then restored into a staging database while the server keeps serving; only a complete
# restore is switched in. The previous database is kept (renamed) and the previous key copied beside the new one, so a
# restore can be rolled back. The server then migrates forward if the backup came from an older version. Tills keep
# everything they hold and resend whatever the server is missing on their next pass.
set -eu
[ $# -eq 2 ] || { echo "Usage: $0 <backup.dump> <backup.server-key.json>" >&2; exit 2; }
dump=$1 key=$2
[ -f "$dump" ] && [ -r "$dump" ] && [ -s "$dump" ] || { echo "$dump is not a readable backup dump" >&2; exit 2; }
[ -f "$key" ] && [ -r "$key" ] && [ -s "$key" ] || { echo "$key is not a readable kolo server key" >&2; exit 2; }
here=$(cd "$(dirname "$0")" && pwd)
compose="docker compose -f $here/compose.selfhost.yml"
stamp=$(date -u +%Y%m%dt%H%M%Sz)
staging=kolo_restore_$stamp previous=kolo_previous_$stamp
sql() { $compose exec -T postgres psql -U kolo -d postgres -v ON_ERROR_STOP=1 -qtA -c "$1"; }
# The same checks as the server's loadServerKey: a UUIDv7 device ID and an Ed25519 private key.
check_key='let text="";process.stdin.setEncoding("utf8").on("data",chunk=>{text+=chunk;}).on("end",()=>{try{const stored=JSON.parse(text);
if(typeof stored.device_id!=="string"||!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(stored.device_id)||typeof stored.private_key!=="string")process.exit(1);
if(process.getBuiltinModule("node:crypto").createPrivateKey(stored.private_key).asymmetricKeyType!=="ed25519")process.exit(1);}catch{process.exit(1);}});'

$compose up -d --wait postgres
$compose run --rm -T --no-deps --entrypoint node server -e "$check_key" < "$key" || { echo "$key is not a valid kolo server key; nothing was changed" >&2; exit 2; }
$compose exec -T postgres pg_restore --list < "$dump" > /dev/null || { echo "$dump is not a valid backup dump; nothing was changed" >&2; exit 2; }

$compose exec -T postgres createdb -U kolo "$staging"
if ! $compose exec -T postgres pg_restore -U kolo -d "$staging" --no-owner --exit-on-error < "$dump"; then
  $compose exec -T postgres dropdb -U kolo --if-exists "$staging" || true
  echo "The dump could not be restored; the server and its database are unchanged" >&2; exit 1
fi

# Switch over: both renames commit together, with the server stopped so nothing holds the current database open.
$compose stop server
sql "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname IN ('kolo','$staging') AND pid<>pg_backend_pid()" > /dev/null
if [ "$(sql "SELECT count(*) FROM pg_database WHERE datname='kolo'")" = 1 ]; then
  sql "ALTER DATABASE kolo RENAME TO $previous; ALTER DATABASE $staging RENAME TO kolo;"
else
  previous=; sql "ALTER DATABASE $staging RENAME TO kolo"
fi
# Write the key into the identity volume with the server's own image, as its user, with owner-only permissions, keeping
# the previous one; the new file only replaces the old once completely written.
if ! $compose run --rm -T --no-deps --entrypoint sh server -c "umask 077 && cd /var/lib/kolo && { [ ! -f server-key.json ] || cp -p server-key.json server-key.json.previous-$stamp; } && cat > server-key.json.new && mv server-key.json.new server-key.json" < "$key"; then
  if [ -n "$previous" ]; then sql "ALTER DATABASE kolo RENAME TO $staging; ALTER DATABASE $previous RENAME TO kolo;"; fi
  $compose up -d server
  echo "The server key could not be written; the previous database and key are back in service" >&2; exit 1
fi
$compose up -d server
echo "Restored. Check: curl -s http://127.0.0.1:\${KOLO_SYNC_PORT:-8080}/readyz"
if [ -n "$previous" ]; then
  echo "The previous database is kept as $previous and the previous key as server-key.json.previous-$stamp in the identity volume."
  echo "Once the restore is confirmed: $compose exec postgres dropdb -U kolo $previous"
fi

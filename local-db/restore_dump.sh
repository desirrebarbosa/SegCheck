#!/bin/sh
set -eu

compose='docker compose -f local-db/docker-compose.yml'
dump_path=${1:-segcheck_dump.sql}

if [ ! -f "$dump_path" ]; then
  printf 'Dump not found: %s\n' "$dump_path" >&2
  exit 1
fi

$compose up -d --wait
$compose exec -T postgres psql -U segcheck -d segcheck_test -v ON_ERROR_STOP=1 -c 'DROP SCHEMA IF EXISTS public CASCADE;'

{
  grep -Eo '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' "$dump_path" \
    | sort -u \
    | sed "s/.*/INSERT INTO auth.users (id) VALUES ('&') ON CONFLICT DO NOTHING;/"
  sed '/^SET transaction_timeout = 0;$/d' "$dump_path"
} | $compose exec -T postgres psql -U segcheck -d segcheck_test -v ON_ERROR_STOP=1

$compose exec -T postgres psql -U segcheck -d segcheck_test -v ON_ERROR_STOP=1 -f /tests/apply_staging_updates.sql
printf 'Local restore complete. Database is available on localhost:55432.\n'

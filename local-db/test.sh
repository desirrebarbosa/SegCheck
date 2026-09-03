#!/bin/sh
set -eu

compose='docker compose -f local-db/docker-compose.yml'
cleanup() {
  $compose down -v
}
trap cleanup EXIT

$compose down -v --remove-orphans
$compose up -d --wait
$compose exec -T postgres psql -U segcheck -d segcheck_test -v ON_ERROR_STOP=1 -f /tests/supabase_migration_corrected_masks.sql
$compose exec -T postgres psql -U segcheck -d segcheck_test -f /tests/partial_redo_test.sql

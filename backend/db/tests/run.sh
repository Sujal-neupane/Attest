#!/usr/bin/env bash
#
# Run the database tests against a throwaway Postgres database.
#
# These tests need a real Postgres because what they are testing — row-level
# security policies, triggers and check constraints — does not exist anywhere
# else. Mocking them would test the mock.
#
# Uses $DATABASE_URL_TEST if set (CI), otherwise a local server.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIGRATIONS="$HERE/../migrations"

if [[ -n "${DATABASE_URL_TEST:-}" ]]; then
  PSQL=(psql "$DATABASE_URL_TEST")
  ADMIN=("${PSQL[@]}")
  DB_READY=1
else
  PGHOST="${PGHOST:-/tmp/attest-pg}"
  PGPORT="${PGPORT:-55432}"
  PGUSER="${PGUSER:-postgres}"
  ADMIN=(psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d postgres)
  PSQL=(psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d attest_test)

  if ! "${ADMIN[@]}" -c 'select 1' >/dev/null 2>&1; then
    echo "No Postgres reachable at $PGHOST:$PGPORT."
    echo "Start one, or set DATABASE_URL_TEST to point at a scratch database."
    echo
    echo "  initdb -D /tmp/attest-pgdata -U postgres --auth=trust"
    echo "  mkdir -p /tmp/attest-pg"
    echo "  pg_ctl -D /tmp/attest-pgdata -o \"-k /tmp/attest-pg -p 55432\" start"
    exit 1
  fi

  "${ADMIN[@]}" -q -c 'DROP DATABASE IF EXISTS attest_test' -c 'CREATE DATABASE attest_test'
fi

echo "→ applying migrations"
for f in "$MIGRATIONS"/*.sql; do
  "${PSQL[@]}" -q -v ON_ERROR_STOP=1 -f "$f"
done

echo "→ running database tests"
# ASSERT failures raise, ON_ERROR_STOP turns that into a non-zero exit, so a
# broken isolation policy fails the build rather than printing a warning.
"${PSQL[@]}" -q -v ON_ERROR_STOP=1 -f "$HERE/rls.test.sql"

echo "✓ database tests passed"

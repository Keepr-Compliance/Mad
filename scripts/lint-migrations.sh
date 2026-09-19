#!/usr/bin/env bash
# lint-migrations.sh - Validate the CONTENTS of Supabase migration files
#
# Checks:
#   1. Dangerous patterns: DROP TABLE/COLUMN without IF EXISTS, DROP SCHEMA, TRUNCATE
#   2. SQL file is not empty
#
# NOT CHECKED HERE — filenames and version stamps belong to
# scripts/check-migration-names.mjs, which runs in the same workflow step list.
#
# This script used to own both, and both were wrong:
#
#   Its naming check accepted `YYYYMMDD_` as valid. That is the form the new gate
#   rejects, so leaving it here left two checkers disagreeing about what a valid
#   migration name is.
#
#   Its "Duplicate Timestamps" check was `uniq -d` over basenames collected by
#   `find` from a single directory — a list in which two identical entries cannot
#   occur. It was structurally incapable of firing, and printed
#   "OK: No duplicate filenames" on every run. On 2026-09-07 two migrations both
#   claimed the stamp `20260905`; this check was green throughout, and reads to a
#   human as though collisions had been ruled out.
#
# Both were removed rather than repaired: the .mjs gate already covers every name
# this one would have rejected, and it is grandfather-aware, which this was not.
#
# Usage:
#   ./scripts/lint-migrations.sh              # Check all migrations
#   ./scripts/lint-migrations.sh --changed    # Check only changed files (CI mode)

set -euo pipefail

MIGRATIONS_DIR="supabase/migrations"
ERRORS=0
WARNINGS=0

# Colors (disabled in CI)
if [ -t 1 ]; then
  RED='\033[0;31m'
  YELLOW='\033[0;33m'
  GREEN='\033[0;32m'
  NC='\033[0m'
else
  RED=''
  YELLOW=''
  GREEN=''
  NC=''
fi

error() {
  echo -e "${RED}ERROR:${NC} $1"
  ERRORS=$((ERRORS + 1))
}

warn() {
  echo -e "${YELLOW}WARNING:${NC} $1"
  WARNINGS=$((WARNINGS + 1))
}

info() {
  echo -e "${GREEN}OK:${NC} $1"
}

# Check migrations directory exists
if [ ! -d "$MIGRATIONS_DIR" ]; then
  error "Migrations directory not found: $MIGRATIONS_DIR"
  exit 1
fi

# Get list of migration files
if [ "${1:-}" = "--changed" ] && [ -n "${GITHUB_BASE_REF:-}" ]; then
  # CI mode: only check changed files
  FILES=$(git diff --name-only "origin/${GITHUB_BASE_REF}...HEAD" -- "$MIGRATIONS_DIR" | grep '\.sql$' || true)
  if [ -z "$FILES" ]; then
    echo "No migration files changed."
    exit 0
  fi
else
  FILES=$(find "$MIGRATIONS_DIR" -name "*.sql" -type f | sort)
fi

FILE_COUNT=$(echo "$FILES" | grep -c '.' || echo 0)
echo "Checking $FILE_COUNT migration file(s)..."
echo ""

# Filenames and version stamps are checked by scripts/check-migration-names.mjs.
# See the header for why the two checks that used to live here were removed rather
# than repaired.
echo "=== Naming and duplicate stamps ==="
info "checked by scripts/check-migration-names.mjs"
echo ""

# Check for same-day timestamp collisions (just warn, not error -- multiple migrations per day is common)
ALL_FILES=$(find "$MIGRATIONS_DIR" -name "*.sql" -type f -exec basename {} \; | sort)
DAY_TIMESTAMPS=$(echo "$ALL_FILES" | grep -oE '^[0-9]{8}' | sort)
DAY_DUPES=$(echo "$DAY_TIMESTAMPS" | uniq -c | sort -rn | head -5)
echo "Top 5 busiest migration days:"
while read -r count day; do
  [ -z "$count" ] && continue
  if [ "$count" -gt 10 ]; then
    warn "Date $day has $count migrations -- consider grouping related changes"
  else
    echo "  $day: $count migration(s)"
  fi
done <<< "$DAY_DUPES"
echo ""

# --- Check 1: Dangerous patterns ---
echo "=== Dangerous Patterns ==="
while IFS= read -r filepath; do
  [ -z "$filepath" ] && continue
  [ ! -f "$filepath" ] && continue
  basename=$(basename "$filepath")

  # DROP TABLE without IF EXISTS
  # Check for DROP TABLE that is NOT followed by IF EXISTS
  if grep -qi 'DROP[[:space:]]\{1,\}TABLE' "$filepath" 2>/dev/null; then
    if grep -qi 'DROP[[:space:]]\{1,\}TABLE' "$filepath" 2>/dev/null && \
       ! grep -qi 'DROP[[:space:]]\{1,\}TABLE[[:space:]]\{1,\}IF[[:space:]]\{1,\}EXISTS' "$filepath" 2>/dev/null; then
      warn "$basename: DROP TABLE without IF EXISTS"
    fi
  fi

  # DROP COLUMN without IF EXISTS
  if grep -qi 'DROP[[:space:]]\{1,\}COLUMN' "$filepath" 2>/dev/null; then
    if ! grep -qi 'DROP[[:space:]]\{1,\}COLUMN[[:space:]]\{1,\}IF[[:space:]]\{1,\}EXISTS' "$filepath" 2>/dev/null; then
      warn "$basename: DROP COLUMN without IF EXISTS"
    fi
  fi

  # TRUNCATE (almost always dangerous in production)
  if grep -qiE '^[[:space:]]*TRUNCATE[[:space:]]' "$filepath" 2>/dev/null; then
    warn "$basename: Contains TRUNCATE statement"
  fi

  # DROP SCHEMA
  if grep -qiE 'DROP[[:space:]]+SCHEMA' "$filepath" 2>/dev/null; then
    error "$basename: Contains DROP SCHEMA -- extremely dangerous in production"
  fi

  # DELETE without WHERE (mass delete)
  if grep -qiE '^[[:space:]]*DELETE[[:space:]]+FROM[[:space:]]+[a-zA-Z_]+[[:space:]]*;' "$filepath" 2>/dev/null; then
    warn "$basename: DELETE without WHERE clause (mass delete)"
  fi
done <<< "$FILES"
echo ""

# --- Check 2: Empty files ---
echo "=== Empty File Check ==="
while IFS= read -r filepath; do
  [ -z "$filepath" ] && continue
  [ ! -f "$filepath" ] && continue
  basename=$(basename "$filepath")

  # Check if file is empty or only whitespace/comments
  content=$(grep -vE '^[[:space:]]*$|^[[:space:]]*--' "$filepath" 2>/dev/null | head -1 || true)
  if [ -z "$content" ]; then
    warn "$basename: Migration file appears empty (no SQL statements)"
  fi
done <<< "$FILES"
echo ""

# --- Summary ---
echo "================================"
echo "Migration Validation Summary"
echo "================================"
echo "Files checked: $FILE_COUNT"
echo "Errors: $ERRORS"
echo "Warnings: $WARNINGS"
echo ""

if [ "$ERRORS" -gt 0 ]; then
  echo -e "${RED}FAILED${NC}: $ERRORS error(s) found. Fix errors before merging."
  exit 1
fi

if [ "$WARNINGS" -gt 0 ]; then
  echo -e "${YELLOW}PASSED with warnings${NC}: Review warnings above."
  exit 0
fi

echo -e "${GREEN}PASSED${NC}: All migration checks passed."
exit 0

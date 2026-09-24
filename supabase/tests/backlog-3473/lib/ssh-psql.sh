#!/usr/bin/env bash
# A `psql` stand-in for run.sh when the NAS test stack answers SSH only
# (BACKLOG-3474 PR 2, 2026-09-24).
#
#   export KEEPR_NAS_VENUE_URL="$NAS_URL" KEEPR_NAS_SSH_HOST=<ssh alias> KEEPR_NAS_DB_CONTAINER=<db container>
#   PSQL="$PWD/supabase/tests/backlog-3473/lib/ssh-psql.sh" \
#     supabase/tests/backlog-3473/run.sh "$NAS_URL" controls
#
# run.sh is unchanged: its loopback/Tailscale host guard still sees the venue's
# real tailnet URL. This wrapper then refuses any URL other than
# KEEPR_NAS_VENUE_URL, so it can only ever reach that one container.
#
# What it does per call:
#   1. copies supabase/migrations and supabase/tests/backlog-3473 into the DB
#      container at the SAME absolute path, only when their content changed
#      (run.sh's `\i <abs path>` and `cat '<abs path>'` then resolve there);
#   2. runs psql INSIDE the container as the local `postgres` role, with every
#      argument after the URL passed through verbatim and stdin forwarded.
#
# `sync-clean` removes the copied tree from the container again.
set -euo pipefail

# The one URL this wrapper will serve. Set it to the venue's real postgres URL
# (the same value passed to run.sh); there is no default.
VENUE_URL="${KEEPR_NAS_VENUE_URL:-}"
# The SSH host alias and the DB container name, from the environment; no defaults.
SSH_HOST="${KEEPR_NAS_SSH_HOST:-}"
CONTAINER="${KEEPR_NAS_DB_CONTAINER:-}"
if [ -z "$SSH_HOST" ] || [ -z "$CONTAINER" ]; then
  echo "ssh-psql: set KEEPR_NAS_SSH_HOST and KEEPR_NAS_DB_CONTAINER" >&2
  exit 2
fi
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../../.." && pwd)"
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=8 "$SSH_HOST")
STAMP_FILE="${TMPDIR:-/tmp}/keepr-ssh-psql-$(printf '%s' "$REPO" | md5 -q 2>/dev/null || printf '%s' "$REPO" | md5sum | cut -c1-32)"

# Single-quote an argument for the remote shell.
sq() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }

if [ "${1:-}" = "sync-clean" ]; then
  "${SSH[@]}" "docker exec $CONTAINER sh -c $(sq "rm -rf $(sq "$REPO"); rmdir -p $(sq "$(dirname "$REPO")") 2>/dev/null; true")"
  rm -f "$STAMP_FILE"
  echo "ssh-psql: removed $REPO from $CONTAINER"
  exit 0
fi

url="${1:-}"; shift || true
if [ -z "$VENUE_URL" ]; then
  echo "ssh-psql: set KEEPR_NAS_VENUE_URL to the venue's postgres URL" >&2
  exit 2
fi
if [ "$url" != "$VENUE_URL" ]; then
  echo "ssh-psql: REFUSING url '$url' -- this wrapper only reaches $VENUE_URL" >&2
  exit 2
fi

# 1. sync when content changed
digest="$(cd "$REPO" && tar cf - supabase/migrations supabase/tests/backlog-3473 2>/dev/null | { md5 -q 2>/dev/null || md5sum | cut -c1-32; })"
if [ "$(cat "$STAMP_FILE" 2>/dev/null || true)" != "$digest" ]; then
  (cd "$REPO" && COPYFILE_DISABLE=1 tar --no-mac-metadata --no-xattrs -cf - supabase/migrations supabase/tests/backlog-3473) \
    | "${SSH[@]}" "docker exec -i $CONTAINER sh -c $(sq "rm -rf $(sq "$REPO/supabase") && mkdir -p $(sq "$REPO") && tar --warning=no-unknown-keyword -xf - -C $(sq "$REPO")")"
  printf '%s' "$digest" > "$STAMP_FILE"
fi

# 2. psql in the container, arguments verbatim
remote="docker exec -i $CONTAINER psql -U postgres -d postgres"
for a in "$@"; do remote+=" $(sq "$a")"; done
exec "${SSH[@]}" "$remote"

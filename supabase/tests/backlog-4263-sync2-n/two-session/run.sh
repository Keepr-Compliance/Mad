#!/bin/bash
# BACKLOG-4263 P11 two-session control: an approve whose transaction began BEFORE T-N's. DRY-RUN DATABASE ONLY; it
# refuses the hosted test project (its marker, its transport) and runs only with the dry-run marker given explicitly.
# Run on a dry-run database on 2026-11-24: pristine PASS, mutant RED.
#
# Usage:
#   T4263N_MARKER_MD5=<md5> T4263N_RUNNER=<path> run.sh <run-id> <fixture-user-id> [--mutant]
#   T4263N_MARKER_MD5=<md5> T4263N_RUNNER=<path> run.sh cleanup <run-id> <fixture-user-id>
# T4263N_MARKER_MD5 is the md5 of the id of the dry-run database's marker row (no default). The hosted test project's
# marker is refused, as an argument and inside every call (the guard refuses when that marker row exists).
# <run-id> is 16 lowercase hex characters, <fixture-user-id> a lowercase uuid4, both chosen BEFORE the run so the
# before-note can name them (openssl rand -hex 8; python3 -c 'import uuid; print(uuid.uuid4())'). T4263N_RUNNER is the
# dry-run transport wrapper, kept outside the repository: it takes one SQL file, sends it as ONE transaction and prints
# kt-sql's envelope (a RAISE -> 'kt-sql: HTTP 400'; a commit -> 'kt-sql: HTTP 200'). It must be set explicitly, and the
# hosted transport (a file named kt-sql, also through a symlink) is refused. T4263N_REPO names the repository checkout
# the migration and the rollback file are read from (default: the checkout this folder is in).
#
# What it COMMITS, in order (everything else ends in a RAISE):
#   setup     one fixture user p4263n2s-<run-id>@example.test with its organization, membership, assignment and Keepr
#             Cloud on; mcp_settings.enabled true; one registered client; one request; the view at version 1.
#   session 1 T-N (the apply file: the migration text, then its ledger row), holding its locks 6 s after the bump.
#   rollback  the rollback file (refuses while any connection holds version 2 or later).
#   teardown  the client (its requests, codes and connections go with it), the fixture user's rows by exact id, email
#             and slug, and mcp_settings.enabled and updated_at back to the values the precheck read.
# Session 2 (ends in RAISE, so its approve and any connection it made are rolled back) starts 1 s BEFORE session 1,
# waits server-side until session 1 sleeps holding EXCLUSIVE on mcp_authorization_requests, then approves the request
# that was viewed at version 1.
# Verdict (verdict.py): pristine -> PASS only when the approve answered request_invalid and no connection was made, with
# session 2's transaction start before session 1's (database clock), session 1 holding the lock when session 2 passed
# its gate, and the approve ending after session 1's hold. --mutant (T-N as it was before the expiry fix) -> RED only
# when the same approve succeeded with a connection stamped 2 (the hole). Otherwise INCONCLUSIVE / FAIL / ERROR.
# Precheck (first call, read only) refuses unless: one call = one transaction, read committed, ledger head
# 20261123140000, mcp_settings.notice_version 1, no T-N object, no pending request, no connection at version 2, no
# fixture user (by id or by the p4263n2s-* pattern), no row referencing the fixture id, no fixture client.
# Trap: if T-N is committed, the matching rollback; then the teardown; then verify.sql against the precheck's baseline
# (ledger head, ledger rows, the mcp_settings row md5, T-N objects, the mcp_ / _mcp_ / ai_app_ functions md5, the triggers
# on the three tables, auth.users and the mcp_ and organization table counts). Any difference: TEARDOWN NOT CLEAN with
# the ids, and nothing further is deleted. On SQLSTATE 40P01 (a turn-off or "disconnect all" at the same moment) nothing
# of that call is applied: the trap still runs; run again later.
# ONE RUN AT A TIME. Signals INT, TERM and HUP wait for the sessions and 8 s more, then run the trap.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
K="${T4263N_RUNNER:-}"
usage() { sed -n '6,17p' "$0"; exit 2; }
[ -n "$K" ] && [ -x "$K" ] || { echo "refusing: T4263N_RUNNER must name the dry-run transport wrapper (an executable)" >&2; usage; }
K_REAL="$(python3 -I -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$K")"
case "$(basename "$K")" in kt-sql|kt-sql.*) echo "refusing: T4263N_RUNNER is the hosted transport (${K}); this control commits T-N" >&2; exit 2 ;; esac
case "$(basename "$K_REAL")" in kt-sql|kt-sql.*) echo "refusing: T4263N_RUNNER resolves to the hosted transport (${K_REAL}); this control commits T-N" >&2; exit 2 ;; esac
MARKER="${T4263N_MARKER_MD5:-}"
[[ "$MARKER" =~ ^[0-9a-f]{32}$ ]] || { echo "refusing: T4263N_MARKER_MD5 (the dry-run database marker md5) is required; there is no default" >&2; usage; }
[ "$MARKER" = "53a38518""7695375e2e8695625a20a77a" ] && { echo "refusing: T4263N_MARKER_MD5 is the hosted test database marker" >&2; exit 2; }
CLEANUP=0
if [ "${1:-}" = cleanup ]; then CLEANUP=1; shift; fi
RUN="${1:-}"; A="${2:-}"; MUT="${3:-}"
UUID_RE='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
[[ "$RUN" =~ ^[0-9a-f]{16}$ ]] || usage
[[ "$A" =~ $UUID_RE ]] || { echo "a fixture user id (lowercase uuid) is required" >&2; usage; }
_hex="${A//-/}"; [ -z "${_hex//${_hex:0:1}/}" ] && { echo "refusing the fixture id ${A}: one repeated digit (use a fresh uuid4)" >&2; exit 2; }
case "$MUT" in ""|--mutant) ;; *) usage ;; esac
[ "$CLEANUP" = 1 ] && [ -n "$MUT" ] && usage
MODE=pristine; [ "$MUT" = --mutant ] && MODE=mutant
umask 077
tmp="$(mktemp -d)"
py() { python3 -I "$@"; }
# derived ids (fixed by the run id, so a cleanup can find them again)
O="$(py -c 'import sys,uuid; print(uuid.uuid5(uuid.NAMESPACE_URL, "p4263n2s-org-" + sys.argv[1]))' "$RUN")"
M="$(py -c 'import sys,uuid; print(uuid.uuid5(uuid.NAMESPACE_URL, "p4263n2s-member-" + sys.argv[1]))' "$RUN")"
C="kpr_c_p4263n2s${RUN:0:14}"
R="p4263n2sreq${RUN:0:11}"
send() { "$K" "$tmp/$1" > "$tmp/$2" 2>"$tmp/$2.err" || true; }
py "$here/compose.py" "$tmp/c" "$MODE" "$RUN" "$A" "$O" "$M" "$C" "$R"
cp "$tmp/c"/* "$tmp/"
echo "RUN ${RUN} (${MODE}): fixture user ${A}, email p4263n2s-${RUN}@example.test, organization ${O}, client ${C}, request ${R}"
echo "  leftovers, if this run is killed: T4263N_RUNNER=... run.sh cleanup ${RUN} ${A}"

send precheck.sql pre.out
pre="$(py "$here/verdict.py" precheck "$tmp/pre.out" "$RUN")" || {
  if [ "$CLEANUP" = 1 ]; then echo "cleanup: precheck reports: ${pre}"; else echo "$pre" >&2; rm -rf "$tmp"; exit 1; fi; }
ENABLED="${pre#*enabled=}"; ENABLED="${ENABLED%% *}"; UPDATED_AT="${pre#*updated_at=}"
if [ "$CLEANUP" = 1 ]; then
  # the values to put back are not known from a fresh precheck once setup has run; cleanup takes them from the environment
  ENABLED="${T4263N_ENABLED:?set T4263N_ENABLED to the precheck value of mcp_settings.enabled (true or false)}"
  UPDATED_AT="${T4263N_UPDATED_AT:?set T4263N_UPDATED_AT to the precheck value of mcp_settings.updated_at}"
fi
case "$ENABLED" in true|false) ;; *) echo "refusing: enabled=${ENABLED}" >&2; exit 1 ;; esac
[[ "$UPDATED_AT" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}\ [0-9:.]+[+-][0-9:]+$ ]] || { echo "refusing: updated_at=${UPDATED_AT}" >&2; exit 1; }
sed -e "s/__ENABLED__/${ENABLED}/g" -e "s/__UPDATED_AT__/${UPDATED_AT}/g" "$tmp/teardown.tpl" > "$tmp/teardown.sql"
[ "$CLEANUP" = 0 ] && echo "precheck clean: mcp_settings.enabled ${ENABLED}, updated_at ${UPDATED_AT} (put back by the teardown)"
cp "$tmp/pre.out" "$tmp/baseline.out"

VERDICT=ERROR
INTERRUPTED=0
restore() {
  local rc=0 probe md5_this md5_other
  send probe.sql probe.out
  probe="$(py "$here/verdict.py" raise T4263N_PROBE "$tmp/probe.out")" || { echo "TEARDOWN NOT CLEAN: probe unreadable (${probe}); user ${A}, run ${RUN}; nothing deleted" >&2; return 1; }
  if py -c 'import json,sys; sys.exit(0 if json.loads(sys.argv[1])["ledger_tn"] == 1 else 1)' "$probe"; then
    md5_this="$(sed -n 's/^expire_md5_this //p' "$tmp/md5s.txt")"; md5_other="$(sed -n 's/^expire_md5_other //p' "$tmp/md5s.txt")"
    if py -c 'import json,sys; sys.exit(0 if json.loads(sys.argv[1])["expire_md5"] == sys.argv[2] else 1)' "$probe" "$md5_this"; then
      send rollback.sql rollback.out
    elif py -c 'import json,sys; sys.exit(0 if json.loads(sys.argv[1])["expire_md5"] == sys.argv[2] else 1)' "$probe" "$md5_other"; then
      send rollback-other.sql rollback.out
    else
      echo "TEARDOWN NOT CLEAN: T-N is applied at an unknown trigger body (${probe}); user ${A}, run ${RUN}; nothing deleted" >&2; return 1
    fi
    grep -q 'kt-sql: HTTP 200' "$tmp/rollback.out" || { echo "TEARDOWN NOT CLEAN: the rollback did not commit: $(head -c 400 "$tmp/rollback.out"); user ${A}, run ${RUN}; nothing deleted" >&2; return 1; }
    echo "rollback committed"
  fi
  send teardown.sql teardown.out
  grep -q 'kt-sql: HTTP 200' "$tmp/teardown.out" || { echo "TEARDOWN NOT CLEAN: the teardown did not commit: $(head -c 400 "$tmp/teardown.out"); user ${A}, run ${RUN}" >&2; rc=1; }
  send verify.sql verify.out
  if [ "$CLEANUP" = 1 ]; then
    py "$here/verdict.py" raise T4263N_VERIFY "$tmp/verify.out" || rc=1
  else
    local b; b="$(py "$here/verdict.py" baseline "$tmp/baseline.out" "$tmp/verify.out")" || { echo "TEARDOWN NOT CLEAN: ${b}; user ${A}, run ${RUN}" >&2; rc=1; }
    [ "$rc" = 0 ] && echo "back to baseline: ${b}"
  fi
  return $rc
}
finish() {
  local rc=$?
  set +e
  trap - EXIT INT TERM HUP
  wait 2>/dev/null
  [ "$INTERRUPTED" = 1 ] && { echo "interrupted: waiting 8 s for the sessions before the trap's first call"; sleep 8; }
  restore || rc=1
  echo "select extensions.pg_stat_statements_reset();" > "$tmp/reset.sql"
  "$K" "$tmp/reset.sql" >/dev/null 2>&1 || echo "pg_stat_statements_reset failed" >&2
  rm -rf "$tmp"
  [ "$CLEANUP" = 1 ] && { echo "cleanup done (exit ${rc})"; exit $rc; }
  echo "${MODE}: ${VERDICT}"
  case "$MODE:$VERDICT" in pristine:PASS|mutant:RED) ;; *) rc=1 ;; esac
  exit $rc
}
trap finish EXIT
trap 'INTERRUPTED=1; exit 130' INT TERM HUP
[ "$CLEANUP" = 1 ] && exit 0

send setup.sql setup.out
grep -q 'kt-sql: HTTP 200' "$tmp/setup.out" || { echo "setup did not commit: $(head -c 400 "$tmp/setup.out")" >&2; exit 1; }
view="$(py "$here/verdict.py" commit "$tmp/setup.out" | grep '"k": "setup"' | tail -1)"
NONCE="$(py -c 'import json,sys,re; v=json.loads(sys.argv[1])["view"]; assert v.get("ok") is True and v.get("notice_version") == 1, v; n=v["nonce"]; assert re.fullmatch(r"[A-Za-z0-9_-]{43}", n); print(n)' "$view")" \
  || { echo "setup: the view did not answer version 1 with a nonce: ${view}" >&2; exit 1; }
echo "setup committed; the request was viewed at version 1"
sed -e "s/__NONCE__/${NONCE}/g" "$tmp/session2.tpl" > "$tmp/session2.sql"

( "$K" "$tmp/session2.sql" > "$tmp/s2.out" 2>"$tmp/s2.err" || true ) &
p2=$!
sleep 1
( "$K" "$tmp/session1.sql" > "$tmp/s1.out" 2>"$tmp/s1.err" || true ) &
p1=$!
wait $p2 $p1
echo "session 1 rows:"; py "$here/verdict.py" commit "$tmp/s1.out" | sed 's/^/  /' || echo "  (no committed rows: $(head -c 600 "$tmp/s1.out"))"
echo "session 2: $(head -c 900 "$tmp/s2.out")"
send state.sql state.out
echo "state: $(head -c 600 "$tmp/state.out")"
VERDICT="$(py "$here/verdict.py" case "$MODE" "$tmp/s1.out" "$tmp/s2.out" "$tmp/state.out" | tee /dev/stderr | tail -1)" || true
[ -n "$VERDICT" ] || VERDICT="ERROR: no verdict"

#!/bin/bash
# BACKLOG-3778 B1 -- offline control for register-agent.sh's sprint lookup.
#
# SR finding: `set -uo pipefail` + `trap exit_ok ERR` means a failed or
# erroring sprint lookup (curl timeout/DNS/refused, or a PostgREST error
# object) tripped the ERR trap and exited BEFORE the pm_agent_activity POST
# ran -- the agent was never registered. The fix makes the lookup immune to
# both failure shapes and, separately, clears the session's sprint marker
# when the lookup succeeds but the item carries no sprint.
#
# Fully offline: PM_SUPABASE_URL/PM_SUPABASE_KEY point at a local fake `curl`
# on PATH, not at Supabase. Nothing here reaches the network or writes a
# production row. State written under $HOME/.claude mirrors the existing
# verify-attribution.sh convention (real hook, throwaway ids, cleaned up).
#
# Usage: .claude/hooks/tests/register-agent-offline.sh

set -uo pipefail

HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_DIR="$(cd "${HOOK_DIR}/../.." && pwd)"
STAMP="$(date +%s)"
PREFIX="test-3778-${STAMP}"
PASS=0; FAIL=0

say() { printf '%s\n' "$*"; }
ok()  { PASS=$((PASS+1)); printf '  PASS  %s\n' "$*"; }
bad() { FAIL=$((FAIL+1)); printf '  FAIL  %s\n' "$*"; }
chk() { if [ "$2" = "$3" ]; then ok "$1 ($2)"; else bad "$1 -- expected [$3] got [$2]"; fi; }

FAKEBIN=$(mktemp -d)
MARKDIR=$(mktemp -d)
MAIN_SPRINT_DIR="${HOME}/.claude/metrics/main-sprint"
AGENT_TASK_DIR="${HOME}/.claude/agent-tasks"
cleanup() { rm -rf "$FAKEBIN" "$MARKDIR"; }
trap cleanup EXIT

# --- fake curl ---------------------------------------------------------
# Dispatches on the request URL. GET to pm_backlog_items answers per
# $SCENARIO; POST to pm_agent_activity always records that it was reached
# (touches a marker file) and returns success -- this is the thing B1 is
# actually about: does the hook get this far at all.
cat > "${FAKEBIN}/curl" <<'FAKECURL'
#!/bin/bash
args="$*"
if [[ "$args" == *pm_agent_activity* ]]; then
  : > "${REGISTRATION_MARKER}"
  echo '[]'
  exit 0
fi
if [[ "$args" == *pm_backlog_items* ]]; then
  case "${SCENARIO:-success_empty}" in
    timeout)        exit 28 ;;              # curl's own CURLE_OPERATION_TIMEDOUT
    conn_refused)    exit 7 ;;               # curl's own CURLE_COULDNT_CONNECT
    error_object)    echo '{"message":"invalid input syntax for type uuid"}'; exit 0 ;;
    success_empty)   echo '[]'; exit 0 ;;
    success_null)    echo '[{"sprint_id":null}]'; exit 0 ;;
    success_sprint)  echo "[{\"sprint_id\":\"${TEST_SPRINT:-sprint-x}\"}]"; exit 0 ;;
    *)               echo '[]'; exit 0 ;;
  esac
fi
echo '[]'
exit 0
FAKECURL
chmod +x "${FAKEBIN}/curl"

# NOTE on the prompt text: it includes a "fix/<legacy_id>-..." substring so
# the UNRELATED, pre-existing grep-pipeline at register-agent.sh:43 (BRANCH
# extraction) does not itself trip the ERR trap on a no-match and mask what
# this harness is actually isolating -- the sprint-lookup fix at :96-99.
# That line-43 behavior is real (confirmed via `bash -x` against this exact
# script: a prompt with no branch-pattern substring exits via the trap before
# ever reaching the code this test exercises) and is documented as a separate
# finding, not fixed here -- it is the same bug class as the line-39 LEGACY_ID
# grep the SR review already called out as pre-existing and out of scope.
run_hook() { # <scenario> <agent_id> <legacy_id> <session_id>
  local scenario="$1" agent_id="$2" legacy_id="$3" session_id="$4"
  local marker="${MARKDIR}/${agent_id}.marker"
  rm -f "$marker"
  local payload
  payload=$(jq -nc --arg a "$agent_id" --arg p "Fix round for ${legacy_id}. Branch: fix/${legacy_id}-offline-test." --arg s "$session_id" \
    '{tool_name:"Agent", tool_response:{agentId:$a},
      tool_input:{subagent_type:"engineer", description:"test", prompt:$p},
      session_id:$s}')
  PATH="${FAKEBIN}:${PATH}" \
    SCENARIO="$scenario" \
    REGISTRATION_MARKER="$marker" \
    PM_SUPABASE_URL="http://fake.invalid" PM_SUPABASE_KEY="fake-key" \
    CLAUDE_PROJECT_DIR="$REPO_DIR" \
    bash "${HOOK_DIR}/register-agent.sh" <<<"$payload" >/dev/null 2>&1
  local hook_exit=$?
  if [ -f "$marker" ]; then echo "0:$hook_exit"; else echo "1:$hook_exit"; fi
}

cleanup_marker_dirs() {
  rm -f "${AGENT_TASK_DIR}/${1}.json" "${MAIN_SPRINT_DIR}/${2}"
}

# ===========================================================================
say "CONTROL 1 -- curl timeout on the sprint lookup still reaches registration"
# ===========================================================================
A1="${PREFIX}-c1"; S1="${PREFIX}-sess1"
RESULT=$(run_hook timeout "$A1" BACKLOG-9001 "$S1")
chk "registration reached, hook exits 0" "$RESULT" "0:0"
cleanup_marker_dirs "$A1" "$S1"

# 6084ac1f5 is PR #2847's head BEFORE this fix round -- the commit that
# introduced the BACKLOG-3778 sprint lookup (and its bug) in the first place.
# origin/develop predates the lookup entirely, so diffing against it would
# make this control pass for the wrong reason (no lookup code to trip on, not
# a working fix).
say "  BREAK: same scenario against the pre-fix hook (git show 6084ac1f5, PR #2847's head before this fix round)"
OLD=$(mktemp)
if git -C "$REPO_DIR" show 6084ac1f5:.claude/hooks/register-agent.sh > "$OLD" 2>/dev/null && [ -s "$OLD" ]; then
  chmod +x "$OLD"
  A1O="${PREFIX}-c1-old"; S1O="${PREFIX}-sess1-old"
  MARKER_OLD="${MARKDIR}/${A1O}.marker"; rm -f "$MARKER_OLD"
  PAYLOAD_OLD=$(jq -nc --arg a "$A1O" --arg p "Fix round for BACKLOG-9001. Branch: fix/BACKLOG-9001-offline-test." --arg s "$S1O" \
    '{tool_name:"Agent", tool_response:{agentId:$a},
      tool_input:{subagent_type:"engineer", description:"test", prompt:$p},
      session_id:$s}')
  PATH="${FAKEBIN}:${PATH}" SCENARIO="timeout" REGISTRATION_MARKER="$MARKER_OLD" \
    PM_SUPABASE_URL="http://fake.invalid" PM_SUPABASE_KEY="fake-key" CLAUDE_PROJECT_DIR="$REPO_DIR" \
    bash "$OLD" <<<"$PAYLOAD_OLD" >/dev/null 2>&1
  if [ -f "$MARKER_OLD" ]; then
    bad "pre-fix hook ALSO reached registration under timeout -- control proves nothing"
  else
    ok "pre-fix hook did NOT reach registration under timeout -- control goes red as required"
  fi
  cleanup_marker_dirs "$A1O" "$S1O"
else
  bad "could not extract 6084ac1f5's register-agent.sh; break-control not run"
fi
rm -f "$OLD"

# ===========================================================================
say ""
say "CONTROL 2 -- connection-refused on the sprint lookup still reaches registration"
# ===========================================================================
A2="${PREFIX}-c2"; S2="${PREFIX}-sess2"
RESULT=$(run_hook conn_refused "$A2" BACKLOG-9002 "$S2")
chk "registration reached, hook exits 0" "$RESULT" "0:0"
cleanup_marker_dirs "$A2" "$S2"

# ===========================================================================
say ""
say "CONTROL 3 -- a PostgREST error object on the sprint lookup still reaches registration"
# ===========================================================================
A3="${PREFIX}-c3"; S3="${PREFIX}-sess3"
RESULT=$(run_hook error_object "$A3" BACKLOG-9003 "$S3")
chk "registration reached, hook exits 0" "$RESULT" "0:0"
cleanup_marker_dirs "$A3" "$S3"

say "  BREAK: same scenario against the pre-fix hook"
OLD=$(mktemp)
if git -C "$REPO_DIR" show 6084ac1f5:.claude/hooks/register-agent.sh > "$OLD" 2>/dev/null && [ -s "$OLD" ]; then
  chmod +x "$OLD"
  A3O="${PREFIX}-c3-old"; S3O="${PREFIX}-sess3-old"
  MARKER_OLD="${MARKDIR}/${A3O}.marker"; rm -f "$MARKER_OLD"
  PAYLOAD_OLD=$(jq -nc --arg a "$A3O" --arg p "Fix round for BACKLOG-9003. Branch: fix/BACKLOG-9003-offline-test." --arg s "$S3O" \
    '{tool_name:"Agent", tool_response:{agentId:$a},
      tool_input:{subagent_type:"engineer", description:"test", prompt:$p},
      session_id:$s}')
  PATH="${FAKEBIN}:${PATH}" SCENARIO="error_object" REGISTRATION_MARKER="$MARKER_OLD" \
    PM_SUPABASE_URL="http://fake.invalid" PM_SUPABASE_KEY="fake-key" CLAUDE_PROJECT_DIR="$REPO_DIR" \
    bash "$OLD" <<<"$PAYLOAD_OLD" >/dev/null 2>&1
  if [ -f "$MARKER_OLD" ]; then
    bad "pre-fix hook ALSO reached registration on an error object -- control proves nothing"
  else
    ok "pre-fix hook did NOT reach registration on an error object -- control goes red as required"
  fi
  cleanup_marker_dirs "$A3O" "$S3O"
else
  bad "could not extract 6084ac1f5's register-agent.sh; break-control not run"
fi
rm -f "$OLD"

# ===========================================================================
say ""
say "CONTROL 4 -- successful lookup with a sprint still writes the marker"
# ===========================================================================
A4="${PREFIX}-c4"; S4="${PREFIX}-sess4"
TEST_SPRINT="sprint-${STAMP}"
RESULT=$(TEST_SPRINT="$TEST_SPRINT" run_hook success_sprint "$A4" BACKLOG-9004 "$S4")
chk "registration reached, hook exits 0" "$RESULT" "0:0"
MARKER_CONTENT=$(cat "${MAIN_SPRINT_DIR}/${S4}" 2>/dev/null || echo "MISSING")
chk "marker written with the looked-up sprint" "$MARKER_CONTENT" "$TEST_SPRINT"
cleanup_marker_dirs "$A4" "$S4"

# ===========================================================================
say ""
say "CONTROL 5 (should-fix) -- a successful lookup with NO sprint CLEARS a stale marker"
# ===========================================================================
A5="${PREFIX}-c5"; S5="${PREFIX}-sess5"
mkdir -p "$MAIN_SPRINT_DIR"
printf 'stale-sprint-from-a-different-item' > "${MAIN_SPRINT_DIR}/${S5}"
RESULT=$(run_hook success_null "$A5" BACKLOG-9005 "$S5")
chk "registration reached, hook exits 0" "$RESULT" "0:0"
if [ -f "${MAIN_SPRINT_DIR}/${S5}" ]; then
  bad "stale marker was NOT cleared -- still reads $(cat "${MAIN_SPRINT_DIR}/${S5}")"
else
  ok "stale marker cleared when the dispatched item carries no sprint"
fi
cleanup_marker_dirs "$A5" "$S5"

say ""
say "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]

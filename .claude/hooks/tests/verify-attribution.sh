#!/bin/bash
# BACKLOG-1693 -- controls for the metrics hooks. Each one BREAKS something and
# observes the result go red; a check nobody has seen fail proves nothing.
#
# These hooks record every agent on this machine and a silent failure is
# invisible until someone queries weeks later, so verification runs the real
# scripts against real transcripts and the real RPC, then reads back the rows
# that landed. Nothing here is asserted from source.
#
# Usage:  PM_SUPABASE_URL=... PM_SUPABASE_KEY=... .claude/hooks/tests/verify-attribution.sh
#
# Rows written carry agent_id prefix "test-1693-" and are DELETED at the end.
# Re-run this after deploying the hooks: worktree copies are inert -- Claude Code
# loads hooks from the session's own project dir, so passing here is not proof
# the harness fires them.

set -uo pipefail

HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_DIR="$(cd "${HOOK_DIR}/../.." && pwd)"
STAMP="$(date +%s)"
PREFIX="test-1693-${STAMP}"
PROJECTS="${HOME}/.claude/projects/-Users-daniel-Developer-Mad"
PASS=0; FAIL=0
declare -a CREATED_IDS=()

say()  { printf '%s\n' "$*"; }
ok()   { PASS=$((PASS+1)); printf '  PASS  %s\n' "$*"; }
bad()  { FAIL=$((FAIL+1)); printf '  FAIL  %s\n' "$*"; }
chk()  { if [ "$2" = "$3" ]; then ok "$1 ($2)"; else bad "$1 -- expected [$3] got [$2]"; fi; }

[ -z "${PM_SUPABASE_URL:-}" ] || [ -z "${PM_SUPABASE_KEY:-}" ] && { say "PM_SUPABASE_URL / PM_SUPABASE_KEY required"; exit 1; }

api_get() { curl -s -m 10 "${PM_SUPABASE_URL}/rest/v1/$1" -H "apikey: ${PM_SUPABASE_KEY}" -H "Authorization: Bearer ${PM_SUPABASE_KEY}"; }

# ---------------------------------------------------------------------------
# Fixtures: REAL transcripts, chosen by what they contain, never synthesised.
#   TA, TB -- briefs naming two DIFFERENT backlog items
#   TC     -- a brief naming none, so the only possible label is the stale file
# ---------------------------------------------------------------------------
pick_transcripts() {
  TA=""; TB=""; TC=""; LA=""; LB=""
  local t p b
  for t in $(ls -t "$PROJECTS"/*/subagents/*.jsonl 2>/dev/null | head -60); do
    p=$(jq -rs '[.[] | select(.type=="user") | .message.content] | first
                | if .==null then "" elif type=="string" then . else ([.[]|.text? // ""]|join(" ")) end' "$t" 2>/dev/null)
    [ "$(jq -rs '[.[]|select(.message.usage!=null)]|length' "$t" 2>/dev/null)" = "0" ] && continue
    b=$(grep -oE 'BACKLOG-[0-9]+' <<<"$p" 2>/dev/null | head -1)
    if [ -n "$b" ]; then
      if [ -z "$TA" ]; then TA="$t"; LA="$b"
      elif [ -z "$TB" ] && [ "$b" != "$LA" ]; then TB="$t"; LB="$b"; fi
    elif [ -z "$TC" ]; then TC="$t"; fi
    [ -n "$TA" ] && [ -n "$TB" ] && [ -n "$TC" ] && break
  done
}
pick_transcripts
[ -z "$TA" ] || [ -z "$TB" ] || [ -z "$TC" ] && { say "could not find the three transcripts this needs"; exit 1; }

# A third, unrelated item plays the contaminant in .current-task.
POISON=$(api_get "pm_backlog_items?select=legacy_id&deleted_at=is.null&legacy_id=neq.${LA}&legacy_id=neq.${LB}&legacy_id=like.BACKLOG-*&order=item_number.desc&limit=1" | jq -r '.[0].legacy_id // ""')
[ -z "$POISON" ] && { say "no contaminant item found"; exit 1; }

say "fixtures"
say "  A: $(basename "$TA")  brief=$LA"
say "  B: $(basename "$TB")  brief=$LB"
say "  C: $(basename "$TC")  brief=<none>"
say "  .current-task contaminant: $POISON"
say ""

# A real SubagentStop payload, captured from ~/.claude/logs/hook-debug.log, with
# only the identity fields substituted. Falls back to a transcription of the
# 2026-08-11 shape if no log is present.
TEMPLATE=$(grep '\[HOOK INPUT\]' "${HOME}/.claude/logs/hook-debug.log" 2>/dev/null | tail -1 | sed 's/^\[HOOK INPUT\] //')
jq -e . >/dev/null 2>&1 <<<"$TEMPLATE" || TEMPLATE='{"session_id":"","transcript_path":"","cwd":"","permission_mode":"auto","agent_id":"","agent_type":"","hook_event_name":"SubagentStop","stop_hook_active":false,"agent_transcript_path":"","background_tasks":[]}'

payload() { # <agent_id> <transcript> <siblings 0|1>
  jq -c --arg a "$1" --arg t "$2" --arg s "${PREFIX}-session" --argjson sib "$3" '
    .agent_id=$a | .agent_transcript_path=$t | .session_id=$s | .transcript_path=$t
    | .hook_event_name="SubagentStop"
    | .background_tasks = (if $sib > 0
        then [{id:"sibling-x",type:"subagent",status:"running",description:"concurrent agent",agent_type:"engineer"}]
        else [] end)' <<<"$TEMPLATE"
}

TESTROOT=$(mktemp -d)
mkdir -p "${TESTROOT}/.claude/metrics"
set_current_task() { printf '{"task_id": "%s", "agent_type": "pm", "description": "contaminant"}' "$1" > "${TESTROOT}/.claude/.current-task"; }
sidecar() { mkdir -p "${HOME}/.claude/agent-tasks"; jq -n --arg a "$1" --arg l "$2" \
  '{agent_id:$a, agent_type:"engineer", legacy_id:$l, description:"control", session_id:"x", spawned_at:"2026-01-01T00:00:00Z"}' \
  > "${HOME}/.claude/agent-tasks/$1.json"; }

run_hook() { CLAUDE_PROJECT_DIR="$TESTROOT" "$@" >/dev/null 2>&1; echo $?; }

# label_of <agent_id> -- the legacy_id reached by JOINING backlog_item_id to
# pm_backlog_items. Not the text column: a string there proves nothing.
label_of() {
  api_get "pm_token_metrics?agent_id=eq.$1&select=backlog_item_id,pm_backlog_items(legacy_id)" \
    | jq -r '.[0].pm_backlog_items.legacy_id // "UNLABELLED"'
}
model_of() { api_get "pm_token_metrics?agent_id=eq.$1&select=model" | jq -r '.[0].model // "NULL"'; }
billable_of() { api_get "pm_token_metrics?agent_id=eq.$1&select=billable_tokens" | jq -r '.[0].billable_tokens // 0'; }

# ===========================================================================
say "CONTROL 1 -- two agents running concurrently get distinct, correct labels"
# ===========================================================================
set_current_task "$POISON"
A1="${PREFIX}-c1a"; B1="${PREFIX}-c1b"
sidecar "$A1" "$LA"; sidecar "$B1" "$LB"
CREATED_IDS+=("$A1" "$B1")

CLAUDE_PROJECT_DIR="$TESTROOT" "${HOOK_DIR}/track-agent-tokens.sh" >/dev/null 2>&1 <<<"$(payload "$A1" "$TA" 1)" &
P1=$!
CLAUDE_PROJECT_DIR="$TESTROOT" "${HOOK_DIR}/track-agent-tokens.sh" >/dev/null 2>&1 <<<"$(payload "$B1" "$TB" 1)" &
P2=$!
wait $P1; wait $P2

chk "agent A labelled $LA"  "$(label_of "$A1")" "$LA"
chk "agent B labelled $LB"  "$(label_of "$B1")" "$LB"

say "  BREAK: same two payloads through the pre-fix hook (shared-file read)"
OLD=$(mktemp); git -C "$REPO_DIR" show "$(git -C "$REPO_DIR" merge-base HEAD origin/int/email-retention 2>/dev/null || echo HEAD~2):.claude/hooks/track-agent-tokens.sh" > "$OLD" 2>/dev/null && chmod +x "$OLD"
if [ -s "$OLD" ]; then
  A1O="${PREFIX}-c1a-old"; B1O="${PREFIX}-c1b-old"; CREATED_IDS+=("$A1O" "$B1O")
  CLAUDE_PROJECT_DIR="$TESTROOT" "$OLD" >/dev/null 2>&1 <<<"$(payload "$A1O" "$TA" 1)"
  CLAUDE_PROJECT_DIR="$TESTROOT" "$OLD" >/dev/null 2>&1 <<<"$(payload "$B1O" "$TB" 1)"
  OA=$(api_get "pm_token_metrics?agent_id=eq.${A1O}&select=task_id" | jq -r '.[0].task_id // "NULL"')
  OB=$(api_get "pm_token_metrics?agent_id=eq.${B1O}&select=task_id" | jq -r '.[0].task_id // "NULL"')
  if [ "$OA" = "$OB" ] && [ "$OA" = "$POISON" ]; then
    ok "old hook cross-stamps both agents as $POISON -- control goes red as required"
  else
    bad "old hook did NOT reproduce cross-stamping (A=$OA B=$OB) -- this control proves nothing"
  fi
else
  bad "could not extract the pre-fix hook; break-control not run"
fi

# ===========================================================================
say ""
say "CONTROL 2 -- a stale .current-task does not contaminate a new run"
# ===========================================================================
C2="${PREFIX}-c2-stale"; CREATED_IDS+=("$C2")
set_current_task "$POISON"
touch -t 202601010000 "${TESTROOT}/.claude/.current-task"   # written long before this run
rm -f "${HOME}/.claude/agent-tasks/${C2}.json"
CLAUDE_PROJECT_DIR="$TESTROOT" "${HOOK_DIR}/track-agent-tokens.sh" >/dev/null 2>&1 <<<"$(payload "$C2" "$TC" 0)"
chk "stale file ignored, row unlabelled" "$(label_of "$C2")" "UNLABELLED"

say "  BREAK: same run, file written just before it started"
# The mtime comes from the transcript's OWN first timestamp, because that is
# what production does: the PM writes .current-task seconds before spawning.
# Touching the file at wall-clock "now" would sit hours outside a replayed
# run's window and the gate would refuse it for the right reason -- which would
# make this control mute rather than green.
C2F="${PREFIX}-c2-fresh"; CREATED_IDS+=("$C2F")
set_current_task "$POISON"
C_START=$(jq -rs '[.[].timestamp // empty] | sort | first' "$TC" 2>/dev/null)
touch -d "$C_START" "${TESTROOT}/.claude/.current-task" 2>/dev/null \
  || touch -d "${C_START%%.*}Z" "${TESTROOT}/.claude/.current-task" 2>/dev/null
rm -f "${HOME}/.claude/agent-tasks/${C2F}.json"
CLAUDE_PROJECT_DIR="$TESTROOT" "${HOOK_DIR}/track-agent-tokens.sh" >/dev/null 2>&1 <<<"$(payload "$C2F" "$TC" 0)"
L=$(label_of "$C2F")
if [ "$L" = "$POISON" ]; then
  ok "fresh + solo file IS used ($POISON) -- the gate discriminates on staleness, not on being disabled"
else
  bad "fresh file was ignored too (got $L) -- control 2 would pass even with the fallback dead"
fi

say "  BREAK: same fresh file, but a sibling subagent is running"
C2S="${PREFIX}-c2-sibling"; CREATED_IDS+=("$C2S")
set_current_task "$POISON"
touch -d "$C_START" "${TESTROOT}/.claude/.current-task" 2>/dev/null \
  || touch -d "${C_START%%.*}Z" "${TESTROOT}/.claude/.current-task" 2>/dev/null
rm -f "${HOME}/.claude/agent-tasks/${C2S}.json"
CLAUDE_PROJECT_DIR="$TESTROOT" "${HOOK_DIR}/track-agent-tokens.sh" >/dev/null 2>&1 <<<"$(payload "$C2S" "$TC" 1)"
chk "concurrency alone disqualifies the shared file" "$(label_of "$C2S")" "UNLABELLED"

# ===========================================================================
say ""
say "CONTROL 3 -- backlog_item_id is a uuid that RESOLVES to a real item"
# ===========================================================================
J=$(api_get "pm_token_metrics?agent_id=eq.${A1}&select=backlog_item_id,pm_backlog_items!inner(id,legacy_id,title)")
UUID=$(jq -r '.[0].backlog_item_id // ""' <<<"$J")
JOINED=$(jq -r '.[0].pm_backlog_items.id // ""' <<<"$J")
if [ -n "$UUID" ] && [ "$UUID" = "$JOINED" ]; then
  ok "inner join to pm_backlog_items returns the row: $UUID = $(jq -r '.[0].pm_backlog_items.legacy_id' <<<"$J")"
else
  bad "backlog_item_id did not resolve through an inner join (uuid=$UUID)"
fi
BADROWS=$(api_get "pm_token_metrics?agent_id=like.${PREFIX}*&backlog_item_id=not.is.null&select=agent_id,backlog_item_id" | jq -r 'length')
chk "no test row carries an unresolvable backlog_item_id" \
    "$(api_get "pm_token_metrics?agent_id=like.${PREFIX}*&backlog_item_id=not.is.null&select=agent_id,pm_backlog_items!left(id)" | jq -r '[.[]|select(.pm_backlog_items==null)]|length')" "0"

# ===========================================================================
say ""
say "CONTROL 4 -- model is a real identifier, never \"unknown\""
# ===========================================================================
M=$(model_of "$A1")
if [ -n "$M" ] && [ "$M" != "unknown" ] && [ "$M" != "NULL" ] && [ "$M" != "<synthetic>" ]; then
  ok "recorded model = $M"
else
  bad "model = $M"
fi
ADV=$(jq -rs '[.[]|.advisorModel // empty]|unique|first // ""' "$TA" 2>/dev/null)
[ -n "$ADV" ] && [ "$M" = "$ADV" ] && bad "recorded the ADVISOR model ($ADV), not the worker's"
say "  BREAK: the pre-fix extraction on the same transcript"
OLDM=$(jq -r '[.message.model // empty] | first // "unknown"' "$TA" 2>/dev/null | head -1)
if [ "$OLDM" = "unknown" ]; then
  ok "old jq yields \"unknown\" on this very transcript -- the bug is reproduced, not assumed"
else
  bad "old extraction returned [$OLDM]; this control did not go red"
fi

# ===========================================================================
say ""
say "CONTROL 5 -- a failing hook does not fail the agent run (exit 0 always)"
# ===========================================================================
LONE=$(mktemp -d); cp "${HOOK_DIR}/track-agent-tokens.sh" "$LONE/"; chmod +x "$LONE/track-agent-tokens.sh"
chk "garbage on stdin"          "$(echo 'not json at all' | run_hook "${HOOK_DIR}/track-agent-tokens.sh")" "0"
chk "empty stdin"               "$(printf '' | run_hook "${HOOK_DIR}/track-agent-tokens.sh")" "0"
chk "transcript missing"        "$(payload "${PREFIX}-c5" /nonexistent/x.jsonl 0 | run_hook "${HOOK_DIR}/track-agent-tokens.sh")" "0"
chk "shared lib missing"        "$(payload "${PREFIX}-c5" "$TA" 0 | run_hook "$LONE/track-agent-tokens.sh")" "0"
chk "jq unavailable"            "$(payload "${PREFIX}-c5" "$TA" 0 | PATH=/nonexistent run_hook "${HOOK_DIR}/track-agent-tokens.sh")" "0"
C5N="${PREFIX}-c5-net"; CREATED_IDS+=("$C5N")
chk "supabase unreachable"      "$(payload "$C5N" "$TA" 0 | PM_SUPABASE_URL=http://127.0.0.1:9 run_hook "${HOOK_DIR}/track-agent-tokens.sh")" "0"
chk "main hook: garbage stdin"  "$(echo '}{' | run_hook "${HOOK_DIR}/track-main-session.sh")" "0"
chk "main hook: no transcript"  "$(echo '{"session_id":"x","transcript_path":"/nope"}' | run_hook "${HOOK_DIR}/track-main-session.sh")" "0"
rm -rf "$LONE"

# ===========================================================================
say ""
say "CONTROL 6 -- main-session Stop hook records a DELTA, not the whole file"
# ===========================================================================
MAIN=$(ls -t "$PROJECTS"/*.jsonl 2>/dev/null | head -1)
if [ -n "$MAIN" ] && [ -f "$MAIN" ]; then
  MSESS="${PREFIX}-main"
  OFF="${HOME}/.claude/metrics/main-offsets/${MSESS}.offset"
  mkdir -p "$(dirname "$OFF")"
  LINES=$(wc -l < "$MAIN" | tr -d ' ')
  echo $((LINES - 40)) > "$OFF"          # pretend all but the last 40 lines are billed
  MID="main:${MSESS}:${LINES}"; CREATED_IDS+=("$MID")
  CLAUDE_PROJECT_DIR="$TESTROOT" "${HOOK_DIR}/track-main-session.sh" >/dev/null 2>&1 \
    <<<"$(jq -nc --arg s "$MSESS" --arg t "$MAIN" '{session_id:$s,transcript_path:$t,cwd:"'"$TESTROOT"'",hook_event_name:"Stop",stop_hook_active:false,background_tasks:[]}')"
  DELTA=$(billable_of "$MID")
  WHOLE=$(jq -rs '[.[]|select(.message.usage!=null)|(.message.usage.input_tokens//0)+(.message.usage.output_tokens//0)+(.message.usage.cache_creation_input_tokens//0)]|add // 0' "$MAIN")
  if [ "$DELTA" -gt 0 ] 2>/dev/null && [ "$DELTA" -lt "$WHOLE" ] 2>/dev/null; then
    ok "delta row = ${DELTA} billable over the last 40 lines, whole file = ${WHOLE}"
  else
    bad "delta=${DELTA} whole=${WHOLE} -- the offset window is not being honoured"
  fi
  say "  BREAK: fire again with no new lines"
  BEFORE=$(api_get "pm_token_metrics?agent_id=like.main:${MSESS}*&select=agent_id" | jq -r 'length')
  CLAUDE_PROJECT_DIR="$TESTROOT" "${HOOK_DIR}/track-main-session.sh" >/dev/null 2>&1 \
    <<<"$(jq -nc --arg s "$MSESS" --arg t "$MAIN" '{session_id:$s,transcript_path:$t,cwd:".",hook_event_name:"Stop",stop_hook_active:false,background_tasks:[]}')"
  AFTER=$(api_get "pm_token_metrics?agent_id=like.main:${MSESS}*&select=agent_id" | jq -r 'length')
  chk "repeat fire writes nothing (no double count)" "$AFTER" "$BEFORE"
  MM=$(model_of "$MID"); [ "$MM" != "unknown" ] && [ "$MM" != "NULL" ] && ok "main row model = $MM" || bad "main row model = $MM"
  rm -f "$OFF"
else
  bad "no main-session transcript found"
fi

# ===========================================================================
say ""
say "CLEANUP -- removing test rows"
# ===========================================================================
for id in "${CREATED_IDS[@]}"; do
  curl -s -o /dev/null -X DELETE "${PM_SUPABASE_URL}/rest/v1/pm_token_metrics?agent_id=eq.${id}" \
    -H "apikey: ${PM_SUPABASE_KEY}" -H "Authorization: Bearer ${PM_SUPABASE_KEY}"
  rm -f "${HOME}/.claude/agent-tasks/${id}.json"
done
LEFT=$(api_get "pm_token_metrics?agent_id=like.test-1693-*&select=agent_id" | jq -r 'length')
LEFTM=$(api_get "pm_token_metrics?agent_id=like.main:test-1693-*&select=agent_id" | jq -r 'length')
chk "no test rows left behind" "$((LEFT + LEFTM))" "0"
rm -rf "$TESTROOT" "$OLD"

say ""
say "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]

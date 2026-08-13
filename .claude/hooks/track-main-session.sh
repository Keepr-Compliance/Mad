#!/bin/bash
# Stop -- record what the MAIN session spent on this turn.
#
# BACKLOG-1693, requirement 4. Only SubagentStop was wired, so every token the
# main session spent -- planning, reviewing, triaging, all the PM work between
# agent spawns -- was recorded nowhere. It is a blind spot of unknown size, and
# a cost model built on subagent rows alone silently understates every item.
#
# DELTA, not total. The session transcript is cumulative: re-summing it on every
# turn would multiply a session's cost by its number of turns. This hook stores
# how many lines it has already accounted for and reads only what is new.
#
# One row per turn, agent_id "main:<session>:<line offset>". The offset makes the
# id unique per turn and idempotent under the RPC's
# ON CONFLICT (agent_id, session_id) DO NOTHING -- a duplicate fire for the same
# turn is a no-op rather than a double count.
#
# NON-BLOCKING BY DESIGN: every failure path still exits 0, silently.

set -uo pipefail
exit_ok() { exit 0; }
trap exit_ok ERR

INPUT=$(cat 2>/dev/null) || exit 0
[ -z "$INPUT" ] && exit 0
command -v jq >/dev/null 2>&1 || exit 0

HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" || exit 0
# shellcheck source=/dev/null
. "${HOOK_DIR}/agent-identity.sh" 2>/dev/null || exit 0

LOG_DIR="${HOME}/.claude/logs"; mkdir -p "$LOG_DIR" 2>/dev/null
DEBUG_LOG="${LOG_DIR}/hook-debug.log"

# A Stop hook that re-triggers itself would loop forever.
[ "$(jq -r '.stop_hook_active // false' <<<"$INPUT" 2>/dev/null)" = "true" ] && exit 0

SESSION_ID=$(jq -r '.session_id // ""' <<<"$INPUT" 2>/dev/null)
TRANSCRIPT=$(jq -r '.transcript_path // ""' <<<"$INPUT" 2>/dev/null)
[ -z "$SESSION_ID" ] && exit 0
[ -z "$TRANSCRIPT" ] || [ ! -f "$TRANSCRIPT" ] && exit 0

# ---------------------------------------------------------------------------
# How much of this transcript has already been billed?
# ---------------------------------------------------------------------------
OFFSET_DIR="${HOME}/.claude/metrics/main-offsets"
mkdir -p "$OFFSET_DIR" 2>/dev/null || exit 0
OFFSET_FILE="${OFFSET_DIR}/${SESSION_ID}.offset"

CURRENT_LINES=$(wc -l < "$TRANSCRIPT" 2>/dev/null | tr -d ' ')
[ -z "$CURRENT_LINES" ] && exit 0

PREV_LINES=0
if [ -f "$OFFSET_FILE" ]; then
  PREV_LINES=$(tr -dc '0-9' < "$OFFSET_FILE" 2>/dev/null)
  [ -z "$PREV_LINES" ] && PREV_LINES=0
fi

# Transcript shrank -- resumed, compacted or rewritten. Resetting to 0 would
# re-bill the whole session, so take the honest loss of this window instead.
if [ "$PREV_LINES" -gt "$CURRENT_LINES" ] 2>/dev/null; then
  echo "$CURRENT_LINES" > "$OFFSET_FILE" 2>/dev/null
  echo "[MAIN] offset reset: stored=$PREV_LINES > lines=$CURRENT_LINES session=$SESSION_ID (window skipped)" >> "$DEBUG_LOG"
  exit 0
fi
[ "$PREV_LINES" -eq "$CURRENT_LINES" ] 2>/dev/null && exit 0

# ---------------------------------------------------------------------------
# This turn's spend
# ---------------------------------------------------------------------------
STATS=$(transcript_stats "$TRANSCRIPT" $((PREV_LINES + 1)))
API_CALLS=$(jq -r '.api_calls // 0' <<<"$STATS" 2>/dev/null); [ -z "$API_CALLS" ] && API_CALLS=0

# New lines but no model turns (tool results only) -- advance and wait.
if [ "$API_CALLS" -eq 0 ] 2>/dev/null; then
  echo "$CURRENT_LINES" > "$OFFSET_FILE" 2>/dev/null
  exit 0
fi

IN=$(jq -r '.total_input // 0' <<<"$STATS"); OUT=$(jq -r '.total_output // 0' <<<"$STATS")
CR=$(jq -r '.total_cache_read // 0' <<<"$STATS"); CC=$(jq -r '.total_cache_create // 0' <<<"$STATS")
START_TS=$(jq -r '.start // empty' <<<"$STATS"); END_TS=$(jq -r '.end // empty' <<<"$STATS")

TOTAL=$((IN + OUT + CR + CC))
BILLABLE=$((IN + OUT + CC))

START_EPOCH=$(iso_to_epoch "$START_TS"); END_EPOCH=$(iso_to_epoch "$END_TS")
if [ -n "$START_EPOCH" ] && [ -n "$END_EPOCH" ] && [ "$END_EPOCH" -ge "$START_EPOCH" ] 2>/dev/null; then
  DURATION_SECS=$((END_EPOCH - START_EPOCH))
else
  DURATION_SECS=0
fi

# The model that did the work. In a main session the advisor runs a different
# model against the same transcript -- 1,314 of 3,104 usage entries in the
# sampled session -- so the modal non-advisor model is what gets named. Its
# tokens are still counted: advisor spend is real spend.
MODEL=$(transcript_model "$TRANSCRIPT")

# ---------------------------------------------------------------------------
# Identity. Same hard gate as the subagent hook: the shared file is only
# trustworthy when nothing else is running and it was written for this window.
# Otherwise the row stands as unlabelled main-session cost, which is still the
# thing that was missing.
# ---------------------------------------------------------------------------
LEGACY_ID=""
CURRENT_TASK_FILE="${CLAUDE_PROJECT_DIR:-$(jq -r '.cwd // "."' <<<"$INPUT" 2>/dev/null)}/.claude/.current-task"
SIBLINGS=$(jq -r '[ .background_tasks[]? | select(.type == "subagent") ] | length' <<<"$INPUT" 2>/dev/null || echo 0)
[ -z "$SIBLINGS" ] && SIBLINGS=0
MTIME=$(file_mtime "$CURRENT_TASK_FILE")
if [ "$SIBLINGS" -eq 0 ] 2>/dev/null && [ -n "$MTIME" ] && [ -n "$START_EPOCH" ] && [ -n "$END_EPOCH" ] \
   && [ "$MTIME" -ge $((START_EPOCH - 300)) ] && [ "$MTIME" -le $((END_EPOCH + 60)) ]; then
  LEGACY_ID=$(jq -r '.task_id // ""' "$CURRENT_TASK_FILE" 2>/dev/null)
fi

load_supabase_creds || { echo "$CURRENT_LINES" > "$OFFSET_FILE" 2>/dev/null; exit 0; }

BACKLOG_ITEM_ID=""; SPRINT_ID=""
if [ -n "$LEGACY_ID" ]; then
  read -r BACKLOG_ITEM_ID SPRINT_ID <<<"$(resolve_item_uuid "$LEGACY_ID")"
fi
BACKLOG_ITEM_ID=$(uuid_or_empty "$BACKLOG_ITEM_ID")
SPRINT_ID=$(uuid_or_empty "$SPRINT_ID")

AGENT_ID="main:${SESSION_ID}:${CURRENT_LINES}"

PAYLOAD=$(jq -n \
  --arg agent_id "$AGENT_ID" \
  --arg task_id "$LEGACY_ID" \
  --arg sprint_id "$SPRINT_ID" \
  --arg backlog_item_id "$BACKLOG_ITEM_ID" \
  --argjson input "$IN" --argjson output "$OUT" \
  --argjson cache_read "$CR" --argjson cache_create "$CC" \
  --argjson total "$TOTAL" --argjson duration_ms "$((DURATION_SECS * 1000))" \
  --argjson api_calls "$API_CALLS" \
  --arg session_id "$SESSION_ID" --arg model "$MODEL" \
  '{
     p_agent_id: $agent_id,
     p_agent_type: "main",
     p_task_id: (if $task_id == "" then null else $task_id end),
     p_description: "main session turn",
     p_sprint_id: (if $sprint_id == "" then null else $sprint_id end),
     p_backlog_item_id: (if $backlog_item_id == "" then null else $backlog_item_id end),
     p_input_tokens: $input, p_output_tokens: $output,
     p_cache_read: $cache_read, p_cache_create: $cache_create,
     p_total_tokens: $total, p_duration_ms: $duration_ms, p_api_calls: $api_calls,
     p_session_id: $session_id,
     p_model: (if $model == "" then null else $model end)
   }' 2>/dev/null) || exit 0

STATUS=$(post_metrics "$PAYLOAD" "$DEBUG_LOG")

# Advance only on a confirmed write. A failed push leaves the window unbilled so
# the next turn picks it up, rather than losing it -- at worst the following row
# is wider, never narrower.
if [ "$STATUS" = "200" ] || [ "$STATUS" = "201" ]; then
  echo "$CURRENT_LINES" > "$OFFSET_FILE" 2>/dev/null
  echo "[MAIN] OK ($STATUS): $BILLABLE billable over $((CURRENT_LINES - PREV_LINES)) lines, task=${LEGACY_ID:-unlabelled} model=${MODEL:-null} agent=$AGENT_ID" >> "$DEBUG_LOG"

  METRICS_FILE="${CLAUDE_PROJECT_DIR:-.}/.claude/metrics/tokens.csv"
  if [ -f "$METRICS_FILE" ]; then
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ),${SESSION_ID},${AGENT_ID},main,${LEGACY_ID},,${IN},${OUT},${CR},${CC},${BILLABLE},${TOTAL},${API_CALLS},${DURATION_SECS},${START_TS},${END_TS}" >> "$METRICS_FILE"
  fi
else
  echo "[MAIN] push failed ($STATUS) -- offset held at $PREV_LINES, window will be retried" >> "$DEBUG_LOG"
fi

exit 0

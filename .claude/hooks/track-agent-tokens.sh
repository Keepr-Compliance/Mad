#!/bin/bash
# SubagentStop -- record what a subagent spent, and WHOSE work it was.
#
# PRIMARY: Supabase pm_token_metrics (via pm_log_agent_metrics RPC)
# BACKUP:  .claude/metrics/tokens.csv (append-only, never queried in workflow)
#
# BACKLOG-1693. Task identity used to be re-read here from .claude/.current-task
# -- one shared file, mutated by whoever spawned the most recent agent. With a
# fleet running concurrently that file names some other agent's item by the time
# this hook fires. Measured on 2026-08-11: five consecutive agents stamped
# BACKLOG-2617 while the file already read BACKLOG-2628; one item accumulated
# 262 runs and 104M tokens over nine days; 19.2% of labelled rows were recorded
# outside their item's lifetime.
#
# Identity is now bound to agent_id at spawn (register-agent.sh) and resolved
# here by that key. Resolution order, first hit wins:
#
#   1. sidecar  ~/.claude/agent-tasks/<agent_id>.json   -- written at spawn
#   2. this agent's own transcript: first BACKLOG-nnnn in its brief
#   3. pm_agent_activity row for this agent_id
#   4. .claude/.current-task -- ONLY when no sibling subagent is running AND the
#      file was written inside this run's window
#   5. nothing. An unlabelled row is recoverable; a wrongly-labelled one is not.
#
# Path 2 exists because for a FOREGROUND Agent call PostToolUse fires at tool
# completion, i.e. after this hook -- the sidecar does not exist yet.
#
# NON-BLOCKING BY DESIGN: every failure path still exits 0.

LOG_DIR="${HOME}/.claude/logs"
mkdir -p "$LOG_DIR" 2>/dev/null
DEBUG_LOG="${LOG_DIR}/hook-debug.log"

echo "[HOOK FIRED] $(date)" >> "$DEBUG_LOG"

INPUT=$(cat)
echo "[HOOK INPUT] $INPUT" >> "$DEBUG_LOG"

command -v jq >/dev/null 2>&1 || { echo '{"decision": "allow"}'; exit 0; }

HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
. "${HOOK_DIR}/agent-identity.sh" 2>/dev/null || { echo '{"decision": "allow"}'; exit 0; }

SESSION_ID=$(jq -r '.session_id // ""' <<<"$INPUT")
AGENT_ID=$(jq -r '.agent_id // ""' <<<"$INPUT")
# agent_transcript_path is the SUBAGENT's own transcript; transcript_path is the
# parent session's and would count the whole fleet's spend against one agent.
TRANSCRIPT_PATH=$(jq -r '.agent_transcript_path // .transcript_path // ""' <<<"$INPUT")

METRICS_FILE="${CLAUDE_PROJECT_DIR:-.}/.claude/metrics/tokens.csv"
mkdir -p "$(dirname "$METRICS_FILE")" 2>/dev/null
if [ ! -f "$METRICS_FILE" ]; then
  echo "timestamp,session_id,agent_id,agent_type,task_id,description,input_tokens,output_tokens,cache_read,cache_create,billable_tokens,total_tokens,api_calls,duration_secs,started_at,ended_at" > "$METRICS_FILE"
fi

if [ -z "$TRANSCRIPT_PATH" ] || [ ! -f "$TRANSCRIPT_PATH" ]; then
  echo "[HOOK] No transcript at: $TRANSCRIPT_PATH" >> "$DEBUG_LOG"
  echo '{"decision": "allow"}'
  exit 0
fi

# ============================================================
# Tokens, timing, model
# ============================================================
STATS=$(transcript_stats "$TRANSCRIPT_PATH")

TOTAL_INPUT=$(jq -r '.total_input // 0' <<<"$STATS")
TOTAL_OUTPUT=$(jq -r '.total_output // 0' <<<"$STATS")
TOTAL_CACHE_READ=$(jq -r '.total_cache_read // 0' <<<"$STATS")
TOTAL_CACHE_CREATE=$(jq -r '.total_cache_create // 0' <<<"$STATS")
API_CALLS=$(jq -r '.api_calls // 0' <<<"$STATS")
START_TS=$(jq -r '.start // empty' <<<"$STATS")
END_TS=$(jq -r '.end // empty' <<<"$STATS")

TOTAL_TOKENS=$((TOTAL_INPUT + TOTAL_OUTPUT + TOTAL_CACHE_READ + TOTAL_CACHE_CREATE))
BILLABLE_TOKENS=$((TOTAL_INPUT + TOTAL_OUTPUT + TOTAL_CACHE_CREATE))

START_EPOCH=$(iso_to_epoch "$START_TS")
END_EPOCH=$(iso_to_epoch "$END_TS")
if [ -n "$START_EPOCH" ] && [ -n "$END_EPOCH" ] && [ "$END_EPOCH" -ge "$START_EPOCH" ] 2>/dev/null; then
  DURATION_SECS=$((END_EPOCH - START_EPOCH))
else
  DURATION_SECS=0
fi
DURATION_MS=$((DURATION_SECS * 1000))
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Real model or empty -- never the literal "unknown" that 1,725 rows carry.
MODEL=$(transcript_model "$TRANSCRIPT_PATH")

# ============================================================
# Identity, keyed on agent_id
# ============================================================
LEGACY_ID=""; AGENT_TYPE=""; DESCRIPTION=""; ID_SOURCE="none"

# --- 1. sidecar written at spawn, keyed by this agent's own id ---
SIDECAR="${AGENT_TASK_DIR}/${AGENT_ID}.json"
if [ -n "$AGENT_ID" ] && [ -f "$SIDECAR" ]; then
  LEGACY_ID=$(jq -r '.legacy_id // ""' "$SIDECAR" 2>/dev/null)
  AGENT_TYPE=$(jq -r '.agent_type // ""' "$SIDECAR" 2>/dev/null)
  DESCRIPTION=$(jq -r '.description // ""' "$SIDECAR" 2>/dev/null)
  [ -n "$LEGACY_ID" ] && ID_SOURCE="sidecar"
fi

# --- 2. the agent's own brief ---
if [ -z "$LEGACY_ID" ]; then
  PROMPT_TEXT=$(jq -rs '
    [ .[] | select(.type == "user") | .message.content ] | first
    | if . == null then "" elif type == "string" then .
      elif type == "array" then ([ .[] | .text? // "" ] | join(" "))
      else "" end
  ' "$TRANSCRIPT_PATH" 2>/dev/null)
  CANDIDATE=$(grep -oE 'BACKLOG-[0-9]+' <<<"$PROMPT_TEXT" 2>/dev/null | head -1)
  if [ -n "$CANDIDATE" ]; then
    LEGACY_ID="$CANDIDATE"
    ID_SOURCE="transcript"
  fi
fi

# agent_type is on the transcript's assistant entries whether or not the
# sidecar exists. Never taken from .current-task -- that field cross-stamps too.
if [ -z "$AGENT_TYPE" ]; then
  AGENT_TYPE=$(jq -rs '[ .[] | .attributionAgent // empty ] | first // empty' "$TRANSCRIPT_PATH" 2>/dev/null)
fi

load_supabase_creds || echo "[HOOK] WARNING: PM_SUPABASE_URL/KEY unset -- Supabase push skipped" >> "$DEBUG_LOG"

# --- 3. registry row for this agent_id ---
if [ -z "$LEGACY_ID" ] && [ -n "$AGENT_ID" ] && [ -n "${SUPABASE_URL:-}" ]; then
  REG=$(curl -s -m 5 \
    "${SUPABASE_URL}/rest/v1/pm_agent_activity?agent_id=eq.${AGENT_ID}&select=legacy_id,agent_type,description&limit=1" \
    -H "apikey: ${SUPABASE_KEY}" -H "Authorization: Bearer ${SUPABASE_KEY}" 2>/dev/null) || REG=""
  if [ -n "$REG" ]; then
    CANDIDATE=$(jq -r '.[0].legacy_id // ""' <<<"$REG" 2>/dev/null)
    if [ -n "$CANDIDATE" ]; then
      LEGACY_ID="$CANDIDATE"
      ID_SOURCE="registry"
      [ -z "$AGENT_TYPE" ] && AGENT_TYPE=$(jq -r '.[0].agent_type // ""' <<<"$REG" 2>/dev/null)
      [ -z "$DESCRIPTION" ] && DESCRIPTION=$(jq -r '.[0].description // ""' <<<"$REG" 2>/dev/null)
    fi
  fi
fi

# --- 4. .current-task, hard-gated ---
# Two conditions, both required. Either one alone leaves the old bug intact:
#   (a) no sibling subagent is running. If one is, the shared file belongs to
#       whichever agent was spawned last and cannot be trusted for this one.
#   (b) the file was written inside this run's window (from 5 min before its
#       first message to its last). A file left over from a previous item fails
#       this and is ignored -- that staleness is what produced the 262-run item.
if [ -z "$LEGACY_ID" ]; then
  CURRENT_TASK_FILE="${CLAUDE_PROJECT_DIR:-.}/.claude/.current-task"
  SIBLINGS=$(jq -r '[ .background_tasks[]? | select(.type == "subagent") ] | length' <<<"$INPUT" 2>/dev/null || echo 0)
  [ -z "$SIBLINGS" ] && SIBLINGS=0
  MTIME=$(file_mtime "$CURRENT_TASK_FILE")

  if [ "$SIBLINGS" -eq 0 ] 2>/dev/null && [ -n "$MTIME" ] && [ -n "$START_EPOCH" ] && [ -n "$END_EPOCH" ] \
     && [ "$MTIME" -ge $((START_EPOCH - 300)) ] && [ "$MTIME" -le $((END_EPOCH + 60)) ]; then
    LEGACY_ID=$(jq -r '.task_id // ""' "$CURRENT_TASK_FILE" 2>/dev/null)
    [ -z "$AGENT_TYPE" ] && AGENT_TYPE=$(jq -r '.agent_type // ""' "$CURRENT_TASK_FILE" 2>/dev/null)
    [ -z "$DESCRIPTION" ] && DESCRIPTION=$(jq -r '.description // ""' "$CURRENT_TASK_FILE" 2>/dev/null)
    [ -n "$LEGACY_ID" ] && ID_SOURCE="current-task(fresh,solo)"
  else
    echo "[HOOK] .current-task not used: siblings=$SIBLINGS mtime=${MTIME:-none} window=[${START_EPOCH:-?},${END_EPOCH:-?}]" >> "$DEBUG_LOG"
  fi
fi

# --- legacy_id -> uuid. Text in a uuid column is not a mislabelled row; it is a
# 400 and a LOST row, so nothing reaches the RPC without passing the gate. ---
BACKLOG_ITEM_ID=""; SPRINT_ID=""
if [ -n "$LEGACY_ID" ]; then
  read -r BACKLOG_ITEM_ID SPRINT_ID <<<"$(resolve_item_uuid "$LEGACY_ID")"
fi
BACKLOG_ITEM_ID=$(uuid_or_empty "$BACKLOG_ITEM_ID")
SPRINT_ID=$(uuid_or_empty "$SPRINT_ID")

echo "[HOOK] identity: agent=$AGENT_ID source=$ID_SOURCE task=$LEGACY_ID item=${BACKLOG_ITEM_ID:-null} type=$AGENT_TYPE model=${MODEL:-null}" >> "$DEBUG_LOG"

# ============================================================
# PRIMARY: Supabase
# ============================================================
SUPABASE_SUCCESS=false
if [ -n "${SUPABASE_URL:-}" ] && [ -n "${SUPABASE_KEY:-}" ]; then
  JSON_PAYLOAD=$(jq -n \
    --arg agent_id "$AGENT_ID" \
    --arg agent_type "$AGENT_TYPE" \
    --arg task_id "$LEGACY_ID" \
    --arg description "$DESCRIPTION" \
    --arg sprint_id "$SPRINT_ID" \
    --arg backlog_item_id "$BACKLOG_ITEM_ID" \
    --argjson input "$TOTAL_INPUT" \
    --argjson output "$TOTAL_OUTPUT" \
    --argjson cache_read "$TOTAL_CACHE_READ" \
    --argjson cache_create "$TOTAL_CACHE_CREATE" \
    --argjson total "$TOTAL_TOKENS" \
    --argjson duration_ms "$DURATION_MS" \
    --argjson api_calls "$API_CALLS" \
    --arg session_id "$SESSION_ID" \
    --arg model "$MODEL" \
    '{
      p_agent_id: $agent_id,
      p_agent_type: (if $agent_type == "" then null else $agent_type end),
      p_task_id: (if $task_id == "" then null else $task_id end),
      p_description: (if $description == "" then null else $description end),
      p_sprint_id: (if $sprint_id == "" then null else $sprint_id end),
      p_backlog_item_id: (if $backlog_item_id == "" then null else $backlog_item_id end),
      p_input_tokens: $input,
      p_output_tokens: $output,
      p_cache_read: $cache_read,
      p_cache_create: $cache_create,
      p_total_tokens: $total,
      p_duration_ms: $duration_ms,
      p_api_calls: $api_calls,
      p_session_id: $session_id,
      p_model: (if $model == "" then null else $model end)
    }')

  HTTP_STATUS=$(post_metrics "$JSON_PAYLOAD" "$DEBUG_LOG")
  if [ "$HTTP_STATUS" = "200" ] || [ "$HTTP_STATUS" = "201" ]; then
    SUPABASE_SUCCESS=true
    echo "[HOOK] Supabase OK ($HTTP_STATUS): $BILLABLE_TOKENS billable, task=${LEGACY_ID:-unlabelled} via $ID_SOURCE" >> "$DEBUG_LOG"
  fi
fi

# ============================================================
# BACKUP: CSV (append-only)
# ============================================================
CSV_ROW="${TIMESTAMP},${SESSION_ID},${AGENT_ID},${AGENT_TYPE},${LEGACY_ID},,$TOTAL_INPUT,$TOTAL_OUTPUT,$TOTAL_CACHE_READ,$TOTAL_CACHE_CREATE,$BILLABLE_TOKENS,$TOTAL_TOKENS,$API_CALLS,$DURATION_SECS,$START_TS,$END_TS"
echo "$CSV_ROW" >> "$METRICS_FILE"
echo "[HOOK] CSV backup written: $TOTAL_TOKENS total (supabase=$SUPABASE_SUCCESS)" >> "$DEBUG_LOG"

# The sidecar has served its purpose; leave no state to go stale.
[ -n "$AGENT_ID" ] && rm -f "$SIDECAR" 2>/dev/null

echo '{"decision": "allow"}'
exit 0

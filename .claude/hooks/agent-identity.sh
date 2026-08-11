#!/usr/bin/env bash
# Shared helpers for the metrics hooks (BACKLOG-1693).
#
# Sourced by track-agent-tokens.sh (SubagentStop) and track-main-session.sh
# (Stop). Contains only pure-ish helpers -- no side effects at source time -- so
# either caller can source it and stay non-blocking.
#
# EVERY function here must be safe to call with empty/garbage input and must
# never exit the caller. A metrics hook that dies takes an agent's run with it.

# Per-agent identity sidecars, written at spawn by register-agent.sh and read at
# stop by agent_id. One file per agent: the replacement for .claude/.current-task,
# which was a single shared file that every concurrent agent overwrote.
AGENT_TASK_DIR="${HOME}/.claude/agent-tasks"

# ---------------------------------------------------------------------------
# Credentials. Env first (the fleet exports these from ~/.zshrc), then the
# optional hook .env. Sets SUPABASE_URL / SUPABASE_KEY; returns 1 if unavailable.
# ---------------------------------------------------------------------------
load_supabase_creds() {
  SUPABASE_URL="${PM_SUPABASE_URL:-}"
  SUPABASE_KEY="${PM_SUPABASE_KEY:-}"
  if [ -z "$SUPABASE_URL" ] || [ -z "$SUPABASE_KEY" ]; then
    local hook_env="${CLAUDE_PROJECT_DIR:-.}/.claude/hooks/.env"
    if [ -f "$hook_env" ]; then
      # shellcheck source=/dev/null
      . "$hook_env" 2>/dev/null || true
      SUPABASE_URL="${PM_SUPABASE_URL:-}"
      SUPABASE_KEY="${PM_SUPABASE_KEY:-}"
    fi
  fi
  [ -n "$SUPABASE_URL" ] && [ -n "$SUPABASE_KEY" ]
}

# ---------------------------------------------------------------------------
# uuid gate. pm_log_agent_metrics types p_backlog_item_id and p_sprint_id as
# uuid, so a text label there is not a mislabelled row -- PostgREST 400s and the
# ENTIRE metric row is lost. Everything bound for those params passes through
# here first.
# ---------------------------------------------------------------------------
is_uuid() {
  case "${1:-}" in
    [0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]-[0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]-[0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]-[0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]-[0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]) return 0 ;;
    *) return 1 ;;
  esac
}

# uuid_or_empty <candidate> -- echoes the value only if it is a uuid.
uuid_or_empty() { is_uuid "${1:-}" && printf '%s' "$1" || printf ''; }

# ---------------------------------------------------------------------------
# resolve_item_uuid <legacy_id>
# BACKLOG-1693 -> pm_backlog_items.id (+ its sprint_id) as "<uuid> <sprint_uuid>".
# Requires load_supabase_creds to have run. Silent on any failure.
# ---------------------------------------------------------------------------
resolve_item_uuid() {
  local legacy="${1:-}"
  [ -z "$legacy" ] && return 0
  [ -z "${SUPABASE_URL:-}" ] || [ -z "${SUPABASE_KEY:-}" ] && return 0

  local resp item sprint
  resp=$(curl -s -m 5 \
    "${SUPABASE_URL}/rest/v1/pm_backlog_items?legacy_id=eq.${legacy}&deleted_at=is.null&select=id,sprint_id&limit=1" \
    -H "apikey: ${SUPABASE_KEY}" -H "Authorization: Bearer ${SUPABASE_KEY}" 2>/dev/null) || return 0

  item=$(printf '%s' "$resp" | jq -r '.[0].id // empty' 2>/dev/null)
  sprint=$(printf '%s' "$resp" | jq -r '.[0].sprint_id // empty' 2>/dev/null)
  printf '%s %s' "$(uuid_or_empty "$item")" "$(uuid_or_empty "$sprint")"
}

# ---------------------------------------------------------------------------
# transcript_model <transcript_path>
#
# The model that actually did the work, or empty. Never the string "unknown" --
# 1,725 rows carry that because the old one-liner ran jq WITHOUT -s, so it was
# evaluated per line, the first line (a user/summary record) had no
# .message.model, and it fell through to the default.
#
# Two exclusions, both measured rather than assumed:
#   <synthetic>  -- harness-generated messages (interrupts, API errors), 0 tokens
#   advisorModel -- the advisor runs a different model inside the same session.
#                   Main-session transcripts carry 1,314 claude-fable-5 usage
#                   entries against 1,790 claude-opus-5; taking "first with a
#                   model" would label an Opus run as Fable.
#
# MOST FREQUENT rather than first or last: a run whose model changes mid-flight
# has no single true answer, and the modal value is the one that did most of the
# work. Ties break to the lexicographically last group (group_by sorts).
# ---------------------------------------------------------------------------
transcript_model() {
  local t="${1:-}"
  [ -f "$t" ] || return 0
  jq -rs '
    [ .[]
      | select(.message.model != null and .message.model != "" and .message.model != "<synthetic>")
      | select(.advisorModel == null or .message.model != .advisorModel)
      | .message.model ]
    | if length == 0 then empty else (group_by(.) | max_by(length) | .[0]) end
  ' "$t" 2>/dev/null | head -1
}

# ---------------------------------------------------------------------------
# transcript_stats <transcript_path> [first_line]
# Token sums + first/last timestamp over the whole file, or from first_line on
# (used by the main-session Stop hook to record per-turn deltas against a
# cumulative transcript). Always emits valid JSON.
#
# Advisor and <synthetic> entries ARE counted here: they are real spend on the
# agent's behalf. The exclusions above apply to naming the model, not to billing.
# ---------------------------------------------------------------------------
transcript_stats() {
  local t="${1:-}" from="${2:-1}"
  local empty='{"total_input":0,"total_output":0,"total_cache_read":0,"total_cache_create":0,"api_calls":0,"start":null,"end":null}'
  [ -f "$t" ] || { printf '%s' "$empty"; return 0; }

  # Whole file goes straight to jq; only a delta window pays for `tail`. A main
  # session transcript runs to tens of MB and must not pass through a shell var.
  if [ "$from" -gt 1 ] 2>/dev/null; then
    tail -n "+${from}" "$t" 2>/dev/null
  else
    cat "$t" 2>/dev/null
  fi | jq -s '
    ([.[] | select(.message.usage != null) | .message.usage]) as $u
    | {
        total_input:        ([$u[].input_tokens // 0]                 | add // 0),
        total_output:       ([$u[].output_tokens // 0]                | add // 0),
        total_cache_read:   ([$u[].cache_read_input_tokens // 0]      | add // 0),
        total_cache_create: ([$u[].cache_creation_input_tokens // 0]  | add // 0),
        api_calls:          ($u | length),
        start: ([.[].timestamp // empty] | sort | first),
        end:   ([.[].timestamp // empty] | sort | last)
      }
  ' 2>/dev/null || printf '%s' "$empty"
}

# ---------------------------------------------------------------------------
# iso_to_epoch <iso8601> -- portable (no macOS-only `date -j`). Empty on failure.
# ---------------------------------------------------------------------------
iso_to_epoch() {
  local ts="${1:-}"
  [ -z "$ts" ] && return 0
  jq -rn --arg t "$ts" '
    ($t | split(".")[0] | sub("Z$";"") | strptime("%Y-%m-%dT%H:%M:%S") | mktime)
  ' 2>/dev/null || true
}

# file_mtime <path> -- epoch seconds, portable across macOS/Linux.
file_mtime() {
  [ -f "${1:-}" ] || return 0
  stat -f %m "$1" 2>/dev/null || stat -c %Y "$1" 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# post_metrics <json_payload> <debug_log>
# One RPC call. Echoes "<http_status>". Never fails the caller; a rejected
# payload is parked in failed-payloads.jsonl for replay.
# ---------------------------------------------------------------------------
post_metrics() {
  local payload="${1:-}" dbg="${2:-/dev/null}" resp body status
  [ -z "${SUPABASE_URL:-}" ] || [ -z "${SUPABASE_KEY:-}" ] && { printf '000'; return 0; }

  resp=$(curl -s -m 10 -w "\n%{http_code}" -X POST "${SUPABASE_URL}/rest/v1/rpc/pm_log_agent_metrics" \
    -H "apikey: ${SUPABASE_KEY}" \
    -H "Authorization: Bearer ${SUPABASE_KEY}" \
    -H "Content-Type: application/json" \
    -d "$payload" 2>/dev/null) || { printf '000'; return 0; }

  body=$(printf '%s' "$resp" | sed '$d')
  status=$(printf '%s' "$resp" | tail -1)

  if [ "$status" != "200" ] && [ "$status" != "201" ]; then
    echo "[HOOK] SUPABASE_PUSH_FAILED ($status): $body" >> "$dbg"
    local failed="${HOME}/.claude/metrics/failed-payloads.jsonl"
    mkdir -p "$(dirname "$failed")" 2>/dev/null
    jq -n --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg status "$status" \
          --arg error "$body" --argjson payload "$payload" \
          '{timestamp:$ts, http_status:$status, error:$error, payload:$payload}' \
      >> "$failed" 2>/dev/null || true
  fi
  printf '%s' "$status"
}

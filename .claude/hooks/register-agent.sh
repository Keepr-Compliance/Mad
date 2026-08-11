#!/usr/bin/env bash
# PostToolUse:Agent — register an agent in pm_agent_activity the moment it launches.
#
# WHY: pm_token_metrics records what an agent SPENT once it finished. Nothing
# recorded what was moving RIGHT NOW. On 2026-08-04 that gap produced two agents
# rewriting contactPickerList.ts unaware of each other, four merge-order
# conclusions (two wrong, measured against branches that then moved), and two
# scratchpad collisions on the obvious filename.
#
# These agents run async, so PostToolUse fires at LAUNCH, not completion — and
# unlike PreToolUse the agentId exists by then.
#
# NON-BLOCKING BY DESIGN. A registry outage must never stop work. Bypasses are
# detectable afterwards via the pm_agent_bypassed view, which reconciles this
# table against pm_token_metrics — so "it failed silently" is visible rather
# than assumed.
set -uo pipefail

exit_ok() { exit 0; }
trap exit_ok ERR

INPUT=$(cat 2>/dev/null) || exit 0
[ -z "$INPUT" ] && exit 0

command -v jq >/dev/null 2>&1 || exit 0

TOOL=$(jq -r '.tool_name // empty' <<<"$INPUT" 2>/dev/null)
[ "$TOOL" = "Agent" ] || [ "$TOOL" = "Task" ] || exit 0

AGENT_ID=$(jq -r '.tool_response.agentId // .tool_response.agent_id // empty' <<<"$INPUT" 2>/dev/null)
[ -z "$AGENT_ID" ] && exit 0

AGENT_TYPE=$(jq -r '.tool_input.subagent_type // "general-purpose"' <<<"$INPUT" 2>/dev/null)
DESCRIPTION=$(jq -r '.tool_input.description // empty' <<<"$INPUT" 2>/dev/null)
PROMPT=$(jq -r '.tool_input.prompt // empty' <<<"$INPUT" 2>/dev/null)
SESSION_ID=$(jq -r '.session_id // empty' <<<"$INPUT" 2>/dev/null)

# First BACKLOG reference in the brief is the item being worked.
LEGACY_ID=$(grep -oE 'BACKLOG-[0-9]+' <<<"$PROMPT" 2>/dev/null | head -1)

# Branch the brief names, if any. Best-effort: the hook cannot know where the
# agent will actually work, and the heartbeat hook corrects this from reality.
BRANCH=$(grep -oE '(fix|feat|chore|feature)/BACKLOG-[0-9A-Za-z._-]+' <<<"$PROMPT" 2>/dev/null | head -1)

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
HEAD_SHA=$(git -C "$PROJECT_DIR" rev-parse --short HEAD 2>/dev/null || true)

# --- BACKLOG-1693: bind task identity to THIS agent_id, at spawn -------------
# The SubagentStop hook used to re-read .claude/.current-task, a single shared
# file that every concurrent agent overwrote. Observed on 2026-08-11: five
# consecutive agents all stamped BACKLOG-2617 while the file already said
# BACKLOG-2628.
#
# One file per agent_id has no such race. It is written HERE, above the
# credential check below, so the primary binding never depends on the network.
AGENT_TASK_DIR="${HOME}/.claude/agent-tasks"
if mkdir -p "$AGENT_TASK_DIR" 2>/dev/null; then
  jq -n \
    --arg agent_id "$AGENT_ID" \
    --arg agent_type "$AGENT_TYPE" \
    --arg legacy_id "$LEGACY_ID" \
    --arg description "$DESCRIPTION" \
    --arg session_id "$SESSION_ID" \
    --arg spawned_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{agent_id:$agent_id, agent_type:$agent_type, legacy_id:$legacy_id,
      description:$description, session_id:$session_id, spawned_at:$spawned_at}' \
    > "${AGENT_TASK_DIR}/${AGENT_ID}.json" 2>/dev/null || true

  # A sidecar is only useful until its agent stops; prune after a week so the
  # directory cannot grow without bound.
  find "$AGENT_TASK_DIR" -name '*.json' -type f -mtime +7 -delete 2>/dev/null || true
fi

SUPABASE_URL="${PM_SUPABASE_URL:-}"
SUPABASE_KEY="${PM_SUPABASE_KEY:-}"
if [ -z "$SUPABASE_URL" ] || [ -z "$SUPABASE_KEY" ]; then
  HOOK_ENV="${PROJECT_DIR}/.claude/hooks/.env"
  if [ -f "$HOOK_ENV" ]; then
    # shellcheck source=/dev/null
    source "$HOOK_ENV" 2>/dev/null || true
    SUPABASE_URL="${PM_SUPABASE_URL:-}"
    SUPABASE_KEY="${PM_SUPABASE_KEY:-}"
  fi
fi
[ -z "$SUPABASE_URL" ] || [ -z "$SUPABASE_KEY" ] && exit 0

PAYLOAD=$(jq -n \
  --arg agent_id "$AGENT_ID" \
  --arg agent_type "$AGENT_TYPE" \
  --arg legacy_id "$LEGACY_ID" \
  --arg description "$DESCRIPTION" \
  --arg branch_name "$BRANCH" \
  --arg head_sha "$HEAD_SHA" \
  --arg session_id "$SESSION_ID" \
  '{agent_id:$agent_id, agent_type:$agent_type, status:"working"}
   + (if $legacy_id   != "" then {legacy_id:$legacy_id}     else {} end)
   + (if $description != "" then {description:$description} else {} end)
   + (if $branch_name != "" then {branch_name:$branch_name} else {} end)
   + (if $head_sha    != "" then {head_sha:$head_sha}       else {} end)
   + (if $session_id  != "" then {session_id:$session_id}   else {} end)' 2>/dev/null) || exit 0

curl -s -m 5 -X POST "${SUPABASE_URL}/rest/v1/pm_agent_activity" \
  -H "apikey: ${SUPABASE_KEY}" \
  -H "Authorization: Bearer ${SUPABASE_KEY}" \
  -H "Content-Type: application/json" \
  -H "Prefer: resolution=merge-duplicates,return=minimal" \
  -d "$PAYLOAD" >/dev/null 2>&1 || true

exit 0

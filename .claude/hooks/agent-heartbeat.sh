#!/usr/bin/env bash
# PostToolUse:Edit|Write — refresh heartbeat and DETECT which files an agent is touching.
#
# This hook fires inside each subagent for its own edits, so it sees reality
# rather than intent. files_claimed is derived from `git diff --name-only`, NOT
# declared in a brief: a declared list goes stale the moment scope changes, and
# on 2026-08-04 two agents rewrote contactPickerList.ts unaware of each other
# for three review cycles because nothing observed what was actually being edited.
#
# Correlation key is the BRANCH, not the agent id — a subagent's hook payload
# does not reliably carry its own id, but it always knows where it is working.
# If no row exists for the branch, one is created: an agent that bypassed
# registration self-heals on its first edit rather than staying invisible.
#
# NON-BLOCKING. Never stops an edit. Never writes to stdout.
set -uo pipefail

exit_ok() { exit 0; }
trap exit_ok ERR

INPUT=$(cat 2>/dev/null) || exit 0
[ -z "$INPUT" ] && exit 0
command -v jq >/dev/null 2>&1 || exit 0

TOOL=$(jq -r '.tool_name // empty' <<<"$INPUT" 2>/dev/null)
case "$TOOL" in Edit|Write|NotebookEdit) ;; *) exit 0 ;; esac

FILE_PATH=$(jq -r '.tool_input.file_path // empty' <<<"$INPUT" 2>/dev/null)
[ -z "$FILE_PATH" ] && exit 0

# Work out which repo/worktree this edit landed in.
DIR=$(dirname "$FILE_PATH" 2>/dev/null) || exit 0
[ -d "$DIR" ] || exit 0
BRANCH=$(git -C "$DIR" rev-parse --abbrev-ref HEAD 2>/dev/null) || exit 0
[ -z "$BRANCH" ] || [ "$BRANCH" = "HEAD" ] && exit 0

# Never register the shared branches — only feature work is interesting here,
# and a row for `develop` would collide across every agent.
case "$BRANCH" in develop|main|master) exit 0 ;; esac

WORKTREE=$(git -C "$DIR" rev-parse --show-toplevel 2>/dev/null || true)
HEAD_SHA=$(git -C "$DIR" rev-parse --short HEAD 2>/dev/null || true)

# DETECTED, not declared: everything this branch has actually changed vs its
# merge-base. Cheap, and correct even when the brief's scope was wrong.
BASE=$(git -C "$DIR" merge-base HEAD origin/int/contacts-followups 2>/dev/null \
    || git -C "$DIR" merge-base HEAD origin/develop 2>/dev/null || true)
if [ -n "$BASE" ]; then
  FILES_JSON=$(git -C "$DIR" diff --name-only "$BASE" 2>/dev/null \
    | head -60 | jq -R . 2>/dev/null | jq -sc . 2>/dev/null || echo '[]')
else
  FILES_JSON='[]'
fi
[ -z "$FILES_JSON" ] && FILES_JSON='[]'

SUPABASE_URL="${PM_SUPABASE_URL:-}"
SUPABASE_KEY="${PM_SUPABASE_KEY:-}"
if [ -z "$SUPABASE_URL" ] || [ -z "$SUPABASE_KEY" ]; then
  HOOK_ENV="${CLAUDE_PROJECT_DIR:-.}/.claude/hooks/.env"
  if [ -f "$HOOK_ENV" ]; then
    # shellcheck source=/dev/null
    source "$HOOK_ENV" 2>/dev/null || true
    SUPABASE_URL="${PM_SUPABASE_URL:-}"
    SUPABASE_KEY="${PM_SUPABASE_KEY:-}"
  fi
fi
[ -z "$SUPABASE_URL" ] || [ -z "$SUPABASE_KEY" ] && exit 0

ENC_BRANCH=$(jq -rn --arg b "$BRANCH" '$b|@uri' 2>/dev/null) || exit 0

# Refresh the row for this branch.
RESP=$(curl -s -m 5 -w '\n%{http_code}' \
  -X PATCH "${SUPABASE_URL}/rest/v1/pm_agent_activity?branch_name=eq.${ENC_BRANCH}&ended_at=is.null" \
  -H "apikey: ${SUPABASE_KEY}" \
  -H "Authorization: Bearer ${SUPABASE_KEY}" \
  -H "Content-Type: application/json" \
  -H "Prefer: return=representation" \
  -d "{\"heartbeat_at\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"files_claimed\":${FILES_JSON},\"head_sha\":\"${HEAD_SHA}\",\"worktree_path\":\"${WORKTREE}\"}" 2>/dev/null) || exit 0

BODY=$(sed '$d' <<<"$RESP" 2>/dev/null)

# No row matched => this agent never registered. Self-heal so the work is
# visible, and leave it detectable in pm_agent_bypassed.
if [ "$BODY" = "[]" ] || [ -z "$BODY" ]; then
  LEGACY=$(grep -oE 'BACKLOG-[0-9]+' <<<"$BRANCH" 2>/dev/null | head -1)
  curl -s -m 5 -X POST "${SUPABASE_URL}/rest/v1/pm_agent_activity" \
    -H "apikey: ${SUPABASE_KEY}" \
    -H "Authorization: Bearer ${SUPABASE_KEY}" \
    -H "Content-Type: application/json" \
    -H "Prefer: resolution=merge-duplicates,return=minimal" \
    -d "$(jq -nc \
        --arg id "branch:${BRANCH}" --arg br "$BRANCH" --arg lg "$LEGACY" \
        --arg wt "$WORKTREE" --arg sha "$HEAD_SHA" --argjson files "$FILES_JSON" \
        '{agent_id:$id, branch_name:$br, worktree_path:$wt, head_sha:$sha,
          files_claimed:$files, status:"working",
          note:"self-registered on first edit; launch hook did not fire"}
         + (if $lg != "" then {legacy_id:$lg} else {} end)')" >/dev/null 2>&1 || true
fi

exit 0

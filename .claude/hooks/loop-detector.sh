#!/bin/bash
# Anti-Loop Detection Hook
# Triggered by PostToolUse to detect exploration and verification loops
# Reference: BACKLOG-161, TASK-979

# State file for tracking tool calls per agent session
STATE_DIR="/tmp/claude-loop-state"
mkdir -p "$STATE_DIR"

# Read hook input from stdin
INPUT=$(cat)

# Extract tool name and agent ID
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // "unknown"')
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // "unknown"')
AGENT_ID=${CLAUDE_AGENT_ID:-$SESSION_ID}

# State file for this agent session
STATE_FILE="$STATE_DIR/$AGENT_ID.state"

# Debug logging (optional, comment out in production)
# echo "[LOOP-DETECTOR] Tool: $TOOL_NAME, Agent: $AGENT_ID" >> /tmp/claude-loop-debug.log

# Initialize state file if it doesn't exist
if [ ! -f "$STATE_FILE" ]; then
  echo '{"exploration_count":0,"last_bash":"","bash_repeat_count":0,"write_occurred":false}' > "$STATE_FILE"
fi

# Read current state
STATE=$(cat "$STATE_FILE")
EXPLORATION_COUNT=$(echo "$STATE" | jq -r '.exploration_count // 0')
LAST_BASH=$(echo "$STATE" | jq -r '.last_bash // ""')
BASH_REPEAT_COUNT=$(echo "$STATE" | jq -r '.bash_repeat_count // 0')
WRITE_OCCURRED=$(echo "$STATE" | jq -r '.write_occurred // false')

# Check for write/edit operations (reset exploration counter)
if [ "$TOOL_NAME" = "Write" ] || [ "$TOOL_NAME" = "Edit" ]; then
  # Reset counters on write
  jq -n \
    --argjson exp 0 \
    --arg bash "" \
    --argjson repeat 0 \
    --argjson wrote true \
    '{exploration_count: $exp, last_bash: $bash, bash_repeat_count: $repeat, write_occurred: $wrote}' > "$STATE_FILE"

  # Silent no-op: empty stdout is the valid "nothing to report" for PostToolUse
  exit 0
fi

# Track exploration tools (Read, Glob, Grep)
if [ "$TOOL_NAME" = "Read" ] || [ "$TOOL_NAME" = "Glob" ] || [ "$TOOL_NAME" = "Grep" ]; then
  EXPLORATION_COUNT=$((EXPLORATION_COUNT + 1))

  # Update state
  jq -n \
    --argjson exp "$EXPLORATION_COUNT" \
    --arg bash "$LAST_BASH" \
    --argjson repeat "$BASH_REPEAT_COUNT" \
    --argjson wrote "$WRITE_OCCURRED" \
    '{exploration_count: $exp, last_bash: $bash, bash_repeat_count: $repeat, write_occurred: $wrote}' > "$STATE_FILE"

  # Check for exploration loop (>20 without Write/Edit)
  if [ "$EXPLORATION_COUNT" -gt 20 ] && [ "$WRITE_OCCURRED" = "false" ]; then
    # additionalContext is the valid PostToolUse channel for injecting a message
    jq -n --arg ctx "WARNING: EXPLORATION LOOP DETECTED - You have made $EXPLORATION_COUNT exploration calls (Read/Glob/Grep) without any Write/Edit. Per anti-loop rules: max 10 files before first Write. Either: (1) Start implementing with Write/Edit, (2) Commit partial progress, or (3) Stop and ask for help. Reference: BACKLOG-161" \
      '{hookSpecificOutput: {hookEventName: "PostToolUse", additionalContext: $ctx}}'
    exit 0
  fi
fi

# Track Bash commands for verification loops
if [ "$TOOL_NAME" = "Bash" ]; then
  CURRENT_BASH=$(echo "$INPUT" | jq -r '.tool_input.command // ""')

  # Check if same command as last time
  if [ "$CURRENT_BASH" = "$LAST_BASH" ] && [ -n "$CURRENT_BASH" ]; then
    BASH_REPEAT_COUNT=$((BASH_REPEAT_COUNT + 1))
  else
    BASH_REPEAT_COUNT=1
    LAST_BASH="$CURRENT_BASH"
  fi

  # Update state
  jq -n \
    --argjson exp "$EXPLORATION_COUNT" \
    --arg bash "$LAST_BASH" \
    --argjson repeat "$BASH_REPEAT_COUNT" \
    --argjson wrote "$WRITE_OCCURRED" \
    '{exploration_count: $exp, last_bash: $bash, bash_repeat_count: $repeat, write_occurred: $wrote}' > "$STATE_FILE"

  # Check for verification loop (>5 identical commands)
  if [ "$BASH_REPEAT_COUNT" -gt 5 ]; then
    jq -n --arg ctx "WARNING: VERIFICATION LOOP DETECTED - You have run the same Bash command $BASH_REPEAT_COUNT times. Per anti-loop rules: max 3 retries of same command. Either: (1) Try a different approach, (2) Commit partial progress, or (3) Stop and ask for help. Reference: BACKLOG-161" \
      '{hookSpecificOutput: {hookEventName: "PostToolUse", additionalContext: $ctx}}'
    exit 0
  fi
fi

# Default: nothing to report (empty stdout = valid no-op)
exit 0

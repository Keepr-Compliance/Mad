#!/bin/bash
# Type-Check After Edit Hook
# Runs tsc --noEmit after Write/Edit on .ts/.tsx files to catch type errors early.
# Only triggers on TypeScript files to avoid unnecessary checks on .md, .json, etc.
#
# Output protocol (PostToolUse):
# - Nothing to report -> empty stdout, exit 0
# - Type errors       -> hookSpecificOutput.additionalContext JSON (reaches Claude)

# Read hook input from stdin
INPUT=$(cat)

TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // "unknown"')

# Only check after Edit or Write (belt-and-braces; settings.json matcher also gates this)
if [ "$TOOL_NAME" != "Edit" ] && [ "$TOOL_NAME" != "Write" ]; then
  exit 0
fi

# Get the file path from tool input
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // .tool_input.path // ""')

# Only check TypeScript files
case "$FILE_PATH" in
  *.ts|*.tsx)
    ;;
  *)
    exit 0
    ;;
esac

# Run type check — capture the REAL tsc exit code before truncating output
# (piping straight into head would make $? the exit code of head, not tsc)
cd "$CLAUDE_PROJECT_DIR" 2>/dev/null || cd "$(dirname "$0")/../.." 2>/dev/null
TSC_OUTPUT=$(npx tsc --noEmit --pretty false 2>&1)
TSC_EXIT=$?
TSC_OUTPUT=$(echo "$TSC_OUTPUT" | head -15)

if [ $TSC_EXIT -ne 0 ]; then
  # jq handles all JSON escaping (newlines, quotes) safely
  jq -n --arg ctx "TYPE ERROR after editing ${FILE_PATH}:
${TSC_OUTPUT}" \
    '{hookSpecificOutput: {hookEventName: "PostToolUse", additionalContext: $ctx}}'
  exit 0
fi

# No errors — silent no-op
exit 0

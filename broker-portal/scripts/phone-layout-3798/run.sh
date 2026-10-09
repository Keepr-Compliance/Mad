#!/usr/bin/env bash
# BACKLOG-3798 layout harness. Renders real components (dumps.harness.tsx),
# compiles the portal's real Tailwind CSS for each dump, and measures element
# rects in Chromium (Playwright, root node_modules) at 375/640/768/1024/1280.
#
#   scripts/phone-layout-3798/run.sh <outDir>
#   node scripts/phone-layout-3798/compare.cjs <beforeDir> <afterDir> 768 1024 1280
#
# Desktop-unchanged check: run once on the base commit, once on the branch,
# compare at 768/1024/1280 -> must print IDENTICAL.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PORTAL="$(cd "$HERE/../.." && pwd)"
OUT="$(mkdir -p "$1" && cd "$1" && pwd)"
WIDTHS="${WIDTHS:-375 640 768 1024 1280}"
cd "$PORTAL"
DUMP_DIR="$OUT" npx jest -c "$HERE/jest.harness.config.js" --silent
for html in "$OUT"/*.html; do
  name="$(basename "$html" .html)"
  npx tailwindcss -c "$PORTAL/tailwind.config.ts" -i "$PORTAL/app/globals.css" --content "$html" -o "$OUT/$name.css" 2>/dev/null
  node "$HERE/measure.cjs" "$html" "$OUT/$name.css" $WIDTHS > "$OUT/$name.json"
  echo "measured $name"
done

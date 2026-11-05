#!/usr/bin/env bash
# BACKLOG-4139/4140 billing phone-width harness: dump real components (jest), compile real Tailwind,
# measure in Chromium.  scripts/billing-phone-4139/run.sh <outDir>
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; PORTAL="$(cd "$HERE/../.." && pwd)"
OUT="$(mkdir -p "$1" && cd "$1" && pwd)"; rm -f "$OUT"/*.html "$OUT"/*.css
cd "$PORTAL"
DUMP_DIR="$OUT" npx jest -c "$HERE/jest.harness.config.js" --bail=0 2>&1 | command grep -E "^Tests:"
n=$(ls "$OUT"/*.html | wc -l | tr -d ' '); [ "$n" -gt 0 ] || { echo "NO DUMPS"; exit 2; }
for html in "$OUT"/*.html; do
  case "$html" in *.tw.html) continue;; esac
  name="$(basename "$html" .html)"
  sed 's/&amp;/\&/g' "$html" > "$OUT/$name.tw.html"
  npx tailwindcss -c "$PORTAL/tailwind.config.ts" -i "$PORTAL/app/globals.css" --content "$OUT/$name.tw.html" -o "$OUT/$name.css" 2>/dev/null
done
node "$HERE/check.cjs" "$OUT"

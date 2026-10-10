#!/usr/bin/env bash
# BACKLOG-3841 admin-portal layout harness (ported from broker 3798).
# Renders real components (dumps.harness.tsx), compiles the portal's real
# Tailwind CSS for each dump, and measures element rects (and form-field font
# sizes) in Chromium (Playwright, root node_modules) at 375/640/768/1024/1280.
#
#   scripts/phone-layout-3841/run.sh <outDir>
#   node scripts/phone-layout-3841/compare.cjs <beforeDir> <afterDir> 768 1024 1280
#
# Desktop-unchanged check: run once on the base commit, once on the branch,
# compare at 768/1024/1280 -> must print IDENTICAL. The drawer-open view has no
# baseline; run.sh compares it against shell-expanded at 768+ (identical, and
# every drawer-only element zero-size).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PORTAL="$(cd "$HERE/../.." && pwd)"
REPO="$(cd "$PORTAL/.." && pwd)"
OUT="$(mkdir -p "$1" && cd "$1" && pwd)"
WIDTHS="${WIDTHS:-375 640 768 1024 1280}"

# @keepr/* resolve through node_modules, which in a worktree is a symlink to
# another checkout. Refuse to measure if that checkout's packages/ differ from
# this tree's HEAD (or this tree has uncommitted packages/ edits).
NM_REPO="$(cd "$(readlink -f "$REPO/node_modules")/.." && pwd)"
HEAD_SHA="$(git -C "$REPO" rev-parse HEAD)"
if ! git -C "$NM_REPO" diff --quiet "$HEAD_SHA" -- packages || ! git -C "$REPO" diff --quiet HEAD -- packages; then
  echo "PACKAGES DRIFT: $NM_REPO/packages differs from $HEAD_SHA -- harness would measure the wrong @keepr/* code" >&2
  exit 2
fi
echo "packages pinned: $NM_REPO/packages == $HEAD_SHA" | tee "$OUT/packages-pin.txt"

cd "$PORTAL"
DUMP_DIR="$OUT" npx vitest run -c "$HERE/vitest.harness.config.ts" --reporter=dot
for html in "$OUT"/*.html; do
  name="$(basename "$html" .html)"
  npx tailwindcss -c "$PORTAL/tailwind.config.ts" -i "$PORTAL/app/globals.css" --content "$html" -o "$OUT/$name.css" 2>/dev/null
  node "$HERE/measure.cjs" "$html" "$OUT/$name.css" $WIDTHS > "$OUT/$name.json"
  echo "measured $name"
done

if [ -f "$OUT/drawer-open.json" ]; then
  T="$(mktemp -d)"; mkdir -p "$T/a" "$T/b"
  cp "$OUT/shell-expanded.json" "$T/a/x.json"; cp "$OUT/drawer-open.json" "$T/b/x.json"
  echo "drawer-open vs shell-expanded at 768 1024 1280:"
  node "$HERE/compare.cjs" "$T/a" "$T/b" 768 1024 1280 || true
  rm -rf "$T"
fi

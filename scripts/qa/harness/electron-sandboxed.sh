#!/bin/bash
# QA harness — run the repo's Electron binary inside a macOS sandbox-exec profile (BACKLOG-4093).
#
# Used to launch QA Electron-main scripts (scripts/qa/harness/seed-fixture.js) so that, whatever
# the script or Chromium decides about userData, the process cannot read or write the real
# profile and personal stores. The profile DENIES file-read* and file-write* under $HOME for:
#
#   ~/Library/Application Support/keepr        (installed app profile)
#   ~/Library/Application Support/Keepr
#   ~/Library/Application Support/keepr-dev    (npm run dev profile)
#   ~/Library/Application Support/Electron     (Chromium's default userData when the
#                                               --user-data-dir switch is lost — fail closed)
#   ~/Library/Application Support/AddressBook
#   ~/Library/Messages
#   ~/Library/Logs/keepr
#   ~/Library/Logs/Keepr
#   ~/Library/Logs/keepr-dev
#
# It does NOT isolate the macOS keychain. Callers must also pass --use-mock-keychain (the seeder
# refuses to run without it), and must pass the profile as --user-data-dir=<dir> (the `=` form).
#
# Usage:
#   scripts/qa/harness/electron-sandboxed.sh --use-mock-keychain --user-data-dir=<dir> <script.js> [args]
#
# Electron is resolved from this repository's node_modules. On non-macOS hosts there is no
# sandbox-exec; the script execs Electron directly with the same arguments.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

if [[ "$(uname -s)" != "Darwin" ]]; then
  exec "$REPO_ROOT/node_modules/.bin/electron" "$@"
fi

ELECTRON_BIN="$REPO_ROOT/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
if [[ ! -x "$ELECTRON_BIN" ]]; then
  echo "electron-sandboxed.sh: Electron binary not found at $ELECTRON_BIN (run: node node_modules/electron/install.js)" >&2
  exit 127
fi

H='(param "HOME")'
deny() { printf '(subpath (string-append %s "%s"))' "$H" "$1"; }
PROFILE="(version 1)(allow default)(deny file-read* file-write*"
for rel in \
  "/Library/Application Support/keepr" \
  "/Library/Application Support/Keepr" \
  "/Library/Application Support/keepr-dev" \
  "/Library/Application Support/Electron" \
  "/Library/Application Support/AddressBook" \
  "/Library/Messages" \
  "/Library/Logs/keepr" \
  "/Library/Logs/Keepr" \
  "/Library/Logs/keepr-dev"; do
  PROFILE+=" $(deny "$rel")"
done
PROFILE+=")"

# --no-sandbox: Chromium's own sandbox cannot initialise inside a sandbox-exec profile.
exec /usr/bin/sandbox-exec -D HOME="$HOME" -p "$PROFILE" "$ELECTRON_BIN" --no-sandbox "$@"

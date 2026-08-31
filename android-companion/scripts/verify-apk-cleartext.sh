#!/usr/bin/env bash
#
# verify-apk-cleartext.sh — assert a built APK permits cleartext HTTP.
#
# BACKLOG-2956. THE gate for the release-only blocker that killed local sync.
#
# ## Why this check exists and why it lives on the ARTIFACT
#
# Android has blocked cleartext HTTP by default since API 28. The companion
# targets 36, and the desktop's local sync server is plain http:// on the LAN.
# If nothing in the manifest permits cleartext, the OS refuses every request
# BEFORE a socket is opened: pairing fails, no packet reaches the desktop, and
# there is nothing in any log to explain it.
#
# It is a RELEASE-ONLY failure, which is exactly why it shipped. Debug builds
# get android:usesCleartextTraffic="true" injected automatically so the Expo dev
# server is reachable, so every companion APK before v1.1.0-3 worked. The first
# release build removed the injection.
#
# An OS network policy is invisible to jest. The compiled manifest is the only
# authority on what a user's device will do, so the check reads that.
#
# ## Demonstrating that it discriminates
#
#   ./scripts/verify-apk-cleartext.sh build/keepr-companion-1.1.0-2.apk   # FAILS
#   ./scripts/verify-apk-cleartext.sh build/keepr-companion-1.1.0-3.apk   # passes
#
# The 1.1.0-2 artifact is the broken build the founder installed. A gate nobody
# has watched fail is not a gate.
#
# Usage: verify-apk-cleartext.sh <path-to-apk>

set -euo pipefail

APK="${1:-}"
if [ -z "$APK" ]; then
  echo "usage: $(basename "$0") <path-to-apk>" >&2
  exit 2
fi
if [ ! -f "$APK" ]; then
  echo "ERROR: no such APK: $APK" >&2
  exit 2
fi

export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
BUILD_TOOLS="$(ls -d "$ANDROID_HOME"/build-tools/* 2>/dev/null | sort -V | tail -1 || true)"
AAPT2="${BUILD_TOOLS:-}/aapt2"
if [ ! -x "$AAPT2" ]; then
  # Refuse rather than pass. A missing tool must never read as a clean bill of
  # health — that is how an absent check becomes an invisible one.
  echo "ERROR: aapt2 not found under $ANDROID_HOME/build-tools." >&2
  echo "       Cannot verify the manifest, and will NOT assume it is fine." >&2
  exit 2
fi

# Capture, THEN filter. Under `set -o pipefail` an early-exiting consumer on the
# right of a pipe (grep -q, head -1) makes aapt2 die on SIGPIPE and takes the
# whole script down with errexit — the defect that silently skipped this
# script's sibling checks on the very first release build.
MANIFEST_TREE="$("$AAPT2" dump xmltree --file AndroidManifest.xml "$APK" 2>/dev/null || true)"
if [ -z "$MANIFEST_TREE" ]; then
  echo "ERROR: could not read AndroidManifest.xml from $APK" >&2
  exit 2
fi

CLEARTEXT_LINES="$(printf '%s\n' "$MANIFEST_TREE" | grep -iE "cleartext|networkSecurityConfig" || true)"

if [ -z "$CLEARTEXT_LINES" ]; then
  echo "ERROR: $(basename "$APK") permits NO cleartext traffic."
  echo "       Neither android:usesCleartextTraffic nor android:networkSecurityConfig"
  echo "       is present in the compiled manifest, so Android will refuse every"
  echo "       http:// request to the desktop. LOCAL SYNC CANNOT WORK in this build."
  echo ""
  echo "       Expected: \"./plugins/withLanCleartext\" listed in app.json's"
  echo "       expo.plugins array. Check it is still there — a config plugin that"
  echo "       is not registered leaves everything else green."
  exit 1
fi

echo "[verify] cleartext permission present in $(basename "$APK"):"
printf '%s\n' "$CLEARTEXT_LINES" | sed 's/^/  /'

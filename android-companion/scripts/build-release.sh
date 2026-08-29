#!/usr/bin/env bash
#
# build-release.sh — Build a SIGNED RELEASE AAB + APK for Keepr Companion (Android)
#
# BACKLOG-2956 / BACKLOG-2340.
#
# ## Why this exists
#
# The only build script this repo had was `build-apk.sh`, which produces a DEBUG
# apk signed with the throwaway `debug.keystore`. That is the artifact currently
# being handed to field testers, and it is the artifact `expo prebuild` will keep
# producing by default: the generated `android/app/build.gradle` wires the
# `release` buildType to `signingConfigs.debug` under a `// Caution!` comment.
# A debug-signed "release" build cannot go on Google Play, and its signing key is
# a public constant, so anyone can forge an update for it.
#
# ## Output
#
#   build/keepr-companion-<version>-<versionCode>.aab   (Play requires an AAB)
#   build/keepr-companion-<version>-<versionCode>.apk   (sideload distribution)
#
# Both names carry the versionCode, so two artifacts can never be confused on
# disk — the same problem this item exists to fix, one level up.
#
# ## Required environment (values NEVER live in this repo)
#
#   KEEPR_ANDROID_KEYSTORE_PATH      absolute path to the release keystore
#   KEEPR_ANDROID_KEYSTORE_PASSWORD  store password
#   KEEPR_ANDROID_KEY_ALIAS          key alias inside the keystore
#   KEEPR_ANDROID_KEY_PASSWORD       key password
#
# On the founder's machine these live in `~/.keepr/android/keystore.env` (mode
# 0600), alongside the keystore itself:
#
#   set -a; source ~/.keepr/android/keystore.env; set +a
#   android-companion/scripts/build-release.sh
#
# ## LOSING THE KEYSTORE IS UNRECOVERABLE
#
# Android refuses to install an update signed by a different key, and Play
# rejects the upload. If the keystore is lost, the ONLY path forward is a new
# app under a new package name that every user installs from scratch. Back up
# the keystore AND its password somewhere durable.
#
# ## Optional
#
#   SENTRY_AUTH_TOKEN  when set, the Sentry gradle plugin (already applied by
#                      `expo prebuild` via @sentry/react-native/expo — see
#                      android/app/build.gradle) uploads the JS bundle + source
#                      map during the gradle build. This script deliberately
#                      does NOT run `sentry-cli sourcemaps upload` itself:
#                      build-apk.sh has to, because it bundles JS manually with
#                      `expo export:embed`, but a release build bundles through
#                      the React Native gradle plugin and a second upload would
#                      double-ship the same artifacts.
#
# ## Prerequisites
#   - Java 17, Android SDK (platforms;android-36, build-tools;36.0.0, ndk)
#   - Node + npm, and `npm install` already run in android-companion/

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# -------------------------------------------------------------------
# 1. Environment
#    (keep in sync with build-apk.sh step 1)
# -------------------------------------------------------------------
export JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home}"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"

[ -d "$JAVA_HOME" ] || { echo "ERROR: JAVA_HOME not found at $JAVA_HOME (brew install openjdk@17)"; exit 1; }
[ -d "$ANDROID_HOME" ] || { echo "ERROR: ANDROID_HOME not found at $ANDROID_HOME"; exit 1; }

# -------------------------------------------------------------------
# 2. Signing credentials — fail LOUDLY and EARLY
#
#    Without this gate gradle would fall through to the debug signing config
#    and cheerfully emit a debug-signed "release" build. That artifact looks
#    correct, installs fine, and is unpublishable — precisely the failure this
#    script exists to prevent, so it must never be reachable by accident.
# -------------------------------------------------------------------
missing=()
for var in KEEPR_ANDROID_KEYSTORE_PATH KEEPR_ANDROID_KEYSTORE_PASSWORD \
           KEEPR_ANDROID_KEY_ALIAS KEEPR_ANDROID_KEY_PASSWORD; do
  [ -n "${!var:-}" ] || missing+=("$var")
done
if [ ${#missing[@]} -gt 0 ]; then
  echo "ERROR: missing signing environment: ${missing[*]}"
  echo "       set -a; source \$HOME/.keepr/android/keystore.env; set +a"
  exit 1
fi
if [ ! -f "$KEEPR_ANDROID_KEYSTORE_PATH" ]; then
  echo "ERROR: keystore not found at KEEPR_ANDROID_KEYSTORE_PATH"
  echo "       (path is set but the file is missing — check your backup)"
  exit 1
fi

# `node -p` renders a NUMBER through util.inspect, which can emit ANSI colour
# escapes — those landed inside the artifact FILENAMES on the first run
# ("keepr-companion-1.1.0-<ESC>[33m2<ESC>[39m.apk"). String() forces plain text.
VERSION="$(node -p "String(require('$PROJECT_DIR/app.json').expo.version)")"
VERSION_CODE="$(node -p "String(require('$PROJECT_DIR/app.json').expo.android.versionCode)")"

# A missing versionCode is how every previous build ended up claiming version 1:
# Expo silently defaults it to 1. Never let that happen again silently.
if [ -z "$VERSION_CODE" ] || [ "$VERSION_CODE" = "undefined" ]; then
  echo "ERROR: expo.android.versionCode is not set in app.json."
  echo "       Expo would default it to 1 and this build would be"
  echo "       indistinguishable from every build ever made. Set it and bump it."
  exit 1
fi

echo "[build-release] version      : $VERSION"
echo "[build-release] versionCode  : $VERSION_CODE"
echo "[build-release] JAVA_HOME    : $JAVA_HOME"
echo "[build-release] ANDROID_HOME : $ANDROID_HOME"
# The Sentry gradle plugin injected by `expo prebuild` runs sentry-cli during
# the release build and FAILS THE WHOLE BUILD when it has no auth token (task
# :app:createBundleReleaseJsAndAssets_SentryUpload_..., sentry-cli exit 1).
# A missing telemetry token must not block shipping a build, so disable the
# auto-upload explicitly and say so loudly rather than dying.
if [ -n "${SENTRY_AUTH_TOKEN:-}" ]; then
  echo "[build-release] Sentry       : token present — gradle will upload source maps"
else
  export SENTRY_DISABLE_AUTO_UPLOAD=true
  echo "[build-release] Sentry       : SENTRY_AUTH_TOKEN unset — source-map upload DISABLED."
  echo "[build-release]                This build's crash reports will NOT be symbolicated."
fi

# -------------------------------------------------------------------
# 3. Prebuild — ALWAYS clean.
#
#    Unlike build-apk.sh (which reuses an existing android/), a release build
#    regenerates from scratch every time so the signing patch below is applied
#    to a known-clean tree. A half-patched android/ is how you ship a debug-
#    signed release.
# -------------------------------------------------------------------
echo "[build-release] Running expo prebuild (clean)..."
cd "$PROJECT_DIR"
npx expo prebuild --platform android --no-install --clean

# -------------------------------------------------------------------
# 4. Patch android/build.gradle for the async-storage local maven repo
#    (expo prebuild overwrites this file each time)
#    KEEP IN SYNC with build-apk.sh step 4.
# -------------------------------------------------------------------
BUILD_GRADLE="$PROJECT_DIR/android/build.gradle"
if ! grep -q "local_repo" "$BUILD_GRADLE" 2>/dev/null; then
  echo "[build-release] Patching build.gradle with async-storage local maven repo..."
  sed -i '' "/maven { url 'https:\/\/www.jitpack.io' }/a\\
\\    // Local maven repo for @react-native-async-storage/async-storage shared KMP module\\
\\    maven { url \"\$rootDir/../node_modules/@react-native-async-storage/async-storage/android/local_repo\" }
" "$BUILD_GRADLE"
fi

# -------------------------------------------------------------------
# 5. local.properties (points gradle at the Android SDK)
#    KEEP IN SYNC with build-apk.sh step 5.
# -------------------------------------------------------------------
LOCAL_PROPS="$PROJECT_DIR/android/local.properties"
[ -f "$LOCAL_PROPS" ] || echo "sdk.dir=$ANDROID_HOME" > "$LOCAL_PROPS"

# -------------------------------------------------------------------
# 6. Inject the RELEASE signing config
#
#    `expo prebuild` emits:
#        signingConfigs { debug { ...debug.keystore... } }
#        buildTypes { release { signingConfig signingConfigs.debug ... } }
#
#    Two edits are needed, and BOTH are asserted afterwards. Credentials are
#    read from the environment at gradle-evaluation time, so no secret is ever
#    written into a file inside the repo or the generated project.
#
#    The `signingConfig signingConfigs.debug` line appears in BOTH buildTypes,
#    so the replace is anchored on the `// Caution!` comment that prebuild emits
#    only inside `release {}`. Anchoring on the bare line would rewrite the
#    debug buildType instead and leave release untouched.
# -------------------------------------------------------------------
APP_GRADLE="$PROJECT_DIR/android/app/build.gradle"
echo "[build-release] Injecting release signing config..."

python3 - "$APP_GRADLE" <<'PYEOF'
import sys, pathlib

path = pathlib.Path(sys.argv[1])
src = path.read_text()

# --- 6a. add a `release` signingConfig next to the generated `debug` one ---
anchor = """    signingConfigs {
        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
    }"""
if anchor not in src:
    sys.exit("FATAL: could not find the generated signingConfigs block. "
             "expo prebuild's output shape changed — re-derive this patch "
             "instead of loosening the anchor.")

replacement = """    signingConfigs {
        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
        // BACKLOG-2956: injected by scripts/build-release.sh. Credentials come
        // from the environment; nothing secret is written into the project.
        release {
            storeFile file(System.getenv("KEEPR_ANDROID_KEYSTORE_PATH"))
            storePassword System.getenv("KEEPR_ANDROID_KEYSTORE_PASSWORD")
            keyAlias System.getenv("KEEPR_ANDROID_KEY_ALIAS")
            keyPassword System.getenv("KEEPR_ANDROID_KEY_PASSWORD")
        }
    }"""
src = src.replace(anchor, replacement, 1)

# --- 6b. point the release buildType at it ---
# Anchored on the `// Caution!` comment, which prebuild emits ONLY inside
# `release {}` — the bare `signingConfig signingConfigs.debug` line also exists
# in the debug buildType.
caution = """            // Caution! In production, you need to generate your own keystore file.
            // see https://reactnative.dev/docs/signed-apk-android.
            signingConfig signingConfigs.debug"""
if caution not in src:
    sys.exit("FATAL: could not find the release buildType's debug signingConfig "
             "anchor. Refusing to guess — a wrong edit here silently produces a "
             "debug-signed release build.")

src = src.replace(caution, "            signingConfig signingConfigs.release", 1)

path.write_text(src)
print("[build-release] signing config injected")
PYEOF

# Assert the swap actually took. An unswapped config produces a debug-signed
# artifact that installs and "verifies" perfectly — the failure is invisible
# without this check.
if grep -q "signingConfig signingConfigs.debug" "$APP_GRADLE" && \
   ! grep -q "signingConfig signingConfigs.release" "$APP_GRADLE"; then
  echo "ERROR: release buildType is STILL using the debug signing config."
  exit 1
fi
grep -q "signingConfig signingConfigs.release" "$APP_GRADLE" || {
  echo "ERROR: release signingConfig was not applied."; exit 1;
}

# -------------------------------------------------------------------
# 7. Build both artifacts
#
#    No manual `expo export:embed` here (build-apk.sh needs one because it
#    builds a debug variant that would otherwise expect a Metro server). The
#    React Native gradle plugin bundles + minifies JS for release variants
#    itself; bundling twice would be wasted work and could disagree.
#    Step 8 verifies the bundle actually made it into the artifacts.
# -------------------------------------------------------------------
cd "$PROJECT_DIR/android"
echo "[build-release] Building signed AAB (bundleRelease)..."
./gradlew bundleRelease
echo "[build-release] Building signed APK (assembleRelease)..."
./gradlew assembleRelease

# -------------------------------------------------------------------
# 8. Collect, verify, report
# -------------------------------------------------------------------
OUT_DIR="$PROJECT_DIR/build"
mkdir -p "$OUT_DIR"

AAB_SRC="$PROJECT_DIR/android/app/build/outputs/bundle/release/app-release.aab"
APK_SRC="$PROJECT_DIR/android/app/build/outputs/apk/release/app-release.apk"
AAB_DEST="$OUT_DIR/keepr-companion-$VERSION-$VERSION_CODE.aab"
APK_DEST="$OUT_DIR/keepr-companion-$VERSION-$VERSION_CODE.apk"

[ -f "$AAB_SRC" ] || { echo "ERROR: AAB not found at $AAB_SRC"; exit 1; }
[ -f "$APK_SRC" ] || { echo "ERROR: APK not found at $APK_SRC"; exit 1; }
cp "$AAB_SRC" "$AAB_DEST"
cp "$APK_SRC" "$APK_DEST"

BUILD_TOOLS="$(ls -d "$ANDROID_HOME"/build-tools/* | sort -V | tail -1)"
APKSIGNER="$BUILD_TOOLS/apksigner"
AAPT2="$BUILD_TOOLS/aapt2"

echo ""
echo "[build-release] --- verification ---"

# The compiled manifest is the only authority on what a user's device will
# report. app.json is an input; this is the output.
if [ -x "$AAPT2" ]; then
  echo "[verify] compiled manifest:"
  # NOT `| head -1`: under `set -o pipefail`, head closing the pipe makes aapt2
  # die on SIGPIPE, the pipeline reports failure, and errexit silently aborts
  # the script before any of the checks below run. Capture, then slice.
  BADGING="$("$AAPT2" dump badging "$APK_DEST" 2>/dev/null || true)"
  MANIFEST_LINE="${BADGING%%$'\n'*}"
  echo "  $MANIFEST_LINE"

  # The compiled manifest is the authority on what a device will report, so
  # assert it against app.json rather than just printing it. A mismatch here
  # means the artifact does not carry the version we think we built.
  case "$MANIFEST_LINE" in
    *"versionCode='$VERSION_CODE'"*) ;;
    *) echo "ERROR: APK manifest versionCode does not match app.json ($VERSION_CODE)"; exit 1 ;;
  esac
  case "$MANIFEST_LINE" in
    *"versionName='$VERSION'"*) ;;
    *) echo "ERROR: APK manifest versionName does not match app.json ($VERSION)"; exit 1 ;;
  esac
  echo "[verify] manifest matches app.json: $VERSION ($VERSION_CODE)"

  # BACKLOG-2956 — THE gate for the release-only cleartext blocker. Delegated
  # to a standalone script so it can be run against ANY apk, including the
  # pre-fix build/keepr-companion-1.1.0-2.apk that it must (and does) reject.
  # A gate nobody has watched fail is not a gate.
  "$SCRIPT_DIR/verify-apk-cleartext.sh" "$APK_DEST"
fi

# `apksigner verify` alone is NOT a useful check: a debug-signed APK verifies
# too. --print-certs is what distinguishes the release key from the public
# debug key, so the digest is printed for comparison against the known cert.
if [ -x "$APKSIGNER" ]; then
  echo "[verify] APK signer certificate:"
  CERTS="$("$APKSIGNER" verify --print-certs "$APK_DEST" 2>/dev/null || true)"
  echo "$CERTS" | grep -E "SHA-256 digest|Signer #1 certificate DN" || true
  # `apksigner verify` succeeding proves NOTHING about WHICH key signed it — a
  # debug-signed APK verifies too. The debug keystore's DN is the well-known
  # "CN=Android Debug"; refuse to ship an artifact carrying it.
  case "$CERTS" in
    *"CN=Android Debug"*)
      echo "ERROR: this APK is signed with the ANDROID DEBUG KEY, not the release key."
      exit 1
      ;;
  esac
  if "$APKSIGNER" verify "$APK_DEST" >/dev/null 2>&1; then
    echo "[verify] APK signature: OK"
  else
    echo "ERROR: APK failed signature verification"; exit 1
  fi
fi

# Prove the JS bundle really is inside the artifacts. A release APK missing
# index.android.bundle installs happily and then shows a red screen on launch.
for artifact in "$APK_DEST" "$AAB_DEST"; do
  # Capture the listing, THEN search it. `unzip -l ... | grep -q` looks correct
  # and can never succeed here: grep -q exits on its first match, unzip takes
  # SIGPIPE, and `set -o pipefail` turns the whole pipeline non-zero — so the
  # `if` always took the else branch and reported a missing bundle that was
  # present all along. Same defect as the `| head -1` above; any early-exit
  # consumer on the right of a pipe is unsafe while pipefail is on.
  LISTING="$(unzip -l "$artifact" 2>/dev/null || true)"
  case "$LISTING" in
    *"index.android.bundle"*)
      echo "[verify] $(basename "$artifact"): JS bundle embedded"
      ;;
    *)
      echo "ERROR: $(basename "$artifact") does not contain index.android.bundle"
      exit 1
      ;;
  esac
done

echo ""
echo "========================================="
echo "  RELEASE BUILD SUCCESSFUL"
echo "========================================="
echo "  Version : $VERSION (versionCode $VERSION_CODE)"
echo "  AAB     : $AAB_DEST"
echo "            $(du -h "$AAB_DEST" | cut -f1)"
echo "  APK     : $APK_DEST"
echo "            $(du -h "$APK_DEST" | cut -f1)"
echo ""
echo "  Sideload:  adb install -r \"$APK_DEST\""
echo ""
echo "  NOTE: a device holding an older DEBUG-signed build (anything shipped"
echo "  before BACKLOG-2956) must UNINSTALL first — Android refuses to update"
echo "  across a change of signing key (INSTALL_FAILED_UPDATE_INCOMPATIBLE)."
echo "  Uninstalling clears pairing and permissions, so the user re-pairs and"
echo "  re-grants SMS/Contacts afterwards."
echo "========================================="

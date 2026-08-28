#!/usr/bin/env bash
#
# build-apk.sh — Build debug APK for Keepr Companion (Android)
#
# Usage:
#   ./scripts/build-apk.sh
#
# Prerequisites:
#   - Java 17 (Homebrew: brew install openjdk@17)
#   - Android SDK at ~/Library/Android/sdk (via Android Studio or sdkmanager)
#   - Required SDK components: platforms;android-36, build-tools;36.0.0, ndk;27.1.12297006
#   - Node.js and npm
#
# Output:
#   android-companion/build/app-debug.apk

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# -------------------------------------------------------------------
# 1. Set environment
# -------------------------------------------------------------------
export JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home}"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"

if [ ! -d "$JAVA_HOME" ]; then
  echo "ERROR: JAVA_HOME not found at $JAVA_HOME"
  echo "Install Java 17: brew install openjdk@17"
  exit 1
fi

if [ ! -d "$ANDROID_HOME" ]; then
  echo "ERROR: ANDROID_HOME not found at $ANDROID_HOME"
  echo "Install Android SDK via Android Studio or sdkmanager"
  exit 1
fi

echo "[build-apk] JAVA_HOME=$JAVA_HOME"
echo "[build-apk] ANDROID_HOME=$ANDROID_HOME"
echo "[build-apk] Project: $PROJECT_DIR"

# -------------------------------------------------------------------
# 2. Install dependencies (if needed)
# -------------------------------------------------------------------
if [ ! -d "$PROJECT_DIR/node_modules" ]; then
  echo "[build-apk] Installing dependencies..."
  cd "$PROJECT_DIR"
  npm install --legacy-peer-deps
fi

# -------------------------------------------------------------------
# 3. Run expo prebuild (generates android/ directory)
# -------------------------------------------------------------------
if [ ! -d "$PROJECT_DIR/android" ] || [ "${FORCE_PREBUILD:-}" = "1" ]; then
  echo "[build-apk] Running expo prebuild..."
  cd "$PROJECT_DIR"
  npx expo prebuild --platform android --no-install --clean
fi

# -------------------------------------------------------------------
# 4. Patch android/build.gradle for async-storage local maven repo
#    (expo prebuild overwrites this file each time)
# -------------------------------------------------------------------
BUILD_GRADLE="$PROJECT_DIR/android/build.gradle"
if ! grep -q "local_repo" "$BUILD_GRADLE" 2>/dev/null; then
  echo "[build-apk] Patching build.gradle with async-storage local maven repo..."
  sed -i '' "/maven { url 'https:\/\/www.jitpack.io' }/a\\
\\    // Local maven repo for @react-native-async-storage/async-storage shared KMP module\\
\\    maven { url \"\$rootDir/../node_modules/@react-native-async-storage/async-storage/android/local_repo\" }
" "$BUILD_GRADLE"
fi

# -------------------------------------------------------------------
# 5. Create local.properties (points to Android SDK)
# -------------------------------------------------------------------
LOCAL_PROPS="$PROJECT_DIR/android/local.properties"
if [ ! -f "$LOCAL_PROPS" ]; then
  echo "sdk.dir=$ANDROID_HOME" > "$LOCAL_PROPS"
  echo "[build-apk] Created local.properties"
fi

# -------------------------------------------------------------------
# 6. Bundle JS + embed image assets for a self-contained APK (BACKLOG-2256)
#
#    The old `expo export` + manual .hbc copy embedded ONLY the JS bundle and
#    dropped every image asset, so every require()'d Image rendered blank in
#    the installed debug APK (login brand mark showed as a white square).
#
#    `expo export:embed` is the modern react-native bundle equivalent: it
#    writes the Hermes bytecode bundle to the gradle assets dir AND copies the
#    referenced images into android/app/src/main/res as drawable resources, so
#    they ship inside the APK. `--bytecode` emits Hermes bytecode (matches the
#    engine); Hermes also runs plain JS, so a non-bytecode fallback is safe.
# -------------------------------------------------------------------
echo "[build-apk] Bundling JS + embedding assets..."
cd "$PROJECT_DIR"

ASSETS_DIR="$PROJECT_DIR/android/app/src/main/assets"
RES_DIR="$PROJECT_DIR/android/app/src/main/res"
mkdir -p "$ASSETS_DIR"

# `--sourcemap-output` emits the JS source map alongside the bundle so Sentry
# can symbolicate minified production stack traces (BACKLOG-2222). metro.config.js
# (getSentryExpoConfig) stamps a matching Debug ID into both the bundle and this
# map; the guarded upload in step 6b ships the map to Sentry. With --bytecode,
# expo export:embed composes the Hermes source map here so the uploaded map maps
# Hermes bytecode frames back to source.
npx expo export:embed \
  --platform android \
  --dev false \
  --bytecode \
  --bundle-output "$ASSETS_DIR/index.android.bundle" \
  --sourcemap-output "$ASSETS_DIR/index.android.bundle.map" \
  --assets-dest "$RES_DIR"

if [ ! -f "$ASSETS_DIR/index.android.bundle" ]; then
  echo "ERROR: JS bundle was not produced at $ASSETS_DIR/index.android.bundle"
  exit 1
fi
echo "[build-apk] JS bundle: $(du -h "$ASSETS_DIR/index.android.bundle" | cut -f1)"
echo "[build-apk] Embedded drawable assets: $(find "$RES_DIR" -type d -name 'drawable*' -exec find {} -type f \; 2>/dev/null | wc -l | tr -d ' ')"

# -------------------------------------------------------------------
# 6b. Upload the JS source map to Sentry (BACKLOG-2222)
#
#    Makes minified production JS stack traces symbolicate in Sentry. Runs ONLY
#    when SENTRY_AUTH_TOKEN is set — local/dev builds without the token skip the
#    upload. This mirrors the runtime `enabled:!__DEV__` reporting gate and keeps
#    the auth token OUT of the repo (it is a secret; NEVER hardcode it).
#
#    Uploads to the SAME org/project as the runtime DSN (services/sentry.ts):
#    the `electron` project in org `keeprcompliancecom`. The --release/--dist
#    below MUST stay in sync with services/sentry.ts (`keepr-companion@<version>`
#    / `<versionCode>`) or traces won't match. The Debug ID injected by
#    metro.config.js is the primary matcher; release/dist is the fallback.
#
#    Required env for upload:
#      SENTRY_AUTH_TOKEN   (scopes: project:releases, org:read, project:read)
#    Optional overrides (default to the electron project on sentry.io US):
#      SENTRY_ORG          (default keeprcompliancecom)
#      SENTRY_PROJECT      (default electron)
#      SENTRY_URL          (default https://us.sentry.io)
# -------------------------------------------------------------------
BUNDLE_FILE="$ASSETS_DIR/index.android.bundle"
SOURCEMAP_FILE="$ASSETS_DIR/index.android.bundle.map"

if [ -n "${SENTRY_AUTH_TOKEN:-}" ]; then
  APP_VERSION="$(node -p "require('$PROJECT_DIR/app.json').expo.version")"
  # BACKLOG-2956: dist is the BUILD NUMBER (versionCode), matching the runtime
  # `dist` set in services/sentry.ts. It used to be the version name on both
  # sides, which made every build of "1.0.0" the same artifact as far as Sentry
  # was concerned. These two MUST agree or uploaded maps stop matching events.
  APP_BUILD="$(node -p "require('$PROJECT_DIR/app.json').expo.android.versionCode")"
  SENTRY_RELEASE="keepr-companion@$APP_VERSION"
  echo "[build-apk] Uploading source map to Sentry (release $SENTRY_RELEASE)..."
  # SENTRY_URL / SENTRY_AUTH_TOKEN are read from the environment by sentry-cli
  # ( --url is a global flag, not a `sourcemaps upload` option, so it is set via
  # env here). SENTRY_URL defaults to the US region that hosts the electron org.
  SENTRY_URL="${SENTRY_URL:-https://us.sentry.io}" \
  npx sentry-cli sourcemaps upload \
    --org "${SENTRY_ORG:-keeprcompliancecom}" \
    --project "${SENTRY_PROJECT:-electron}" \
    --release "$SENTRY_RELEASE" \
    --dist "$APP_BUILD" \
    --strip-prefix "$PROJECT_DIR" \
    "$BUNDLE_FILE" "$SOURCEMAP_FILE"
  echo "[build-apk] Source map uploaded to Sentry."
else
  echo "[build-apk] SENTRY_AUTH_TOKEN not set — skipping Sentry source-map upload (dev/local build)."
fi

# -------------------------------------------------------------------
# 7. Build debug APK
# -------------------------------------------------------------------
echo "[build-apk] Building debug APK..."
cd "$PROJECT_DIR/android"
./gradlew assembleDebug

# -------------------------------------------------------------------
# 8. Copy APK to a convenient location
# -------------------------------------------------------------------
APK_SRC="$PROJECT_DIR/android/app/build/outputs/apk/debug/app-debug.apk"
APK_DEST="$PROJECT_DIR/build/app-debug.apk"

if [ -f "$APK_SRC" ]; then
  mkdir -p "$PROJECT_DIR/build"
  cp "$APK_SRC" "$APK_DEST"
  echo ""
  echo "========================================="
  echo "  BUILD SUCCESSFUL"
  echo "========================================="
  echo "  APK: $APK_DEST"
  echo "  Size: $(du -h "$APK_DEST" | cut -f1)"
  echo ""
  echo "  Install on device:"
  echo "    adb install $APK_DEST"
  echo "========================================="
else
  echo "ERROR: APK not found at $APK_SRC"
  exit 1
fi

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

npx expo export:embed \
  --platform android \
  --dev false \
  --bytecode \
  --bundle-output "$ASSETS_DIR/index.android.bundle" \
  --assets-dest "$RES_DIR"

if [ ! -f "$ASSETS_DIR/index.android.bundle" ]; then
  echo "ERROR: JS bundle was not produced at $ASSETS_DIR/index.android.bundle"
  exit 1
fi
echo "[build-apk] JS bundle: $(du -h "$ASSETS_DIR/index.android.bundle" | cut -f1)"
echo "[build-apk] Embedded drawable assets: $(find "$RES_DIR" -type d -name 'drawable*' -exec find {} -type f \; 2>/dev/null | wc -l | tr -d ' ')"

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

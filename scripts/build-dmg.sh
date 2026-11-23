#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Build Netfari.app from extension/ and pack it into build/Netfari.dmg.
# Signing is ad-hoc: fine for your own Mac, Safari needs "Allow Unsigned Extensions".
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
PROJ_DIR="$ROOT/xcode"
PROJ="$PROJ_DIR/Netfari/Netfari.xcodeproj"
BUILD="$ROOT/build"
BUNDLE_ID="io.github.liu-yu-tung.Netfari"
BASE_VERSION=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$ROOT/extension/manifest.json")

# Every build gets its own number (base version + counter), so Safari's settings
# and the popup show which build is loaded. The counter file is not in git.
# RELEASE=1 builds the plain base version for a GitHub release.
COUNTER="$ROOT/.build-number"
if [ "${RELEASE:-0}" = 1 ]; then
  BUILD_NUM=$(cat "$COUNTER" 2>/dev/null || echo 0)
  VERSION="$BASE_VERSION"
else
  BUILD_NUM=$(( $(cat "$COUNTER" 2>/dev/null || echo 0) + 1 ))
  echo "$BUILD_NUM" > "$COUNTER"
  VERSION="$BASE_VERSION.$BUILD_NUM"
fi

# Regenerate every time: the project lists extension files one by one,
# so a stale project would leave out files added since.
rm -rf "$PROJ_DIR"
xcrun safari-web-extension-converter "$ROOT/extension" \
  --project-location "$PROJ_DIR" \
  --app-name Netfari \
  --bundle-identifier "$BUNDLE_ID" \
  --swift --macos-only --no-open --no-prompt --copy-resources

# Stamp the copied manifest only; extension/manifest.json stays as it is.
MANIFEST=$(find "$PROJ_DIR" -name manifest.json -path '*Resources*' | head -n 1)
sed -i '' "s/\"version\": *\"[^\"]*\"/\"version\": \"$VERSION\"/" "$MANIFEST"
grep -q "\"version\": \"$VERSION\"" "$MANIFEST"

rm -rf "$BUILD"
xcodebuild -project "$PROJ" -scheme Netfari -configuration Release \
  -derivedDataPath "$BUILD/dd" -destination 'generic/platform=macOS' \
  ARCHS="arm64 x86_64" ONLY_ACTIVE_ARCH=NO MACOSX_DEPLOYMENT_TARGET=12.0 \
  CODE_SIGN_STYLE=Manual CODE_SIGN_IDENTITY=- DEVELOPMENT_TEAM= \
  MARKETING_VERSION="$VERSION" CURRENT_PROJECT_VERSION="$BUILD_NUM" \
  build -quiet

APP="$BUILD/dd/Build/Products/Release/Netfari.app"
STAGE="$BUILD/stage"

# Keep only the dmg, so Safari doesn't list the build output as extra copies.
# Runs on exit, also when a step fails.
cleanup() {
  LSREG=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
  for app in "$APP" "$STAGE/Netfari.app"; do
    pluginkit -r "$app/Contents/PlugIns/Netfari Extension.appex" 2>/dev/null || true
    "$LSREG" -u "$app" 2>/dev/null || true
  done
  rm -rf "$BUILD/dd" "$STAGE"
}
trap cleanup EXIT

mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"

# Fails with "Resource busy" while an older Netfari.dmg is still mounted.
hdiutil create -volname Netfari -srcfolder "$STAGE" -format UDZO -ov "$BUILD/Netfari.dmg" >/dev/null
echo "Netfari $VERSION: $BUILD/Netfari.dmg"

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
VERSION=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$ROOT/extension/manifest.json")

if [ ! -d "$PROJ" ]; then
  xcrun safari-web-extension-converter "$ROOT/extension" \
    --project-location "$PROJ_DIR" \
    --app-name Netfari \
    --bundle-identifier "$BUNDLE_ID" \
    --swift --macos-only --no-open --no-prompt
fi

rm -rf "$BUILD"
xcodebuild -project "$PROJ" -scheme Netfari -configuration Release \
  -derivedDataPath "$BUILD/dd" \
  CODE_SIGN_STYLE=Manual CODE_SIGN_IDENTITY=- DEVELOPMENT_TEAM= \
  MARKETING_VERSION="$VERSION" \
  build -quiet

APP="$BUILD/dd/Build/Products/Release/Netfari.app"
STAGE="$BUILD/stage"
mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"

hdiutil create -volname Netfari -srcfolder "$STAGE" -format UDZO -ov "$BUILD/Netfari.dmg" >/dev/null

# Keep only the dmg, so Safari doesn't list the build output as extra copies.
LSREG=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
for app in "$APP" "$STAGE/Netfari.app"; do
  pluginkit -r "$app/Contents/PlugIns/Netfari Extension.appex" 2>/dev/null || true
  "$LSREG" -u "$app" 2>/dev/null || true
done
rm -rf "$BUILD/dd" "$STAGE"
echo "$BUILD/Netfari.dmg"

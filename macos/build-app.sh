#!/usr/bin/env bash
# Build "AI Browser Bridge.app" (menu-bar app) around the single-executable
# ai-bridge binary and the extension folder, then wrap it in a .dmg.
#   macos/build-app.sh            → dist/macos/AI Browser Bridge.app + dist/macos/AI-Browser-Bridge-<ver>-<arch>.dmg
# Requires Xcode Command Line Tools (swiftc). Signing is ad hoc; the release
# pipeline replaces it with Developer ID + notarization.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
VERSION=$(node -p "require('./package.json').version")
ARCH=$(uname -m)
APP="AI Browser Bridge"
OUT="$ROOT/dist/macos"
BUNDLE="$OUT/$APP.app"
BIN="$ROOT/dist/ai-bridge"
EXT_ID=$(cat extension/EXTENSION_ID)
STORE_URL="${AI_BRIDGE_STORE_URL:-}"   # set once the extension is on the Chrome Web Store

[ -x "$BIN" ] || npm run build:sea
rm -rf "$BUNDLE"; mkdir -p "$BUNDLE/Contents/MacOS" "$BUNDLE/Contents/Resources"

# generated config
GEN="$OUT/gen"; mkdir -p "$GEN"
cat > "$GEN/Config.swift" <<SWIFT
enum Config {
    static let extensionID = "$EXT_ID"
    static let storeURL: String? = $( [ -n "$STORE_URL" ] && printf '"%s"' "$STORE_URL" || printf 'nil' )
}
SWIFT

echo "compiling app…"
swiftc -O -swift-version 5 -target "${ARCH}-apple-macosx13.0" \
  -framework Cocoa -framework ServiceManagement \
  macos/AIBridge/Sources/*.swift "$GEN/Config.swift" \
  -o "$BUNDLE/Contents/MacOS/$APP"

cp "$BIN" "$BUNDLE/Contents/MacOS/ai-bridge"; chmod +x "$BUNDLE/Contents/MacOS/ai-bridge"
rsync -a --exclude EXTENSION_ID extension/ "$BUNDLE/Contents/Resources/extension/"
sed "s/@VERSION@/$VERSION/g" macos/AIBridge/Info.plist.in > "$BUNDLE/Contents/Info.plist"
echo "APPL????" > "$BUNDLE/Contents/PkgInfo"

echo "icon…"
swift macos/gen-icon.swift "$GEN/AppIcon.iconset" >/dev/null
iconutil -c icns "$GEN/AppIcon.iconset" -o "$BUNDLE/Contents/Resources/AppIcon.icns"

echo "signing (ad hoc)…"
codesign --force --sign - "$BUNDLE/Contents/MacOS/ai-bridge"
codesign --force --sign - "$BUNDLE"

echo "dmg…"
STAGE="$OUT/stage"; rm -rf "$STAGE"; mkdir -p "$STAGE"
cp -R "$BUNDLE" "$STAGE/"; ln -s /Applications "$STAGE/Applications"
DMG="$OUT/AI-Browser-Bridge-$VERSION-$ARCH.dmg"; rm -f "$DMG"
hdiutil create -volname "$APP" -srcfolder "$STAGE" -ov -format UDZO -quiet "$DMG"
rm -rf "$STAGE" "$GEN"
echo "built: $BUNDLE"
echo "built: $DMG ($(du -h "$DMG" | cut -f1))"

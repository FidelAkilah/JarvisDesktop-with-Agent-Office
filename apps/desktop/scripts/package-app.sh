#!/bin/bash
# Packages JARVIS.app and installs it to /Applications.
# Run from apps/desktop:  npm run package
set -euo pipefail
cd "$(dirname "$0")/.."

REPO_ROOT="$(cd ../.. && pwd)"
echo "→ repo: $REPO_ROOT"

echo "→ building renderer"
npm run build >/dev/null

echo "→ generating icon"
python3 scripts/make-icon.py >/dev/null

echo "→ baking repo path (sidecars + .env live in the repo)"
printf '{"repoRoot": "%s"}\n' "$REPO_ROOT" > home.json

echo "→ packaging JARVIS.app"
npx @electron/packager . JARVIS \
  --platform=darwin --arch=arm64 \
  --out=release --overwrite \
  --ignore='^/src($|/)' --ignore='^/scripts($|/)' --ignore='^/release($|/)' \
  --ignore='^/build/icon\.iconset' --ignore='\.map$' >/dev/null

APP="release/JARVIS-darwin-arm64/JARVIS.app"

echo "→ applying the arc-reactor icon"
cp build/icon.icns "$APP/Contents/Resources/electron.icns"

echo "→ adding microphone usage description"
/usr/libexec/PlistBuddy -c \
  "Add :NSMicrophoneUsageDescription string 'JARVIS listens for \"Hey Jarvis\" and your voice commands.'" \
  "$APP/Contents/Info.plist" 2>/dev/null || true

echo "→ installing to /Applications"
rm -rf /Applications/JARVIS.app
cp -R "$APP" /Applications/

rm -f home.json
echo "✓ /Applications/JARVIS.app ready"

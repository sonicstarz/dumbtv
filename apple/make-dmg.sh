#!/usr/bin/env bash
# Build the Mac app and package it into a .dmg for GitHub Releases.
#
#   ./make-dmg.sh                # unsigned (dev / CI without certs)
#   TEAM_ID=XXced ./make-dmg.sh  # Developer ID signed (then notarize separately)
#
# Notarization (once signed) is a separate step:
#   xcrun notarytool submit build/dumbTV.dmg --keychain-profile <profile> --wait
#   xcrun stapler staple build/dumbTV.dmg
set -euo pipefail
cd "$(dirname "$0")"

CONFIG="${CONFIG:-Release}"
xcodegen generate

SIGN_ARGS=(CODE_SIGNING_ALLOWED=NO)
if [ -n "${TEAM_ID:-}" ]; then
  SIGN_ARGS=(DEVELOPMENT_TEAM="$TEAM_ID" CODE_SIGN_STYLE=Automatic
             CODE_SIGN_IDENTITY="Developer ID Application" CODE_SIGNING_ALLOWED=YES)
fi

echo "==> building dumbTV-macOS ($CONFIG)"
xcodebuild build -project dumbTV.xcodeproj -scheme dumbTV-macOS \
  -configuration "$CONFIG" -destination 'platform=macOS' -derivedDataPath build \
  "${SIGN_ARGS[@]}" -quiet

APP="build/Build/Products/$CONFIG/dumbTV.app"
[ -d "$APP" ] || { echo "error: $APP not found" >&2; exit 1; }

STAGE="$(mktemp -d)/dumbTV"
mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"     # drag-to-install

# The .app is now staged; drop the heavy build intermediates and SPM checkouts
# (VLCKit's static libs are large) so hdiutil has room on space-tight CI runners.
rm -rf build/Build/Intermediates.noindex build/SourcePackages build/Build/Products/*/*.swiftmodule 2>/dev/null || true

OUT="build/dumbTV.dmg"; rm -f "$OUT"
hdiutil create -volname "dumbTV" -srcfolder "$STAGE" -ov -format UDZO "$OUT" >/dev/null
echo "==> created $OUT ($(du -h "$OUT" | cut -f1))"
[ -z "${TEAM_ID:-}" ] && echo "    (unsigned — sign + notarize before public distribution)"

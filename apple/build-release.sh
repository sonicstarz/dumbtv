#!/usr/bin/env bash
# Archive + export all dumbTV apps for the App Store. Ready to run the moment
# Apple Developer enrollment clears — just pass your Team ID.
#
#   ./build-release.sh <TEAM_ID> [ios|tvos|macos ...]   (default: all three)
#
# Exports .ipa/.pkg into build/export/<scheme>/. Upload with Transporter or:
#   xcrun altool --upload-app -f <file> --apiKey ... --apiIssuer ...   (or notarytool for the .dmg)
set -euo pipefail

TEAM="${1:?Usage: ./build-release.sh <TEAM_ID> [ios tvos macos]}"; shift || true
cd "$(dirname "$0")"

WANT=("$@"); [ ${#WANT[@]} -eq 0 ] && WANT=(ios tvos macos)

xcodegen generate

archive_one() {
  local scheme="$1" dest="$2"
  echo "==> archiving $scheme"
  xcodebuild archive \
    -project dumbTV.xcodeproj -scheme "$scheme" -destination "$dest" \
    -archivePath "build/archives/$scheme.xcarchive" \
    DEVELOPMENT_TEAM="$TEAM" CODE_SIGN_STYLE=Automatic \
    CODE_SIGNING_ALLOWED=YES CODE_SIGNING_REQUIRED=YES \
    -allowProvisioningUpdates
  echo "==> exporting $scheme"
  xcodebuild -exportArchive \
    -archivePath "build/archives/$scheme.xcarchive" \
    -exportPath "build/export/$scheme" \
    -exportOptionsPlist ExportOptions-AppStore.plist \
    -allowProvisioningUpdates
}

for p in "${WANT[@]}"; do
  case "$p" in
    ios)   archive_one dumbTV-iOS   "generic/platform=iOS" ;;
    tvos)  archive_one dumbTV-tvOS  "generic/platform=tvOS" ;;
    macos) archive_one dumbTV-macOS "generic/platform=macOS" ;;
    *) echo "unknown platform: $p" >&2; exit 1 ;;
  esac
done

echo "Done. Exports in build/export/. Upload each to App Store Connect."

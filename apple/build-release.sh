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

# Export options carrying the team. Written per-run so the script stays
# team-agnostic (pass any Team ID on the command line).
EXPORT_PLIST="$(mktemp)"
cat > "$EXPORT_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>export</string>
  <key>signingStyle</key><string>automatic</string>
  <key>teamID</key><string>$TEAM</string>
  <key>generateAppStoreInformation</key><true/>
</dict></plist>
EOF

archive_one() {
  local scheme="$1" dest="$2"
  echo "==> archiving $scheme (unsigned; team baked in)"
  # Archive UNSIGNED with the team set. The App Store export below then creates
  # a *distribution* provisioning profile — which needs NO registered devices,
  # unlike a development profile — and signs the artifact. This is what lets a
  # device-free machine (or CI) produce App Store builds; a normal signed
  # archive would fail on "your team has no devices".
  xcodebuild archive \
    -project dumbTV.xcodeproj -scheme "$scheme" -destination "$dest" \
    -archivePath "build/archives/$scheme.xcarchive" \
    DEVELOPMENT_TEAM="$TEAM" CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO
  echo "==> exporting $scheme for the App Store"
  xcodebuild -exportArchive \
    -archivePath "build/archives/$scheme.xcarchive" \
    -exportPath "build/export/$scheme" \
    -exportOptionsPlist "$EXPORT_PLIST" \
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

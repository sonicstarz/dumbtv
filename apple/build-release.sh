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
  local scheme="$1" dest="$2" mode="$3"
  if [ "$mode" = "signed" ]; then
    # macOS: archive WITH signing so the App Sandbox + network entitlements
    # (CODE_SIGN_ENTITLEMENTS) are baked in — App Store rejects an un-sandboxed
    # Mac app. macOS signing needs NO registered devices, so this is safe.
    echo "==> archiving $scheme (signed; entitlements embedded)"
    xcodebuild archive \
      -project dumbTV.xcodeproj -scheme "$scheme" -destination "$dest" \
      -archivePath "build/archives/$scheme.xcarchive" \
      DEVELOPMENT_TEAM="$TEAM" CODE_SIGN_STYLE=Automatic \
      CODE_SIGNING_ALLOWED=YES CODE_SIGNING_REQUIRED=YES -allowProvisioningUpdates
  else
    # iOS/tvOS: archive UNSIGNED with the team set; the export below mints a
    # *distribution* profile (needs NO registered devices, unlike a development
    # one) and signs. A normal signed archive here fails on "no devices".
    echo "==> archiving $scheme (unsigned; team baked in)"
    xcodebuild archive \
      -project dumbTV.xcodeproj -scheme "$scheme" -destination "$dest" \
      -archivePath "build/archives/$scheme.xcarchive" \
      DEVELOPMENT_TEAM="$TEAM" CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO
  fi
  echo "==> exporting $scheme for the App Store"
  xcodebuild -exportArchive \
    -archivePath "build/archives/$scheme.xcarchive" \
    -exportPath "build/export/$scheme" \
    -exportOptionsPlist "$EXPORT_PLIST" \
    -allowProvisioningUpdates
}

for p in "${WANT[@]}"; do
  case "$p" in
    ios)   archive_one dumbTV-iOS   "generic/platform=iOS"   unsigned ;;
    tvos)  archive_one dumbTV-tvOS  "generic/platform=tvOS"  unsigned ;;
    macos) archive_one dumbTV-macOS "generic/platform=macOS" signed ;;
    *) echo "unknown platform: $p" >&2; exit 1 ;;
  esac
done

echo "Done. Exports in build/export/. Upload each to App Store Connect."

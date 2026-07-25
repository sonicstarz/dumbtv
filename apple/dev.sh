#!/usr/bin/env bash
# dumbTV — local dev run. Builds the Mac app from the CURRENT source and
# launches it. This is the fast test loop: no GitHub, no .dmg, no quarantine.
#
#   ./apple/dev.sh            # pull latest, build, relaunch
#   ./apple/dev.sh --no-pull  # build exactly what's checked out now
#
# The web config UI (public/*) is served by the app — for web-only tweaks you
# don't even need this: edit the file and reload the browser tab.
set -euo pipefail
cd "$(dirname "$0")"

if [ "${1:-}" != "--no-pull" ]; then
  echo "==> git pull"
  (cd .. && git pull --ff-only) || echo "   (pull skipped — local changes or offline)"
fi

echo "==> xcodegen"
command -v xcodegen >/dev/null || brew install xcodegen
xcodegen generate >/dev/null

echo "==> build (Debug)"
xcodebuild -project dumbTV.xcodeproj -scheme dumbTV-macOS \
  -destination 'platform=macOS' -derivedDataPath build -configuration Debug build \
  -quiet CODE_SIGNING_ALLOWED=NO

APP="build/Build/Products/Debug/dumbTV.app"
echo "==> relaunch $APP"
killall dumbTV 2>/dev/null || true
sleep 1
open "$APP"
echo "==> up. Config UI: http://localhost:8080"

#!/usr/bin/env bash
# Set the dumbTV version in one place — Node (package.json) and Apple
# (project.yml MARKETING_VERSION) stay in lockstep, so a release tag means
# one version across both products.
#
#   ./scripts/set-version.sh 1.0.1
set -euo pipefail

V="${1:?Usage: ./scripts/set-version.sh <x.y.z>}"
[[ "$V" =~ ^[0-9]+\.[0-9]+(\.[0-9]+)?$ ]] || { echo "version must look like 1.0 or 1.0.1" >&2; exit 1; }

cd "$(dirname "$0")/.."

# package.json
python3 - "$V" <<'PY'
import json, sys
v = sys.argv[1]
p = json.load(open("package.json"))
p["version"] = v
open("package.json", "w").write(json.dumps(p, indent=2) + "\n")
PY

# apple/project.yml  MARKETING_VERSION
perl -pi -e 's/(MARKETING_VERSION:\s*")[^"]*(")/${1}'"$V"'${2}/' apple/project.yml

echo "Set version $V in package.json and apple/project.yml."
echo "Next: (cd apple && xcodegen generate) ; git commit -am \"Release v$V\" ; git tag v$V"

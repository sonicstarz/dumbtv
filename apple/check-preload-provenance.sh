#!/usr/bin/env bash
# Gate on what actually goes INSIDE the App Store binary.
#
#   ./check-preload-provenance.sh            # check every PRELOAD pack's built dist
#   ./check-preload-provenance.sh <dist.json>
#
# WHY THIS EXISTS
#
# `build-pack.js` has a provenance gate, but it runs at BUILD time. The Xcode
# bundle phase does not: it copies any pack with a PRELOAD marker and a built
# `dist/pack.json`, whatever is in it. So a dist encoded before the rights schema
# existed — or with --allow-unverified — ships in the binary with the gate never
# having seen it.
#
# That is not hypothetical. Build 18 was archived with `ad-break` and
# `saturday-morning` inside it, carrying four titles with NO rights basis
# recorded at all, while the download catalog was correctly refusing the very
# same packs. The reversible path was clean and the irreversible one was not.
#
# FAILS CLOSED. A missing basis is a failure, not a pass. The first version of
# this check tested for "CLAIMED, or NR without a citation" and a `basis: null`
# sailed straight through it — an absent claim read as a safe one. Anything this
# script cannot positively verify, it rejects.
set -euo pipefail

cd "$(dirname "$0")/.."

check_one() {
  python3 - "$1" "$2" <<'PY'
import json, os, sys
pid, path = sys.argv[1], sys.argv[2]
d = json.load(open(path))
# Only these may ship inside the binary. CLAIMED is deliberately absent: it is
# fine in the download catalog (pull it in minutes) and never here (needs an app
# review cycle, and a complaint via Apple can take the whole app down).
PRELOADABLE = {"GOV", "AGE", "NR", "CC"}
bad = []
for i in d.get("items", []):
    lic = i.get("license") or {}
    basis, title = lic.get("basis"), i.get("title", i.get("id", "?"))
    if not basis:
        bad.append(f'{title} — NO license.basis (dist predates the rights schema, or was built --allow-unverified)')
    elif basis not in PRELOADABLE:
        bad.append(f'{title} — basis {basis} may not ship in a preloaded pack')
    elif basis == "NR" and not lic.get("verifiedBy"):
        bad.append(f'{title} — basis NR with no license.verifiedBy')
if bad:
    print(f'\n⛔ {pid}: {len(bad)} item(s) may NOT ship inside the App Store binary:')
    for b in bad:
        print(f'   - {b}')
    print(f'   Fix: cite them, or remove packs/{pid}/PRELOAD and ship it as a download.')
    sys.exit(1)
print(f'✓ {pid}: {len(d.get("items", []))} item(s), all clear for preload')
PY
}

if [ $# -eq 1 ]; then
  check_one "$(basename "$(dirname "$(dirname "$1")")")" "$1"
  exit $?
fi

fail=0
found=0
for marker in packs/*/PRELOAD; do
  [ -e "$marker" ] || continue
  pid="$(basename "$(dirname "$marker")")"
  dist="packs/$pid/dist/pack.json"
  # Not built is not a failure — the bundle phase skips it with a warning.
  [ -f "$dist" ] || { echo "· $pid: not built, will be skipped"; continue; }
  found=$((found + 1))
  check_one "$pid" "$dist" || fail=1
done

[ "$found" -eq 0 ] && echo "no built PRELOAD packs found"
if [ "$fail" -ne 0 ]; then
  echo ""
  echo "PRELOAD PROVENANCE CHECK FAILED — this content would ship inside the binary."
  exit 1
fi
exit 0

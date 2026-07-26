# Build 11/12 — implementation handoff

**For the implementing session (Opus). Planning is DONE — this doc + its two
companions are everything you need. Read in this order:**

1. `CLAUDE.md` — invariants. They override everything here if in conflict.
2. `docs/build-10-test-triage.md` — the bug list from real-device testing,
   root-caused with file:line evidence (items A1–A5, B1–B3, C1–C6, phases).
3. **This file** — additional audit findings (N1–N8), fix specs, environment
   quirks, build/release procedure, acceptance criteria.

Companion for background only (don't re-plan): `docs/content-without-plex.md`
(Track I design), Notion "Master Release Roadmap" (status home — update it as
you land things).

---

## Environment quirks (will bite you if skipped)

- **Node:** better-sqlite3 does NOT build on the default Node 26. Run all Node
  things with `/opt/homebrew/opt/node@22/bin/node` (keg-only node@22).
  - Tests: `/opt/homebrew/opt/node@22/bin/node scripts/selftest.js` → expect **49/0** before your changes.
- **Swift:** `cd apple/dumbTVCore && swift test` → expect **63 pass / 1 skip** (skip = PlexLive, needs live Plex).
- **Apple builds:** after ANY `apple/project.yml` change run `cd apple && xcodegen generate`.
  Build check: `xcodebuild -project dumbTV.xcodeproj -scheme dumbTV-iOS -configuration Debug -destination 'generic/platform=iOS Simulator' build` (same for `-macOS` w/ `platform=macOS`, `-tvOS` w/ tvOS Simulator).
- **No tvOS simulator runtime is installed** on this machine — tvOS compiles
  but cannot be run/screenshotted locally. That's why build 11 is
  **diagnostics-first** (see A5 spec below): the build must carry on-screen
  evidence for the user's real Apple TV.
- **SourceKit noise:** the IDE reports "No such module dumbTVCore/VLCKitSPM"
  diagnostics constantly. They're false; trust `swift build`/`xcodebuild`.
- **Release/exports:** `apple/build-release.sh B875CKJ7J5` archives+exports all
  three (iOS/tvOS unsigned-archive → export mints distribution profile; macOS
  signed for sandbox entitlements). **Bump `CURRENT_PROJECT_VERSION` in
  project.yml before every export** (currently 10 → next is 11). MARKETING_VERSION
  is 1.2.0. Artifacts land in `apple/build/export/`; user uploads via Transporter.
- **GitHub:** account upgraded — push + Actions are fine now. The **CI workflow
  has been failing in ~4s on every push for a while (pre-existing)**; the
  Release workflow works (v1.2.0 published). Fixing CI is fair game if quick.
- **Screenshot/dev hooks** (env-gated, harmless in prod): `DUMBTV_SCREENSHOT=1`
  pins the banner + suppresses first-run overlays; `DUMBTV_START_GUIDE=1` opens
  the guide; `DUMBTV_START_SETUP=1` opens channel 00. Launch via
  `SIMCTL_CHILD_… xcrun simctl launch …`. iPhone sim UDID used before:
  `023C2F14-9D95-4C88-BA77-AC87AC34EEC8` (iPhone 17 Pro Max).
- **Verify visually in the sim** after UI changes: the apps render landscape
  inside a portrait sim framebuffer — rotate screenshots 90° (`sips -r 90`).

---

## NEW audit findings (N-series) — found by code inspection after the device round

### N1 · Node: partial downloads poison the pack cache 🔴
`src/packs/install.js:220` — `if (!fs.existsSync(dest)) await downloadTo(...)`.
`downloadTo` streams straight into `dest`; a crash/kill mid-download leaves a
truncated file that the exists-check then treats as complete **forever** →
corrupt media registered and played. **Fix:** download to `dest + '.part'`,
rename on success; on install, verify size (catalog has `bytes`) or sha256
before accepting an existing file. (Swift is safer — `URLSession.download`
lands in a temp file then moves — but has no resume; see N5.)

### N2 · Channel-number collisions: Node 500s, Swift silently "succeeds" with id 0 🔴
`channels.number` is `UNIQUE` in both schemas.
- Node `POST /api/channels` (`src/routes/api.js:297`) does a plain INSERT →
  a duplicate number **throws → 500** to the UI.
- Swift (`ConfigAPI.swift:272`) `insertChannel` is `try?` → returns **0** on
  conflict → responds `.ok(["id": 0])` — a phantom success the UI then acts on.
- The web UI picks `number = state.channels.length + 2` (`app.js:746-749`),
  which collides easily now that the preload channel sits at number 7.
**Fix:** both backends: pick `MAX(number)+1` when the requested number is taken
(or return 409 with a clear error); Swift must treat id 0 as failure. Web UI:
stop guessing numbers — omit `number` and let the backend assign.

### N3 · Pack channel-number hints collide too 🟠
`createChannelFromPack` (both backends) uses the manifest hint (e.g. SATURDAY
MORNING → number 7). If the user already has a channel 7: Swift returns nil
(good-ish), **Node throws inside the transaction** → 500 from
`POST /api/packs/:id/channel`. **Fix:** fall back to next-free-number when the
hint is taken (both backends), keep the hint as a preference only.

### N4 · tvOS: downloaded packs ALSO use Application Support 🔴 (A5 family)
`Packs+API.swift:40-45` — `downloadedPacksDir()` is Application Support. The
same real-tvOS write restriction that (probably) kills the Store will kill pack
downloads. **Fix together with A5:** a single `Store.dataRoot()` helper that
picks Application Support on iOS/macOS and **Caches on tvOS**, used by BOTH the
DB path (`dumbTVApp.openStore`) and `downloadedPacksDir`; mirror the small
critical settings (plex token/uri, `setup_seen`, `preload_seeded`) to
UserDefaults so a Caches purge doesn't unlink Plex. Purged media re-downloads
(pack picker already handles "not installed").

### N5 · iOS pack downloads die on app suspension 🟠
`Packs+API.swift packInstall` uses `URLSession.shared` + `Task.detached` — the
user backgrounds the app, the Superman download dies silently; progress UI
never completes. **Fix (choose scope):** minimum = mark progress "error:
interrupted" on resume + a Retry button (per-file skip-if-complete gives coarse
resume); proper = `URLSessionConfiguration.background`. Document whichever in
the pack-picker UI ("keep the app open during downloads" if minimum).

### N6 · A5 has a competing hypothesis — build the diagnostics to distinguish 🟠
Triage A5 (store fails on real tvOS) explains no-QR/no-server/no-packs, but if
the store were nil, `bootstrapFromEnvIfPresent()` should still have started the
**demo lineup** — yet the user reported an *empty guide and a dead remote*.
Alternative: a **main-thread hang** on real tvOS (VLCKit init at app scope, or
Store/SQLite blocking) freezing UI + input after first paint. The A5 diagnostics
screen must therefore show: store state (path + open error), server state
(NWListener state/port), channel count, current program, **VLC player state**,
and LAN IP — and app init should be staggered/instrumented so a hang is
localizable. Design the channel-00 diagnostics so ONE TestFlight screenshot
answers which hypothesis is true.

### N7 · `setup_seen` is set by ANY /api/status hit 🟡
`ConfigAPI.status()` marks setup as seen — including a port-scan or a browser
prefetch, not just a real config-page visit. Minor: move the flag to a hit on
`/` (the actual page load) or `/api/channels`. Low priority.

### N8 · Misc hardening (batch with nearby work) 🟡
- `resolvePackPath` doesn't check the file exists → missing media = VLC error
  loop behind bars. Cheap existence check + log (matches vanished-file rule).
- `preload_seeded` means a deleted preload channel never reseeds — intended,
  but add "reinstall starter channels" to the web-UI packs view so it's a
  feature, not a mystery.
- Web packs view keeps polling only while open — fine — but a page reload
  during a download shows stale "Install" until `GET /api/packs` returns
  progress; verify the merge renders `downloading` state on first load.
- `loadPacks._t` timer isn't cleared when navigating away (harmless dup poll).

---

## What to build (order + acceptance criteria)

### BUILD 11 — "Apple TV alive + playback correct" (phases F1+F2 from triage)
1. **A5+N4+N6 tvOS rescue, diagnostics-first**
   - `dataRoot()` (Caches on tvOS) for DB + downloads; settings mirrored to
     UserDefaults; surface `openStore`/listener errors.
   - Channel-00 diagnostics block (store/server/IP/channels/VLC state).
   - Staggered init so a hang is localizable.
   - ✅ Accept: tvOS sim boots with preload channels + QR (localhost); on the
     user's real ATV, EITHER it works OR the diagnostics screen names the failure.
2. **A1 ad partKey** — register pack ads with `partKey`; Swift test: an ad slot
   resolves to a playable file URL. ✅ Accept: restart-into-ad-break plays the ad.
3. **A2 layout precedence** — guide renders above setup channel; exiting setup
   on tune stays correct. ✅ Accept: double-tap on ch-00 opens the guide (sim
   screenshot); swipe on ch-00 changes channel.
4. **B3 tvOS remote remap** — up/down=channel, select=guide (drop two-step),
   select-in-guide=tune, back=dismiss. Coach-mark text updated. ✅ Accept: code
   paths per spec (real-device confirm by user).
5. **B2 single video surface** — one persistent surface across watch/guide
   layouts. ✅ Accept: sim — open guide, select same channel: picture continues
   (no black), no restart (audio uninterrupted).
6. **B1 mute/CC hardening** — front-player only, off-main VLC calls, debounce.
   ✅ Accept: sim — spam mute/CC; banner stays stable; gestures never die.
7. **N2/N3 number collisions** — backend fallback to next-free number + honest
   errors; web UI stops sending guessed numbers. ✅ Accept: create channels
   with 7 taken (Node test + Swift test + manual web check).
8. Cut **build 11** (bump CURRENT_PROJECT_VERSION → 11, `build-release.sh`),
   hand the user the three Transporter paths. Sim-verify iOS first run + guide
   + ch-00 + packs view before handing off.

### BUILD 12 — "config UX right" (phases F3+F4)
9. **A3 create-on-save** — Add-channel opens the editor WITHOUT creating;
   Create happens on save (or DELETE on cancel). Use returned `{id}` (fix the
   positional-last bug). ✅ Accept: cancel leaves no channel; editor opens the
   channel you just made.
10. **A4 server concurrency + image caching** — per-request tasks; `/api/image`
    disk LRU + Plex sized-thumb params; picker connected-dot + spinner (C6).
    ✅ Accept: picker populates while a pack downloads; art renders on iOS sim.
11. **N1 partial-download fix** (+ N5 minimum: interrupted→Retry).
12. **C1 QR dismiss ✕** (hide until next launch; does NOT set `setup_seen`).
13. **C3 packs in the Add-content picker** (installed selectable; not-installed
    greyed + Download button; N8 "reinstall starter channels" here too).
14. **C4 byte-level progress** (bytes done/total, speed, ETA — Node byte
    counting + Swift URLSession delegate; wire into both pack UIs).
15. **C5 Jellyfin honesty on Apple** — hide the toggle on the embedded server
    (native:true in /api/status is already there to key off) or label "coming
    soon". Node keeps it.
16. **C2/channel-00 copy** — replace the fallback sentence (diagnostics block
    covers server-down; QR card covers server-up).
17. Cut **build 12** (→ CURRENT_PROJECT_VERSION 12).

### CONTENT — owner-directed additions (2026-07-26) · *build alongside BUILD 11*

The owner wants the preload lineup expanded. Manifests are **already authored
and PD-verified** (`build-pack.js verify` passes on all five packs) — your job
is building/bundling, not curation:

**C-1 · SUPERMAN preload channel with ONE bundled episode** (testing aid)
- `packs/superman/PRELOAD` marker is already set. Build the partial dist:
  `node scripts/build-pack.js build superman --only the-mad-scientist`
  (downloads a 208 MB HD source from IA, re-encodes to 480p — expect ~40–60 MB
  bundled). The project.yml bundling step picks it up automatically.
- First run then seeds a SUPERMAN channel (manifest hint: number 6) looping
  *The Mad Scientist* — join-in-progress on a real episode, ideal for testing.
- **Partial-pack upgrade (spec):** the picker must detect installed-item-count
  < catalog-item-count and offer **"Download all 17 episodes"** — installing
  the full pack repoints `root_path` to the downloaded copy and upserts all 17
  media rows (the model already handles this; the UI affordance is what's
  missing). Add a test: partial install (1 item) → full install → 17 items,
  channel schedule extends, no duplicates.

**C-2 · POPEYE IN COLOR pack** — `packs/popeye-color/manifest.json` authored:
the three Technicolor two-reelers (Sindbad '36 / Ali Baba '37 / Aladdin '39),
all PD-verified with IA PD marks, channel hint number 8, release_order.
⚠️ Ali Baba + Aladdin sources are HD (~1.2–1.6 GB each) — **built-pack delivery
only** (the 480p re-encode shrinks them); do NOT let the picker download these
raw (the catalog's `downloadBytes` will make that obvious — respect it, or
regenerate the catalog after deciding delivery).

**C-3 · EARLY DISNEY pack** — `packs/early-disney/manifest.json` authored:
*Plane Crazy* (1928) · *Steamboat Willie* (1928) · *The Skeleton Dance* (1929),
all PD-verified with IA PD marks, channel hint number 9, release_order.
⚠️ Trademark note is IN the manifests: films are PD, Mickey is a Disney
trademark — never use Disney characters in dumbTV marketing/screenshots.

**C-4 · Preload set for build 11** (owner: "I want all of that built out"):
build + PRELOAD-mark **popeye-color** and **early-disney** too
(`build-pack.js build <id>` + `touch packs/<id>/PRELOAD`). Expected preload:
SATURDAY MORNING (7) · SUPERMAN (6, one ep) · POPEYE (8) · EARLY DISNEY (9) +
AD BREAK assets. Rough bundled size: ~219 MB existing + ~50 MB Superman ep +
~90 MB Popeye (480p) + ~25 MB Disney ≈ **~380 MB** — inside the D1 starter
budget. If it runs hot, raise CRF to 28 on the heavy items.
- After building packs, regenerate the catalog: `node scripts/build-pack.js catalog`
  (note: catalog durations for popeye/disney come from IA metadata).
- Remember N3 (number-hint collisions) applies to the new hints 6/8/9.

### JELLYFIN (P7) — status + unblock path (owner asked 2026-07-26)
State: **Node = fully written, never verified live** (src/jellyfin/, 295 lines,
web-UI forms exist) · **Apple = stub only** (ConfigAPI.swift:175 hardcodes
configured:false; Engine.streamURL has no `jf:` branch).
- **P7a (unblocked the moment the owner stands up a Jellyfin server** — free
  installer on the Windows Plex box, pointed at the same folders): verify +
  fix the Node client live (AuthenticateByName, /Shows/:id/Episodes,
  ?static=true direct-play), mark verified in CLAUDE.md. `[S–M]`
- **P7b: Swift JellyfinClient** mirroring PlexClient (simpler: user/pass auth,
  no PIN flow, no discovery; static stream URLs) + replace ConfigAPI stubs +
  `jf:` branch in Engine.streamURL + tests. Media rows are already
  backend-agnostic, so mixed Plex+Jellyfin+pack channels need zero scheduler
  work. `[M]` — schedule after P7a proves the API shapes.
- Until P7b lands: build-12 item C5 (hide/"coming soon" the Jellyfin toggle on
  the embedded/native server; key off `native:true` in /api/status).

### Don't do (scope guards)
- No scheduler/`schedule/` changes — nothing here needs them (invariants #4–#6).
- No Jellyfin implementation on Swift (separate decision, P7b).
- No manual-schedule-editor work (`docs/manual-schedule-editor.md` is future).
- Don't re-encode/re-curate packs (content work is a separate track; test packs
  are fine for builds 11/12).
- Don't touch `regenerateChannel` cursor re-phasing (known, pre-existing,
  harmless — documented in Notion).

## Regression gates (run before every build hand-off)
```
/opt/homebrew/opt/node@22/bin/node scripts/selftest.js     # 49/0 + your new checks
cd apple/dumbTVCore && swift test                           # 63/1skip + your new tests
# all three: xcodebuild … dumbTV-iOS / dumbTV-macOS / dumbTV-tvOS → BUILD SUCCEEDED
```
Add tests WITH each fix (A1 ad resolution, N2 collision, A3 id-usage at least).

## Reporting
- Update the Notion "Master Release Roadmap" (page id
  `3a7128af-9afe-81c7-969b-e0bbd80adbc8`) — append a build-11/12 status section;
  use `insert_content` at end (string-matching `update_content` often fails on
  that page's special chars).
- Commit style: repo uses plain descriptive messages; run the regression gates
  first; push is fine (Actions now enabled; CI red is pre-existing).
- End git commits with the Co-Authored-By + Claude-Session trailer per system
  instructions.

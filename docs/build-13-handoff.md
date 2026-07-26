# Build 13 handoff — build-12 device triage + fix plan

Audit of the build-12 device feedback (Apple TV + iOS, 2026-07-26). Findings
are ranked; each has a root cause (or an honest "unproven") and a fix plan.
**No code has been changed** — this is the plan to implement from.

The one-line story: build 12's remaining bugs are dominated by TWO root
causes — a Swift-concurrency cancellation bug that kills the banner (F1), and
video-view re-parenting that kills the picture (F3). Fix those two and five of
the eight reports disappear.

---

## F1 · CONFIRMED — cancelled delay-tasks fire their effect immediately

**One root cause, three symptoms.** The pattern, all over `Engine.swift`:

```swift
bannerTask?.cancel()
bannerTask = Task { @MainActor [weak self] in
    try? await Task.sleep(nanoseconds: 4_500_000_000)
    self?.bannerVisible = false          // ← runs IMMEDIATELY when cancelled
}
```

`Task.sleep` **throws `CancellationError` instantly** on a cancelled task.
`try?` swallows it — so the "hide after 4.5s" body executes right away.
Cancelling the old task is what fires it.

Proof the author knew the correct form: `scheduleReload()`
(`apple/Sources/Engine.swift:151`) has the missing
`guard !Task.isCancelled else { return }`. Every other site lacks it.

**Symptom A — "banner doesn't show on channel switch" (tvOS + iOS report).**
`tune()` runs `sync()` — which calls `showBanner()` on the program change —
then calls `showBanner()` again itself (`Engine.swift:440-441`). Back-to-back
calls: call 2 sets `bannerVisible = true` and cancels task 1; task 1 resumes
on the main actor a beat later and sets `bannerVisible = false`. Banner dies
within a frame or two of every channel change.

**Symptom B — "after mute/CC, double-tap banner flashes and vanishes; wait a
bit and it works again" (iOS report).** Mute/CC call `showBanner()` (task
pending for 4.5s). A double-tap inside that window calls `showBanner()` again
→ cancelled task hides it instantly. After ~5s idle the pending task has
completed naturally, nothing is left to mis-fire, and the next double-tap
works. Matches the report exactly, including the recovery-after-waiting.

**Symptom C — multi-digit dialing commits early (found in audit, unreported).**
`pressDigit()` (`Engine.swift:557`): the second digit cancels the first
`dialTask`, whose body calls `commitDial()` — immediately. Dialing "2","3"
tunes at the instant you press 3; a third digit is unreachable, so channels
≥ 100 can't be dialed. The `DialCountdown` bar restarts but the commit has
already happened.

**Symptom D — repeated ⊘ flash self-destructs (minor).** `showFlash()`'s
guard `if self?.flash == s` passes when the SAME glyph flashes twice (⊘ then
⊘) → second flash cleared instantly.

**Fix (S):** add `guard !Task.isCancelled else { return }` after every
`try? await Task.sleep` in `Engine.swift` (`bannerTask`, `dialTask`,
`flashTask`, and audit any new ones). Consider one helper:
`func after(_ s: Double, _ body: @MainActor @escaping () -> Void) -> Task<…>`
that encapsulates the guard so the bug class can't come back.
While in there: banner hide delay 4.5s → **5.0s** (owner asked for 5).

**Verify:** unit-testable on the Engine (call `showBanner()` twice, spin the
main queue, assert `bannerVisible == true`); then sim visual pass: mute →
double-tap → banner stays; channel switch → banner shows every time; dial
"1","0","2" → lands on 102 (demo has no 102 → expect ⊘, but AFTER 1.5s).

---

## F2 · CONFIRMED (verify on device) — tvOS: select press outside the guide is swallowed

`TVView.swift:101`:

```swift
if press.key == .return { if engine.guideOpen { engine.guideSelect() }; return .handled }
```

Outside the guide this **consumes the press and does nothing** — and because
the key handler ate it, the `.onTapGesture` fallback (`TVView.swift:87-89`,
which would call `toggleGuide()`) never fires. In-guide select reaches
`guideSelect()` — which is exactly the split the owner reports: selecting in
the guide works; a single center-click to OPEN the guide doesn't.

**Fix (S):** make `.return` symmetric with the tap gesture:
`engine.guideOpen ? engine.guideSelect() : engine.toggleGuide()`. Keep the
tap gesture as-is (it also serves sim/testing).

**Verify:** needs the real Apple TV (sim remote semantics differ). Expected:
single click opens guide, single click on a row tunes it — the owner's spec.

---

## F3 · ROOT-CAUSED — black screen with audio after guide→channel (the "only major bug", tvOS + iOS)

**Mechanism.** `watchLayout` and `guideLayout` each instantiate their own
`VideoLayer` → different SwiftUI identities → toggling the guide TEARS DOWN
one `VideoSurface` (UIViewRepresentable) and CREATES the other. The two
persistent player views get re-parented into the new container. VLCKit's
video output does not reliably survive `removeFromSuperview` →
`addSubview` — audio keeps playing, vout is gone. The build-12 patch
(`reattachDrawables()` +0.12s after `guideOpen` flips, `TVView.swift:125`)
is insufficient for two reasons:

1. It re-assigns the **same** drawable object (`p.drawable = views[i]`) —
   VLCKit can treat an identical drawable as a no-op and never rebuild vout.
2. The fixed 0.12s delay races SwiftUI's actual representable
   creation/re-parent — fire too early and nothing re-attaches after.

Note the comment history in `Player.swift:189` already records the smell:
re-parenting is why "the guide toggle FIXED the black" in one build and
causes it in another. The class of bug is the re-parent itself.

**Fix — Option A (architectural, recommended, M):** ONE `VideoSurface`,
mounted once at the root `ZStack` in `TVView`, **never re-parented**. Guide
mode animates its frame down into the thumbnail slot (plain
`.frame/.position` from the same GeometryReader, or
`matchedGeometryEffect`); watch mode is full-screen; setup channel hides it.
Delete `reattachVideoSoon()` and `reattachDrawables()` entirely. This kills
the whole class — including the iOS plain-channel-switch black, since no
layout event ever detaches the views again.

**Fix — Option B (fallback only if A fights the guide layout):** keep two
layouts but make reattach real: nil-cycle (`p.drawable = nil; p.drawable =
views[i]`) and only after confirming `views[i].window != nil`, retrying
next runloop until true; also re-assert on front-swap completion in
`Player.tick()`.

Do A. B is listed so the fallback is pre-agreed and doesn't get invented at
midnight.

**Verify:** sim first (guide → different channel → picture up), then device:
the owner's exact repro — guide, select channel, guide closes → **picture,
not black**. Also swipe-switch channels repeatedly on iOS.

---

## F4 · Feature — guide→channel handoff shows the banner (owner spec)

When `guideTuneTask` (`Engine.swift:490`) decides the new channel is up and
closes the guide, call `showBanner()` so the channel info banner rides the
transition, staying up 5s (F1 sets the duration). One line, but it only
works once F1 is fixed — today the tune's double-`showBanner()` kills it.

**Verify:** guide → select channel → guide dismisses → banner visible 5s.

---

## F5 · Feature — setup/QR card auto-dismisses after 60s

When `setupCardVisible` first becomes true on a live channel, schedule a
60-second task → `setupCardDismissed = true` (per-launch, does NOT set
`setup_seen`; channel 00 unchanged as the way back — same semantics as the
C1 ✕). Use the F1-safe helper; this is exactly the pattern that bites.

---

## F6 · Design — replace the iOS LAN-explainer overlay + QR banner with one click-through SETUP popup

Owner spec: the local-network explainer shouldn't be a TV overlay; fold it
into a first-run **setup popup** the user must page through, which then
fully dismisses.

Plan (M):
- One paged first-run popup (replaces `LanExplainer` + the first-run
  `SetupCard` banner):
  - **Page 1** — welcome: "this is a television; it's already playing.
    Set it up from your phone."
  - **Page 2 (iOS only)** — the LAN permission heads-up (current
    `LanExplainer` copy; keep it — the system prompt fires right after).
  - **Page 3** — QR + URL (`SetupCard` content) + "channel 0 brings this
    back."
  - **DONE** on the last page persists a flag (`first_run_done`) and fully
    dismisses. No ✕ short-circuit on first run — the click-through is the
    point.
- tvOS: same popup minus the LAN page; F5's 60s auto-dismiss applies to the
  post-first-run card, not the popup.
- Move the LAN-permission wording into the web UI setup guide as well
  (docs/setup-guide.md + the Server page), per "should only be on the web
  UI".
- Keep `lan_explainer_shown`/`guide_hint_shown` handling coherent: the new
  flag supersedes `lan_explainer_shown`.

---

## F7 · INVESTIGATED, no smoking gun — "every new build resets the app / custom channels" (iOS)

What the audit ruled OUT (evidence, not vibes):
- **Not a path change:** build 10 and builds 11/12 use the identical iOS DB
  path — `Application Support/dumbTV/dumbtv.db` (verified against commit
  `2e05b74`'s `openStore()` vs `AppPaths.databasePath()`).
- **Not a schema wipe:** schema diff build 10 → HEAD is purely additive
  (new `packs` table, `IF NOT EXISTS`; one tolerated `ALTER`). No
  `DROP`/recreate path exists.
- **Not TestFlight:** updates preserve the app container.

Leading hypotheses, in order:
1. **The silent tmp fallback.** `AppPaths.dataRoot()` falls back to
   `fm.temporaryDirectory` if the Application Support lookup ever fails —
   silently. A DB living in tmp is purged between launches/updates and
   presents EXACTLY as reported. Today this failure is invisible.
2. **Delete + reinstall** rather than update (expired build, manual
   delete). Container gone → everything gone.
3. **Platform conflation:** on Apple TV the DB is in Caches BY DESIGN and
   can be evicted (documented trade-off; durable settings survive via
   UserDefaults). If the reset was observed on the Apple TV, it may be this.

Build-13 actions (S):
- Remove the silent tmp fallback: record the failure in
  `SystemDiagnostics` and surface it; tmp only as a last resort WITH a
  visible warning on the channel-00 diag block.
- Add DB provenance to the channel-00 diagnostics: full path (exists),
  file created-at timestamp, and settings/channels row counts — one
  TestFlight photo then answers where the data went.
- **One question for the tester after the next update:** *after the
  "reset," was Plex still linked?*
  - Yes → the DB file was genuinely recreated (the UserDefaults durable
    mirror restored the link) → hypothesis 1.
  - No, and the LAN explainer replayed → whole container gone →
    hypothesis 2 (`lan_explainer_shown` is DB-only, not durable — it
    replays only on a truly fresh container-or-DB).

Do NOT ship a "fix" for this without the diagnostic evidence — nothing in
the code provably wipes, and a blind fix would just be noise.

---

## Suggested implementation order (build 13)

1. **F3** — single video surface (the "only major bug"; biggest risk, do it
   with the most runway).
2. **F1** — cancellation guards + 5s banner (+ regression-style Engine test).
3. **F2** — tvOS select opens the guide.
4. **F4, F5** — banner-on-guide-tune, 60s QR auto-dismiss (trivial after F1).
5. **F6** — first-run setup popup (iOS + tvOS variants; retire LanExplainer).
6. **F7** — diagnostics only (no behavioral "fix").

Gates: `npm run selftest` and `swift test` stay green (F1 gets a new test if
practical); all three apps build; iOS sim visual pass (banner behavior, guide
tune, setup popup); **device pass required** for F2 (tvOS select) and F3
(black screen) — neither is provable in the simulator.

Don't do: scheduler changes (none of this touches `schedule/`), pack
re-curation. The banner/video work is all in
`apple/Sources/{Engine,Player,TVView,SetupCard}.swift`.
(Part 2 below ADDS Swift Jellyfin and new pack work as explicit features —
the "don't do" above scoped the bug-fix pass only.)

---
---

# Part 2 — Features & UX additions (owner directive, 2026-07-26)

Owner asked for: Jellyfin testable on iOS · the SPACE channel (Notion
"Phase — Channel 1") · other easy unbuilt Notion features · no ads on the
prebuilt channels · a richer how-to popup mentioning the website · more
preloaded content within limits. Framed as a UX audit + feature pass.

## J1 · Jellyfin on the Apple embedded server (iOS-testable) `[M]`

**Good news from the audit: this is smaller than Notion thought.** The
roadmap called the Swift port "[L] — PlexClient-sized… decide after Node
verification." In fact:
- The web UI's library browse hits **backend-agnostic** endpoints —
  `/api/library/sections`, `/api/library/sections/:id/items`,
  `/api/library/show/:id/episodes` (`ConfigAPI.swift:141-146`) — so the
  picker needs **zero UI changes**, only server-side dispatch.
- `PlexClient.swift` is **228 lines**. The Node Jellyfin client is 199.
  A Swift `JellyfinClient` is an afternoon-sized actor, not a subsystem.

Work list:
1. **`JellyfinClient` actor** (dumbTVCore) mirroring `src/jellyfin/client.js`:
   `AuthenticateByName` (X-Emby-Authorization header — copy the exact shape
   from `src/jellyfin/auth.js:5`), Views→sections, section items,
   `/Shows/:id/Episodes`, movie lookup, `cacheSource` writing media rows
   with `jf:<itemId>` part keys, `imageUrl`. Skip ads-import for v1 (Node
   keeps it; native ads come from packs/local anyway).
2. **ConfigAPI dispatch by `media_backend` setting** (mirrors
   `src/media/backend.js`): implement `POST /api/media/backend`,
   `GET /api/jellyfin/status` (real), `POST /api/jellyfin/connect`,
   `POST /api/jellyfin/logout`; route `/api/library/*`, `addSources`'
   cacheSource, and `fetchImage` through the active backend. `status()`
   reports the backend so the web UI switch renders correctly.
3. **`Engine.streamURL`**: add the `jf:` branch —
   `{url}/Videos/{id}/stream?static=true&mediaSourceId={id}&api_key={token}`
   (exact shape: `src/jellyfin/client.js:189-194`). `?static=true` = never
   transcode (invariant #2).
4. **Store**: `jellyfin_url/user/token` are already in `durableKeys` ✓ —
   nothing to do.
5. **Web UI**: remove the build-12 C5 native-disable of `#beJelly` (it was
   honesty about a gap; the gap closes).
6. **Tests**: ConfigAPI wire tests with a stubbed client (connect → status
   flips, backend switch, sections dispatch). Real verification is manual.

**Verification plan (this also unblocks P7):** run Jellyfin in Docker on
the Mac (`docker run -p 8096:8096 jellyfin/jellyfin`) with a small library
— that gives a LIVE server to verify BOTH the Node client (P7, currently
"written, never executed") and the new Swift client, before the owner's
iOS device test. Known risk: the Node client is unverified, so expect
API-shape fixes during this step — budget for them; the iOS test is the
point of this feature.

## S · SPACE — the channel-1 system channel (Notion Phase — Channel 1) `[M–L]`

Prereqs are met: N2/N3 (channel-number collisions) shipped in builds 11/12.
Per the Notion spec, this is **a pack + a lock flag, not a new channel
type** — the scheduler needs zero changes.

- **S1 · Curation** `[M]`: ≈2–3 h loop. NASA direct (public domain, no API
  key at images.nasa.gov) → IA NASA/space-race collections → Prelinger.
  Rights gates in every `rightsNote`: no NASA insignia/seal, no implied
  endorsement, care with identifiable people. `build-pack.js` already
  enforces `license.verified`.
- **S1a · Pipeline** `[S]`: add a **direct-URL item source** to
  `build-pack.js` (it's IA-identifier-driven today; it already downloads +
  re-encodes, so this is a small extension).
- **S2 · Build** `[S]`: `packs/space/`, channel hint **1**, `system: true`
  in the manifest.
- **S3 · Locked flag** `[M]` — the only real engine work, BOTH stores:
  `locked` column (Node `db.js` + Swift `Store.swift`); ConfigAPI/api.js
  reject PATCH/DELETE with **403**; `createChannelFromPack` honours
  `system: true`; web UI swaps edit/delete for a lock chip;
  **hideable, not editable** (disable allowed). Tests: can't PATCH, can't
  DELETE, disable round-trips, aired programs preserved.
- **S4 · Delivery** `[S–M]`: bundle ONE ~20-min piece (~60–80 MB) with
  PRELOAD; the rest is one-tap download via the existing pack picker
  (the SUPERMAN partial-pack pattern).
- **S5 · Launch countdown — DEFER.** Recommend shipping SPACE as pure
  replay this build; the LL2 corner bug is a separate later feature
  (spec answers Notion open-Q4). S6 live preemption stays DO-NOT-BUILD.

Decisions this directive settles or the owner still owns:
- **Ads: OFF** — settled by the no-ads-on-prebuilt directive below
  (answers Notion open-Q2).
- **Guide treatment**: normal row for v1 (open-Q3, cheapest honest answer).
- **Call sign** (open-Q1): owner's pick — "SPACE" is the placeholder.
- **System band 0–5** reserved by convention: document it, no enforcement
  code yet beyond channel 1's lock.

## ADS · No ads on the prebuilt channels `[S]`

Owner: preloaded channels play programs back-to-back — nobody should land
in a commercial while evaluating the product. (Reverses Notion decision D2,
"preload channels ship ads ON"; update the Notion page after shipping.)

- Apple: `Engine.seedPreloadPacks` → `createChannelFromPack(pid,
  adsEnabled: false)` (`Engine.swift:276`).
- Node: same default in the starter-pack seeding path.
- **Migration for already-seeded installs** (the owner's devices!): a
  one-time flag (`preload_ads_off` setting); where applied, flip
  `ads_enabled=0` on channels whose only source is a bundled pack, then
  regenerate — safe: `regenerateChannel` deletes only `start_utc >= now`
  (invariant #4 holds; what's airing survives).
- The AD BREAK pack still ships and registers — ads stay available for
  user-made channels. Programs already run back-to-back natural-length
  when ads are off (invariant #6); no scheduler change.

## POPUP · First-run how-to popup content (extends Part 1 F6) `[S]`

On top of the F6 paged popup, per owner:
- **Mention the website** — "Full guide & FAQ at **dumbtv.app**" on the
  final page (see WEB below — the site must actually be live).
- **Useful details** (one tight page, per-platform strings):
  - "Channels are already playing — this is a TV, not an app to set up."
  - Controls cheatsheet: swipe ↑↓ / arrows = channel · double-tap /
    select = info & guide · dial 0 = setup screen.
  - "Add your own channels from Plex or Jellyfin — scan the QR."
  - "No pause. That's the point." (the product's one-liner, sets
    expectations that ⊘ is deliberate)
- UX audit note: first launch currently stacks THREE competing overlays
  (LanExplainer + setup card + 12s guide hint). The popup replaces all
  three on first run; keep the guide hint only for users who skipped the
  popup pages (i.e., drop it once `first_run_done` is set).

## POLISH · Easy unbuilt Notion items worth folding in

1. **NEXT skips ads** `[S]` — the banner's NEXT line currently announces
   the upcoming *commercial* (Notion "P-later" polish). Filter `upNext`
   to episode/movie/offair on both platforms (resolver query only — the
   Swift `Engine.nextUp` and web banner). Pairs naturally with ADS above.
   Fix in the same pass: guide/banner anywhere else ad titles leak.
2. **N7 hardening** `[S]` — `setup_seen` is set by ANY `/api/status` hit;
   it should require a real config-page load (the web UI's first page
   fetch), so a port-scan or the app's own probe can't silently retire
   the setup card.
3. **CRF-28 Popeye re-encode** `[S, build-time]` — see CONTENT below.

Checked and deliberately NOT pulled in: config export/import (Node-side,
not iOS-visible), Track D Pi items, H1/H2/H3, macOS menu-bar polish —
wrong build for all of these.

## CONTENT · More preloaded content, inside the budget `[S–M]`

Budget math (Notion D1: ~300–400 MB preload target; current bundle
**~636 MB**, Popeye two-reelers = 353 MB of it):
- **CRF-28 pass on POPEYE** → roughly −180 MB → bundle ≈ 455 MB.
- **SPACE bundled piece** (S4) → +60–80 MB → ≈ 520–535 MB.
- Net: **five preloaded channels** (Saturday Morning, Superman, Popeye,
  Early Disney, SPACE) at a ~530 MB bundle — over D1's letter but a
  defensible v1.2 shape; the .ipa lands ≈ 600 MB.
- **Owner dial** (decide at build time): accept ~530 MB, or drop the
  Popeye two-reelers to download-on-tap (−~170 MB more → ~360 MB, inside
  D1). Recommend: take the CRF pass first, measure, then decide.
- RERUN THEATRE / CREATURE FEATURE / GULLIVER authoring stays backlog —
  each is another 100+ MB against the same budget; downloads, not
  preloads, are their natural home.

## WEB · dumbtv.app deploy (parallel task, not app code)

The popup and this build's story reference the website; Notion D5 says
hosting is **still open and gates App Store submission** (privacy +
support URLs). `site/index.html` + privacy/support pages are drafted.
Action: deploy (any static host — Pages/Netlify), wire
`dumbtv.app/packs/index.json` (the pack catalog URL the apps already
prefer, with bundled fallback). This is the critical-path item for
submission regardless of this build.

---

## Combined build-13 order (Parts 1 + 2)

1. F3 single video surface (the major bug — most runway)
2. F1 cancellation guards + 5s banner (+ engine test)
3. F2 tvOS select · F4 banner-on-guide-tune · F5 60s QR auto-dismiss
4. ADS off for preloads (+ migration) · POLISH-1 NEXT-skips-ads · N7
5. J1 Jellyfin (client → dispatch → streamURL → web toggle), verified
   against local Docker Jellyfin (unblocks P7 for Node too)
6. F6+POPUP first-run flow (replaces LanExplainer/setup-card/hint stack)
7. S SPACE channel (S1 curation can run in parallel from day one; S3 lock
   is the only engine-adjacent code — build it behind tests)
8. CONTENT: CRF-28 Popeye, re-measure, owner decides the preload set
9. F7 diagnostics · WEB deploy in parallel

If TestFlight turnaround matters more than batching: 1–4 is a coherent
"build 13" (all fixes + instant UX wins) and 5–8 a "build 14" (Jellyfin +
SPACE + popup + content). Same total work either way — owner's call.

Gates: selftest + swift test green (new: lock-flag tests, backend-dispatch
tests, engine banner test) · 3 apps build · iOS sim visual pass · device
pass for F2/F3 · **live-Jellyfin pass for J1** (Docker locally, then the
owner's iOS device against a real server).

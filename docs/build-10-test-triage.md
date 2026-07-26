# Build 10 device testing — triage & fix plan

**Status: investigation only, 2026-07-26. No code changed.** Real-device round:
Apple TV = total bust; iOS = mostly working with real bugs. Everything below is
grounded in code inspection with file:line evidence.

---

## A. CONFIRMED root causes (found by inspection)

### A1 · Preloaded ads never play on Apple → "please stand by" bars + a Ford title 🔴
**Symptom:** after app restart, colour bars + banner says "Wonderful New World
of Fords", nothing plays.
**Cause — confirmed:** `Packs.swift:89-93` registers ad-pack items as assets
with `path = pack:<id>/<file>` but **`partKey = nil`**. `Engine.swift:635`
resolves ad programs via `asset.partKey` only → nil → `player.stop()` +
stand-by for the *entire ad slot*. Every scheduled ad break on Apple is dead
air; a restart mid-break shows exactly the reported screen. (Node is fine — its
resolver reads `asset.path` for `pack:` ads.)
**Fix:** register ad packs with `partKey = packPartKey(...)` too (one line), or
teach the Engine's ad branch the `pack:` path fallback. Add a Swift test:
ad-pack slot resolves to a playable file.

### A2 · Channel 0: double-tap/guide "does nothing" 🔴
**Symptom:** on the setup channel, "double tap for the guide" does nothing.
**Cause — confirmed:** `TVView.swift:33-38` — layout precedence is
`onSetupChannel` **before** `guideOpen`. Double-tap calls `toggleGuide()`,
`guideOpen` becomes true, but the body still renders the setup layout. The
guide opens invisibly (which then makes later gestures feel haunted).
**Fix:** render `guideOpen` above `onSetupChannel` (or clear `onSetupChannel`
when the guide opens). Re-check the swipe path after this lands — the invisible
guide likely explains the "swipe doesn't work" report too.

### A3 · Web UI: Cancel still creates a channel + editor opens "channel 7 Saturday Morning" + "ads default ON" — one bug 🔴
**Symptom trio**, all from `public/app.js:745-754`:
1. `#addChannel` **POSTs the channel immediately**, then opens the editor →
   Cancel leaves the already-created phantom channel.
2. It then opens `state.channels[state.channels.length - 1]` — **positional
   last**, but the list is ordered by number. With the preload channel at
   number 7 and the new channel getting a lower number, "last" = **SATURDAY
   MORNING** → the editor opens on the pack channel.
3. That pack channel legitimately has **ads ON** (decision D2) → user sees "Run
   commercials on by default." The actual create default is OFF — confirmed at
   `ConfigAPI.swift:269` (`?? false`) — the user was looking at the wrong
   channel's settings.
**Fix:** use the returned `{id}` from POST (both backends return it), and make
the editor **create-on-save** (or DELETE on cancel). One fix clears all three
symptoms.

### A4 · Picker slow / artwork missing / TV-shows tab never loads — the server is serial 🔴
**Cause — confirmed:** `EmbeddedServer.swift:26-30` — the listener **and every
connection** run on one dispatch queue. Every request is handled one-at-a-time:
a big `/library/.../items` fetch (WAN Plex — this user's server is WAN-only),
then each `/api/image` poster is another serialized WAN roundtrip, all queued
behind each other and competing with the in-app Superman download for
bandwidth. The picker isn't "broken", it's starved.
**Fix plan:** (a) handle each request on its own task/queue (Store/SQLite
access stays serialized internally); (b) disk-cache the image proxy (LRU) and
request Plex's sized thumbnails instead of full art; (c) picker UX: connected
dot + loading spinner (user asked for exactly this); (d) paginate/lazy-load
sections.

### A5 · tvOS total failure — one nil cascades into everything reported 🟠 (high-confidence hypothesis)
**Symptoms:** no QR anywhere, no setup card, `IP:8080` dead, no preloaded
content, channel-00 shows the fallback sentence ("Open dumbTV's setup page from
a browser…"). Sim works; two real Apple TVs fail identically across builds.
**Cause chain — inspected:** `dumbTVApp.swift:67-77` opens the Store in
**Application Support**. On real tvOS, the sandbox only allows writing to
**Caches and tmp** — Application Support writes fail on hardware but are NOT
enforced by the simulator (exactly matching "sim yes, device no", on two
different devices, across builds). When `openStore()` throws:
- `store = nil` → **EmbeddedServer never starts** → `IP:8080` dead
- `configURL = nil` → **no QR** (both the setup card and channel 00 fall to the
  unhelpful fallback text — the exact string the user quoted)
- `setupCardVisible` never set → no setup banner
- `seedPreloadPacks` skipped → **no preloaded channels** → guide shows only the
  SETUP row → "no content"
- failure is only `print()`ed — invisible on a TV.
**Fix plan (build 11 = diagnostics-first):**
1. Store path: fall back to **Caches** on tvOS (purge-safe: the schedule is
   deterministic and regenerates; mirror the small critical settings — plex
   token, `setup_seen`, `preload_seeded` — to UserDefaults/Keychain so a purge
   doesn't unlink Plex).
2. Surface failures on-screen: channel 00 gains a diagnostics block (store:
   ok/failed+why · server: port/listening/failed · LAN IP) instead of the
   useless fallback sentence. If A5's hypothesis is wrong, this tells us what
   is — we have no tvOS hardware here, so the fix must carry its own evidence.
3. `NWListener.stateUpdateHandler` → surface bind errors.
4. Check tvOS 18 Local-Network permission behavior for the *outbound* Plex
   connection while we're in there.

---

## B. PROBABLE causes (need on-device verification)

### B1 · Mute/CC: banner flash + gestures dead for a while 🟠
`toggleMute()` sets `isMuted` on **both** VLC players synchronously on the main
actor; `toggleCaptions()` walks subtitle track arrays. VLCKit setters can stall
while a stream is buffering → main thread hitches → SwiftUI gesture recognizers
starve ("double tap stopped working, came back later") and the banner's
animation state thrashes.
**Fix plan:** apply to the front player only, move VLC calls off the main
actor, debounce the buttons; verify on device.

### B2 · Guide → same channel → black picture, audio continues 🟠
The watch layout and guide layout each create their **own** `VideoSurface`
container; dismissing the guide re-parents the persistent VLC views into a new
container. On a same-channel dismiss there's no retune/frame swap to force the
video output to re-attach → black with live audio. (The code's own comments
note re-parenting is what previously "fixed" black — it's fragile in the other
direction.)
**Fix plan:** ONE persistent video surface hosted at the ZStack root for both
layouts (the guide shrinks it with frame/position instead of a second
container), or explicitly force a drawable re-attach after a layout swap.

### B3 · tvOS remote "inconsistent" 🟠
Two contributors: (a) the known tvOS focus-polish debt (roadmap A2), and (b)
the current two-step select (select = info, select-again = guide) reads as
broken on a real remote.
**Fix = adopt the user's spec (it's better):**
- **Up/down** = channel change (banner auto-appears — already does on tune)
- **Select** = open the guide, directly (drop the two-step)
- **Select in guide** = tune to the highlighted channel
- **Back/Menu** = dismiss the guide (exists via `onExitCommand`)
- Mute/CC on tvOS: defer (needs a real focus pass for the control row).

---

## C. Requested improvements (design decisions adopted into the plan)

1. **QR banner: tap-to-dismiss** — an ✕ that hides the card *without* marking
   `setup_seen` (the web UI still hasn't been opened); channel 0 stays the way
   back and the card already says so.
2. **Channel-00 copy** — replace the fallback sentence; with the server down it
   becomes the diagnostics block (A5.2), with the server up it's the full QR
   card (needs A5.1 on tvOS).
3. **Content Packs inside the Add-content picker** — a "Content Packs" source
   tab in the picker: installed packs selectable; not-downloaded packs greyed
   with a download button right there (mirrors the Channel Packs view).
4. **Byte-level download progress** — downloaded/total bytes, speed, ETA
   (URLSession delegate on Apple; byte-counting stream on Node); progress shown
   in both Channel Packs and the picker tab. Downloads must never block other
   requests (fixed by A4's concurrency work).
5. **Jellyfin on Apple is a stub** — decide: hide the Jellyfin toggle on the
   embedded (native) server until the Swift client exists, or label it "coming
   soon". Node's Jellyfin stays (still needs a live server to verify — P7).
6. **Web-UI picker states** — green connected dot + loading spinner while
   sections populate (explicit user request).

---

## D. Execution plan

| Phase | Scope | Items |
|---|---|---|
| **B11-F1** 🔴 | tvOS rescue (diagnostics-first build 11) | A5.1–A5.4, B3 remote remap, C2 |
| **B11-F2** 🔴 | Playback correctness, all platforms | A1 ad partKey, A2 precedence, B2 single surface, B1 mute/CC |
| **B11-F3** 🟠 | Web UI + embedded server | A3 create-on-save + returned id, A4 concurrency + image cache + picker states (C6) |
| **B11-F4** 🟡 | Features | C1 QR dismiss, C3 packs-in-picker, C4 byte progress, C5 Jellyfin visibility |

- Suggested batching: F1+F2 = **build 11** (get Apple TV alive + core playback
  right), F3+F4 = **build 12**.
- **Verification:** iOS sim covers A1/A2/A3/A4 checks; **A5/B1/B2/B3 need the
  user's real devices** — build 11's on-screen diagnostics exist precisely so
  one TestFlight round answers tvOS definitively.
- New tests to add alongside fixes: ad-pack slot resolves playable (Swift);
  create-channel API returns id used by UI (web); setup-channel + guide
  precedence (UI logic test).

## E. Honest notes
- P2 was verified "in sim" — that held for iOS but masked tvOS, where the
  sim doesn't enforce the write sandbox. Real-device tvOS was never verifiable
  from this machine; build 11 carries its own on-screen evidence so the next
  TestFlight round is decisive either way.
- The preload DID work on iOS (Betty Boop played, joined in progress) — the
  tvOS "no content" is the store failure, not the pack model.

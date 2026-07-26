# Content Without Plex — full build plan (Track I)

**Status (2026-07-26): P0–P6 BUILT + TESTED, P7 blocked on a live server.**
- **P0** pack pipeline ✓ · **P1** pack model both engines ✓ · **P2** preload (Apple) ✓ *verified in sim* · **P3** web-UI pack picker ✓ · **P4** Pi packs ✓ · **P5** local folders (Node) ✓ · **P6** local folders (Apple) — model ✓, native folder-grant UI is remaining app/device work · **P7** Jellyfin — written but needs a LIVE server to verify (can't be done here).
- Suites: Node selftest **49/0**, Swift **63/0** (1 skip = live Plex), all 3 apps build. All local, uncommitted (GitHub paused).

The complete engineering plan for preloaded channels, one-tap Internet Archive
packs, local folders, and Jellyfin verification. Companion to the Notion Master
Roadmap (Track I) — this file is the file-level truth; Notion holds phase status.

The research behind this (IA API verification, PD content catalog, the preload
lineup) is recorded in Notion Track I §I5. Summary of the load-bearing facts:

- The engine is **already source-agnostic**: `media` rows are `rating_key` +
  `part_key` strings in both backends; `local:` keys work end-to-end in Node.
- IA's metadata API supplies **durations per file** (`length`), h.264 MP4
  derivatives, and direct HTTPS download URLs with range support.
- The curated preload lineup (~6 h ≈ 2 GB @ 480p) and the launch packs
  (SUPERMAN, SATURDAY MORNING, RERUN THEATRE, CREATURE FEATURE, AD BREAK) are
  chosen; per-item PD verification is a build step, not an open question.

---

## The one design decision everything hangs on: the `pack:` part key

A **pack** is a versioned folder of media files plus a `manifest.json`. Media
rows for pack items use part keys of the form:

```
pack:{packId}/{filename}
```

Resolution is a two-step lookup at play time: `packId` → the pack's install
root (app bundle, or the downloads dir), then the filename inside it. Never
store absolute paths — bundle paths change on every app update, and the same
manifest must work on Apple (bundle/Application Support), Node (data dir), and
Pi (SD card).

`rating_key` for a pack item is `pack:{packId}:{itemId}` — deterministic by
construction, so schedules survive reinstalls and rescans (invariant #5).

### Manifest schema (locked in P0)

```json
{
  "id": "superman",
  "name": "SUPERMAN",
  "version": 1,
  "kind": "shows" | "ads",
  "items": [{
    "id": "mad-scientist",
    "file": "superman-01-mad-scientist.mp4",
    "title": "The Mad Scientist",
    "show": "Superman", "season": 1, "episode": 1,
    "aired": "1941-09-26",
    "durationMs": 620000,
    "source": { "iaIdentifier": "fleischer-superman", "iaFile": "..." },
    "license": { "url": "https://creativecommons.org/publicdomain/...", "verified": "2026-07-26", "note": "not renewed; renewal search clear" }
  }],
  "bytes": 412000000,
  "sha256": "..."
}
```

`durationMs` ships in the manifest → **no probing at install time** on any
platform. `license` per item is the provenance log — it is the answer to both
App Review and any takedown question. `show`/`season`/`episode` feed the
ordering modes (sequential Superman = airdate order, for free).

---

## Phases

### P0 · Curation + pack pipeline (offline tooling — no app code) `[M]`

The pipeline is repo tooling, not app code. PD content may be **pre-encoded by
us** — the no-transcode invariant (#2) is about runtime, not mastering.

- `packs/` in-repo: one folder per pack holding `manifest.json` (media files
  are NOT committed — .gitignore'd; a build artifact).
- `scripts/build-pack.js` (Node, ffmpeg): reads a manifest's `source` entries →
  downloads the best derivative from IA → re-encodes to uniform **480p h.264 +
  AAC MP4** (retro-correct, small, direct-plays everywhere including the web
  `<video>` tag) → probes and stamps `durationMs` → writes the pack folder +
  checksums.
- **Per-item PD verification is a pipeline gate**: each item needs
  `license.verified` filled by a human (licenseurl + renewal-check — the
  *Wooden Soldiers* trap is why this is manual). The script refuses to build a
  pack containing unverified items.
- Build the six launch packs. The preload set (Notion §I5-PRELOAD) is the
  bundled subset; everything else becomes downloadable packs.
- **Deliverable:** real encoded packs on disk + locked manifest schema.

### P1 · Pack model in both engines `[M]`

Schema + resolution, no UI yet. Node and Swift in the same phase so the API
contract never forks.

- **DB (both `src/db.js` and `Store.swift`):** new `packs` table — `id, name,
  version, kind, origin (bundled|downloaded), root_path, installed_at`.
  Migration is additive (append-only schema, same as always).
- **Install = register:** installing a pack inserts its media rows (from the
  manifest — titles, S/E, durations, `pack:` part keys) and the pack row.
  Ad-kind packs register as `assets` (tags `ad`) instead — that wires the
  AD BREAK pack into the existing ad-pod system with zero scheduler changes.
- **Resolution:**
  - Swift `Engine.streamURL()`: `pack:` prefix → look up pack root (bundle vs
    Application Support) → file URL for VLCKit.
  - Node resolver/mpv: `pack:` → absolute path under the data dir.
  - Browser playback: extend `/api/local` (path-must-be-in-DB rule unchanged).
- **Selftest additions:** manifest → media rows → generate → deterministic
  schedule; pack removal = vanished-file behaviour (exclude + log, aired rows
  untouched).

### P2 · Preload — ship channels in the box (Apple) `[M]`

- Bundle the preload pack(s) in `Resources/packs/` (added to the existing
  targetTemplate copy step).
- **First-run seeding:** empty Store → register bundled packs + create the
  five preload channels (SUPERMAN · SATURDAY MORNING · RERUN THEATRE ·
  CREATURE FEATURE seed · AD BREAK assets) with deterministic seeds/numbers,
  then `Scheduler.topUp`. The TV is a real television out of the box.
- **Demo mode is retired** as the fallback (the test-pattern clip stays in the
  bundle as the last-resort "please stand by" content, but `startDemoLineup()`
  gives way to the preload lineup). App Review note gets *better*: reviewers
  see real channels, no Plex, no setup.
- Preload channels ship **kid-safe flagged** and with **ads ON** (our retro ad
  pods are the charm; user channels keep ads OFF default).
- ⚠️ **Decision gate D1 (owner)** — how much rides in the binary:
  - **(a) Full ~2 GB in the .ipa/.pkg** — simplest, works offline day one.
    Cost: every app update re-ships 2 GB (painful during current
    build-per-day TestFlight cadence); slower ASC processing.
  - **(b) Starter ~300–400 MB bundled + one-tap "finish the lineup"** download
    for the rest — recommended; keeps update size sane. *(Recommended)*
  - **(c) Apple On-Demand Resources** — Apple-hosted, tvOS-blessed, but adds
    ODR plumbing + review complexity. Revisit if (b)'s downloads annoy.
- **tvOS wrinkle (design constraint):** tvOS treats app-writable storage as
  purgeable — the bundle is the only guaranteed-persistent store. Downloaded
  packs on tvOS live in Caches and must be silently re-downloadable (the
  channel shows stand-by bars while it refetches — invariant #7). Verify
  behaviour on real hardware.

### P3 · Pack picker in the web UI `[M]`

The owner's bar: **no browsing IA in-app, ever** — only curated packs.

- **Manifest index:** `https://dumbtv.app/packs/index.json` (updates curation
  without an app release) with a **bundled fallback copy** so the picker works
  offline/with the site down. Fetched only when the user opens the packs page
  — no phone-home.
- **API contract additions** (both backends; `docs/api-contract.md` updated):
  - `GET  /api/packs` — installed + available (merged view)
  - `POST /api/packs/:id/install` — download from IA (or pack host) with
    resume; progress via the existing status polling pattern
  - `POST /api/packs/:id/channel` — one-tap: create channel from pack
  - `DELETE /api/packs/:id` — remove files + media rows (aired schedule rows
    untouched, append-only)
- **Web UI:** a "Channel Packs" section — pack cards (name, runtime, size,
  one-line description), INSTALL → progress bar → "CREATE CHANNEL", storage
  management. Same retro UI language as the rest of the config app.
- Downloads for v1 pull **IA's existing h.264 derivatives directly** (zero
  hosting cost). Self-hosted re-encodes (quality + speed control) are a later
  swap behind the same manifest — the manifest's `source` already carries
  both shapes.

### P4 · Node/Pi parity `[S–M]`

- Same schema/API/UI (the web UI is shared already). Pack storage under the
  Node data dir; `pi/install.sh` gains an optional `--packs` fetch so a Pi can
  be flashed with the full lineup.
- Node preload = a post-install download prompt, not repo bloat.

### P5 · Local folders, Node (was I1) `[M]`

- New source type `local_folder`: scanner walks it (the `assets.js` pattern),
  filename parsing **with no network metadata**: `S01E02`/`1x02` → show/season/
  episode; `Title (1994)` → movie; fallback title=filename. Parsing rules
  published in docs; parse-preview in the web UI before committing.
- `rating_key` = hash(folder-relative path) — stable across rescans.
- Rescan on demand + at top-up; vanished file → exclude + log.
- Selftest: parse table, key stability, vanished-file.

### P6 · Local folders, Apple (was I2) `[M→L]`

- **macOS first:** native "grant folder" (security-scoped bookmark, entitlement
  already present) → folders then *managed* in the web UI (decision from
  planning: native grants once, web manages). `bm:{bookmarkId}/{relpath}` part
  keys; AVAsset durations; the same filename-parsing spec as P5 with **shared
  test vectors** (one spec, two implementations).
- **iOS second wave** once macOS proves the bookmark model.
- **tvOS: never** — no user filesystem; tvOS is packs + Plex/Jellyfin, stated
  plainly in docs (decision already made in planning).

### P7 · Jellyfin verification, Node (was I4a) `[M]`

- Run the existing `src/jellyfin/` client against a live server; fix what
  reality breaks; mark verified in CLAUDE.md (house rule). Surface the backend
  toggle properly in the web UI docs. The Swift port stays a separate decision
  afterward.

---

## Cross-cutting (lands alongside the phases)

- **Privacy policy** += two lines: pack index is fetched from dumbtv.app when
  you open the packs page; installing/streaming a pack transfers data with
  archive.org. Still no analytics, no accounts, nothing phoned home.
- **App Review note** rewrite (P2): "the app ships with working channels of
  verified US-public-domain content; provenance: dumbtv.app/packs".
- **Docs:** setup guide gains "Channels out of the box" + "Add a channel
  pack"; FAQ gains "Where does the built-in content come from?" and the tvOS
  honesty answer; website brief's How-To updated after P3 ships.
- **Version:** this is **1.2.0** (feature release), builds continue
  monotonically.
- **No CI/push work needed** until GitHub usage resets (~2026-07-31); all
  phases build/test locally.

## Order, sizing, and what gates what

```
P0 (packs exist)  →  P1 (engines understand packs)  →  P2 (preload ships)
                                        └→  P3 (pack picker)  →  P4 (Pi parity)
P5 (Node folders) → P6 (Apple folders)          [independent of P2–P4]
P7 (Jellyfin verify)                             [independent, anytime]
```

- P0+P1+P2 is the coherent first shippable: **the box comes with television.**
- P3 is the second shippable: **one-tap packs.**
- P5–P7 can interleave behind them.
- Rough effort: P0 [M] · P1 [M] · P2 [M] · P3 [M] · P4 [S–M] · P5 [M] ·
  P6 [M→L] · P7 [M]. ([S] hours–day, [M] days, [L] week+.)

## Decision gates — RESOLVED 2026-07-26

| # | Gate | Decision |
|---|---|---|
| D1 | Binary size | **Starter bundle (~300–400 MB) + one-tap fetch** for the rest. |
| D2 | Preload channels ads/kid-safe | **Ads ON, kid-safe ON.** |
| D3 | Retire demo lineup | **Yes — preload replaces demo. BUT the setup QR card stays on screen until the first web-UI open** (not just "gone once configured"), and that card gains a **"Tune to channel 0 anytime for this code"** line. |
| D4 | Pack downloads | **IA derivatives direct** for v1. |
| D5 | Pack index host | **`dumbtv.app`** (`/packs/index.json`), with the bundled fallback. |

### D3 detail (P2 implementation)
- New persisted Store flag `setup_seen` (0 until the web config UI is opened at
  least once — the embedded server / Node server sets it on the first browser
  hit to the config page / its status endpoint).
- On-TV **setup card shows while `setup_seen == 0`**, regardless of demo/preload
  — so a fresh box plays real preloaded channels *and* keeps nudging you to set
  up until you've actually opened the web UI once.
- The card copy gains: **"Tune to channel 0 anytime to bring this back."**
  (Channel 0 / SETUP already exists from the earlier fix — this just advertises
  it on first run.)
- After first web-UI open the card retires; channel 0 remains the way back.
- The demo test-pattern clip stays bundled as the last-resort stand-by asset
  (invariant #7), it just no longer drives a fake lineup.

## Definition of done (track)

- Fresh install, no Plex, no setup → five channels + retro ad breaks playing.
- Web UI installs a pack and creates its channel in ≤ 3 clicks.
- A channel can mix pack + Plex + local content; scheduler/guide can't tell.
- Same folder / same pack rescanned → identical schedule (deterministic keys).
- Every bundled/pack item has recorded PD provenance.
- selftest + Swift tests cover: manifest→rows, determinism, vanished
  file/pack, parse table (P5+).
- Docs + privacy policy + App Review note updated.

# Build 15 — implementation handoff (P1 · Pay the debts)

**Status: planned, nothing built. Written 2026-07-29 against build 14.**

Read order before touching anything:

1. `CLAUDE.md` — the invariants. Several items below sit right next to them.
2. Notion → **Code Audit — 2026-07-29** — why each fix exists.
3. Notion → **Engineering Plan — schemas & plumbing** — the schema designs this build implements.
4. This file — file-level specs, acceptance criteria, ordering.

---

## Environment quirks (bite once, remembered here)

- **Node 22 only.** `better-sqlite3` will not build on the default Node 26. Use the keg-only `node@22`.
- **ffmpeg has no freetype** on this machine — `drawtext` is unavailable, `demo.js` falls back to `testsrc2`. Don't "fix" that.
- `npm run selftest` currently passes **60/0**. Swift is **96/0** with 3 skipped (2 need a live server, 1 needs live Plex).
- Plex: only the **WAN** connection resolves from this Mac. `.avi` is mpv-only.
- Jellyfin verification: `node scripts/verify-jellyfin.mjs <url> <user> <pass>` — skips cleanly with no server.

## Scope guards

- **Do not touch `schedule/` generation logic in this build.** Config v3 regenerates through the existing `ensureSchedule()`; nothing here changes how programs are placed. The scheduler work is build 17.
- **Do not add dependencies.** Invariant #8 — plain ESM, no build step, `npm install && npm start`.
- **Do not rewrite `tv.js` into a framework.** U-1 is an escaping fix, not a rewrite.
- If a fix appears to need a schema migration not listed here, stop and flag it rather than inventing one.

## Regression gates (every chunk must leave these green)

```bash
npm run selftest          # 60/0 today; new checks only add to it
cd apple && swift test    # 96/0, 3 skips
xcodebuild -scheme dumbTV-iOS  build   # all three apps must still build
```

---

# Chunk A · Security batch — **do this first, it blocks Chunk B**

These three are the reason the live pack catalog cannot ship yet. All small.

### A1 · Pack install path traversal (audit **S-1**)

**File:** `src/packs/install.js`

`startInstall()` builds `path.join(dir, it.file)` from a catalog-supplied `it.file`. A value of `../../../evil.txt` resolves outside the pack directory (verified). Today the catalog is bundled so it's inert; **Chunk B makes it remote-controlled**, which is why this lands first.

- Reject any `it.file` where `it.file !== path.basename(it.file)`, or where it is empty / begins with a dot. Throw a plain `Error` naming the offending value.
- Apply in **both** `startInstall()` and `readPack()` — a hand-placed pack directory is the same hazard.
- Add the same assertion to `scripts/build-pack.js` `verify`, so a bad manifest can never be published.

**Acceptance:** a selftest case with `file: "../escape.mp4"` throws and writes nothing outside the pack dir.

### A2 · Download caps (audit **S-9**)

**File:** `src/packs/install.js`, `downloadTo()`

No size cap, no timeout, follows redirects wherever the catalog points.

- `AbortSignal.timeout()` on the fetch (10 min is generous for a 300 MB pack on a slow line).
- Cap total bytes written; abort and delete the `.part` when exceeded. Derive the cap from the catalog's declared `bytes` with generous headroom (e.g. `max(50 MB, declared × 1.5)`); if the entry declares nothing, use a flat ceiling.
- On abort, remove the partial file — the N1 `.part` convention already means a leftover can't poison the cache, but don't leave litter.

**Acceptance:** an oversized/hanging download aborts, the `.part` is gone, and `progress.state === 'error'` with a readable message.

### A3 · XSS in the browser TV (audit **U-1**)

**Files:** `public/tv.js`, plus a new tiny shared module.

`tv.js` builds the guide with `innerHTML` and interpolates `p.title`, `p.subtitle` and `c.channel.name` **unescaped** — zero `escapeHtml` calls in the file, while `app.js` uses it consistently. Those strings come from Plex/Jellyfin metadata, from **filenames**, and from **pack manifests** (network-fetched after Chunk B).

- Extract `escapeHtml` from `public/app.js` into `public/esc.js` (a two-line ESM module) and import it in both. Do not duplicate the function.
- Escape every interpolated value in `paint()`'s guide construction and in the `show()` card helpers.
- Audit the whole file for other `innerHTML` sinks while you're in there.

**Acceptance:** a media title of `<img src=x onerror="document.title='xss'">` renders as literal text in the guide and the banner, and `document.title` is unchanged.

---

# Chunk B · The website and the pack catalog

Closes D5 properly and fixes the drift found on 2026-07-29: the deployed `dumbtv.app` does **not** match `site/` in the repo (26.6 KB live, working guide grid, vs a 4.0 KB July-24 draft). What is on the internet is untracked.

**Owner decision 2026-07-29:** pull the deployed files down and make them the source of truth.

### B1 · Deployed site into the repo

```bash
curl -sSL https://dumbtv.app/         -o site/index.html
curl -sSL https://dumbtv.app/privacy  -o site/privacy.html
curl -sSL https://dumbtv.app/support  -o site/support.html
```

Commit as-is in one commit with a message saying plainly that these are the **deployed** files being brought under version control, so the history records that the repo copy was previously stale. Do not reformat or "improve" them in the same commit — a later commit can do that, and keeping this one a pure import means the diff against the live site is verifiable.

### B2 · CI deploy

New `.github/workflows/site.yml` — on push to `main` touching `site/**`, deploy to Netlify. Path-filtered like `docker.yml` already is. Needs a `NETLIFY_AUTH_TOKEN` + site ID as repo secrets; **if they are not present, the workflow should no-op with a clear message rather than fail the build.**

### B3 · Publish `packs/index.json`

`dumbtv.app/packs/index.json` currently **404s** — the apps fall back to the bundled catalog, so nothing is broken, but "curation updates without an app release" is not true today.

- `npm run build-pack -- catalog` already generates `packs/index.json`. Have B2's workflow copy it to `site/packs/index.json` on deploy so the live catalog is generated, never hand-edited.
- Verify the deployed URL returns 200 and parses, and that a device with no bundled catalog can install from it.

**Acceptance:** `curl https://dumbtv.app/packs/index.json` returns the same JSON as the repo's, and a fresh Docker container installs a pack from the live catalog.

> **Ordering is not optional:** A1 and A2 must be merged before B3. Publishing the catalog is what converts S-1 from theoretical to live.

### B3 findings — 2026-07-29 · **the second half of this task does not exist**

The publishing half is done: `.github/workflows/site.yml` regenerates the catalog from the manifests, validates it, deploys it, and then asserts the live URL returns 200 with a matching pack list. `dumbtv.app/packs/index.json` will stop 404ing the first time that workflow runs with credentials.

**But nothing consumes it, so publishing alone cannot make curation live.** Verified in both engines:

- **Node** — `loadCatalog()` in `src/packs/install.js` reads exactly one path, `<repo>/packs/index.json`, and falls back to an empty catalog. There is no remote fetch anywhere in the Node codebase.
- **Swift** — `loadCatalog()` in `Packs+API.swift` prefers `downloadedPacksDir()/index.json` over the bundled copy, but **nothing in the codebase ever writes that file.** The override is a slot that was left for this feature and never filled.

So the acceptance criterion *"a fresh Docker container installs a pack from the live catalog"* **is not achievable by this chunk** — a container installs from its bundled catalog, exactly as before.

**This was not specced, and it should not be invented**, because the missing piece carries a real decision:

- **The no-phone-home promise.** The roadmap's P3 entry says the catalog is *"fetched only when the page opens — no phone-home."* A fetch on boot, on a timer, or on every pack-picker render are three different privacy stories, and the privacy policy currently describes none of them.
- **Failure and staleness policy** — TTL, offline behaviour, and whether a fetched catalog that is *older* or *smaller* than the bundled one should ever win.
- **Where the fetched copy lands on Apple** — writing `downloadedPacksDir()/index.json` interacts with the tvOS purgeable-Caches rule from the A5/N4 work.
- **Trust.** The moment a remote catalog is honoured, S-1 and S-9 stop being theoretical. Those are fixed (Chunk A), but the threat model should be written down alongside the fetch, not after it.

**Recommendation:** a small follow-up — "fetch the pack catalog, with the bundled copy as fallback" — specced with the privacy answer decided up front. Roughly `[S]` in both engines once the policy question is settled. It is the honest remainder of D5.

---

# Chunk C · Pack manifest schema v2

Full design in Notion → **Engineering Plan**, §1. This chunk implements it.

### C1 · Schema + validator

**File:** `scripts/build-pack.js`

New per-item fields: `rightsBasis` (`GOV`|`AGE`|`NR`|`CC`), `rightsNote`, `rightsVerified`, `rightsVerifiedBy`, `musicRights` (`cleared`|`unverified`|`encumbered`), `contentWarning[]`. New pack-level: `rightsBasisSummary[]`, `partialSeries`.

`verify` rejects when:

1. `rights: "public-domain"` lacks `rightsBasis`, `rightsNote`, or `rightsVerified`.
2. `musicRights === "encumbered"` — always, no override.
3. `rightsBasis === "NR"` lacks `rightsVerifiedBy` naming the CCE volume checked. **This is the *Wooden Soldiers* trap** — an NR claim with no citation is a lead, not a clearance.
4. A `contentWarning` entry is outside the closed vocabulary: `racial-caricature`, `wartime-propaganda`, `smoking`, `graphic-violence`, `adult-humor`.
5. `rightsBasis === "CC"` — **reject entirely for now.** The CC question (PD Packs Task 4) is an open owner decision; until it's made, no CC content ships. NonCommercial stays rejected permanently regardless.

**v1 manifests must still load at runtime.** Only `build` and `verify` are strict; `readPack()` treats a missing basis as unverified and carries on. A user with an installed v1 pack must not lose their channel.

### C2 · Migrate SNAFU & BOSKO (54 items)

New `scripts/migrate-manifests.js` handling the uniform fields:

- **SNAFU & CO** (32 items) — every item `rightsBasis: "GOV"`, `musicRights: "cleared"` (Stalling's scores were work-for-hire on a federal production), `rightsNote` citing 17 USC 105.
- **BOSKO & FRIENDS** (22 items) — every item `rightsBasis: "AGE"`, `rightsVerified` = release-date confirmation.

**Leave the per-title `contentWarning` subset to a human pass.** Do not let the script guess which cartoons carry caricature — the existing pack-level `contentNote` on both packs tells you the warning applies, not which titles. Emit a checklist of every title needing review and stop.

### C3 · Per-item tags (forward-compat for build 17)

Add an optional per-item `tags: []` to the manifest schema and populate it during C2 — `cartoon`, decade (`1940s`), `wartime` etc. Costs nothing now; it means dayparting in build 17 works on the preload lineup with **zero user effort**. Reopening every manifest later is the expensive version.

**Acceptance:** all 8 packs pass `verify` under v2; `npm run selftest` still green; an installed v1 pack still resolves and plays.

### C findings — 2026-07-29 · **the gate blocks 40 items across 5 packs, and that is it working**

Two things the plan did not anticipate.

**1 · The schema applies to all 8 packs, not the 2 named.** C2 scoped the migration to SNAFU and BOSKO — the two authored ahead of the gate. But `checkProvenance` runs on *every* pack, in `verify`, in `build`, and in `catalog`. Migrating only two would have left the other six failing. `scripts/migrate-manifests.js` therefore covers all eight, driven by each manifest's own documented prose.

**2 · Half the catalog rests on an uncitable NR claim.** After migration:

| Pack | Basis | Verify |
| --- | --- | --- |
| snafu-and-co (32) | GOV | ✅ |
| space (5) | GOV | ✅ |
| early-disney (3) | AGE | ✅ |
| bosko-and-friends (22) | AGE + NR | ⛔ 16 items |
| superman (17) | NR | ⛔ 17 items |
| popeye-color (3) | NR | ⛔ 3 items |
| saturday-morning (3) | NR | ⛔ 3 items |
| ad-break (1) | NR | ⛔ 1 item |

**40 of 86 items claim "copyright not renewed" with no Catalog of Copyright Entries citation.** Their provenance reads *"IA item carries a public-domain mark"* — which the PD Packs page itself calls *"uploader-supplied, not a legal guarantee"* and *"a lead, not a clearance."* Rule 3 of the schema exists precisely to catch this, and on day one it caught the existing catalog.

Nothing here is a surprise to the manifests themselves. BOSKO's own `rightsNote` already says the 1931 titles *"clear by AGE on 2027-01-01; until then their PD status rests on documented non-renewal (NR)"*, and one of them literally says **"VERIFY before ship if shipping in 2026."** POPEYE was already moved to download-only in build 14 pending a CCE check. v2 turned prose caveats into a gate.

**No citations were invented.** A script cannot open a renewal volume, and fabricating `verifiedBy` would defeat the only rule that matters. The 40 items are marked `basis: "NR"` with `verifiedBy` absent, so `verify` fails with exactly what is missing, per item.

**What is and is not broken:** every pack's `dist/` is already built, so **all three apps still build and every preload channel still plays.** What is blocked is *rebuilding* those five packs and *regenerating* `packs/index.json` — the Site workflow already falls back to the committed catalog, so deploys still work.

**This needs an owner decision, and it is sharper than it looks: three of the five blocked packs (`ad-break`, `saturday-morning`, `superman`) are PRELOAD** — they ship inside the App Store binary. Options, roughly in order of honesty:

1. **Do the CCE lookups** for the 40 titles and record `license.verifiedBy`. Real work, but it is the work the project's own policy already committed to.
2. **Narrow the packs** to titles with citable provenance and drop the rest.
3. **Wait on BOSKO's 16** — they clear by AGE on 2027-01-01 with no lookup at all, so that subset resolves itself in five months.
4. Weaken rule 3 — **not recommended**; it is the only thing standing between the catalog and the *Wooden Soldiers* trap.

**Content warnings were left to a human**, as instructed: SNAFU, BOSKO and SUPERMAN all carry pack-level notes saying a warning applies *somewhere*, and the migration prints a per-pack checklist rather than guessing which titles.

### Deviation from the written schema shape

The Engineering Plan showed flat item fields (`rightsBasis`, `rightsNote`, `rightsVerified`, `rightsVerifiedBy`, `musicRights`). The existing manifests already nest provenance under `license: { url, verified, note }`, so the flat shape would have produced **two competing verification dates** (`rightsVerified` beside `license.verified`) and two places to record why.

Implemented instead as `license.basis` / `license.verifiedBy` / `license.musicRights`, keeping `license.verified` and `license.note` as the single date and single rationale. `contentWarning` and `tags` stay at item level — they are content facts the scheduler reads, not rights facts. Every validator rule from the plan is enforced unchanged; only the nesting differs.

---

# Chunk D · Config Format v3

Design in Notion → **Engineering Plan**, §4. This closes the long-open Track B export/import item and fixes three audit findings on the way.

### D1 · Node (`src/routes/api.js`)

- **Export v3.** Channels carry their own nested `sources`, `excludes`, `rules` keyed by a per-file synthetic `key`, using API field spellings (`orderingMode`, `adsEnabled`, `shuffleSeed`) not raw column names. Add `origin: { platform, appVersion }` and a `settings` block (the syncable subset only).
- **`shuffleSeed` must travel.** Without it a cloned lineup plays in a different order — invariant #5 broken across devices.
- **Locked channels never export** (filter `locked = 0`).
- **Import:** accept v3, and accept v2 for one release (read-only compat). Replace the `Object.keys()`-derived column list with a **fixed whitelist** (fixes **S-7**). Scope the delete to unlocked channels only — today's wholesale delete destroys SPACE, the channel whose 403s exist to prevent exactly that (fixes **D-3**, live in shipped code). Skip any incoming `locked: true` rows.
- One transaction, then `ensureSchedule()`. Invariant #4 holds because regeneration only deletes `start_utc >= now`.

### D2 · Swift (`ConfigAPI.swift`)

Today `exportConfig()` emits `{version: 2, channels, rules}` — **no sources, no excludes**. An Apple export therefore loses the actual content of every channel. And there is **no import route at all**.

- Rewrite the exporter to emit the identical v3 bytes as Node.
- Add `POST /api/config/import` with matching semantics, including the locked-channel rules.
- The preload re-seed (`preload_seeded`) must not fight an import — check the interaction and guard it.

### D3 · Stable shuffle seeds (audit **D-2**)

`POST /api/channels` and `createChannelFromPack` seed with `Math.random()`, so the same pack on two devices plays in a different order. `createChannelFromLocalFolder` already does this correctly with `fnv(folderId)` — copy that pattern in both places, deriving from pack id or channel name.

Existing channels keep their stored seed; this only changes the default for new ones.

**Acceptance:** export from Node → import on Apple → identical channels, sources, excludes, rules, and **identical running order**. Export from a device with SPACE → the file contains no locked channel → import elsewhere → SPACE survives untouched. Round-trip a v2 file without data loss.

---

# Chunk E · Performance and correctness

### E1 · Guide N+1 (audit **E-1**) — `src/schedule/resolver.js`

`guide()` issues a separate max-end-time lookup **per program row**, and re-prepares the statement **inside the loop**. Replace with one grouped lookup for all slots in the window, and hoist the prepare to module scope like every other statement in the file. Best single perf win in the Node codebase.

### E2 · Index-defeating `OR` (audit **E-2**)

`WHERE parent_key = ? OR rating_key = ?` in `/api/channels` and in `ordering.js` `selectSourceMedia` — SQLite generally won't use both sides of an `OR`. Replace with two indexed lookups combined. Runs once per source per channel on every channel-list load.

### E3 · Image proxy + cache + whitelist (audit **S-5**, **S-6**, **E-3**)

`src/plex/client.js` `imageUrl()` puts `X-Plex-Token` in a URL handed to the browser — it lands in page source, history, devtools, screenshots. Apple's `fetchImage` exists precisely to avoid this; **the two backends disagree on a security property and Node is weaker.**

- Add `GET /api/image?path=…` to Node, proxying with the token server-side. Update `imageUrl()` to return the proxy URL.
- Validate `path` against a tight pattern for library metadata/part paths **in both backends** (fixes S-6, where the Swift proxy will currently make arbitrary authenticated requests to the Plex server for anyone on the LAN). Cap the response size.
- Add a small memory LRU (fixes E-3 — Apple got one in build 12, Node has none).

### E4 · Filename year parsing (audit **D-1**) — `src/media/filename.js` + `Filenames.swift`

The year strip is unanchored and fires on the first match anywhere: `2001 A Space Odyssey (1968)` loses the **2001** and is dated 2001. Prefer the parenthesised year; accept a bare year only at the **end** of the name.

Add vectors to `scripts/filename-vectors.json` first — **both** implementations assert that table, so the vectors are the spec. Include `2001 A Space Odyssey (1968)`, `1984 (1984)`, and a bare-year-at-end case.

### E5 · Timezone regenerates (audit **D-4**) — `src/routes/api.js`

Slot alignment is anchored to **local midnight**, but changing the timezone doesn't trigger a rebuild — the schedule silently sits on the old grid. After a successful timezone change, regenerate futures on every channel. Invariant #4 keeps what's airing intact.

### E6 · Small hardening (audit **S-8**, **E-4**, **D-5**)

- `/api/local`: resolve the **real** path (symlinks) before comparing against the pack root; a symlink inside a pack root is currently served.
- `packs/install.js`: evict finished entries from `installProgress` after a grace period — it currently grows forever in a long-running Pi process.
- `src/db.js`: `addColumnIfMissing` interpolates table names. All call sites are literals; add a comment (or a whitelist) so the pattern isn't copied unsafely — this file is described as the single source of truth for the model and will be read as an example.

---

# Chunk F · P6 · macOS folder-grant UI

The **last** piece of Track I code. The model is already done and tested (`LocalFolders.swift`: shared parser, stable `folder:` keys, `local:` playback, vanished-file drop, Swift tests green).

Remaining:

- **Native grant:** `NSOpenPanel` folder picker on macOS → security-scoped bookmark persisted in the Store (`bm:` part keys). The entitlement (`files.user-selected.read-write`) is already present.
- **Manage in web:** a "granted folders" list in the web config UI — view, rescan, remove. **The decided shape is native grant once, manage in web** (Track I open question 1, resolved). The web UI cannot open a native picker on the TV, so don't try.

iOS is wave 2. **tvOS is never** — no user filesystem; that's a documented product decision, not a gap.

### ✅ F — BUILT 2026-07-29, after the storage decision was made

Storage decided: a **`granted_folders` table** (not UserDefaults — that was for small durable flags surviving a tvOS Caches purge; these are ~1 KB blobs with a path, a scan time and a count, which is a model object). The bookmark is stored **base64 in a TEXT column**, because this SQLite wrapper has no blob value type and a kilobyte is not worth widening the whole layer for.

Shipped: the table + `saveGrantedFolder` / `grantedFolders` / `removeGrantedFolder` / `resolveGrantedFolder` (which silently re-saves a stale bookmark, so a moved folder keeps working) · `NSOpenPanel` behind **Channel ▸ Add Local Folder…** in the Mac menu bar · four API routes · and a shared web UI.

**Node gained parity so ONE web UI serves both**: a `local_folders` table mirroring the Apple columns minus the bookmark, a `GET /api/local-folders` list, rescan, forget, and a `/:id/channel` route matching the Apple shape. A wire mismatch was caught by testing — Node's existing route took the id in the BODY while the Apple one takes it in the PATH, which is precisely the kind of drift that makes "one UI, two backends" quietly false.

**Verified:** 5 Swift tests (grant survives, bookmark round-trips byte-for-byte through base64, a moved folder reports itself, forgetting drops media but keeps the channel, path normalisation is stable so a re-grant restores the same schedule) and an end-to-end Node run against real video files (scan → list → channel → 50k programs scheduled → rescan → forget).

**Still needs a human:** the `NSOpenPanel` itself. A file panel cannot be clicked headlessly, so the grant path is the one part shipping unexercised — it is on the device-pass list, not claimed as done.

### Superseded F findings — *(the reasoning for stopping, kept for the record)*

Stopped here rather than inventing, per this document's own scope guard (*"If a fix appears to need a schema migration not listed here, stop and flag it"*). Two things are genuinely undecided:

**1 · Where do the bookmark blobs live?** `bm:` is named as the part-key prefix, but a security-scoped bookmark is ~1 KB of opaque `Data` per granted folder, and nothing in the schema holds it. `LocalFolders.swift` has `registerLocalFolder`/`createChannelFromLocalFolder` and stable `folder:` keys, but no bookmark storage at all — I checked. The options are a new `granted_folders` table, a blob column on an existing one, or `UserDefaults` (which is what the build-11 work used for durable settings that must survive a tvOS Caches purge). That is a model decision, and `db.js` is described as the single source of truth for the model.

**2 · It cannot be verified here.** `NSOpenPanel` requires a human to click a real panel in a real desktop session, and security-scoped bookmarks have failure modes that only appear in the sandbox — stale bookmarks after a move, `startAccessingSecurityScopedResource` balance, and the App Sandbox behaving differently from a dev build. Shipping that unexercised would put it straight onto CLAUDE.md's "Known unverified" list beside `mpv.js` and `overlay.js`, which is exactly the category this project has been working to shrink.

**What is already done** (build 13, tested): the whole model — shared filename parser, stable `folder:` keys, `local:` playback, vanished-file drop, and Swift tests covering register/rescan/vanish/schedule.

**What remains, once the storage question is answered:** the `NSOpenPanel` grant, bookmark persist/resolve with `startAccessing` at play time, `ConfigAPI` routes (Apple has **no** local-folder routes at all today — also verified), and a "granted folders" list in the web UI. Sizing is unchanged at `[M]`; it wants a session with the Mac app actually running.

---

# Chunk G · G1 investigation (repo-side only)

G1 (macOS TestFlight "not compatible") is an owner/device item, but **part of it is diagnosable from the repo** and should be done here so the device round has an answer waiting.

**Strong lead found 2026-07-29:** `apple/project.yml` sets the macOS target's `deploymentTarget: "14.0"`. A tester on macOS 13 or earlier gets exactly "not compatible." Check this against the test Mac **before** anything else.

Also check and report:

- No explicit `ARCHS` is set for the macOS target. Confirm what the CI archive on `macos-15` actually produces — if VLCKit ships arm64-only slices, an Intel Mac reports the same error.
- Whether the macOS platform build is assigned to the TestFlight tester group at all.
- Whether the tester installed from the **macOS** TestFlight app (Mac builds don't appear in the iOS one).

Write findings into `docs/build-15-handoff.md` under a "G1 findings" heading rather than guessing at a code fix. **Do not change the deployment target speculatively** — lowering it has real consequences and needs the tester's OS version first.

### ⚠️ G1 — CORRECTED 2026-07-29. The findings below answered the wrong question.

**The actual error is "TestFlight is currently unavailable. Try again." — not "not compatible."** Everything under the heading that follows was reasoned from a paraphrase and is answering a failure mode that never occurred. It is kept only because ruling architecture out is still useful.

**What the real error tells us:**

- **It is not a build problem.** The build lists correctly — 435.8 MB, correct version, Install offered. Nothing about a deployment target or a missing architecture produces this message.
- **It is not an Apple outage.** It has failed since build 1, across months and fifteen builds.
- **It is not the account, the Apple ID, or the agreements** — because the **iOS build installs on that same Mac**, through the same TestFlight and App Store plumbing. If any of those were broken, nothing would install.

So it is specific to the **macOS platform build's distribution**, and the ranked candidates are:

1. **The macOS build is not assigned to a TestFlight tester group.** Groups are assigned PER PLATFORM in App Store Connect — being a tester on iOS does not make you one on macOS. This fits "since build 1" exactly: it would never self-resolve, and it surfaces as a generic error because the build genuinely is not available to that account.
2. **Export compliance unanswered on the macOS build**, which leaves it visible but not distributable.
3. Sign out / back in to the App Store on that Mac — forces a re-fetch of the install authorisation.

**PARKED 2026-07-29 by the owner.** Group membership was checked and is correct, so candidate 1 is out too. State when it was set down:

- **Ruled out:** architecture · Apple ID / TestFlight / agreements (the iOS build installs on that same Mac) · tester-group membership.
- **Leading hypothesis, untested:** all three targets share the bundle ID `app.dumbtv.app` for universal purchase, and the iOS build is installed on that Mac — so the macOS build carries the same identity as something already present. One-minute test: delete the iOS build, reboot, retry.
- **The right next step is evidence, not another hypothesis.** Two rounds of diagnosis have now missed because they reasoned from a description. Capture the real failure while reproducing it:
  ```
  log stream --info --debug --predicate 'process CONTAINS[c] "appstore" OR process CONTAINS[c] "storedownload" OR process CONTAINS[c] "TestFlight"'
  ```
- **Still unchecked:** whether the macOS build shows *Missing Compliance* in App Store Connect.

**This blocks TESTING the Mac build, not shipping.** iOS, iPadOS and tvOS can be submitted independently under the same app record — see the note in the plan about submitting the Mac later.

**Lesson for the next one of these: get the exact error text before writing a findings section.** Two builds of diagnosis went into the wrong failure mode.

---

### Superseded G1 findings — 2026-07-29 · *(kept for the architecture ruling only)*

Read from `xcodebuild -showBuildSettings` on the **Release** configuration, which is what `build-release.sh` archives and therefore what build 14 actually shipped:

```
ARCHS             = arm64 x86_64      ← universal
ONLY_ACTIVE_ARCH  = NO
MACOSX_DEPLOYMENT_TARGET = 14.0       ← requires macOS 14 Sonoma
```

**Architecture is not the cause.** A release archive is universal, and VLCKit ships both slices (`lipo -archs` on the framework: `x86_64 arm64`), so an Intel Mac is fully supported. (The *Debug* binary is arm64-only, but only because Debug defaults `ONLY_ACTIVE_ARCH=YES` — that never reaches TestFlight, and it is the trap to avoid when checking this by hand.)

**`MACOSX_DEPLOYMENT_TARGET = 14.0` is the answer that fits the symptom exactly.** A Mac running macOS 13 Ventura or earlier cannot install the build, and TestFlight's wording for that is precisely "not compatible."

**The one question for the tester: what does ☰ → About This Mac say?**

- **macOS 13 or earlier** → confirmed. Then it is a product decision, not a bug: macOS 14 was released September 2023, so the current floor excludes Intel Macs that stopped at Monterey/Ventura. Lowering to 12.0 or 13.0 widens reach; whether the SwiftUI in use survives that is the thing to test, and it should be a deliberate change with its own verification, not a speculative edit. **Nothing was changed here.**
- **macOS 14 or later** → the deployment target is exonerated and the remaining candidates, in order: the macOS build is not assigned to the tester's TestFlight group in App Store Connect; or the tester is looking in the **iOS** TestFlight app, where Mac builds never appear.

For reference, the other floors are iOS 16.0 and tvOS 17.0, both unchanged.

---

# Suggested commit order

Six logical chunks, mirroring the build-13 shape:

1. **A** — security batch (A1, A2, A3). Merge before anything in B.
2. **B** — site into repo, CI deploy, live catalog.
3. **C** — pack schema v2 + migration + tags.
4. **D** — Config v3, both engines, stable seeds.
5. **E** — perf and correctness batch.
6. **F + G** — macOS folder grant, G1 findings.

Bump `CURRENT_PROJECT_VERSION` to 15 last, as a separate commit, the way build 13 did.

## What this build does NOT do

Named so scope doesn't drift: no scheduler changes (build 17), no presentation work (build 16), no accessibility pass (build 16), no cloud/accounts anything (P5), no new packs authored (the schema has to land first), and no speculative fix for G1 or G2 — those need the device.

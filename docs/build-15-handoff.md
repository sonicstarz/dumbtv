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

---

# Chunk G · G1 investigation (repo-side only)

G1 (macOS TestFlight "not compatible") is an owner/device item, but **part of it is diagnosable from the repo** and should be done here so the device round has an answer waiting.

**Strong lead found 2026-07-29:** `apple/project.yml` sets the macOS target's `deploymentTarget: "14.0"`. A tester on macOS 13 or earlier gets exactly "not compatible." Check this against the test Mac **before** anything else.

Also check and report:

- No explicit `ARCHS` is set for the macOS target. Confirm what the CI archive on `macos-15` actually produces — if VLCKit ships arm64-only slices, an Intel Mac reports the same error.
- Whether the macOS platform build is assigned to the TestFlight tester group at all.
- Whether the tester installed from the **macOS** TestFlight app (Mac builds don't appear in the iOS one).

Write findings into `docs/build-15-handoff.md` under a "G1 findings" heading rather than guessing at a code fix. **Do not change the deployment target speculatively** — lowering it has real consequences and needs the tester's OS version first.

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

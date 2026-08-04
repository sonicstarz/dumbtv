# AI Lineup Builder — full design

**Status: designed, decisions closed 2026-08-03, not started.** Owner-requested
2026-08-03. This document is the build plan; the Docket rows (AI-1, AI-A0…A4)
track execution. Read `docs/manual-schedule-editor.md` for the sibling problem
(H2) — several decisions here deliberately rhyme with it.

**Owner decisions, 2026-08-03 (all five open questions closed):**

| # | Question | Call |
|---|---|---|
| 1 | Privacy | Delegated → **local-first stands.** Apple on-device + Ollama only; no cloud path built now. Privacy policy untouched. |
| 2 | Tag visibility | Delegated → **visible, read-only chips from A1** (invisible data steering the schedule would feel haunted). |
| 3 | Re-run cadence | Delegated → **manual only.** Matches no-phone-home. |
| 4 | Scope | **"Ship as much as possible. We build build build."** A4 ships in v1.x; nothing waits for the Pi. |
| 5 | Providers | **Apple on-device AI is the primary provider** (iPhone/Mac — the phone is already in the setup flow). **Ollama is the Pi/Node-self-host provider**, not the default. Cloud: not built. |

One constraint decision #5 must respect (verified in the SDK): FoundationModels
is **absent on tvOS**. "On the Apple TV" therefore means *the phone runs the
planner during the link-with-your-phone flow and pushes the result to the TV* —
the TV never runs a model itself. Rule-based remains the only planner that runs
literally everywhere, which is why it stays the floor and the fallback.

The pitch: a questionnaire plus a model that reads the media catalog and builds
an entire lineup — channels, groupings, dayparts, original-airdate scheduling —
so a new user goes from "linked" to "a television with my library on it"
without hand-building anything.

---

## 0 · The one rule

> **The model emits channel definitions — rows for `channels`,
> `channel_sources`, `schedule_rules`, and tags. It never emits programs.**

Everything downstream of that boundary is the existing deterministic engine.
`regenerateChannel()` turns definitions into two weeks of schedule exactly as
it does today. Consequences, in both directions:

| | Definitions (chosen) | Literal schedule (rejected) |
|---|---|---|
| Invariants #4/#5/#6 | untouched | all three break |
| Output size | ~2–5 KB JSON | ~180k rows |
| Reviewable / editable | yes, trivially | no |
| Re-runnable / diffable | yes | no |
| Two devices, same lineup | identical (seeded) | divergent |

A model that "builds a schedule" is really a model that **fills in a config
form** — which is also why hallucination is survivable: a config form can be
validated field by field. A schedule cannot.

---

## 1 · Verified ground truth (all checked 2026-08-03, not assumed)

**Platform:**
- `FoundationModels.framework` is **ABSENT from the tvOS 26.5 SDK** (present
  iOS + macOS). No on-device model on Apple TV, and no Ollama there either.
  The TV must call over the LAN — or hand off to the phone.

**Engine — the expensive parts already exist:**
- `schedule_rules` supports `kind ∈ blackout|pinned|recurring|airdate|rotation`,
  `days_of_week`, `start_time`, `duration_min`, `airdate_mode ∈
  original_weekday|anniversary|original_cadence`, `cadence_compress`,
  `effective_from/to`, per-rule `ordering_mode` + `cursor`, per-rule
  `ad_policy` JSON.
- **Rules select by tag**: `select_tags` (CSV) + `select_mode ∈ any|all` are
  live in the schema and the POST route. "Everything tagged `cartoon` on
  Saturday mornings" is expressible *today*.
- `media_tags` exists with provenance `user|pack|derived`. Rescans never touch
  `user`; `derived` recomputes freely (currently: decade). `pack` arrives from
  manifests.
- `POST /api/channels`, `POST /api/channels/:id/sources`,
  `POST /api/channels/:id/rules`, `PATCH /api/rules/:id`,
  `POST /api/channels/:id/refresh` — the whole commit path is existing API.
- Deterministic per-channel seed pattern exists (`hashString('pack:'+id)` in
  `createChannelFromPack`) — the D-2 lesson.

**The genuine gaps this feature must fill:**
1. **Genres.** `plex/client.js` caches only `title/year/leafCount/thumb`.
   `tags.js` refuses to guess genres on principle ("a decade is a fact, a
   genre is a guess"). Plex *has* Genre metadata; we never fetch it. The
   catalog dump needs a one-time enrichment call per section.
2. **A planner.** Nothing turns preferences + catalog into channel
   definitions.
3. **A questionnaire UI** and a **review UI**.

So the feature is: *catalog dump → planner → validator → review → commit*,
where commit is plumbing that already exists.

---

## 2 · Architecture

```
                                  ┌──────────────────────────────┐
   questionnaire answers ───────► │                              │
                                  │   PLANNER (provider iface)   │ ──► LineupProposal (JSON)
   catalog digest ──────────────► │  rule-based | ollama |       │          │
     (media + tags + genres)      │  apple-fm | cloud-byok       │          ▼
                                  └──────────────────────────────┘     VALIDATOR
                                                                            │ (repairs/rejects)
                                                                            ▼
                                                                      REVIEW SCREEN
                                                                            │ (user edits, accepts)
                                                                            ▼
                                                                     COMMITTER (transaction)
                                                                    channels + sources + rules
                                                                    + media_tags('ai' source)
                                                                            │
                                                                            ▼
                                                                  regenerateChannel() × N
```

Planner lives in `src/lineup/` on Node and mirrors into `dumbTVCore` later
(same porting pattern as everything else — Node first, Swift when proven).
The provider is *stateless*: `(digest, answers, constraints) → proposal`.
All state (answers, raw model output, accepted proposal) is persisted in
`settings` so a lineup is explainable and re-runnable.

---

## 3 · The catalog digest

What the planner sees. Built server-side, cached, and identical for every
provider — the rule-based baseline consumes the same digest, which keeps the
comparison honest.

```jsonc
{
  "version": 1,
  "generatedAt": "2026-08-03T18:00:00Z",
  "shows": [
    { "key": "12937", "title": "8 Out of 10 Cats Does Countdown",
      "year": 2012, "episodes": 120, "runtimeMin": 45,
      "genres": ["Comedy", "Game Show"],            // from Plex enrichment
      "decade": "2010s",                            // derived tag, existing
      "contentRating": "TV-14",                     // enrichment, if present
      "airedFirst": "2012-07-02", "airedLast": "2021-12-25" }
  ],
  "movies": [
    { "key": "5501", "title": "The General", "year": 1926,
      "runtimeMin": 78, "genres": ["Comedy"], "decade": "1920s",
      "contentRating": "NR" }
  ],
  "packs": [ { "key": "pack:space", "title": "SPACE", "locked": true } ],
  "existingChannels": [ { "number": 1, "name": "SPACE", "locked": true } ]
}
```

Rules:
- **Shows and movies only — never episodes.** Episode counts and aired ranges
  are aggregates computed from the cached `media` rows. This is what keeps a
  518-title library at ~20–25k tokens (measured against the owner's real
  library: 435 movies + 83 shows).
- **Genre enrichment** is one Plex call per section
  (`/library/sections/{key}/all` carries `Genre` tags), fetched at digest
  build time, stored as `media_tags` with a new source `'plex'` (provenance:
  it is Plex's claim, not ours and not the user's). Jellyfin has the same
  concept (`Genres` on items); local folders get decade only — the planner is
  told which items have no genre rather than being fed guesses.
- `existingChannels` is included so the model can *complement* what exists
  (and is forbidden from touching it — §5).
- Digest is cached alongside the catalog cache with the same TTL discipline;
  rebuilt on library rescan.

**Large-library mode (>~1,500 titles):** pre-cluster with plain code (by
genre-set + decade), then plan per cluster with a shared channel-number
allocator. Two passes, same contract. Design now, build only when someone
actually hits it.

---

## 4 · The questionnaire

One schema, two renderers. Every question maps to concrete fields — a question
that maps to nothing is not asked.

| # | Question | Type | Maps to |
|---|---|---|---|
| Q1 | What is this TV mostly for? | single: `background` / `kids` / `movie-nights` / `nostalgia` / `everything` | channel count bias, `ads_enabled` default, marathon vs sequential bias, kid-safe filter |
| Q2 | Pick what you love | multi-chips, **built from the digest's own genres/decades** — never a hardcoded list | channel themes; weighting |
| Q3 | Anything that should never air? | multi-chips (genres, ratings) + kids-mode toggle | exclusions; `contentWarning`/rating filters |
| Q4 | Should channels have a daily rhythm? | single: `yes-strong` / `light` / `no` | whether `recurring` daypart rules are emitted at all |
| Q5 | Mornings are for… / Evenings are for… | chips per daypart (only if Q4 ≠ no) | `recurring` rules: `days_of_week`, `start_time`, `duration_min`, `select_tags` |
| Q6 | Shows on their original air dates? | single: `where-it-fits` / `strict` / `no` | `airdate` rules, `airdate_mode` |
| Q7 | Commercial breaks? | single: `yes` / `no` / `only-retro` | `ads_enabled`, `ad_policy` |
| Q8 | How many channels feels right? | single: `a-few (4-6)` / `a-dial-full (8-12)` / `cable-box (13-20)` | hard cap passed as a *constraint*, not a suggestion |
| Q9 | *(phone/web only)* Tell me more — anything goes | free text | passed verbatim to the model; ignored by rule-based |

Answer document (persisted verbatim in `settings.lineup_answers`):

```jsonc
{ "v": 1, "purpose": "nostalgia", "loves": ["Cartoon", "1960s", "Western"],
  "never": ["Horror"], "kids": false, "rhythm": "light",
  "dayparts": { "morning": ["Cartoon"], "evening": ["Drama", "Movie"] },
  "airdates": "where-it-fits", "ads": "only-retro", "channelCount": "a-dial-full",
  "freeText": "I love 90s sitcoms and anything with Buster Keaton" }
```

**tvOS renders Q1–Q8 as chip/card pickers — no free text on a D-pad, ever.**
The last card offers "want to say more? finish on your phone" with the QR that
setup already shows. Web/phone renders all nine.

---

## 5 · The LineupProposal contract

The single format every provider emits and the only thing the validator,
review UI, and committer ever see.

```jsonc
{
  "version": 1,
  "provider": "ollama:qwen2.5:14b",       // provenance, shown in review
  "channels": [
    {
      "name": "SATURDAY MORNING",          // ≤ 20 chars, uppercased by us
      "rationale": "Your cartoon shorts and 60s animation in one place",
      "number": null,                      // null = we allocate; model MAY suggest
      "ordering": "shuffle",               // sequential|release_order|shuffle|marathon
      "marathonSize": 3,                   // only read when ordering=marathon
      "ads": true,
      "dark": null,                        // or { "start": "22:00", "end": "06:00" }
      "sources": [
        { "key": "12937", "type": "show" },
        { "key": "pack:looney-tunes", "type": "pack" }
      ],
      "tags": ["cartoon", "kids-ok"],      // written as media_tags source='ai'
      "rules": [
        { "kind": "recurring", "name": "Cartoon mornings",
          "daysOfWeek": [0,6], "startTime": "07:00", "durationMin": 300,
          "selectTags": ["cartoon"], "selectMode": "any",
          "ordering": "shuffle" },
        { "kind": "airdate", "airdateMode": "original_weekday",
          "selectTags": ["sitcom"] }
      ]
    }
  ],
  "itemTags": [                            // per-title tags, the R8 payoff
    { "key": "12937", "tags": ["comedy", "panel-show"] }
  ],
  "notes": "Skipped 12 titles with no genre data; see review."
}
```

Contract rules the prompt states and the validator enforces:
- `sources[].key` **must** come from the digest. Nothing else exists.
- `number` is a suggestion; the committer allocates for real.
- No channel may reference zero valid sources after validation.
- `rules` are optional per channel; a channel with none gets the default
  rotation exactly as hand-made channels do today (generator already
  auto-seeds the `rotation` rule and the `blackout` from `dark_*`).
- Tag vocabulary: lowercase kebab, ≤ 24 chars, from a soft-suggested list the
  prompt provides (`cartoon`, `sitcom`, `western`, `noir`, `sci-fi`,
  `kids-ok`, `late-night`…) plus free invention — tags are data, not code.

---

## 6 · The validator

Load-bearing, not defensive — with a local model it **will** fire. Two output
lanes: *repair* (fix silently, note it) and *reject* (drop with a reason shown
in review).

| # | Check | Lane |
|---|---|---|
| V1 | Parse: strict JSON, schema-shape, unknown fields dropped | reject proposal if unparseable after one re-ask |
| V2 | Every `sources[].key` exists in digest; unknowns dropped | repair (list them in review) |
| V3 | Channel with zero surviving sources | reject channel |
| V4 | `ordering` valid; else `sequential` | repair |
| V5 | Name: dedupe, truncate 20 chars, uppercase, non-empty | repair |
| V6 | Channel count ≤ Q8 cap; excess dropped lowest-rationale-first | repair |
| V7 | Numbers: drop model suggestions that collide (SPACE=1, existing, each other); allocate from next-free | repair |
| V8 | **Never touches an existing channel.** Committer literally has no delete/update path — additive INSERT only (the D-3 lesson: import once cleared `channels` and destroyed SPACE) | structural |
| V9 | Rules: `kind` in the enum; `HH:MM` times; `daysOfWeek ⊆ 0..6`; `durationMin` 15..1440; `selectTags` non-empty when present; `airdateMode` in enum | repair or drop rule |
| V10 | Q3 exclusions enforced *after* the model: excluded genres/ratings stripped from sources even if the model ignored the instruction | repair |
| V11 | `itemTags` keys exist; tags normalised (lowercase kebab, ≤24) | repair |
| V12 | Whole-proposal floor: ≥ 2 valid channels or it is treated as failure → fall back to rule-based | reject proposal |

Every repair is recorded on the proposal (`_repairs: []`) and the review
screen shows them — silent correction of an AI's output is how trust dies.

---

## 7 · The committer

One transaction. Inputs: validated proposal + user edits from review.

1. Allocate numbers (next-free walk, skipping locked/existing).
2. `INSERT channels` — seed = `hashString('ai:' + name + ':' + sortedSourceKeys)`
   masked to 31 bits (the `createChannelFromPack` pattern) so the same accepted
   proposal produces the same playout on every device. **Never `Math.random()`**
   (invariant #5 / D-2).
3. `INSERT channel_sources` per source (pack keys use the existing
   `pack:`-prefix source_type dispatch).
4. `INSERT schedule_rules` per rule via the same field mapping as
   `POST /api/channels/:id/rules`.
5. `setTags(key, tags, 'ai')` for itemTags and channel tags — **new tag source
   `'ai'`** added to `TAG_SOURCES`, so a rescan treats them like `pack` (stable)
   and the user can bulk-remove all AI tags in one statement if they hate them.
6. `regenerateChannel(id)` per new channel. Invariant #4 holds by construction —
   these channels have no past to preserve.
7. Persist: `settings.lineup_proposal` (as accepted), `lineup_answers`,
   `lineup_provider`, `lineup_committed_at`.

Rollback = `DELETE` the channels the committer created (their ids are
recorded), which cascades sources/rules. AI tags removable separately.
"Re-run" = new proposal; review shows a diff against the previous accepted one.

---

## 8 · Provider interface

```js
// src/lineup/provider.js — the whole contract
// plan(digest, answers, constraints) → Promise<LineupProposal>
// constraints: { maxChannels, excludeTags, existingNumbers, locale }
```

### 8a · `rule-based` (A1 — build first, keep forever)

Deterministic, no network, no model. Also the **fallback** whenever any other
provider fails, times out, or validates to fewer than 2 channels.

Algorithm:
1. Partition shows by primary genre (from enrichment); movies by genre+decade.
2. Merge partitions smaller than 3 titles into the nearest neighbour
   (genre-similarity table, hardcoded and small).
3. Order candidate channels by total runtime; keep the top `maxChannels`.
4. Name channels from a template table (`Cartoon+pre-1970 → "SATURDAY
   MORNING"`, `Western → "FRONTIER"`, fallback `"{GENRE} CHANNEL"`).
5. Movies-heavy partitions get `ordering=shuffle`, `ads` per Q7; episodic
   partitions get `sequential`; a partition dominated by one show with >30
   episodes gets `marathon`.
6. If Q4 rhythm ≠ no: emit one `recurring` morning rule tagged from Q5 chips
   on the most-kid-safe channel, one evening rule on the most-drama channel.
7. Q6 strict → add `airdate original_weekday` rule to any channel whose shows
   have ≥ 80% aired-date coverage.
8. Emit tags: genre (lowercased) + decade for every item — sourced `'ai'` all
   the same, since "the machine said so" is the provenance that matters.

Every step is a pure function of (digest, answers) — same inputs, same lineup,
which also makes A0's judging reproducible.

> **Provider hierarchy per owner decision #5:** on Apple platforms the primary
> provider is **`apple-fm`** (§8c — runs on the phone/Mac, result pushed to the
> TV). **`ollama` is the Pi / Node-self-host provider** — the Pi has no Apple
> silicon and Node has no FoundationModels, so the LAN model box is its
> natural planner. `rule-based` is the floor everywhere. `cloud-byok` is not
> built (decision #1).

### 8b · `ollama` (the Pi / Node-self-host provider)

- `POST {base}/api/chat` with `format` set to the **LineupProposal JSON
  schema** (Ollama structured outputs), `stream:false`,
  `options.num_ctx: 32768`, `keep_alive: "5m"`.
- Discovery: manual URL field, default `http://localhost:11434`, plus a probe
  of the Plex server's host on :11434 (the media box is the likely host) —
  suggestion only, never automatic.
- **Pin one blessed model in docs and UI** (candidate: a mid-size instruct
  model ~8–14B; A0 decides which). "Any model" is a support tarpit; the UI
  shows *"works best with X — `ollama pull X`"* and a test button that sends a
  10-token ping.
- Timeout 120 s; on failure → rule-based, with the failure named in review.
- One retry on V1 parse failure, feeding the validator errors back
  (*"your last answer failed: …; re-emit valid JSON only"*).

### 8c · `apple-fm` (iOS/macOS on-device — **PRIMARY on Apple**, decision #5)

- FoundationModels `@Generable` maps 1:1 onto the proposal struct — the
  guided-generation path removes the parse-failure class entirely.
- The ~3B model will be good at *structured extraction*, mediocre at *taste*:
  expect to feed it the rule-based output as a draft to refine, rather than
  a blank page. That hybrid ("rule-based proposes, model polishes names +
  dayparts + free-text wishes") may be the sweet spot on-device.
- Runs on the phone during the "link with your phone" flow; result POSTs to
  the TV over the LAN like every other config mutation.

### 8d · `cloud-byok` — **gated on AI-1, the privacy decision**

- Only with a user-supplied key, explicit per-run consent ("this sends your
  library's titles to X"), and the privacy policy updated first. Never a
  bundled key: dumbTV ships no accounts and pays for no inference.
- Best quality, and handles free text best. Implementation is trivial once
  the interface exists; the *decision* is the work.

---

## 9 · Prompt design (ollama / cloud)

System prompt skeleton (final text lives with the code, evolved during A0):

```
You are programming a nostalgic broadcast TV lineup from a person's private
media library. You receive their preferences and their catalog. You emit ONLY
a JSON object matching the provided schema — channel definitions, not
schedules.

Principles:
- Channels have personality. A channel is a theme with a voice, not a folder.
  6 good channels beat 12 thin ones.
- Respect every "never" absolutely.
- Use dayparts only if rhythm ≠ "no": mornings kid-safe, late evening for
  adult-leaning themes.
- Only use source keys from the catalog. Do not invent keys or titles.
- marathon suits shows with many short episodes; release_order suits shows
  whose arc matters; shuffle suits variety/shorts; sequential is the default.
- airdate rules only where aired dates are present in the catalog.
- Tag every item you place (lowercase-kebab). Tags power future scheduling.
- Rationales: one sentence, addressed to the owner, saying why this channel
  earns a number on their dial.
```

User message = answers JSON + digest JSON. Few-shot: one worked
mini-example (8 titles → 2 channels) pinned in the prompt; A0 measures whether
it earns its tokens.

---

## 10 · API surface (Node first; Swift `ConfigAPI` mirrors)

| Route | Does |
|---|---|
| `GET  /api/lineup/digest` | Build/refresh + return the catalog digest (drives Q2's chips too) |
| `GET  /api/lineup/providers` | Which providers are reachable (rule-based always; ollama probed; apple-fm platform-dependent; cloud iff key + AI-1) |
| `POST /api/lineup/plan` | `{answers, provider}` → validated proposal + `_repairs`. **No side effects.** Long-poll or job-id + progress poll (Ollama can take 60s+; reuse the pack-install progress pattern) |
| `POST /api/lineup/commit` | `{proposal}` (post-review edit) → committed channel ids |
| `POST /api/lineup/rollback` | Delete the channels the last commit created |
| `GET  /api/lineup/last` | answers + accepted proposal + provider + timestamp |

All mutations PIN-gated like every other mutation. `plan` sends the digest to
the chosen provider only — the fetch-on-page-open privacy discipline from the
pack catalog applies: **nothing runs at boot, on a timer, or in the
background.**

---

## 11 · UI flows

### Web (first, cheapest to iterate)
`Setup → "Build my lineup"` card → Q1–Q9 single page → provider pick (with
reachability badges) → progress → **review screen**:
- One card per proposed channel: name (editable), rationale, source chips
  (removable), rules in plain words ("Sat+Sun mornings 7:00–12:00: cartoons"),
  ads toggle.
- Banner listing `_repairs` and skipped/no-genre titles.
- `Add lineup` (commit) / `Regenerate` (re-plan, same answers) / `Cancel`.
- After commit: "Undo" toast wired to rollback, plus the channels appear in
  the normal channel list where they are ordinary channels forever after.

### tvOS (A4 — after review exists)
Setup gains a `BUILD MY LINEUP` card (grid pattern already proven). Q1–Q8 as
chip cards, one per screen, LEFT/RIGHT between cards per the input doctrine —
**no free text, no nested Buttons over the watch surface
(`docs/tvos-input.md`)**. Provider: LAN Ollama if reachable, else rule-based,
else "finish on your phone" + QR. Review = simplified: channel cards with
include/exclude toggles only; fine editing stays on the web, consistent with
Setup's existing "critical path only" philosophy.

### iOS
Same as web (it is the web UI), plus the A5 on-device option when spiked.

---

## 12 · Failure modes

| Failure | Behaviour |
|---|---|
| Ollama unreachable / timeout | Named error in UI, offer rule-based — never silently substitute |
| Model emits garbage twice (V1) | Fall back to rule-based, show why |
| Proposal validates to < 2 channels (V12) | Same |
| Library has no genre metadata | Digest flags it; rule-based groups by decade+runtime; model told "no genres available" rather than fed guesses |
| Huge library | Two-pass clustering (§3); until built, digest truncates to top N by episode count with an explicit note in review |
| User hates the result | Rollback removes exactly the committed channels; AI tags removable in one action; answers persist so re-running is cheap |
| Re-run after library growth | Diff view against last accepted proposal; additive-only still holds |

---

## 13 · Phasing, effort, exit criteria

| Phase | Contents | Effort | Exit criterion |
|---|---|---|---|
| **A0 · spike** | Digest builder (incl. Plex genre enrichment) + `scripts/lineup-spike.mjs`: dump real 518-title catalog, run **rule-based + Apple FM (spikeable on this Mac — macOS 26.5 has the framework) + 1–2 Ollama models** on the same three answer-sets, print proposals for hand-judging | M | Owner judges blind: is any model output **clearly better** than rule-based? If no → ship A1 alone, park the rest. Also picks the blessed Ollama model for the Pi |
| **A1 · rule-based** | `src/lineup/` provider + validator + committer + web questionnaire + review UI. Ships end-to-end value with zero AI | M | A fresh install goes link → questionnaire → watching in < 3 min; selftest gains lineup invariant checks (seeded determinism, additive-only, SPACE untouched) |
| **A2 · providers + interface** | Provider interface; **`apple-fm` `@Generable` planner on iOS/macOS (primary Apple path, incl. the hybrid draft-refine shape)**; Ollama client for Node/Pi with model pin + test button; `_repairs` surfacing | M–L | Same library + same answers → committed lineup through the on-device model on a Mac AND through Ollama on Node; all validator lanes exercised by fixture tests |
| **A3 · review polish + diff** | Re-run diffs, rollback UX, repair explanations | S–M | Re-run on a grown library produces a sane additive diff |
| **A4 · tvOS + phone handoff** | Chip questionnaire on the TV; planner runs on the phone (apple-fm) reached via the existing link flow, result pushed to the TV; rule-based direct on the TV when no phone is present | M | Real-remote pass per the input doctrine checklist; the phone→TV push works on real hardware |
| cloud-byok | **Not built** (owner decision #1/#5). Revisit only if on-device quality disappoints | — | — |

Sequencing vs the rest of the docket: A0/A1 slot into **P2** (they are
Presentation-tier wins — "the TV builds itself" is the single most
demo-able thing on the roadmap after the guide). A2+ sit in **P3** with the
scheduler tier they exercise (R1/R5 get their UI *through* this feature).
**H2 (manual editor) should follow A3**, inheriting its review-screen
patterns.

---

## 14 · Open questions — **ALL CLOSED 2026-08-03** (see the decision table at
the top). The only one still carrying a sub-decision is the blessed Ollama
model's RAM ceiling for the Pi path, which A0 answers with data.

---

## 15 · Worked example (end to end)

Answers: `purpose=nostalgia`, loves `[Cartoon, Western, 1950s]`, never
`[Horror]`, rhythm `light`, mornings `[Cartoon]`, airdates `where-it-fits`,
ads `only-retro`, count `a-few`.

Digest (abridged): 83 shows incl. Gunsmoke (635 eps, 1955, Western), 435
movies incl. 40 pre-1960 westerns, packs incl. `pack:looney-tunes`.

Proposal (validated, abridged):

```jsonc
{ "channels": [
  { "name": "FRONTIER", "rationale": "Gunsmoke has 635 episodes — it IS a channel, with your western movies riding shotgun.",
    "ordering": "marathon", "marathonSize": 4, "ads": true,
    "sources": [ {"key":"8801","type":"show"}, {"key":"5502","type":"movie"} ],
    "tags": ["western","1950s"],
    "rules": [ { "kind":"airdate", "airdateMode":"original_weekday", "selectTags":["western"] } ] },
  { "name": "SATURDAY MORNING", "rationale": "Your shorts and the Looney Tunes pack, mornings only — like it used to be.",
    "ordering": "shuffle", "ads": true,
    "sources": [ {"key":"pack:looney-tunes","type":"pack"}, {"key":"7220","type":"show"} ],
    "tags": ["cartoon","kids-ok"],
    "rules": [ { "kind":"recurring", "daysOfWeek":[0,6], "startTime":"07:00",
                 "durationMin":300, "selectTags":["cartoon"] } ] }
],
  "itemTags": [ {"key":"8801","tags":["western","1950s"]} ] }
```

Committer: numbers 2 and 3 (1 is SPACE), seeds from name+sources hash, rules
via the existing route mapping, tags written as `source='ai'`,
`regenerateChannel × 2` → the guide fills, staggered per channel as always.
Review showed one repair: a hallucinated key `"9999"` dropped from FRONTIER.

---

*Related: `docs/manual-schedule-editor.md` (H2 — inherits A3's review
patterns) · `docs/tvos-input.md` (A4 must follow it) · R8 tags ·
Config v3 (an accepted proposal is a config document; export/clone falls out).*

# Build 17 — implementation handoff (P3 · The scheduler tier)

**Status: planned, nothing built. Written 2026-07-29. Depends on builds 15 and 16.**

Read `CLAUDE.md` **carefully** — this is the only one of the three builds that touches `schedule/`, and it sits directly against invariants #4 (append-only), #5 (deterministic shuffle) and #6 (natural-length blocks). Then Notion → **Engineering Plan** §5–6 and **Competitive Feature Gaps** R1/R5/R8.

> **Run `npm run selftest` after every single change in this build.** The house rule exists for exactly this file, and it catches drift immediately.

## The framing that makes this build small

The research called **dayparting the biggest single gap in the product** and sized it as a medium. Reading the code says otherwise.

`schedule_rules` already carries `days_of_week`, `start_time`, `duration_min`, `ordering_mode`, `priority`, `effective_from`, `effective_to`. `generator.js` already expands a **recurring** rule into day/time occurrences and already clamps every rule to its effective window. `RULE_FIELDS` already accepts all of them over HTTP.

**A daypart *is* a recurring rule.** "Cartoons, weekdays, 06:00, 360 minutes" is a row you can insert today. The **only** thing missing is that a recurring rule points at one `rating_key`, where a daypart needs a **tag-filtered subset**.

So this build is really: *add tags, teach rules to select by them, and put a UI on what already works.*

## Regression gates

```bash
npm run selftest      # must stay green after EVERY change, not just at the end
cd apple && swift test
```

Plus a specific one for this build: **generate a schedule, snapshot it, re-run generation, and assert the future is byte-identical.** Determinism is the thing most at risk here.

---

# Chunk A · Tags (R8) — the unlock

**New table `media_tags`:** `(rating_key, tag, source)`, primary key `(rating_key, tag)`, index on `tag`.

A table rather than a CSV column because this one is **queried** ("find everything tagged cartoon"), unlike `channels.ad_tags` which is only ever read for a single channel. Don't copy the CSV pattern here.

**`source` is `user` | `pack` | `derived`:**

- `user` — hand-applied. **A rescan must never touch these.**
- `pack` — declared by a pack manifest. Build 15 Chunk C3 added per-item `tags` to the schema and populated them during the SNAFU/BOSKO migration, so **the preload lineup arrives pre-tagged** and dayparting works out of the box with zero user effort. Replaceable on reinstall.
- `derived` — computed (decade from `aired`, short-runtime from `duration_ms`). Recomputed freely.

**Where it plugs in:** `ordering.js` → `loadSourceBuckets()`. It already drops `channel_excludes` **before** rotation, cooldown and airing counts see anything — the tag predicate goes in exactly the same place, which is what keeps determinism, cooldown and premiere counting correct for free. Do not filter anywhere else.

**Web UI:** tag editing on media, and a tag picker where sources are chosen.

---

# Chunk B · Dayparting (R1)

**Schema:** `schedule_rules.select_tags` (CSV; `null` preserves today's single-`rating_key` behaviour) and `select_mode` (`any` | `all`).

**`expand()` is untouched.** A daypart is still a `recurring` occurrence — the existing day/time expansion is correct as written. Only **content resolution** changes: when `select_tags` is set, the rule draws from the tag-filtered pool instead of one rating key.

**UI:** a daypart editor on the channel — a day/time grid with a source-or-tag selector per band. Presets worth shipping: "Saturday morning cartoons," "Primetime," "Late night."

**Invariant checks that must be in the selftest:**

- Two generations with the same dayparts produce identical output (#5).
- A daypart edit regenerates only `start_utc >= now`; whatever is airing survives (#4).
- Programs still run back-to-back at natural length inside a band — dayparts bound *selection*, they do not impose a slot grid (#6).

---

# Chunk C · Blocks, marathons, themed nights (R5)

Mostly a preset layer over Chunk B plus the existing `marathon_size`. "Monday night movie," "all-day marathon on a date," "Saturday morning 8am–noon."

**Owner ruled 2026-07-29 that this does NOT retire H2** (the manual schedule editor). Don't design as though it does — H2 stays on the docket as its own phase, with its own pins model, and still needs a throwaway prototype before anything in `schedule/` is touched for it.

---

# Chunk D · Content warnings reach the scheduler (PD Packs Task 2)

Build 15 put `contentWarning[]` in the manifests. This makes it mean something.

**Schema:** `media.content_warnings` (CSV, null = none recorded) and `channels.exclude_warnings` (CSV, default empty). CSV here is right — these are read per-channel, not queried across the library, so they match the `ad_tags` convention rather than `media_tags`.

**Same choke point as Chunk A** — `loadSourceBuckets()`. It's the same predicate shape; write them together.

**Empty-schedule behaviour:** if exclusions eliminate everything, **reuse the existing off-air path**. The generator already emits an `offair` block when a channel has nothing playable, and both players already render the stand-by card (invariant #7). Add nothing new — just make the card's subtitle say *why* ("No programmes match this channel's content filters").

**UI:** a kids' channel should be able to exclude `racial-caricature` and `adult-humor` in one click. That is the whole point of the feature and it should not require understanding the vocabulary.

---

# Chunk E · Partial-series support (PD Packs Task 3)

**Mostly test coverage, not implementation.** Two of the three behaviours already work:

1. **Ordering tolerates gaps** — `bySeasonEpisode` sorts by season then episode and never assumes contiguity. ✅ Already correct. Prove it with a vector.
2. **The scheduler wraps to the start of the available set** — `buildPlaylist` cycles whatever bucket it's given. ✅ Already correct. Prove it with a vector.
3. **The guide must not imply a complete run** — ⬅ *the one real change.* Suppress any "next episode" affordance pointing at an absent episode, and don't render a placeholder for a missing S01E56.

**Schema:** `media.series_partial` flag, set from the pack's `partialSeries`.

This matters because **most PD television is partial-series** — 55 of 274 *Beverly Hillbillies*, 31 *Bonanza*, 17 *Lone Ranger* — so it's a hard prerequisite for the RERUN THEATRE pack, which is why it lands before that pack is authored.

---

# Chunk F · Audio leveling, the cheap half (J-A1, J-A2)

Full spec in Notion → **Audio Leveling (J)**. Only the two `[S]` items belong in this build.

- **A1 · Bake loudness into pack encodes.** The cheapest real win in the whole phase: we already re-encode PD content, so a `loudnorm` + `alimiter` pass at build time makes **every pack level with every other pack on every platform with zero runtime code.** Invariant #2 is about *runtime*, not mastering. Add it to `build-pack.js`; re-encode the existing packs as a follow-up.
- **A2 · Peak-safety fix.** A flat dB gain with no limiter **can clip** exactly the loud commercials the feature exists to tame. Add a limiter after the gain. Also rename `measureGain` to what it actually is — integrated-loudness matching, not `loudnorm`.

**A3–A6 stay in P5.** A4 in particular needs a VLCKit spike (no per-item filter chain like mpv) and should not be attempted opportunistically.

**Sequencing note that matters later:** Audio Leveling must land **before or with** mid-program ad breaks. That phase moves pods *inside* episodes, turning one level jump per program into two or three — and with no pause and no seek, a viewer blasted by a loud ad has exactly one available action, which is the volume knob.

---

# Chunk G · XMLTV export (R6)

The cheap half of the competitor category's headline feature, without any of its cost. We already have the grid; this is a serialiser.

`GET /api/xmltv` emitting standard XMLTV over the existing `programs` table. Buys guide data in third-party clients, an easy integration story, and compatibility with the Prevue-guide simulators that consume XMLTV. Good README material.

**Explicitly not tuner emulation (R7).** That would require a persistent per-channel *encoded* stream — permanent transcoding, a head-on collision with invariant #2. R7 remains an open owner decision and is **not** part of this build.

---

# Suggested commit order

1. **A** — tags (nothing else works without it)
2. **B** — dayparting via `select_tags`
3. **C** — blocks/marathons presets
4. **D** — content-warning exclusions (same predicate as A)
5. **E** — partial series (mostly vectors)
6. **F** — audio A1/A2
7. **G** — XMLTV

## What this build does NOT do

No manual schedule editor (H2 — own phase, needs its prototype first). No mid-program ad breaks (P5). No audio A3–A6. No tuner emulation. No guide channel (R4 — needs build 16's repaint fix, then P5).

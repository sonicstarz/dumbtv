# Manual schedule editor — future phase (design / brainstorm, NOT built)

Status: **proposed, not started.** This is a thinking document. Do not build
from it yet — the plan is to prototype a few throwaway HTML tests first (see
"Prototypes to build" below) and only then commit to a model.

## The want

Today a channel's lineup is fully derived: pick shows + an ordering mode, and
the generator lays out programs back-to-back deterministically. You cannot say
"put *this* episode on at 4:00 Saturday" or "move the Batman block to the
evening." The ask is a **calendar view of one channel where you can build and
move programs by hand** — drag a show to a time, reorder blocks, drop a specific
episode into a specific spot.

## Why this is hard (the invariants it collides with)

Read `CLAUDE.md` first. Three rules make a naive "just let the user edit rows"
approach wrong:

- **#4 The schedule is append-only.** Already-generated programs are never
  rewritten; `regenerateChannel()` only deletes `start_utc >= now`. Anything
  currently airing must survive an edit. So the editor can only ever touch the
  **future**, and "what's on right now" is off-limits.
- **#5 Shuffle must be deterministic.** Seeded by `channel_id + cycle`. A
  printed guide must stay true. A manual move cannot silently reshuffle
  everything downstream, or every printed listing goes stale.
- **#6 Programs run back-to-back at their natural length.** No fixed slot grid.
  So the editor is **not** a Google-Calendar grid where you resize a block to
  make it longer — a program is exactly as long as its file. You can move
  *where a block starts* (by reordering / inserting gaps), not *how long it is*.

The generator is a pure function of (channel config, ordering mode, seed, now).
Manual editing introduces state that is **not** derivable from that function.
That's the whole design problem: how do hand placements coexist with a
deterministic generator without breaking reproducibility?

## Proposed model: pins, not free edits

Don't let the user rewrite the `programs` table directly. Instead store a small
set of **pins** (overrides) and have the generator honor them:

- A **pin** = "on channel C, the program starting at/after time T is
  ratingKey R" (an anchor), or "insert an off-air/marker block of length L at
  T." Pins live in their own table, keyed by channel, all with `start_utc >= now`.
- `generate()` becomes generate-with-pins: it lays out the deterministic
  sequence as today, but when it reaches a pinned time it emits the pinned item
  first, then resumes the deterministic order from where it left off. The seed
  still drives everything unpinned, so an unpinned stretch is still reproducible.
- Editing = adding/removing/moving pins, then `regenerateChannel()` from `now`
  forward. Aired programs and the currently-airing one are untouched (#4).

This keeps determinism (#5): given the same pins + seed, you get the same
schedule every time, so the printed guide stays honest. It respects #6 because a
pin sets a *start*, and the block is still played at its natural length; a
"move" that would leave a gap is filled with the normal ad-pod / off-air logic,
not by stretching a program.

### What "move" means concretely

- **Reorder within the future:** swap the position of two upcoming blocks →
  becomes two pins (or a small reordering of the deterministic cursor).
- **Drop a specific episode at a time:** a pin anchoring R at the slot boundary
  nearest T (snapping is a UX choice — see open questions).
- **Pin a daily/weekly recurrence** ("cartoons at 8am every day"): a recurring
  pin, expanded by the generator each cycle. This is the powerful case and
  probably the real reason someone wants the editor.

## UI sketch

A per-channel **timeline/calendar** (day or week view), same Prevue-blue look as
the guide:

- Vertical time axis, channel's programs as blocks sized by duration.
- **Past + currently-airing blocks are locked** (greyed, not draggable) — a
  visual embodiment of #4.
- Drag a block to a new time → creates/moves a pin. Drag a show from a
  "library" rail on the side into the timeline → insert pin.
- A block can't be resized (its length is the file); dragging its edge does
  nothing / flashes the ⊘, same language as the TV.
- "Regenerate future" button = apply pins, re-derive `start_utc >= now`.
- Show the deterministic (unpinned) baseline faintly behind the pinned version,
  so the user sees what they're overriding.

This is a **web-UI** feature (the config app), not the TV — editing happens on a
phone/laptop, the TV just plays the result. Same as every other config surface.

## Prototypes to build first (throwaway HTML)

Before touching `schedule/` or the Store, build these as standalone HTML files
(no backend) to find out what actually feels good:

1. **Drag-to-reorder timeline** — blocks of realistic durations, drag to
   reorder, watch everything downstream reflow back-to-back. Does reflow feel
   understandable or chaotic?
2. **Pin + reflow** — pin one block to a time, let the rest flow around it.
   Does "pin one thing, everything else stays deterministic" read clearly?
3. **Locked past** — render "now" and grey everything behind it; try to drag a
   locked block and confirm the affordance (⊘) makes sense.
4. **Recurrence** — "every day at 8am" expanded across a week; is a recurring
   pin comprehensible in a calendar view?

Keep them in `scratch/` or a throwaway branch — they inform the model, they are
not the model.

## Open questions

- **Snapping:** free placement vs snap-to-existing-boundaries. Free placement
  reintroduces gaps/filler (the thing #6 was designed to kill). Probably snap.
- **Pin vs sequence drift:** if a pinned episode is later deleted from the
  library, what happens to the pin? (Drop it and log, like a missing file.)
- **Determinism of the *unpinned* remainder** after an insert: does inserting R
  consume R from the deterministic cursor (so it doesn't also appear later), or
  is a pin purely additive? This changes what "the guide" shows and needs a
  decision before coding.
- **Recurring pins across a `cycle` boundary** — how do they interact with the
  `channel_id + cycle` seed?
- **Conflict with the hourly top-up** (`Scheduler.topUp`) — pins must be honored
  by the same code path that extends the horizon, not just a one-off regenerate.

## Definition of done (when it's actually built)

- New pins table, `start_utc >= now` only; aired schedule never rewritten.
- `generate()` honors pins and stays a pure function of (config, pins, seed, now).
- `selftest.js` gains cases: pinned item lands where pinned; unpinned remainder
  still deterministic across regeneration; a pin never rewrites an aired program;
  recurring pin expands identically across cycles.
- Web-UI calendar view with locked past, drag-to-move, library rail.
- The printed-guide invariant still holds: same pins + seed → identical listing.

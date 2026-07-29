# Build 16 — implementation handoff (P2 · Presentation & UX)

**Status: planned, nothing built. Written 2026-07-29. Depends on build 15 having landed.**

Read `CLAUDE.md`, then Notion → **Broadcast Presentation (K)**, **Vibe (L)**, **Competitive Feature Gaps (R)**, and the **Code Audit** UI/UX section.

This is the "felt quality" build. Everything here is presentation layer or front-end — **no scheduler changes**, which is what makes it safe to run in parallel with thinking about build 17.

The organising insight: **most of this batch shares one mechanism.** Build it first and the rest are cheap.

## Regression gates

Same as build 15 (`selftest` green, `swift test` green, all three apps build), plus: **no change to any program's start time** as a result of this build. Presentation must not move the schedule.

---

# Chunk A · The shared static / tracking renderer — **build this first**

Called out as a cross-phase dependency on the K, L and M pages: **one renderer serves channel-change static (K-B3), the Vibe filter stack (L-V1), and later the VCR insert animation (Track M).** Build it once, callable from all three.

Requirements:

- Canvas-based noise/static field, parameterised by intensity and grain size, cheap enough to run at 60 fps on a Pi 4 and on an Apple TV.
- Usable as (a) a full-screen burst of a few hundred ms, (b) a persistent low-intensity overlay, (c) a transition mask.
- **Must respect `prefers-reduced-motion`** — `style.css` already honours it and this is the most motion-heavy thing in the product.
- Node/browser first (`public/`), with the Apple equivalent as a sibling. On Apple this is an overlay above the persistent `VideoSurface`, **not** a change to the video pipeline — the shader tier (L-V2) is explicitly out of scope and parked in P5.

---

# Chunk B · Broadcast presentation batch (K-B1/B2/B3)

The phase page says these three give the biggest felt change per hour. Ship as one batch.

- **B1 · Channel bug / watermark.** Persistent small channel ident in a corner. Per-channel opt-out. Must sit inside the CRT safe area (centre 85%, nothing important outside it).
- **B2 · Up-next auto-reveal.** The banner slides in over the last act of a program rather than only on demand. The data is already correct — build 13 made `upNextShow()` mean the next *show*, skipping ad pods, on both engines. Reveal window should be a setting, defaulting to ~2 minutes before end.
- **B3 · Channel-change static.** A few hundred ms of noise on every tune. Consumes Chunk A. This is the cheapest thing in the build and probably the most noticed.

---

# Chunk C · Scheduled sign-off and off-air (R3)

Today colour bars exist **only as an error state** (invariant #7) — nobody schedules them. Real television signed off.

- New columns: `channels.signoff_asset_id` (plays once at blackout start) and `channels.offair_pattern` (`bars` | `snow` | `card`).
- A sign-off is **a blackout rule that plays something.** The `blackout` rule kind already reserves the time and the generator already emits the `offair` blocks both players render — so this is: place one asset at the head of the window, and tell the renderer which fill to draw for the remainder.
- `snow` consumes Chunk A.

**Do not invent a new rule kind for this.** The existing blackout already does the scheduling half.

---

# Chunk D · Sleep timer (R10)

No schema at all. Player state (`sleepUntil` timestamp) plus a default. `settings.sleep_start` / `sleep_end` already exist and are already surfaced by `/api/settings` — the timer is their manual sibling.

Both players: a remote/keyboard affordance to set 30/60/90 minutes, an on-screen acknowledgement, and a fade to off-air (not an abrupt black) when it fires. Pairs naturally with R3.

---

# Chunk E · Seasonal windows (R2) — **UI only**

**This needs no engine work.** `schedule_rules.effective_from` / `effective_to` already exist, are accepted by `POST /api/channels/:id/rules`, and are honored by the generator (it clamps every rule to its effective window). There is simply no control to set them.

- A date-range control on the rule editor.
- A preset ("Only air in October") so the common case is one click.
- A guide affordance so a windowed rule reads as *seasonal* rather than mysteriously absent in November.

**Decision applied:** add `effective_annual` — when set, compare **month and day only**, ignoring the year. Without it every user re-edits their holiday channel each year. This is the one schema addition in this chunk, and it's a single flag plus a comparison branch in the generator's window clamp.

---

# Chunk F · Web remote (R9)

Nearly free — every device already serves a config UI on the LAN. A `/remote` page: channel up/down, number entry, guide, mute, CC, and the current program.

Solves real problems: a Pi with no IR receiver yet, a lost Siri remote, testing without getting up. It also makes the phone-as-accessory story consistent with the NFC deck idea in Track M, which is worth having established before that phase is designed.

The endpoints already exist (`/api/player/tune`, `/surf`, `/digit`, `/banner`). This is a page, not a backend.

---

# Chunk G · Vibe V1 (L-V1) — the no-shader tier

**Ships everywhere now with zero shader work.** The phase page's own assessment is that **4:3 crop alone may be the single biggest "it looks right" win.**

- Per-channel 4:3 crop/pillarbox option. (`settings.display_fill` already handles fit-vs-fill globally; this is the per-channel, aspect-correct sibling.)
- Overlay-based scanlines, vignette, dead pixels — all CSS/canvas over the video, no pipeline change.
- Static/grain via Chunk A.

**Explicitly not in this build:** the V2 shader tier. mpv supports GLSL user shaders natively so Node/Pi would be easy, but VLCKit renders into a view we don't own, so Apple parity needs a **Metal compositing rework of the video pipeline** — on the same surface build 13's F3 fix just stabilised. That is a gated spike in P5, not a task here.

> ⚠️ **Cross-phase decision needed before this chunk is designed:** does Vibe support **per-item** overrides? Tapes carrying their own worn-VHS look (Track M) is a strong, cheap detail *only* if per-item is already in the model — retrofitting later is much worse. Get the answer before writing the schema for this chunk.

---

# Chunk H · Accessibility and front-end hygiene

From the audit. The Apple app had an accessibility pass; **the web config UI never did**, and it is where all real configuration happens.

- **U-2:** `public/index.html` has **zero** `aria-*`, **zero** `role=`, and all **37** buttons lack an accessible label beyond their text — icon buttons (✕, lock, gear) announce nothing. Add labelled icon buttons, `role="dialog"` + `aria-modal` on modals, a **live region for toasts** (a screen reader is currently never told whether an action succeeded or failed), and visible focus styles.
- **U-3:** modals focus the first field and handle Escape, but Tab walks out into the page behind and focus isn't restored on close. Trap and restore.
- **U-4:** six polling loops, none pausing on `document.hidden`, none backing off on failure. Pause when hidden; exponential backoff on error. **Keep the status heartbeat frequent while visible** — that one is deliberate and is what greys the page honestly when the app quits.
- **U-5:** `tv.js` replays the 9-second help overlay on **every** load, forever. The Apple app solved this in build 13 with `first_run_done`; use `localStorage` the same way. `h` already brings it back.
- **E-5:** `paint()` re-assigns the guide's `innerHTML` every 250 ms though the data changes on the 1 s poll, destroying the selected row each tick. Rebuild only when a cheap data signature changes; update the clock in place. **This is a prerequisite for R4 (the guide channel) in P5** — a scrolling listings channel cannot be rebuilt four times a second.
- **U-6:** one breakpoint at 860 px, for a product whose founding promise is configuration from a phone. The channel editor and the library picker need a real narrow-viewport pass.

---

# Suggested commit order

1. **A** — shared static renderer (everything else leans on it)
2. **B** — K-B1/B2/B3 presentation batch
3. **C + D** — sign-off, off-air, sleep timer
4. **E** — seasonal windows + `effective_annual`
5. **F** — web remote
6. **G** — Vibe V1 (after the per-item decision)
7. **H** — accessibility + front-end hygiene

## What this build does NOT do

No scheduler placement changes. No shader work. No credits squeeze (K-B4 — it shares R4's mechanism and both sit in P5). No mid-program ad breaks (P5, and Audio Leveling must land first). No new packs.

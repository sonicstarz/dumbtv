# dumbTV — notes for Claude Code

Turns a Plex library into a 1990s cable box. What's on is what's on.

Read this before changing anything. Most of the rules below look like
limitations and are actually the product.

---

## The one idea

dumbTV does not stream. It **precomputes a schedule** into SQLite, two weeks
ahead. Tuning to a channel is one indexed query plus one seek:

```js
row = SELECT * FROM programs
      WHERE channel_id = ? AND start_utc <= now AND end_utc > now
offset = now - row.start_utc
play(source, { startAt: offset })
```

You join a show in progress because you seek into the file by however long it
has been "airing." Everything else — instant channel changes, surviving power
loss, a truthful guide, a printable listing — falls out of that for free.

If a change would require a running stream, a persistent playback timer, or
state that has to stay correct across restarts: **it is the wrong change.**
Re-derive from the clock instead.

---

## Invariants — do not break these

1. **No pause, no seek, no resume prompts** on live channels. The keys are
   deliberately bound to a no-op that flashes `⊘`. DVR playback is the single
   exception.
2. **Never transcode.** Direct play only. Transcoding kills instant seeking,
   which kills the whole illusion. If a file will not play, exclude it and log
   it — do not reach for `/video/:/transcode/universal/start`.
3. **Never touch Plex watch state.** No scrobbling, no progress updates,
   nothing added to Continue Watching.
4. **The schedule is append-only.** Already-generated programs are never
   rewritten. `regenerateChannel()` deletes only `start_utc >= now`, so
   whatever is currently airing survives an edit.
5. **Shuffle must be deterministic.** Seeded by `channel_id + cycle`. If a
   printed guide says Spider-Man is on at 4:00, Spider-Man is on at 4:00.
   Never introduce `Math.random()` into scheduling.
6. **Programs run back-to-back at their natural length.** No fixed slot grid —
   a program, then an optional short ad break, then straight into the next
   program. Channels are staggered by a deterministic per-channel offset so they
   aren't in lock-step; switch channels and you land mid-show on each. (This
   replaced the old fixed 30-min slot model, which padded every block to :00/:30
   with a filler card — that produced long dead air and synchronised channels.)
7. **Never show a loading spinner or an error dialog on the TV.** Show
   something a broadcaster would show: colour bars, a station ID, or the
   "one moment please" card.
8. **No build step.** Plain ESM JavaScript, vanilla frontend. Do not add
   TypeScript, React, Vite, or a bundler. `npm install && npm start` has to
   work on a stranger's machine on a Saturday.

---

## Layout

```
src/
  config.js              env vars and paths, all optional
  db.js                  SQLite schema — single source of truth for the model
  assets.js              commercial import, ffprobe durations, folder tagging
  index.js               fastify boot, static serving, hourly top-up
  schedule/
    generator.js         THE core. slot rounding, ad pods, dark hours
    ordering.js          sequential / release_order / shuffle / marathon
    resolver.js          nowOn(), upNext(), guide() — the hot path
  player/
    engine.js            once-a-second loop that makes reality match schedule
    mpv.js               JSON IPC wrapper
    overlay.js           ASS markup for banner, digits, cards, colour bars
  plex/
    auth.js              PIN link flow, server discovery
    client.js            library browse, episode caching, direct-play URLs
  routes/api.js          the whole HTTP surface
  util/
    time.js              slot alignment anchored to LOCAL midnight
    rng.js               mulberry32 + FNV — seeded, reproducible
public/
  index.html/app.js      config app
  tv.html/tv.js          the television
  style.css
scripts/
  selftest.js            16 engine checks, no Plex needed — run this often
  demo.js                whole lineup with generated content, no Plex
  doctor.js              environment check
```

---

## Testing

```bash
npm run selftest    # engine invariants. Fast. Run after any schedule change.
npm run doctor      # environment
npm run demo        # rebuild the demo lineup
```

`selftest.js` seeds a fake library into a temp database and asserts: no gaps,
no overlaps, slot alignment, join-in-progress offsets, ordering modes, stable
shuffle across regeneration, dark hours, ad caps, guide coverage. **If you
touch `schedule/`, run it.** It catches drift immediately.

There is no test coverage for `plex/`, `player/mpv.js`, or `player/overlay.js`
because none of it can run headless.

---

## Known unverified

Written from API shape and docs, never executed against the real thing:

- **`plex/auth.js` and `plex/client.js`** — the PIN flow and `/allLeaves` have
  never seen a live response.
- **`jellyfin/auth.js` and `jellyfin/client.js`** — written from the Jellyfin
  API shape. AuthenticateByName, `/Shows/:id/Episodes`, and the `?static=true`
  direct-play stream URL have never seen a live Jellyfin server. The active
  backend is chosen by the `media_backend` setting; `media/backend.js` is the
  facade and dispatches stream URLs by part-key prefix (`jf:` → Jellyfin).
- **`player/mpv.js`** — mpv was not installed in the build environment. The
  `loadfile` option syntax moved between mpv releases, so `play()` tries three
  forms and falls back to a corrective seek after `file-loaded`. Plausible,
  unproven.
- **`player/overlay.js`** — the ASS overlays have never been drawn on a screen.
  Sizing and positioning are guesses.

When any of these gets verified, say so in the commit message.

---

## Gotchas

- `npm run doctor` is dumbTV's. `claude doctor` is Claude Code's. Unrelated.
- Slot alignment is anchored to **local midnight**, not UTC, so it stays on
  wall-clock :00/:30 in half-hour-offset timezones.
- Dark windows wrap midnight (`20:00`–`07:00`). Test both sides.
- Media rows whose `part_key` starts with `local:` are local files, not Plex.
  Demo mode uses this. mpv gets the raw path; the browser gets `/api/local`.
- `/api/local` only serves paths already in the database. Keep it that way.
- Overlays are laid out for a **CRT safe area** — nothing important outside the
  centre 85%, no 1px horizontal lines, minimum ~24px at 480 lines.
- Demo mode writes to `media/demo-shows/`. The asset scanner deliberately
  ignores it and reads only `media/ads` and `media/bumpers`.

---

## Where it's going

Next: verify mpv end to end, verify against a real Plex library, prefetch the
next program to kill the transition gap, guide overlay on the mpv player.

Then the Pi: `install.sh` with a systemd unit, HDMI→composite at 480 lines,
FLIRC remote keymap, safe-area pass on real glass, prebuilt SD image.

Later: printable weekly PDF guide from the same `programs` table, DVR playback,
loudness normalisation on commercials, device sleep schedule.

**Manual schedule editor** (proposed, not started) — a per-channel calendar
view in the web UI to hand-place and move programs, instead of only deriving
them from an ordering mode. This collides head-on with invariants #4/#5/#6
(append-only, deterministic, natural-length blocks), so it needs a "pins"
model rather than free row edits, plus throwaway HTML prototypes first. Full
design + open questions: `docs/manual-schedule-editor.md`. **Do not build from
it yet** — prototype and decide the model before touching `schedule/`.

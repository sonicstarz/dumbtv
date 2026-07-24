# Cathode

**Turn a Plex library into a 1990s cable box. What's on is what's on.**

No menus. No resume prompts. No pausing. You turn it on and something is
already playing, halfway through, the way television used to work.

Built to end up on a Raspberry Pi wired to a CRT, but it runs on your laptop
first — and you can watch it in a browser before you own any hardware.

```
npm install
npm run demo      # builds a working lineup, no Plex needed
npm start         # open http://localhost:8080/tv
```

---

## How it works

Cathode does not stream. It **precomputes a schedule** — a table of rows
saying "Channel 4, Mutant Academy S01E03, starts 14:30:00, runs 2m30s" — two
weeks ahead, regenerated in the background.

Tuning to a channel is then one indexed query and one seek:

```js
SELECT * FROM programs
WHERE channel_id = ? AND start_utc <= now AND end_utc > now

offset = now - row.start_utc
play(row.source, { startAt: offset })
```

You are joining a show in progress because you literally seek into the file by
however many seconds have elapsed since it "started airing."

That one idea gives you everything else for free:

- **Instant channel changes.** No buffering a live stream, just a seek.
- **Survives power loss.** Unplug it for an hour, plug it back in, it rejoins
  whatever is on now. Exactly like a real cable box.
- **A guide that is actually true**, because the schedule already exists.
- **A printable listing**, from the same table.

The schedule is **append-only**. Once a program has been published to the
guide, nothing moves it — including shuffle, which is seeded so it produces
the same order every time. A printed schedule on the fridge stays correct.

---

## Getting started

### Requirements

- **Node 20+** — that's it for the browser TV
- **mpv** *(optional)* — for a real full-screen player instead of a browser tab
- **ffmpeg / ffprobe** *(optional)* — needed to import commercials

```bash
# macOS
brew install node mpv ffmpeg

# Debian / Raspberry Pi OS
sudo apt install nodejs npm mpv ffmpeg
```

Check everything at once:

```bash
npm run doctor
```

### Try it without Plex

```bash
npm run demo-ads   # stand-in commercials
npm run demo       # four channels of generated content
npm start
```

Open **http://localhost:8080/tv**.

The demo clips have a **running timecode burned into the picture**. If it says
anything other than `00:00:00` when you tune in, you joined a broadcast
already in progress — which is the entire point of the project.

Remove it later with `npm run demo -- --clean`.

### Wire up your real library

1. `npm start`, open **http://localhost:8080**
2. Go to **Plex**, hit *Get a link code*, enter it at
   [plex.tv/link](https://plex.tv/link)
3. Pick your server — prefer a local address, relay will not hold up
4. **Channels → Add a channel → Add content**, pick your shows
5. Open `/tv`

---

## Watching

| Key | Does |
| --- | --- |
| `0`–`9` | Tune directly to a channel number |
| `↑` `↓` | Channel up / down |
| `G` | Guide |
| `I` | What's on |
| `R` | Record to a DVR slot |
| `F` | Fullscreen |
| `H` | Show / hide the key list |

Space, `←` and `→` are deliberately dead. Pressing them flashes a ⊘ and
nothing happens. This is not an oversight.

---

## Channel settings

**Order** decides how a channel walks through its content:

| Mode | Feels like |
| --- | --- |
| Sequential | Rotates between shows, each advancing episode by episode |
| Release order | Everything by original air date — syndication block |
| Shuffle | Random but locked in, so the printed guide stays honest |
| Marathon | A few of one show in a row, then the next |

**Slot minutes** is the grid the schedule snaps to. 30 is what real TV used. A
22-minute episode plus its ad break lands exactly on the next half hour, which
is what makes a guide readable. Set it to 5 while you are testing so you can
watch programs roll over.

**Dark hours** take a channel off the air between two times — colour bars
instead of cartoons after bedtime. Wraps midnight correctly.

**Ads** fill the gap between a program ending and its slot boundary. Anything
still left over becomes a station ID card, so blocks land on the boundary to
the millisecond.

---

## Commercials

Drop video files in and scan:

```
media/
  ads/
    90s/
      toys/
        transformers-1994.mp4     -> tagged "90s, toys"
    cereal-spot.mp4               -> no tags
  bumpers/
    we-will-be-right-back.mp4
```

Sub-folder names become tags. Set **ad tags** on a channel to pull only from a
matching pool — 90s toy spots on the retro channel, nothing but bumpers on the
preschool one.

Durations are read with `ffprobe`. Anything unreadable is skipped and
reported, because a wrong duration makes the schedule drift and drift is what
stops it feeling like television.

```bash
npm run scan-assets
```

---

## Commands

| Command | Does |
| --- | --- |
| `npm start` | Run it |
| `npm run dev` | Run with auto-restart |
| `npm run doctor` | Check your environment |
| `npm run demo` | Build a demo lineup with generated content |
| `npm run demo-ads` | Generate stand-in commercials |
| `npm run selftest` | Verify the schedule engine — no Plex needed |
| `npm run scan-assets` | Import commercials |
| `npm run reset` | Clear the schedule and rebuild |

---

## Configuration

All optional, all environment variables:

| Variable | Default | |
| --- | --- | --- |
| `CATHODE_PORT` | `8080` | Web port |
| `CATHODE_PLAYER` | `mpv` | `none` runs browser-only |
| `CATHODE_MPV` | `mpv` | Path to the binary |
| `CATHODE_FULLSCREEN` | `1` | `0` for a windowed player |
| `CATHODE_WINDOW_DAYS` | `14` | How far ahead to schedule |
| `CATHODE_DB` | `./data/cathode.db` | Database file |
| `CATHODE_MEDIA` | `./media` | Commercials folder |
| `CATHODE_TICK_MS` | `1000` | How often to re-check what's on |

---

## What it does not do

- **Transcode.** Ever. Direct play only — transcoding kills instant seeking,
  and instant seeking is the whole trick. If a file will not play, exclude it
  from the channel rather than reaching for a transcoder.
- **Touch your watch state.** No scrobbling, nothing marked watched, nothing
  added to Continue Watching. Live TV should not rearrange your library.
- **Let you pause.** By design.

---

## Where it's going

Working today: schedule engine, ad breaks, dark hours, guide, browser TV, mpv
player, Plex linking, demo mode.

Next: on-screen guide overlay on the mpv player, Raspberry Pi install script
and prebuilt image, FLIRC remote mapping, CRT-safe overscan pass, DVR playback
UI, printable weekly PDF guide, device sleep schedule.

---

## Project layout

```
src/
  schedule/   generator.js   builds the grid — slot rounding, ads, dark hours
              ordering.js    sequential / release / shuffle / marathon
              resolver.js    what's on now, guide queries
  player/     engine.js      the once-a-second loop that keeps TV honest
              mpv.js         JSON IPC wrapper
              overlay.js     ASS overlays for banner and cards
  plex/       auth.js        PIN link flow
              client.js      library browsing, direct-play URLs
public/       index.html     channel setup
              tv.html        the television
scripts/      demo.js        a whole lineup with no Plex
              selftest.js    proves the engine without a server
```

MIT.

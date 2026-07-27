# Running dumbTV in Docker

The headless self-host path: the config page **and** a working television, both in
your browser. No Plex required, no display required, nothing installed but Docker.

```bash
git clone https://github.com/sonicstarz/dumbtv.git
cd dumbtv
docker compose up -d
```

| | |
|---|---|
| **Set up channels** | <http://localhost:8080> |
| **Watch TV** | <http://localhost:8080/tv> |

Two tabs. The setup page is where you link a server and build channels; `/tv` is
the actual television — full-bleed picture, channel banner, guide, colour bars.

---

## ⚠️ The one thing that will trip you up

**When you enter your Jellyfin or Plex address, use your machine's LAN IP.
Not `localhost`. Not `host.docker.internal`.**

```
✅  http://192.168.1.50:8096
❌  http://localhost:8096
❌  http://host.docker.internal:8096
```

Here's why, because it's genuinely confusing:

Two different things need to reach your media server, and they live in different
places. **dumbTV's server** runs inside the container, where `localhost` means
*the container itself* and `host.docker.internal` means *your machine*. But the
**television at `/tv` runs in your browser**, on your machine, where
`host.docker.internal` doesn't resolve at all — so the video element would sit
there with a broken source and never play a frame.

A LAN IP is the one address that means the same thing from both sides. Find it:

```bash
ipconfig getifaddr en0          # macOS
hostname -I | awk '{print $1}'  # Linux
ipconfig                        # Windows — look for IPv4 Address
```

If the picture never appears but the guide shows programs, this is almost
certainly why. Change the address on the **Server** page and hit refresh.

---

## No media server yet?

Bring one up alongside dumbTV:

```bash
mkdir -p demo-media          # drop a few video files in here
docker compose --profile demo up -d
```

That starts Jellyfin at <http://localhost:8096>. Run its setup wizard, add
`/media` as a library, then point dumbTV at `http://<your-LAN-IP>:8096`.

Even with no server at all, dumbTV still works — the **Channel Packs** page
downloads curated public-domain content (cartoons, NASA footage, vintage
commercials) straight from the Internet Archive and turns each into a channel.

---

## What's in the image, and what isn't

**No mpv.** mpv drives a real display, and a container doesn't have one. The
browser TV at `/tv` is the whole product instead — same schedule, same channels,
same join-in-progress. If you want the real thing driving an HDMI output on a
Raspberry Pi, use `pi/install.sh`, not Docker.

**ffmpeg is included** (~400 MB of the image). `ffprobe` reads durations when you
scan local folders; `ffmpeg` measures loudness for commercial leveling. If you
only ever use Jellyfin or Plex, neither runs — but an image that silently can't
scan local media is a half-product, so it ships.

**Debian, not Alpine.** `better-sqlite3` publishes glibc prebuilds only. On
Alpine every build would compile SQLite from source and drag in a full toolchain.

---

## Your own video files

Uncomment the media mount in `docker-compose.yml`:

```yaml
    volumes:
      - dumbtv-data:/data
      - /path/to/your/videos:/media:ro
```

Then in the setup UI: **Channels → Add content → Local folder → `/media`**. Name
files so the parser can read them — `Show Name - S01E02 - Title.mkv` or
`Movie Title (1994).mp4`. No metadata service is ever contacted; the filename is
the metadata.

---

## Configuration

Everything is optional. Set in `docker-compose.yml` under `environment:`.

| Variable | Default | What it does |
|---|---|---|
| `DUMBTV_PORT` | `8080` | Port inside the container |
| `DUMBTV_PLAYER` | `none` | Leave it. `mpv` needs a display the container hasn't got |
| `DUMBTV_WINDOW_DAYS` | `14` | How far ahead the schedule is built |
| `TZ` | `America/Denver` | **Set this.** Slot alignment anchors to *local* midnight |
| `DUMBTV_LLM_URL` | unset | Optional OpenAI-compatible endpoint for channel suggestions |

`TZ` is the one worth changing. dumbTV aligns programming to your wall clock, so
a wrong timezone means a schedule that's correct but shifted.

---

## Data, updates, teardown

Your database and any downloaded content packs live in the `dumbtv-data` volume
and survive restarts and rebuilds.

```bash
docker compose logs -f          # watch it
docker compose restart          # restart
docker compose pull && docker compose up -d --build   # update
docker compose down             # stop, keep data
docker compose down -v          # stop, DELETE the database and packs
```

Back up your lineup from **Settings → Export config** rather than copying the
volume — the JSON is portable between machines and platforms.

---

## Troubleshooting

**Guide shows programs but the picture never loads.** The LAN IP thing above.
Nine times out of ten.

**`/data is not writable by uid 1000`.** You swapped the named volume for a host
directory. Either switch back, or `chown -R 1000:1000 your-dir` — the container
runs as the unprivileged `node` user, not root.

**dumbTV can't reach the media server.** From inside: `docker compose exec dumbtv
node -e "fetch('http://YOUR-IP:8096/System/Info/Public').then(r=>console.log(r.status))"`.
If that fails, it's a firewall or the server isn't listening on the LAN.

**Channel says "No content selected".** The source cached zero playable items —
check the Server page connects, then **Add content** again.

**Port 8080 taken.** Change the left-hand side: `- "9090:8080"`.

---

## Verified

Built and run against Docker 29.6 / colima on Apple Silicon, 2026-07-26:
image builds clean, container comes up **healthy** as non-root, `/`, `/tv`,
`/api/status` and `/api/packs` all serve, and a live **Jellyfin 10.11.11** server
was connected from inside the container — library browsed, a channel built, the
schedule resolving to a `?static=true` direct-play URL that returns **HTTP 206
`video/mp4`** to a host-side request, including a seek into the middle of the
file (which is what join-in-progress needs).

Not verified headlessly: the picture rendering in an actual browser window. The
page loads, its three API calls succeed, and the exact URL it assigns to
`video.src` serves seekable video to the host — but nobody has watched it play in
this environment. Worth one human glance at <http://localhost:8080/tv>.

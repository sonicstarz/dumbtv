# dumbTV — shared config API contract

The single spec both backends implement so the **same web UI** runs everywhere:
**Node** (`src/routes/api.js`) on Pi/Windows, an **embedded Swift server over `dumbTVCore`** on iOS/tvOS/macOS. Derived from the current Node implementation, which is the reference.

All paths are under `/api`. JSON in/out unless noted. Mutations (non-GET) are gated
by an optional household PIN (see Auth); reads and `/api/auth/*` stay open so the TV
never prompts.

## Scope tiers — what the Swift/Apple backend must implement

- **[CONFIG]** — the web config UI calls these; **Swift MUST implement** for on-device setup. This is the v1 port.
- **[READ]** — guide/on-air reads; the web `/tv` view uses them. On Apple the *native* player reads `dumbTVCore` directly, so these are only needed if the web `/tv` runs on Apple too. **Swift SHOULD implement** (cheap, same data).
- **[NODE-ONLY]** — tied to the Node runtime (mpv control, local-file range streaming). **Apple does NOT implement**; the native SwiftUI player + VLCKit replace them.
- **[LATER]** — optional/post-v1 on Apple (LLM, DVR, PDF, Jellyfin).

---

## Auth — household PIN  [CONFIG]
Gate: any non-GET (except `/api/auth/*`) requires a valid session cookie **once a PIN is set**. No PIN set → everything open.
- `GET  /api/auth/status` → `{ configured, authed }`
- `POST /api/auth/setup` `{ pin: "4–6 digits" }` → sets/rotates PIN, Set-Cookie. 401 if a PIN exists and you're not authed.
- `POST /api/auth/login` `{ pin }` → Set-Cookie or 401.
- `POST /api/auth/logout` → clears cookie.

## Status  [CONFIG]
- `GET /api/status` → `{ backend, linked, server:{name,uri,local}|null, reachable, counts:{channels,media,assets,programs}, player, orderingModes }`

## Plex link  [CONFIG]
- `POST /api/plex/pin` → `{ id, code }` (start PIN-link)
- `GET  /api/plex/pin/:id` → `{ linked:false }` while pending, else `{ linked:true, servers:[…] }` (saves token)
- `GET  /api/plex/servers` → `{ servers }` (400 if not linked)
- `POST /api/plex/server` `{ name, uri, local, accessToken, … }` → `{ ok, reachable }`
- `POST /api/plex/logout` → `{ ok }`

## Media backend / Jellyfin  [LATER on Apple]
- `POST /api/media/backend` `{ backend:"plex"|"jellyfin" }` → `{ ok, backend, reachable }`
- `GET  /api/jellyfin/status` · `POST /api/jellyfin/connect` `{url,username,password}` · `POST /api/jellyfin/apikey` `{url,userId,apiKey}` · `POST /api/jellyfin/logout`

## Library browsing  [CONFIG]
- `GET /api/library/sections` → `{ sections:[{key,title,type}] }`
- `GET /api/library/sections/:key/items?type=show|movie` → `{ items:[{ratingKey,title,thumb,image,…}] }`
- `GET /api/library/show/:ratingKey/episodes?channel=:id` → `{ episodes:[{ratingKey,title,showTitle,seasonNo,episodeNo,aired,durationMs,image,excluded}] }` (caches from Plex on first miss)

## Channels  [CONFIG]
- `GET    /api/channels` → `{ channels:[{…publicChannel, sources:[{id,ratingKey,sourceType,title,itemCount}]}] }`
- `POST   /api/channels` `{ name,number,slotMinutes,orderingMode,marathonSize,darkStart,darkEnd,adsEnabled,maxAdsPerBreak,adTags }` → `{ id }`
- `PATCH  /api/channels/:id` (any channel field) → `{ ok, …regenResult }`  *(edit triggers regenerate-from-now)*
- `DELETE /api/channels/:id` → `{ ok }`
- `POST   /api/channels/:id/sources` `{ items:[{ratingKey,sourceType,title}] }` → `{ ok, results, …regen }`
- `DELETE /api/channels/:id/sources/:sourceId` → `{ ok, …regen }`
- `GET    /api/channels/:id/excludes` → `{ excludes:[ratingKey] }`
- `PUT    /api/channels/:id/excludes` `{ ratingKeys:[…] }` → `{ ok, excluded, …regen }`
- `POST   /api/channels/:id/refresh` → re-pull sources from Plex → `{ ok, results, …regen }`

## Schedule  [CONFIG] (+ print [LATER])
- `POST /api/schedule/regenerate` `{ channelId? }` → one channel or all
- `POST /api/schedule/ensure` → top-up any short channels
- `GET  /api/channels/:id/preview?days=7` → dry-run BuildResult (no writes)
- `GET  /api/schedule/print?from=&days=&channels=` → **PDF** [LATER on Apple]
- `GET  /api/schedule/calendar?channel=&from=&days=` → `{ from,to, programs:[{startUtc,endUtc,kind,title,subtitle,seasonNo,episodeNo,ratingKey,isPremiere}] }`

## Schedule rules  [CONFIG]
- `GET    /api/channels/:id/rules` → `{ rules:[…] }` (priority desc)
- `POST   /api/channels/:id/rules` `{ kind, name?, priority?, daysOfWeek?, startTime?, durationMin?, startsAtUtc?, sourceType?, ratingKey?, orderingMode?, effectiveFrom?, effectiveTo?, adPolicy?, airdateMode?, cadenceCompress? }` → `{ id }`
- `PATCH  /api/rules/:id` (any rule field) → `{ ok }`
- `DELETE /api/rules/:id` → `{ ok }`
- Default priorities: blackout 1000, pinned 800, recurring 600, airdate 400, rotation 0.

## Config backup / restore  [CONFIG]
- `GET  /api/config/export` → `{ version:2, exportedAt, channels, sources, rules, excludes }` (no secrets)
- `POST /api/config/import` `<that JSON>` → replaces lineup, `{ ok, channels, rules }`

## Guide / on-air — player-facing reads  [READ]
- `GET /api/guide?from=&hours=3` → slot-collapsed listings grid
- `GET /api/onair` → `{ at, channels:[nowOn…] }`
- `GET /api/channels/:id/upnext?count=5` → `{ now, next:[…] }`

## Player control — mpv  [NODE-ONLY]
`GET /api/player`, `POST /api/player/{tune,surf,digit,banner}` — drive the Node mpv window. **Apple replaces this with the native SwiftUI player + VLCKit calling `dumbTVCore` directly.**

## Local media streaming  [NODE-ONLY]
`GET /api/local?p=` — Range/206 file streaming for the browser `/tv`. Apple plays Plex URLs / bundled files via VLCKit directly.

## Assets — ads & bumpers  [CONFIG, import-plex LATER]
- `GET /api/assets` · `POST /api/assets/scan` · `DELETE /api/assets/:id` · `PATCH /api/assets/:id` `{tags?,kind?}`
- `POST /api/assets/import-plex` `{sectionKey}` · `POST /api/assets/refresh-plex`  [LATER on Apple]

## DVR  [LATER]
`GET /api/dvr` · `POST /api/dvr {channelId}` · `DELETE /api/dvr/:id`

## Settings  [CONFIG]
- `GET  /api/settings` → `{ dvrSlots, sleepStart, sleepEnd, timezone, activeTimezone, loudnessTarget, displayFill, captions }`
- `POST /api/settings` (any of the above) → `{ ok }`

---

## Swift port sizing (the [CONFIG] core)
Most of these map onto logic that already exists in `dumbTVCore`:
- **Channels / rules / schedule / preview** → `ChannelScheduler`, `RuleScheduler`, `Generator`, `Resolver` (present).
- **Plex link / library / episodes** → `PlexClient` (present: `createPin`, `checkPin`, `listServers`, `sections`, `episodes`, `streamURL`).
- **Persistence** → the one real gap: `dumbTVCore` is in-memory today; needs a SQLite store (channels, sources, rules, excludes, settings, cached media) mirroring `src/db.js`.
- **Auth / settings / assets / config-export** → thin CRUD over that store.

**Not needed on Apple:** `player/*` (mpv), `/api/local` (native VLCKit instead). **Deferred:** Jellyfin, LLM, DVR, PDF print, Plex-ad-import.

So the v1 Swift server = the **[CONFIG]** + **[READ]** tiers over `dumbTVCore` + a new SQLite layer. That's the bulk of Track G.

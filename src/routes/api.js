import fs from 'node:fs';
import path from 'node:path';
import { db, getSetting, setSetting } from '../db.js';

const MIME = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.mpg': 'video/mpeg',
  '.mpeg': 'video/mpeg',
};
import {
  createPin,
  checkPin,
  saveToken,
  getToken,
  listServers,
  saveServer,
  getServer,
  clearAuth,
} from '../plex/auth.js';
import {
  getSections,
  getSectionItems,
  cacheSource,
  importAds,
  ping,
  imageUrl,
  fetchImage,
  activeBackend,
} from '../media/backend.js';
import {
  authenticate as jfAuthenticate,
  saveApiKey as jfSaveApiKey,
  getJfServer,
  clearJf,
  jfConfigured,
} from '../jellyfin/auth.js';
import { completeJSON, llmConfigured, llmConfig } from '../llm/client.js';
import { generateChannel, regenerateChannel, ensureSchedule, previewChannel } from '../schedule/generator.js';
import {
  packsOverview, startInstall, createChannelFromPack, uninstallPack,
  refreshCatalogInBackground,
} from '../packs/install.js';
import {
  scanLocalFolder, previewLocalFolder, createChannelFromLocalFolder,
  listLocalFolders, forgetLocalFolder,
} from '../media/localscan.js';
import {
  isConfigured, setPin, verifyPin, clearPin, tokenValid, cookieToken, sessionCookieHeader,
} from '../auth.js';
import {
  CONFIG_VERSION, CHANNEL_COLUMNS, RULE_COLUMNS,
  pickChannel, pickRule, pickSource, upgradeV2,
} from '../config-format.js';
import { config } from '../config.js';
import { guide, nowOnAll, nowOn, upNextShow, publicChannel } from '../schedule/resolver.js';
import { ORDERING_MODES } from '../schedule/ordering.js';
import { hashString } from '../util/rng.js';
import { normalizeVibe, parseVibe, VIBE_PRESETS } from '../vibe.js';
import { allTags, setTags, tagsFor, refreshDerivedTags } from '../media/tags.js';
import { scanAssets } from '../assets.js';
import { buildSchedulePdf } from '../print.js';
import { buildXmltv } from '../xmltv.js';
import { engine } from '../player/engine.js';
import { HOUR } from '../util/time.js';

/** A shuffle seed derived from the channel's identity, so the same lineup built
 *  on two devices plays in the same order (invariant #5, across boxes). */
const channelSeed = (name, number) => hashString(`channel:${name}:${number}`) & 0x7fffffff;

const CHANNEL_FIELDS = [
  'name',
  'number',
  'slot_minutes',
  'ordering_mode',
  'marathon_size',
  'dark_start',
  'dark_end',
  'ads_enabled',
  'max_ads_per_break',
  'ad_tags',
  'timing_mode',
  'ads_between',
  'cooldown_days',
  'overrun_policy',
  'enabled',
  'vibe',
  'signoff_asset_id',
  'offair_pattern',
  'exclude_warnings',
];

export default async function api(fastify) {
  // Gate mutations behind the household PIN. Reads (GET) and the auth endpoints
  // stay open, so the TV never asks for a password. When no PIN is set, all open.
  fastify.addHook('preHandler', async (req, reply) => {
    const method = req.method.toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;
    if (req.url.startsWith('/api/auth/')) return;
    if (!isConfigured()) return;
    if (tokenValid(cookieToken(req))) return;
    return reply.code(401).send({ error: 'PIN required' });
  });

  fastify.get('/api/auth/status', async (req) => ({
    configured: isConfigured(),
    authed: !isConfigured() || tokenValid(cookieToken(req)),
  }));

  fastify.post('/api/auth/setup', async (req, reply) => {
    if (isConfigured() && !tokenValid(cookieToken(req))) {
      return reply.code(401).send({ error: 'Enter the current PIN first' });
    }
    const pin = String((req.body && req.body.pin) || '');
    if (!/^\d{4,6}$/.test(pin)) return reply.code(400).send({ error: 'PIN must be 4–6 digits' });
    setPin(pin);
    reply.header('Set-Cookie', sessionCookieHeader());
    return { ok: true };
  });

  fastify.post('/api/auth/login', async (req, reply) => {
    if (!verifyPin((req.body && req.body.pin) || '')) {
      return reply.code(401).send({ error: 'Wrong PIN' });
    }
    reply.header('Set-Cookie', sessionCookieHeader());
    return { ok: true };
  });

  fastify.post('/api/auth/logout', async (req, reply) => {
    // Rotate the secret via a no-op PIN reset is heavy; just clear the cookie.
    reply.header('Set-Cookie', 'dumbtv_auth=; Path=/; HttpOnly; Max-Age=0');
    return { ok: true };
  });

  fastify.get('/api/status', async () => {
    const backend = activeBackend();
    const plexServer = getServer();
    const jf = getJfServer();
    // "linked" reflects whichever backend is active.
    const linked = backend === 'jellyfin' ? jfConfigured() : !!getToken();
    const connected = backend === 'jellyfin' ? jfConfigured() : !!plexServer;
    let reachable = null;
    if (connected) reachable = await ping().catch(() => false);
    const server =
      backend === 'jellyfin'
        ? jf ? { name: jf.name || 'Jellyfin', uri: jf.url, local: false } : null
        : plexServer ? { name: plexServer.name, uri: plexServer.uri, local: plexServer.local } : null;
    const counts = {
      channels: db.prepare('SELECT COUNT(*) n FROM channels').get().n,
      media: db.prepare('SELECT COUNT(*) n FROM media').get().n,
      assets: db.prepare('SELECT COUNT(*) n FROM assets').get().n,
      programs: db.prepare('SELECT COUNT(*) n FROM programs').get().n,
    };
    return {
      backend,
      linked,
      server,
      reachable,
      counts,
      // What kind of device the TV is. The web UI shows platform-specific advice
      // off this (e.g. the iOS local-network permission). Self-hosted installs
      // are "node" — Pi, Windows, or a dev Mac; no such prompt anywhere.
      platform: 'node',
      player: engine.snapshot(),
      orderingModes: ORDERING_MODES,
    };
  });

  // ---- Plex link ---------------------------------------------------------

  fastify.post('/api/plex/pin', async () => createPin());

  fastify.get('/api/plex/pin/:id', async (req) => {
    const token = await checkPin(req.params.id);
    if (!token) return { linked: false };
    saveToken(token);
    const servers = await listServers(token);
    return { linked: true, servers };
  });

  fastify.get('/api/plex/servers', async (req, reply) => {
    const token = getToken();
    if (!token) return reply.code(400).send({ error: 'Not linked to Plex yet' });
    return { servers: await listServers(token) };
  });

  fastify.post('/api/plex/server', async (req) => {
    saveServer(req.body);
    return { ok: true, reachable: await ping().catch(() => false) };
  });

  fastify.post('/api/plex/logout', async () => {
    clearAuth();
    return { ok: true };
  });

  // ---- Jellyfin link -----------------------------------------------------

  // Switch which media backend is active (plex | jellyfin).
  fastify.post('/api/media/backend', async (req) => {
    const backend = req.body?.backend === 'jellyfin' ? 'jellyfin' : 'plex';
    setSetting('media_backend', backend);
    return { ok: true, backend, reachable: await ping().catch(() => false) };
  });

  fastify.get('/api/jellyfin/status', async () => {
    const s = getJfServer();
    return {
      configured: jfConfigured(),
      server: s ? { url: s.url, name: s.name, userId: s.userId } : null,
      active: activeBackend() === 'jellyfin',
    };
  });

  // Connect with a username + password (Jellyfin issues an access token).
  fastify.post('/api/jellyfin/connect', async (req, reply) => {
    const b = req.body || {};
    try {
      const s = await jfAuthenticate(b.url, b.username, b.password);
      setSetting('media_backend', 'jellyfin');
      return { ok: true, server: { url: s.url, name: s.name, userId: s.userId } };
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
  });

  // Or connect with a server URL + user id + dashboard API key.
  fastify.post('/api/jellyfin/apikey', async (req, reply) => {
    const b = req.body || {};
    if (!b.url || !b.userId || !b.apiKey) {
      return reply.code(400).send({ error: 'Need server URL, user id, and API key.' });
    }
    await jfSaveApiKey(b.url, b.userId, b.apiKey);
    setSetting('media_backend', 'jellyfin');
    return { ok: true, reachable: await ping().catch(() => false) };
  });

  fastify.post('/api/jellyfin/logout', async () => {
    clearJf();
    setSetting('media_backend', 'plex');
    return { ok: true };
  });

  // ---- Library browsing --------------------------------------------------

  fastify.get('/api/library/sections', async () => ({ sections: await getSections() }));

  fastify.get('/api/library/sections/:key/items', async (req) => {
    const type = req.query.type || 'show';
    const items = await getSectionItems(req.params.key, type);
    return {
      items: items.map((i) => ({ ...i, image: imageUrl(i.thumb, 200, 300) })),
    };
  });

  // Episodes of a show, for the pin-an-episode and filter-out-episodes UIs.
  // Reads the local cache first (populated when the show is added as a source);
  // if the show has never been cached, pulls it from Plex once. Pass ?channel=
  // to get each episode's excluded flag for that channel.
  fastify.get('/api/library/show/:ratingKey/episodes', async (req) => {
    const showKey = String(req.params.ratingKey);
    const read = db.prepare(
      `SELECT rating_key, title, show_title, season_no, episode_no, aired, duration_ms, thumb,
              series_partial, content_warnings
       FROM media WHERE parent_key = ? AND duration_ms > 0
       ORDER BY COALESCE(season_no, 0), COALESCE(episode_no, 0), title`
    );
    let rows = read.all(showKey);
    if (rows.length === 0) {
      try {
        await cacheSource(showKey, 'show');
        rows = read.all(showKey);
      } catch (err) {
        return { episodes: [], error: err.message };
      }
    }
    const excluded = new Set();
    if (req.query.channel) {
      for (const r of db
        .prepare('SELECT rating_key FROM channel_excludes WHERE channel_id = ?')
        .all(Number(req.query.channel))) {
        excluded.add(r.rating_key);
      }
    }
    return {
      // PD Packs Task 3: most public-domain television is an INCOMPLETE run —
      // each episode had to be renewed separately, so only the first 55 Beverly
      // Hillbillies are PD. The UI must not imply the rest exist.
      partialSeries: rows.some((r) => r.series_partial),
      episodes: rows.map((r) => ({
        ratingKey: r.rating_key,
        seriesPartial: !!r.series_partial,
        contentWarnings: String(r.content_warnings || '').split(',').map((w) => w.trim()).filter(Boolean),
        title: r.title,
        showTitle: r.show_title,
        seasonNo: r.season_no,
        episodeNo: r.episode_no,
        aired: r.aired,
        durationMs: r.duration_ms,
        image: imageUrl(r.thumb, 160, 90),
        excluded: excluded.has(r.rating_key),
      })),
    };
  });

  // ---- Artwork proxy -----------------------------------------------------

  /**
   * Poster/thumb bytes, fetched with the server's credentials so the browser
   * never sees them (S-5). The path is validated per backend inside the client,
   * so this cannot be turned into a general-purpose authenticated proxy (S-6).
   *
   * The cache is what the Apple side gained in build 12 as the fix for the slow
   * picker; Node had none, so every render re-fetched every poster (E-3).
   */
  const IMG_CACHE_MAX = 200;
  const imgCache = new Map();   // insertion-ordered → cheap LRU

  fastify.get('/api/image', async (req, reply) => {
    const p = req.query.path;
    if (!p) return reply.code(400).send({ error: 'Missing path' });
    const w = Math.min(1000, Math.max(16, Number(req.query.w) || 300));
    const h = Math.min(1500, Math.max(16, Number(req.query.h) || 450));
    const key = `${activeBackend()}|${p}|${w}x${h}`;

    const hit = imgCache.get(key);
    if (hit) {
      imgCache.delete(key);      // refresh recency
      imgCache.set(key, hit);
      reply.header('Cache-Control', 'private, max-age=86400');
      return reply.type(hit.type).send(hit.buf);
    }

    let img;
    try {
      img = await fetchImage(p, w, h);
    } catch {
      img = null;
    }
    // No artwork is ordinary, not an error — an item with no primary image 404s
    // on Jellyfin, which is exactly why thumbs are only claimed when they exist.
    if (!img) return reply.code(404).send({ error: 'No image' });

    imgCache.set(key, img);
    if (imgCache.size > IMG_CACHE_MAX) imgCache.delete(imgCache.keys().next().value);
    reply.header('Cache-Control', 'private, max-age=86400');
    return reply.type(img.type).send(img.buf);
  });

  // ---- Channels ----------------------------------------------------------

  fastify.get('/api/channels', async () => {
    const rows = db.prepare('SELECT * FROM channels ORDER BY number').all();
    const srcStmt = db.prepare('SELECT * FROM channel_sources WHERE channel_id = ? ORDER BY id');
    // Two indexed lookups rather than an OR, which SQLite would answer with a
    // full scan — this runs once per source on every channel-list load (E-2).
    const countStmt = db.prepare(
      `SELECT (SELECT COUNT(*) FROM media WHERE parent_key = ?)
            + (SELECT COUNT(*) FROM media WHERE rating_key = ?) AS n`
    );
    return {
      channels: rows.map((c) => {
        const sources = srcStmt.all(c.id).map((s) => ({
          id: s.id,
          ratingKey: s.rating_key,
          sourceType: s.source_type,
          title: s.title,
          itemCount: countStmt.get(s.rating_key, s.rating_key).n,
        }));
        return { ...publicChannel(c), sources };
      }),
    };
  });

  fastify.post('/api/channels', async (req) => {
    const b = req.body || {};
    // N2: never collide on the UNIQUE number — use the requested one only if
    // free, else the next above the max (a plain INSERT used to 500 on a clash).
    const maxNo = db.prepare('SELECT MAX(number) m FROM channels').get().m || 1;
    const taken = b.number != null && db.prepare('SELECT 1 FROM channels WHERE number=?').get(b.number);
    const number = b.number != null && !taken ? b.number : maxNo + 1;
    const info = db
      .prepare(
        `INSERT INTO channels
          (number, name, slot_minutes, ordering_mode, marathon_size,
           shuffle_seed, dark_start, dark_end, ads_enabled, max_ads_per_break,
           ad_tags, enabled, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?)`
      )
      .run(
        number,
        b.name || 'New Channel',
        b.slotMinutes ?? 30,
        b.orderingMode || 'sequential',
        b.marathonSize ?? 3,
        // Seed from the channel's identity, not the clock. The seed is stored
        // either way, so the schedule was always deterministic ON a device —
        // but a random one means the SAME lineup built on two boxes plays in a
        // different order, which breaks cloning and makes a printed guide
        // device-specific. createChannelFromLocalFolder already did this right.
        channelSeed(b.name || 'New Channel', number),
        b.darkStart || null,
        b.darkEnd || null,
        b.adsEnabled === true ? 1 : 0,   // ads OFF by default (matches Swift + D2)
        b.maxAdsPerBreak ?? 10,
        b.adTags || '',
        Date.now()
      );
    return { id: info.lastInsertRowid, number };
  });

  // S3: a system channel (SPACE at 1) is hideable, not editable. `enabled` is
  // allowed through — a channel you can neither remove nor hide is a hostage —
  // but everything else is a clean 403 rather than a silent no-op or a 500.
  const lockedChannel = (id) =>
    !!db.prepare('SELECT locked FROM channels WHERE id = ?').get(id)?.locked;
  const LOCKED_MSG =
    'This channel is built into dumbTV and cannot be edited or removed. You can turn it off.';

  fastify.patch('/api/channels/:id', async (req, reply) => {
    const b = req.body || {};
    if (lockedChannel(req.params.id)) {
      const onlyEnabled = Object.keys(b).every((k) => k === 'enabled');
      if (!onlyEnabled) return reply.code(403).send({ error: LOCKED_MSG });
    }
    const map = {
      name: b.name,
      number: b.number,
      slot_minutes: b.slotMinutes,
      ordering_mode: b.orderingMode,
      marathon_size: b.marathonSize,
      dark_start: b.darkStart === '' ? null : b.darkStart,
      dark_end: b.darkEnd === '' ? null : b.darkEnd,
      ads_enabled: b.adsEnabled === undefined ? undefined : b.adsEnabled ? 1 : 0,
      max_ads_per_break: b.maxAdsPerBreak,
      ad_tags: b.adTags,
      timing_mode: b.timingMode,
      ads_between: b.adsBetween,
      cooldown_days: b.cooldownDays,
      overrun_policy: b.overrunPolicy,
      enabled: b.enabled === undefined ? undefined : b.enabled ? 1 : 0,
      // A vibe is stored whole. `null` clears it back to the global default.
      vibe: b.vibe === undefined ? undefined
        : (b.vibe === null ? null : JSON.stringify(normalizeVibe(b.vibe))),
      signoff_asset_id: b.signoffAssetId === undefined ? undefined
        : (b.signoffAssetId ? Number(b.signoffAssetId) : null),
      offair_pattern: b.offairPattern === undefined ? undefined
        : (['bars', 'snow', 'card'].includes(b.offairPattern) ? b.offairPattern : 'bars'),
      exclude_warnings: b.excludeWarnings === undefined ? undefined
        : (Array.isArray(b.excludeWarnings) ? b.excludeWarnings.join(',') : String(b.excludeWarnings || '')),
    };
    const sets = [];
    const vals = [];
    for (const f of CHANNEL_FIELDS) {
      if (map[f] !== undefined) {
        sets.push(`${f} = ?`);
        vals.push(map[f]);
      }
    }
    if (sets.length) {
      vals.push(req.params.id);
      db.prepare(`UPDATE channels SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    }
    const res = regenerateChannel(Number(req.params.id));
    return { ok: true, ...res };
  });

  fastify.delete('/api/channels/:id', async (req, reply) => {
    if (lockedChannel(req.params.id)) return reply.code(403).send({ error: LOCKED_MSG });
    db.prepare('DELETE FROM channels WHERE id = ?').run(req.params.id);
    return { ok: true };
  });

  // ── content packs (Track I) ────────────────────────────────────────────────
  // Curated public-domain channel packs. GET lists the catalog merged with
  // what's installed; install downloads from the Internet Archive; channel
  // spins one up in a tap; DELETE removes it (aired programs survive).
  fastify.get('/api/packs', async () => {
    // D5: opening the pack page is the ONE moment dumbTV asks dumbtv.app what
    // exists. Fire-and-forget — the list you see is whatever is already cached,
    // and a refresh lands for the next open. Nobody waits on our server to see
    // their own installed packs. Stated in the privacy policy in these terms.
    refreshCatalogInBackground();
    return { packs: packsOverview() };
  });

  fastify.post('/api/packs/:id/install', async (req, reply) => {
    try { return { ok: true, progress: startInstall(req.params.id) }; }
    catch (e) { return reply.code(404).send({ error: e.message }); }
  });

  fastify.post('/api/packs/:id/channel', async (req, reply) => {
    try {
      const { channelId } = createChannelFromPack(req.params.id, req.body || {});
      const res = ensureSchedule();
      return { ok: true, channelId, results: res };
    } catch (e) { return reply.code(400).send({ error: e.message }); }
  });

  fastify.delete('/api/packs/:id', async (req) => {
    uninstallPack(req.params.id);
    return { ok: true };
  });

  // ── local folders (Track I) — "bring your own files", no Plex ──────────────
  // Node/Pi/Mac-dev only: the config UI runs on another device and can't pick a
  // folder on the TV. (Apple registers folders via a native grant; see docs.)
  // The management list the web UI renders. Same wire shape as the Apple side's
  // /api/local-folders, so one UI serves both without branching.
  fastify.get('/api/local-folders', async () => ({ folders: listLocalFolders() }));

  fastify.delete('/api/local-folders/:id', async (req) => {
    forgetLocalFolder(req.params.id);
    return { ok: true };
  });

  // Matches the Apple side's shape (/:id/channel) so ONE web UI drives both.
  // The older body-carries-the-id form below is kept for anything already
  // calling it.
  fastify.post('/api/local-folders/:id/channel', async (req, reply) => {
    const f = listLocalFolders().find((x) => x.folderId === req.params.id);
    if (!f) return reply.code(400).send({ error: 'No such folder' });
    const { channelId } = createChannelFromLocalFolder(
      f.folderId, req.body?.name || f.name, req.body || {}
    );
    return { ok: true, channelId, results: ensureSchedule() };
  });

  fastify.post('/api/local-folders/:id/rescan', async (req, reply) => {
    const f = listLocalFolders().find((x) => x.folderId === req.params.id);
    if (!f) return reply.code(400).send({ error: 'No such folder' });
    try {
      const res = await scanLocalFolder(f.path);
      for (const { id } of db.prepare(
        "SELECT channel_id AS id FROM channel_sources WHERE rating_key = ?"
      ).all(req.params.id)) regenerateChannel(id);
      return { ok: true, items: res.added };
    } catch (e) { return reply.code(400).send({ error: e.message }); }
  });

  fastify.get('/api/local-folders/preview', async (req, reply) => {
    if (!req.query.path) return reply.code(400).send({ error: 'path required' });
    try { return await previewLocalFolder(req.query.path); }
    catch (e) { return reply.code(400).send({ error: e.message }); }
  });

  fastify.post('/api/local-folders', async (req, reply) => {
    if (!req.body?.path) return reply.code(400).send({ error: 'path required' });
    try { return { ok: true, ...(await scanLocalFolder(req.body.path)) }; }
    catch (e) { return reply.code(400).send({ error: e.message }); }
  });

  fastify.post('/api/local-folders/channel', async (req, reply) => {
    if (!req.body?.folderId) return reply.code(400).send({ error: 'folderId required' });
    const { channelId } = createChannelFromLocalFolder(req.body.folderId, req.body.name, req.body);
    return { ok: true, channelId, results: ensureSchedule() };
  });

  fastify.post('/api/channels/:id/sources', async (req, reply) => {
    const channelId = Number(req.params.id);
    const items = req.body.items || [];
    const insert = db.prepare(
      `INSERT OR IGNORE INTO channel_sources (channel_id, rating_key, source_type, title)
       VALUES (?,?,?,?)`
    );

    const results = [];
    for (const it of items) {
      insert.run(channelId, String(it.ratingKey), it.sourceType, it.title);
      // Pack + local sources already have their media registered — nothing to
      // fetch from Plex (C3: content packs are addable to any channel).
      if (it.sourceType === 'pack' || it.sourceType === 'local') {
        const n = db.prepare('SELECT COUNT(*) n FROM media WHERE parent_key=?').get(String(it.ratingKey)).n;
        results.push({ title: it.title, cached: n });
        continue;
      }
      try {
        const r = await cacheSource(String(it.ratingKey), it.sourceType);
        results.push({ title: it.title, ...r });
      } catch (err) {
        results.push({ title: it.title, error: err.message });
      }
    }
    const regen = regenerateChannel(channelId);
    return { ok: true, results, ...regen };
  });

  fastify.delete('/api/channels/:id/sources/:sourceId', async (req, reply) => {
    // A locked channel's content is not the user's to strip — removing its only
    // source would leave a channel that can't be deleted showing nothing.
    if (lockedChannel(req.params.id)) return reply.code(403).send({ error: LOCKED_MSG });
    db.prepare('DELETE FROM channel_sources WHERE id = ? AND channel_id = ?').run(
      req.params.sourceId,
      req.params.id
    );
    const regen = regenerateChannel(Number(req.params.id));
    return { ok: true, ...regen };
  });

  // ---- Episode filtering (exclude specific episodes from rotation) --------

  fastify.get('/api/channels/:id/excludes', async (req) => ({
    excludes: db
      .prepare('SELECT rating_key FROM channel_excludes WHERE channel_id = ?')
      .all(Number(req.params.id))
      .map((r) => r.rating_key),
  }));

  // Replace the whole exclusion set for a channel, then rebuild the schedule.
  fastify.put('/api/channels/:id/excludes', async (req) => {
    const channelId = Number(req.params.id);
    const keys = Array.isArray(req.body?.ratingKeys) ? req.body.ratingKeys.map(String) : [];
    const apply = db.transaction(() => {
      db.prepare('DELETE FROM channel_excludes WHERE channel_id = ?').run(channelId);
      const ins = db.prepare('INSERT OR IGNORE INTO channel_excludes (channel_id, rating_key) VALUES (?,?)');
      for (const k of keys) ins.run(channelId, k);
    });
    apply();
    return { ok: true, excluded: keys.length, ...regenerateChannel(channelId) };
  });

  fastify.post('/api/channels/:id/refresh', async (req) => {
    const sources = db
      .prepare('SELECT * FROM channel_sources WHERE channel_id = ?')
      .all(req.params.id);
    const results = [];
    for (const s of sources) {
      try {
        results.push({ title: s.title, ...(await cacheSource(s.rating_key, s.source_type)) });
      } catch (err) {
        results.push({ title: s.title, error: err.message });
      }
    }
    return { ok: true, results, ...regenerateChannel(Number(req.params.id)) };
  });

  // ---- Schedule ----------------------------------------------------------

  fastify.post('/api/schedule/regenerate', async (req) => {
    if (req.body && req.body.channelId) {
      return regenerateChannel(Number(req.body.channelId));
    }
    const ids = db.prepare('SELECT id FROM channels').all().map((r) => r.id);
    return { results: ids.map((id) => regenerateChannel(id)) };
  });

  fastify.post('/api/schedule/ensure', async () => ({ results: ensureSchedule() }));

  // Dry-run: what a regeneration would produce, without writing anything.
  fastify.get('/api/channels/:id/preview', async (req) =>
    previewChannel(Number(req.params.id), Number(req.query.days || 7))
  );

  /**
   * R6 · the schedule as XMLTV, for third-party guide clients.
   *
   * Deliberately NOT paired with tuner emulation (R7): that would mean a
   * permanent per-channel encoded stream, which is invariant #2 in reverse.
   * This is the half that costs nothing — the grid already exists.
   */
  fastify.get('/api/xmltv', async (req, reply) => {
    const from = req.query.from ? Number(req.query.from) : Date.now();
    const days = Math.max(1, Math.min(14, Number(req.query.days || 7)));
    const proto = req.headers['x-forwarded-proto'] || 'http';
    const baseUrl = req.headers.host ? `${proto}://${req.headers.host}` : '';
    reply.header('Content-Type', 'application/xml; charset=utf-8');
    reply.header('Content-Disposition', 'inline; filename="dumbtv.xml"');
    return reply.send(buildXmltv({ from, days, baseUrl }));
  });

  // Printable PDF guide, straight from the programs table.
  fastify.get('/api/schedule/print', async (req, reply) => {
    const from = req.query.from ? Number(req.query.from) : Date.now();
    const days = Math.max(1, Math.min(14, Number(req.query.days || 7)));
    const channelIds = req.query.channels
      ? String(req.query.channels).split(',').map(Number).filter(Boolean)
      : null;
    reply.header('Content-Type', 'application/pdf');
    reply.header('Content-Disposition', 'inline; filename="dumbtv-guide.pdf"');
    return reply.send(buildSchedulePdf({ from, days, channelIds }));
  });

  // ---- Tags (R8) ---------------------------------------------------------

  /** The vocabulary in use, most-used first — what the daypart picker offers. */
  fastify.get('/api/tags', async () => ({ tags: allTags() }));

  /** Replace a media item's USER tags. Pack and derived tags are untouched. */
  fastify.put('/api/media/:ratingKey/tags', async (req) => {
    setTags(req.params.ratingKey, req.body?.tags || [], 'user');
    return { ok: true, tags: tagsFor(req.params.ratingKey) };
  });

  /** Recompute the tags we can infer (decade, short/feature) across the library. */
  fastify.post('/api/tags/refresh', async () => ({ ok: true, updated: refreshDerivedTags() }));

  // ---- Schedule rules ----------------------------------------------------

  const DEFAULT_PRIORITY = { blackout: 1000, pinned: 800, recurring: 600, airdate: 400, rotation: 0 };
  const RULE_FIELDS = [
    'name', 'kind', 'priority', 'enabled', 'days_of_week', 'start_time', 'duration_min',
    'starts_at_utc', 'source_type', 'rating_key', 'ordering_mode', 'effective_from',
    'effective_to', 'ad_policy', 'airdate_mode', 'cadence_compress', 'effective_annual',
    'select_tags', 'select_mode',
  ];

  fastify.get('/api/channels/:id/rules', async (req) => ({
    rules: db.prepare('SELECT * FROM schedule_rules WHERE channel_id = ? ORDER BY priority DESC, id')
      .all(Number(req.params.id)),
  }));

  fastify.post('/api/channels/:id/rules', async (req, reply) => {
    const b = req.body || {};
    if (!b.kind) return reply.code(400).send({ error: 'kind is required' });
    const priority = b.priority ?? DEFAULT_PRIORITY[b.kind] ?? 0;
    const info = db.prepare(`
      INSERT INTO schedule_rules
        (channel_id, name, kind, priority, enabled, days_of_week, start_time, duration_min,
         starts_at_utc, source_type, rating_key, ordering_mode, effective_from, effective_to,
         ad_policy, airdate_mode, cadence_compress, effective_annual, select_tags, select_mode)
      VALUES (@channelId,@name,@kind,@priority,1,@daysOfWeek,@startTime,@durationMin,
              @startsAtUtc,@sourceType,@ratingKey,@orderingMode,@effectiveFrom,@effectiveTo,
              @adPolicy,@airdateMode,@cadenceCompress,@effectiveAnnual,@selectTags,@selectMode)
    `).run({
      channelId: Number(req.params.id), name: b.name || null, kind: b.kind, priority,
      daysOfWeek: b.daysOfWeek || null, startTime: b.startTime || null, durationMin: b.durationMin ?? null,
      startsAtUtc: b.startsAtUtc ?? null, sourceType: b.sourceType || null, ratingKey: b.ratingKey || null,
      orderingMode: b.orderingMode || null, effectiveFrom: b.effectiveFrom || null,
      effectiveTo: b.effectiveTo || null, adPolicy: b.adPolicy ? JSON.stringify(b.adPolicy) : null,
      airdateMode: b.airdateMode || null, cadenceCompress: b.cadenceCompress ?? 1,
      effectiveAnnual: b.effectiveAnnual ? 1 : 0,
      selectTags: Array.isArray(b.selectTags) ? b.selectTags.join(',') : (b.selectTags || null),
      selectMode: b.selectMode === 'all' ? 'all' : 'any',
    });
    return { id: info.lastInsertRowid };
  });

  fastify.patch('/api/rules/:id', async (req) => {
    const b = req.body || {};
    const map = {
      name: b.name, kind: b.kind, priority: b.priority,
      enabled: b.enabled === undefined ? undefined : (b.enabled ? 1 : 0),
      days_of_week: b.daysOfWeek, start_time: b.startTime, duration_min: b.durationMin,
      starts_at_utc: b.startsAtUtc, source_type: b.sourceType, rating_key: b.ratingKey,
      ordering_mode: b.orderingMode, effective_from: b.effectiveFrom, effective_to: b.effectiveTo,
      ad_policy: b.adPolicy === undefined ? undefined : (b.adPolicy ? JSON.stringify(b.adPolicy) : null),
      airdate_mode: b.airdateMode, cadence_compress: b.cadenceCompress,
      effective_annual: b.effectiveAnnual === undefined ? undefined : (b.effectiveAnnual ? 1 : 0),
      select_tags: b.selectTags === undefined ? undefined
        : (Array.isArray(b.selectTags) ? b.selectTags.join(',') : (b.selectTags || null)),
      select_mode: b.selectMode === undefined ? undefined : (b.selectMode === 'all' ? 'all' : 'any'),
    };
    const sets = [], vals = [];
    for (const f of RULE_FIELDS) {
      if (map[f] !== undefined) { sets.push(`${f} = ?`); vals.push(map[f]); }
    }
    if (sets.length) {
      vals.push(Number(req.params.id));
      db.prepare(`UPDATE schedule_rules SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    }
    return { ok: true };
  });

  fastify.delete('/api/rules/:id', async (req) => {
    db.prepare('DELETE FROM schedule_rules WHERE id = ?').run(Number(req.params.id));
    return { ok: true };
  });

  // ---- Config backup / restore -------------------------------------------

  // Export the whole lineup as one JSON — back it up, share it, or move it to
  // another box. Format spec + what deliberately never travels: config-format.js.
  fastify.get('/api/config/export', async () => {
    // A locked channel is the device's own (SPACE ships with dumbTV), so it is
    // not the user's to clone — and the receiving device already has its own.
    const channels = db.prepare('SELECT * FROM channels WHERE locked = 0 ORDER BY number').all();
    const srcStmt = db.prepare('SELECT * FROM channel_sources WHERE channel_id = ? ORDER BY id');
    const ruleStmt = db.prepare('SELECT * FROM schedule_rules WHERE channel_id = ? ORDER BY id');
    const exclStmt = db.prepare('SELECT rating_key FROM channel_excludes WHERE channel_id = ?');

    return {
      version: CONFIG_VERSION,
      exportedAt: Date.now(),
      origin: { platform: 'node', appVersion: config.productVersion },
      channels: channels.map((c) => ({
        key: `ch-${c.id}`,
        number: c.number, name: c.name, slotMinutes: c.slot_minutes,
        orderingMode: c.ordering_mode, marathonSize: c.marathon_size,
        // Invariant #5 across devices: without the seed a cloned lineup plays
        // in a different order, and a printed guide stops being true.
        shuffleSeed: c.shuffle_seed,
        darkStart: c.dark_start, darkEnd: c.dark_end,
        adsEnabled: !!c.ads_enabled, maxAdsPerBreak: c.max_ads_per_break,
        adTags: c.ad_tags, timingMode: c.timing_mode, adsBetween: c.ads_between,
        cooldownDays: c.cooldown_days, overrunPolicy: c.overrun_policy,
        enabled: !!c.enabled, vibe: parseVibe(c.vibe),
        sources: srcStmt.all(c.id).map((s) => ({
          ratingKey: s.rating_key, sourceType: s.source_type, title: s.title,
        })),
        excludes: exclStmt.all(c.id).map((e) => e.rating_key),
        rules: ruleStmt.all(c.id).map((r) => ({
          name: r.name, kind: r.kind, priority: r.priority, enabled: !!r.enabled,
          daysOfWeek: r.days_of_week, startTime: r.start_time, durationMin: r.duration_min,
          startsAtUtc: r.starts_at_utc, sourceType: r.source_type, ratingKey: r.rating_key,
          orderingMode: r.ordering_mode, effectiveFrom: r.effective_from,
          effectiveTo: r.effective_to, adPolicy: r.ad_policy, airdateMode: r.airdate_mode,
          cadenceCompress: r.cadence_compress,
        })),
      })),
      settings: {
        kidsMode: !!getSetting('kids_mode', 0),
        kidsSafeChannels: getSetting('kids_safe_channels', []),
        mediaBackend: activeBackend(),
        loudnessTarget: getSetting('loudness_target', -23),
        timezone: getSetting('timezone', null),
      },
    };
  });

  fastify.post('/api/config/import', async (req, reply) => {
    let cfg = req.body;
    if (!cfg || !Array.isArray(cfg.channels)) {
      return reply.code(400).send({ error: 'Not a dumbTV config file' });
    }
    // A v2 backup still restores; only v3 is written.
    if (cfg.version === 2 || cfg.sources !== undefined) cfg = upgradeV2(cfg);
    if (cfg.version !== CONFIG_VERSION) {
      return reply.code(400).send({ error: `Unsupported config version ${cfg.version}` });
    }

    const insChannel = (ch) => {
      const picked = pickChannel(ch);
      const cols = Object.keys(picked).map((f) => CHANNEL_COLUMNS[f]);
      // Every column name comes from the whitelist above, never from the file.
      return db.prepare(
        `INSERT INTO channels (${cols.join(',')}, created_at)
         VALUES (${cols.map(() => '?').join(',')}, ?)`
      ).run(...Object.keys(picked).map((f) => picked[f]), Date.now()).lastInsertRowid;
    };
    const insRule = (channelId, r) => {
      const picked = pickRule(r);
      const cols = Object.keys(picked).map((f) => RULE_COLUMNS[f]);
      db.prepare(
        `INSERT INTO schedule_rules (channel_id${cols.length ? ',' + cols.join(',') : ''})
         VALUES (?${cols.map(() => ',?').join('')})`
      ).run(channelId, ...Object.keys(picked).map((f) => picked[f]));
    };
    const insSource = db.prepare(
      'INSERT OR IGNORE INTO channel_sources (channel_id, rating_key, source_type, title) VALUES (?,?,?,?)'
    );
    const insExclude = db.prepare(
      'INSERT OR IGNORE INTO channel_excludes (channel_id, rating_key) VALUES (?,?)'
    );

    let imported = 0;
    let skippedLocked = 0;
    const run = db.transaction(() => {
      // Replace the user's lineup, but NOT the device's own system channels —
      // the API returns 403 on deleting one, so an import must not do it either.
      db.prepare('DELETE FROM channels WHERE locked = 0').run(); // cascades sources/rules/excludes/programs
      const taken = new Set(db.prepare('SELECT number FROM channels').all().map((r) => r.number));
      let nextFree = Math.max(1, ...taken, 0);

      for (const ch of cfg.channels) {
        // Devices own their system channels; a file never carries one in.
        if (ch.locked) { skippedLocked++; continue; }
        // A surviving locked channel may sit on the incoming number.
        if (ch.number == null || taken.has(ch.number)) ch.number = ++nextFree;
        taken.add(ch.number);

        const id = insChannel(ch);
        for (const s of ch.sources || []) {
          const p = pickSource(s);
          if (p.ratingKey) insSource.run(id, String(p.ratingKey), p.sourceType ?? null, p.title ?? null);
        }
        for (const k of ch.excludes || []) insExclude.run(id, String(k));
        for (const r of ch.rules || []) insRule(id, r);
        imported++;
      }

      const s = cfg.settings || {};
      if (s.kidsMode !== undefined) setSetting('kids_mode', s.kidsMode ? 1 : 0);
      if (Array.isArray(s.kidsSafeChannels)) setSetting('kids_safe_channels', s.kidsSafeChannels);
      if (s.loudnessTarget !== undefined) setSetting('loudness_target', Number(s.loudnessTarget));
      if (s.timezone !== undefined) setSetting('timezone', s.timezone || null);
      // The backend CHOICE travels; its credentials do not, so the new device
      // asks for its own login rather than inheriting one it cannot use.
      if (s.mediaBackend === 'plex' || s.mediaBackend === 'jellyfin') {
        setSetting('media_backend', s.mediaBackend);
      }
    });
    run();
    // Schedules are never carried — they are re-derived from this device's
    // clock. Invariant #4 holds: regeneration only deletes start_utc >= now.
    ensureSchedule();
    return { ok: true, channels: imported, skippedLocked };
  });

  // ---- LLM assist (optional, proposes only — a human applies) ------------

  fastify.get('/api/llm/status', async () => {
    const c = llmConfig();
    return { configured: llmConfigured(), model: llmConfigured() ? c.model : null };
  });

  fastify.post('/api/llm/settings', async (req) => {
    const b = req.body || {};
    if (b.url !== undefined) setSetting('llm_url', (b.url || '').trim() || null);
    if (b.model !== undefined) setSetting('llm_model', (b.model || '').trim() || null);
    if (b.key !== undefined) setSetting('llm_key', b.key || null);
    return { ok: true, configured: llmConfigured() };
  });

  // Propose a themed channel from the library + a natural-language brief. Returns
  // a proposal only; the client shows it and the user applies it with the normal
  // create-channel + add-sources endpoints. Never mutates anything here.
  fastify.post('/api/llm/suggest-channel', async (req, reply) => {
    if (!llmConfigured()) return reply.code(400).send({ error: 'No LLM configured.' });
    const brief = String(req.body?.prompt || '').slice(0, 500);
    if (!brief) return reply.code(400).send({ error: 'Describe the channel you want.' });

    // Gather the library (shows + movies) with rating keys, capped for the prompt.
    let items = [];
    try {
      for (const sec of await getSections()) {
        const type = sec.type === 'movie' ? 'movie' : 'show';
        for (const it of await getSectionItems(sec.key, type)) {
          items.push({ ratingKey: String(it.ratingKey), title: it.title, type });
          if (items.length >= 400) break;
        }
        if (items.length >= 400) break;
      }
    } catch (err) {
      return reply.code(502).send({ error: `Could not read the library: ${err.message}` });
    }
    if (items.length === 0) return reply.code(400).send({ error: 'No library items to choose from.' });

    const modes = ORDERING_MODES.map((m) => m.id).join(', ');
    const system =
      `You program a retro cable channel from a media library. Reply ONLY with a JSON object: ` +
      `{"name": string, "orderingMode": one of [${modes}], "ratingKeys": string[]}. ` +
      `Pick ONLY ratingKeys that appear in the provided library. Choose items that fit the theme; ` +
      `4–20 is a good channel. name is short and broadcast-style.`;
    const user =
      `Brief: ${brief}\n\nLibrary (JSON):\n${JSON.stringify(items)}`;

    let out;
    try {
      out = await completeJSON(system, user);
    } catch (err) {
      return reply.code(502).send({ error: err.message });
    }

    // Validate & sanitise: keep only real rating keys; clamp the ordering mode.
    const byKey = new Map(items.map((i) => [i.ratingKey, i]));
    const chosen = (Array.isArray(out.ratingKeys) ? out.ratingKeys : [])
      .map(String)
      .filter((k) => byKey.has(k))
      .map((k) => byKey.get(k));
    const orderingMode = ORDERING_MODES.some((m) => m.id === out.orderingMode) ? out.orderingMode : 'sequential';
    if (chosen.length === 0) {
      return reply.code(422).send({ error: 'The model did not pick anything from your library. Try rephrasing.' });
    }
    const nextNumber = (db.prepare('SELECT MAX(number) m FROM channels').get().m || 1) + 1;
    return {
      proposal: {
        name: (out.name && String(out.name).slice(0, 60)) || 'New Channel',
        number: nextNumber,
        orderingMode,
        sources: chosen.map((c) => ({ ratingKey: c.ratingKey, title: c.title, sourceType: c.type })),
      },
    };
  });

  fastify.get('/api/guide', async (req) => {
    const from = req.query.from ? Number(req.query.from) : Date.now();
    const hours = req.query.hours ? Number(req.query.hours) : 3;
    return guide(from, hours);
  });

  // A channel's real program blocks over a day range, for the calendar view.
  // Unlike /api/guide this does not collapse to slot boundaries — it returns the
  // actual episodes/movies/off-air as they air.
  fastify.get('/api/schedule/calendar', async (req) => {
    const channelId = Number(req.query.channel);
    const from = req.query.from ? Number(req.query.from) : Date.now();
    const days = Math.max(1, Math.min(14, Number(req.query.days || 7)));
    const to = from + days * 24 * HOUR;
    const rows = db
      .prepare(
        `SELECT start_utc, end_utc, kind, title, subtitle, season_no, episode_no, rating_key, airing_no
         FROM programs
         WHERE channel_id = ? AND end_utc > ? AND start_utc < ?
           AND kind IN ('episode','movie','offair')
         ORDER BY start_utc`
      )
      .all(channelId, from, to);
    return {
      from,
      to,
      programs: rows.map((r) => ({
        startUtc: r.start_utc,
        endUtc: r.end_utc,
        kind: r.kind,
        title: r.title,
        subtitle: r.subtitle,
        seasonNo: r.season_no,
        episodeNo: r.episode_no,
        ratingKey: r.rating_key,
        isPremiere: r.airing_no === 1,
      })),
    };
  });

  fastify.get('/api/onair', async () => ({ at: Date.now(), channels: nowOnAll() }));

  // "next" means the next SHOW everywhere it is spoken on screen — ad pods and
  // bumpers are skipped (POLISH-1).
  fastify.get('/api/channels/:id/upnext', async (req) => ({
    now: nowOn(Number(req.params.id)),
    next: upNextShow(Number(req.params.id), Number(req.query.count || 5)),
  }));

  // ---- Player ------------------------------------------------------------

  fastify.get('/api/player', async () => engine.snapshot());

  fastify.post('/api/player/tune', async (req, reply) => {
    const { channelId, number } = req.body || {};
    try {
      if (number != null) {
        const res = await engine.tuneByNumber(Number(number));
        if (!res) return reply.code(404).send({ error: 'No channel on that number' });
        return res;
      }
      return await engine.tune(Number(channelId));
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
  });

  fastify.post('/api/player/surf', async (req) =>
    engine.surf(req.body && req.body.direction < 0 ? -1 : 1)
  );

  fastify.post('/api/player/digit', async (req) => ({
    digits: engine.pressDigit(String(req.body.digit)),
  }));

  fastify.post('/api/player/banner', async () => engine.showBanner());

  // The phone remote's GUIDE key (R9). Same guide the mpv window toggles.
  fastify.post('/api/player/guide', async () => engine.toggleGuide());

  // ---- Local media -------------------------------------------------------

  /**
   * Streams a file from disk with Range support, which the browser needs in
   * order to join a program already in progress. Only paths that are already
   * in the database can be served.
   */
  fastify.get('/api/local', async (req, reply) => {
    const p = req.query.p;
    if (!p) return reply.code(400).send({ error: 'Missing path' });

    // Authorize: a hand-dropped local file, OR a file inside a registered
    // content pack's root (Track I). path.resolve collapses any ".." so a
    // request can't escape a pack root — same "DB-known locations only" rule.
    // path.resolve collapses ".." but does NOT follow symlinks, so a link
    // planted inside a pack root used to pass this check and then be streamed
    // (S-8). Compare REAL paths on both sides.
    const realPath = (f) => { try { return fs.realpathSync(f); } catch { return path.resolve(f); } };
    const resolved = realPath(p);
    const underPackRoot = db
      .prepare('SELECT root_path FROM packs')
      .all()
      .some((r) => resolved.startsWith(realPath(r.root_path) + path.sep));
    const known =
      db.prepare('SELECT 1 FROM assets WHERE path = ?').get(p) ||
      db.prepare('SELECT 1 FROM media WHERE part_key = ?').get(`local:${p}`) ||
      underPackRoot;
    if (!known) return reply.code(403).send({ error: 'That file is not part of the library' });

    let stat;
    try {
      stat = fs.statSync(p);
    } catch {
      return reply.code(404).send({ error: 'File is missing from disk' });
    }

    const type = MIME[path.extname(p).toLowerCase()] || 'video/mp4';
    const range = req.headers.range;

    if (!range) {
      reply.header('Content-Length', stat.size);
      reply.header('Accept-Ranges', 'bytes');
      reply.type(type);
      return reply.send(fs.createReadStream(p));
    }

    const m = /bytes=(\d*)-(\d*)/.exec(range);
    const start = m && m[1] ? Number(m[1]) : 0;
    const end = m && m[2] ? Number(m[2]) : stat.size - 1;
    if (start >= stat.size) {
      reply.header('Content-Range', `bytes */${stat.size}`);
      return reply.code(416).send();
    }

    reply.code(206);
    reply.header('Content-Range', `bytes ${start}-${end}/${stat.size}`);
    reply.header('Accept-Ranges', 'bytes');
    reply.header('Content-Length', end - start + 1);
    reply.type(type);
    return reply.send(fs.createReadStream(p, { start, end }));
  });

  // ---- Assets ------------------------------------------------------------

  fastify.get('/api/assets', async () => ({
    assets: db.prepare('SELECT * FROM assets ORDER BY kind, title').all(),
  }));

  fastify.post('/api/assets/scan', async () => scanAssets());

  // Pull a Plex library of commercials into the ad pool. The section id is
  // remembered so /refresh-plex can re-pull when new spots are added in Plex.
  fastify.post('/api/assets/import-plex', async (req, reply) => {
    const sectionKey = req.body && req.body.sectionKey;
    if (!sectionKey) return reply.code(400).send({ error: 'sectionKey is required' });
    const res = await importAds(String(sectionKey));
    const saved = new Set(getSetting('ad_plex_sections', []));
    saved.add(String(sectionKey));
    setSetting('ad_plex_sections', [...saved]);
    return { ok: true, ...res };
  });

  fastify.post('/api/assets/refresh-plex', async () => {
    const sections = getSetting('ad_plex_sections', []);
    const results = [];
    for (const key of sections) {
      try {
        results.push({ sectionKey: key, ...(await importAds(String(key))) });
      } catch (err) {
        results.push({ sectionKey: key, error: err.message });
      }
    }
    return { ok: true, sections, results };
  });

  fastify.delete('/api/assets/:id', async (req) => {
    db.prepare('DELETE FROM assets WHERE id = ?').run(req.params.id);
    return { ok: true };
  });

  fastify.patch('/api/assets/:id', async (req) => {
    const b = req.body || {};
    if (b.tags !== undefined) {
      db.prepare('UPDATE assets SET tags = ? WHERE id = ?').run(b.tags, req.params.id);
    }
    if (b.kind !== undefined) {
      db.prepare('UPDATE assets SET kind = ? WHERE id = ?').run(b.kind, req.params.id);
    }
    return { ok: true };
  });

  // ---- DVR ---------------------------------------------------------------

  fastify.get('/api/dvr', async () => ({
    slots: db.prepare('SELECT * FROM dvr ORDER BY recorded_at DESC').all(),
    limit: getSetting('dvr_slots', 6),
  }));

  fastify.post('/api/dvr', async (req, reply) => {
    const p = nowOn(Number(req.body.channelId));
    if (!p || !p.ratingKey) {
      return reply.code(400).send({ error: 'Nothing recordable is on right now' });
    }
    const limit = getSetting('dvr_slots', 6);
    const count = db.prepare('SELECT COUNT(*) n FROM dvr').get().n;
    if (count >= limit) {
      db.prepare(
        'DELETE FROM dvr WHERE id = (SELECT id FROM dvr ORDER BY recorded_at ASC LIMIT 1)'
      ).run();
    }
    db.prepare(
      `INSERT INTO dvr (rating_key, title, subtitle, duration_ms, recorded_at)
       VALUES (?,?,?,?,?)`
    ).run(p.ratingKey, p.title, p.subtitle, p.durationMs, Date.now());
    return { ok: true, recorded: p.title };
  });

  fastify.delete('/api/dvr/:id', async (req) => {
    db.prepare('DELETE FROM dvr WHERE id = ?').run(req.params.id);
    return { ok: true };
  });

  // ---- Settings ----------------------------------------------------------

  fastify.get('/api/settings', async () => ({
    dvrSlots: getSetting('dvr_slots', 6),
    sleepStart: getSetting('sleep_start', null),
    sleepEnd: getSetting('sleep_end', null),
    timezone: getSetting('timezone', null),
    activeTimezone: process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone,
    loudnessTarget: getSetting('loudness_target', -23),
    // Display: 'fit' letterboxes to keep the whole picture; 'fill' crops to fill
    // the screen (right for a 4:3 set where letterbox bars waste the tube).
    displayFill: getSetting('display_fill', 'fit'),
    // L-V1: the look every channel inherits unless it sets its own.
    vibeDefault: getSetting('vibe_default', null),
    vibePresets: VIBE_PRESETS,
    captions: getSetting('captions', 0) ? 1 : 0,
  }));

  fastify.post('/api/settings', async (req) => {
    const b = req.body || {};
    if (b.dvrSlots !== undefined) setSetting('dvr_slots', Number(b.dvrSlots));
    if (b.sleepStart !== undefined) setSetting('sleep_start', b.sleepStart || null);
    if (b.sleepEnd !== undefined) setSetting('sleep_end', b.sleepEnd || null);
    if (b.loudnessTarget !== undefined) setSetting('loudness_target', Number(b.loudnessTarget));
    if (b.displayFill !== undefined) setSetting('display_fill', b.displayFill === 'fill' ? 'fill' : 'fit');
    if (b.vibeDefault !== undefined) {
      setSetting('vibe_default', b.vibeDefault ? normalizeVibe(b.vibeDefault) : null);
    }
    if (b.captions !== undefined) setSetting('captions', b.captions ? 1 : 0);
    if (b.timezone !== undefined) {
      const tz = (b.timezone || '').trim();
      const before = process.env.TZ;
      // Validate the IANA zone before storing.
      try {
        if (tz) Intl.DateTimeFormat('en', { timeZone: tz });
        setSetting('timezone', tz || null);
        if (tz) process.env.TZ = tz;
      } catch {
        return { ok: false, error: 'Unknown timezone' };
      }
      // Slot alignment is anchored to LOCAL midnight, so every program already
      // generated is aligned to the OLD one. Nothing else triggers a rebuild,
      // so the schedule would sit silently on the wrong grid until some
      // unrelated edit fixed it (D-4). Invariant #4 holds — regeneration only
      // deletes start_utc >= now, so whatever is airing finishes as scheduled.
      if (tz && tz !== before) {
        for (const { id } of db.prepare('SELECT id FROM channels').all()) {
          try { regenerateChannel(id); } catch { /* one bad channel must not fail the setting */ }
        }
      }
    }
    return { ok: true };
  });

  // The AI lineup builder used to live here as seven routes. It now runs in
  // the config UI itself (public/lineup/), against endpoints this file and
  // ConfigAPI have both served for months — which is the only reason it works
  // on an Apple TV. A server-side builder meant a second implementation in
  // Swift that would always have been behind this one.


}

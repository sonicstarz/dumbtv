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
import { packsOverview, startInstall, createChannelFromPack, uninstallPack } from '../packs/install.js';
import { scanLocalFolder, previewLocalFolder, createChannelFromLocalFolder } from '../media/localscan.js';
import {
  isConfigured, setPin, verifyPin, clearPin, tokenValid, cookieToken, sessionCookieHeader,
} from '../auth.js';
import { guide, nowOnAll, nowOn, upNext, publicChannel } from '../schedule/resolver.js';
import { ORDERING_MODES } from '../schedule/ordering.js';
import { scanAssets } from '../assets.js';
import { buildSchedulePdf } from '../print.js';
import { engine } from '../player/engine.js';
import { HOUR } from '../util/time.js';

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
      `SELECT rating_key, title, show_title, season_no, episode_no, aired, duration_ms, thumb
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
      episodes: rows.map((r) => ({
        ratingKey: r.rating_key,
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

  // ---- Channels ----------------------------------------------------------

  fastify.get('/api/channels', async () => {
    const rows = db.prepare('SELECT * FROM channels ORDER BY number').all();
    const srcStmt = db.prepare('SELECT * FROM channel_sources WHERE channel_id = ? ORDER BY id');
    const countStmt = db.prepare(
      `SELECT COUNT(*) n FROM media WHERE parent_key = ? OR rating_key = ?`
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
    const maxNo = db.prepare('SELECT MAX(number) m FROM channels').get().m || 1;
    const info = db
      .prepare(
        `INSERT INTO channels
          (number, name, slot_minutes, ordering_mode, marathon_size,
           shuffle_seed, dark_start, dark_end, ads_enabled, max_ads_per_break,
           ad_tags, enabled, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?)`
      )
      .run(
        b.number ?? maxNo + 1,
        b.name || 'New Channel',
        b.slotMinutes ?? 30,
        b.orderingMode || 'sequential',
        b.marathonSize ?? 3,
        Math.floor(Math.random() * 2 ** 31),
        b.darkStart || null,
        b.darkEnd || null,
        b.adsEnabled === false ? 0 : 1,
        b.maxAdsPerBreak ?? 10,
        b.adTags || '',
        Date.now()
      );
    return { id: info.lastInsertRowid };
  });

  fastify.patch('/api/channels/:id', async (req) => {
    const b = req.body || {};
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

  fastify.delete('/api/channels/:id', async (req) => {
    db.prepare('DELETE FROM channels WHERE id = ?').run(req.params.id);
    return { ok: true };
  });

  // ── content packs (Track I) ────────────────────────────────────────────────
  // Curated public-domain channel packs. GET lists the catalog merged with
  // what's installed; install downloads from the Internet Archive; channel
  // spins one up in a tap; DELETE removes it (aired programs survive).
  fastify.get('/api/packs', async () => ({ packs: packsOverview() }));

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

  fastify.delete('/api/channels/:id/sources/:sourceId', async (req) => {
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

  // ---- Schedule rules ----------------------------------------------------

  const DEFAULT_PRIORITY = { blackout: 1000, pinned: 800, recurring: 600, airdate: 400, rotation: 0 };
  const RULE_FIELDS = [
    'name', 'kind', 'priority', 'enabled', 'days_of_week', 'start_time', 'duration_min',
    'starts_at_utc', 'source_type', 'rating_key', 'ordering_mode', 'effective_from',
    'effective_to', 'ad_policy', 'airdate_mode', 'cadence_compress',
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
         ad_policy, airdate_mode, cadence_compress)
      VALUES (@channelId,@name,@kind,@priority,1,@daysOfWeek,@startTime,@durationMin,
              @startsAtUtc,@sourceType,@ratingKey,@orderingMode,@effectiveFrom,@effectiveTo,
              @adPolicy,@airdateMode,@cadenceCompress)
    `).run({
      channelId: Number(req.params.id), name: b.name || null, kind: b.kind, priority,
      daysOfWeek: b.daysOfWeek || null, startTime: b.startTime || null, durationMin: b.durationMin ?? null,
      startsAtUtc: b.startsAtUtc ?? null, sourceType: b.sourceType || null, ratingKey: b.ratingKey || null,
      orderingMode: b.orderingMode || null, effectiveFrom: b.effectiveFrom || null,
      effectiveTo: b.effectiveTo || null, adPolicy: b.adPolicy ? JSON.stringify(b.adPolicy) : null,
      airdateMode: b.airdateMode || null, cadenceCompress: b.cadenceCompress ?? 1,
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
  // the Pi. No secrets (token, PIN) are included.
  fastify.get('/api/config/export', async () => ({
    version: 2,
    exportedAt: Date.now(),
    channels: db.prepare('SELECT * FROM channels ORDER BY number').all(),
    sources: db.prepare('SELECT * FROM channel_sources').all(),
    rules: db.prepare('SELECT * FROM schedule_rules').all(),
    excludes: db.prepare('SELECT * FROM channel_excludes').all(),
  }));

  fastify.post('/api/config/import', async (req, reply) => {
    const cfg = req.body;
    if (!cfg || !Array.isArray(cfg.channels)) {
      return reply.code(400).send({ error: 'Not a dumbTV config file' });
    }
    const insertRow = (table, obj, remap = {}) => {
      const row = { ...obj, ...remap };
      const cols = Object.keys(row).filter((k) => k !== 'id');
      return db.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
        .run(...cols.map((c) => row[c]));
    };
    const run = db.transaction(() => {
      db.prepare('DELETE FROM channels').run(); // cascades sources, rules, programs
      const idMap = {};
      for (const c of cfg.channels) idMap[c.id] = insertRow('channels', c).lastInsertRowid;
      for (const s of cfg.sources || []) {
        if (idMap[s.channel_id]) insertRow('channel_sources', s, { channel_id: idMap[s.channel_id] });
      }
      for (const r of cfg.rules || []) {
        if (idMap[r.channel_id]) insertRow('schedule_rules', r, { channel_id: idMap[r.channel_id] });
      }
      for (const e of cfg.excludes || []) {
        if (idMap[e.channel_id]) insertRow('channel_excludes', e, { channel_id: idMap[e.channel_id] });
      }
    });
    run();
    ensureSchedule();
    return { ok: true, channels: cfg.channels.length, rules: (cfg.rules || []).length };
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

  fastify.get('/api/channels/:id/upnext', async (req) => ({
    now: nowOn(Number(req.params.id)),
    next: upNext(Number(req.params.id), Number(req.query.count || 5)),
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
    const resolved = path.resolve(p);
    const underPackRoot = db
      .prepare('SELECT root_path FROM packs')
      .all()
      .some((r) => resolved.startsWith(path.resolve(r.root_path) + path.sep));
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
    captions: getSetting('captions', 0) ? 1 : 0,
  }));

  fastify.post('/api/settings', async (req) => {
    const b = req.body || {};
    if (b.dvrSlots !== undefined) setSetting('dvr_slots', Number(b.dvrSlots));
    if (b.sleepStart !== undefined) setSetting('sleep_start', b.sleepStart || null);
    if (b.sleepEnd !== undefined) setSetting('sleep_end', b.sleepEnd || null);
    if (b.loudnessTarget !== undefined) setSetting('loudness_target', Number(b.loudnessTarget));
    if (b.displayFill !== undefined) setSetting('display_fill', b.displayFill === 'fill' ? 'fill' : 'fit');
    if (b.captions !== undefined) setSetting('captions', b.captions ? 1 : 0);
    if (b.timezone !== undefined) {
      const tz = (b.timezone || '').trim();
      // Validate the IANA zone before storing.
      try {
        if (tz) Intl.DateTimeFormat('en', { timeZone: tz });
        setSetting('timezone', tz || null);
        if (tz) process.env.TZ = tz;
      } catch {
        return { ok: false, error: 'Unknown timezone' };
      }
    }
    return { ok: true };
  });
}

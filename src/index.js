import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import os from 'node:os';
import fs from 'node:fs';
import { config } from './config.js';
import { db, getSetting } from './db.js';
import api from './routes/api.js';
import { ensureSchedule } from './schedule/generator.js';
import { engine } from './player/engine.js';
import { initFromEnv } from './auth.js';
import { migratePreloadAdsOff, reconcileMissingPacks } from './packs/install.js';
import { HOUR } from './util/time.js';

const app = Fastify({ logger: false });

app.register(fastifyStatic, { root: config.publicDir });
app.register(api);

app.get('/', (req, reply) => reply.sendFile('index.html'));
app.get('/tv', (req, reply) => reply.sendFile('tv.html'));

app.setErrorHandler((err, req, reply) => {
  reply.code(err.statusCode || 500).send({ error: err.message });
});

function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal) return i.address;
    }
  }
  return 'localhost';
}

/**
 * The address to PRINT on startup. Inside a container the only non-internal
 * interface is the docker bridge (172.x), which is useless to the person
 * reading the log — they reach us through a published port on the host, and we
 * have no way to know the host's address or which port it mapped. So say
 * localhost, which is right for the common case, and let anyone running on a
 * remote box override it.
 */
function publicBaseUrl() {
  if (process.env.DUMBTV_PUBLIC_URL) return process.env.DUMBTV_PUBLIC_URL.replace(/\/+$/, '');
  const containerised = fs.existsSync('/.dockerenv') || process.env.DUMBTV_IN_CONTAINER === '1';
  return `http://${containerised ? 'localhost' : lanAddress()}:${config.port}`;
}

async function main() {
  // Honor a configured IANA timezone (a headless Pi often boots on UTC). Set
  // before any scheduling, which is anchored to local midnight.
  const tz = getSetting('timezone', null);
  if (tz) process.env.TZ = tz;
  initFromEnv();
  // Build 13: pack channels ship without commercials. Repair anything seeded
  // by an earlier build before the schedule is topped up.
  const adsOff = migratePreloadAdsOff();
  if (adsOff.length) console.log(`  Turned commercials off on ${adsOff.length} pack channel(s).`);
  // A pack whose files went away (uninstalled by hand, or dropped from a release)
  // becomes downloadable again rather than a channel that silently plays nothing.
  const gone = reconcileMissingPacks();
  if (gone.length) console.log(`  Pack files missing, now re-downloadable: ${gone.join(', ')}`);
  ensureSchedule();

  // Keep the rolling window topped up. Append-only, so nothing already
  // published to a printed guide can move.
  setInterval(() => {
    try {
      ensureSchedule();
    } catch (err) {
      console.error('Schedule top-up failed:', err.message);
    }
  }, HOUR);

  // Bind the port FIRST. If another dumbTV is already running, fail here —
  // before opening an mpv window that would be orphaned by the crash.
  await app.listen({ port: config.port, host: config.host });

  engine.on('log', (m) => console.log(`  [player] ${m}`));
  engine.on('error', (err) => console.error(`  [player] ${err.message}`));
  await engine.start();

  const url = publicBaseUrl();
  const channels = db.prepare('SELECT COUNT(*) n FROM channels').get().n;

  console.log('');
  console.log('  ██████ dumbTV');
  console.log('  ────────────────────────────────────────────');
  console.log(`  Set up channels   ${url}`);
  console.log(`  Watch in browser  ${url}/tv`);
  console.log(`  Player            ${engine.driver === 'mpv' ? 'mpv window' : 'browser only'}`);
  if (engine.lastError) console.log(`  Note              ${engine.lastError}`);
  console.log(`  Channels          ${channels}`);
  console.log('  ────────────────────────────────────────────');
  if (channels === 0) {
    console.log('  Open the setup page to link Plex and build your first channel.');
    console.log('');
  }
}

async function shutdown() {
  await engine.stop().catch(() => {});
  await app.close().catch(() => {});
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main().catch((err) => {
  console.error('dumbTV could not start:', err);
  process.exit(1);
});

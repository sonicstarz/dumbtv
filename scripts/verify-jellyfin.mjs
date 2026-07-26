/**
 * Live verification of the Node Jellyfin client against a REAL server.
 *
 * This is what closed out P7 ("written from the API shape, never executed
 * against a real server") in build 13, verified against Jellyfin 10.11.11.
 * Keep it runnable: the Jellyfin API moves, and this is the only thing that
 * tells us when it has. It calls the real client functions — no mocks — and
 * checks the things dumbTV actually depends on: the auth header shape, library
 * browse, /Shows/:id/Episodes, durations, and that the ?static=true stream URL
 * serves real bytes and honours Range requests (join-in-progress).
 *
 * Needs a server. The cheapest one is the official portable macOS build:
 *
 *   curl -LO https://repo.jellyfin.org/files/server/macos/latest-stable/arm64/jellyfin_<ver>-arm64.dmg
 *   hdiutil attach jellyfin_<ver>-arm64.dmg && cp -R "/Volumes/Jellyfin Server/Jellyfin.app" .
 *   ./Jellyfin.app/Contents/MacOS/jellyfin --datadir ./data --cachedir ./cache \
 *      --configdir ./config --nowebclient
 *
 * (Use the .dmg, not the .tar.xz — the tarball's binary is unsigned and macOS
 * SIGKILLs unsigned arm64 executables. Complete the wizard via /Startup/*, add a
 * library via /Library/VirtualFolders.)
 *
 *   node scripts/verify-jellyfin.mjs <url> <user> <pass>
 */

import path from 'node:path';
import os from 'node:os';

const [url, user, pass] = process.argv.slice(2);
process.env.DUMBTV_DB = process.env.DUMBTV_DB
  || path.join(os.tmpdir(), `dumbtv-jfverify-${Date.now()}.db`);

const auth = await import('../src/jellyfin/auth.js');
const jf = await import('../src/jellyfin/client.js');
const { db } = await import('../src/db.js');

let pass_ = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) { pass_++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label} ${detail}`); }
};

console.log('\nAuth');
let server;
try {
  server = await auth.authenticate(url, user, pass);
  ok('AuthenticateByName returns a token + user id', !!(server.token && server.userId),
     JSON.stringify(server));
} catch (e) { ok('AuthenticateByName', false, e.message); process.exit(1); }
ok('jfConfigured() is true after login', auth.jfConfigured());
ok('ping() reaches the server', await jf.ping());

console.log('\nLibrary browse');
const sections = await jf.getSections();
console.log('       sections:', JSON.stringify(sections));
ok('getSections maps Views to show/movie types',
   sections.some((s) => s.type === 'show') && sections.some((s) => s.type === 'movie'));

const tv = sections.find((s) => s.type === 'show');
const movies = sections.find((s) => s.type === 'movie');

const shows = await jf.getSectionItems(tv.key, 'show');
console.log('       shows:', JSON.stringify(shows));
ok('getSectionItems lists series', shows.length >= 1);
ok('series carry a leafCount (episode count)',
   shows.every((s) => Number.isFinite(s.leafCount) && s.leafCount > 0),
   JSON.stringify(shows.map((s) => s.leafCount)));

const films = await jf.getSectionItems(movies.key, 'movie');
console.log('       movies:', JSON.stringify(films));
ok('getSectionItems lists movies', films.length >= 1);
ok('movies carry a duration', films.every((m) => m.duration > 0),
   JSON.stringify(films.map((m) => m.duration)));

console.log('\nEpisodes');
const eps = await jf.getAllEpisodes(shows[0].ratingKey);
console.log('       episodes:', JSON.stringify(eps, null, 0));
ok('/Shows/:id/Episodes returns episodes', eps.length >= 1);
ok('episodes carry S/E numbers', eps.every((e) => e.seasonNo != null && e.episodeNo != null),
   JSON.stringify(eps.map((e) => [e.seasonNo, e.episodeNo])));
ok('episodes carry a duration in ms', eps.every((e) => e.durationMs > 0),
   JSON.stringify(eps.map((e) => e.durationMs)));
ok('episodes carry jf: part keys', eps.every((e) => e.partKey.startsWith('jf:')));
ok('episodes carry the show title', eps.every((e) => !!e.showTitle),
   JSON.stringify(eps.map((e) => e.showTitle)));

console.log('\nMovie lookup');
const movie = await jf.getMovie(films[0].ratingKey);
console.log('       movie:', JSON.stringify(movie));
ok('getMovie returns the item', !!movie && movie.kind === 'movie');
ok('movie has a duration + jf: part key',
   !!movie && movie.durationMs > 0 && movie.partKey.startsWith('jf:'));

console.log('\ncacheSource (media rows)');
const r1 = await jf.cacheSource(shows[0].ratingKey, 'show');
console.log('       show cache:', JSON.stringify(r1));
ok('cacheSource writes episode rows', r1.cached === eps.length, JSON.stringify(r1));
const rows = db.prepare("SELECT * FROM media WHERE part_key LIKE 'jf:%'").all();
ok('media rows landed with jf: part keys', rows.length === eps.length);
const r2 = await jf.cacheSource(films[0].ratingKey, 'movie');
ok('cacheSource writes a movie row', r2.cached === 1, JSON.stringify(r2));

console.log('\nDirect play (invariant #2: never transcode)');
const key = eps[0].partKey;
const su = jf.streamUrl(key);
console.log('       stream url:', su.replace(/api_key=[^&]+/, 'api_key=***'));
ok('stream URL carries ?static=true', su.includes('static=true'));
const head = await fetch(su, { headers: { Range: 'bytes=0-1023' } });
ok('the stream URL actually serves bytes',
   head.status === 200 || head.status === 206, `HTTP ${head.status}`);
console.log('       content-type:', head.headers.get('content-type'),
            '| length:', head.headers.get('content-length'),
            '| accept-ranges:', head.headers.get('accept-ranges'));
ok('server supports range requests (join-in-progress seeks)',
   head.status === 206 || head.headers.get('accept-ranges') === 'bytes',
   `status ${head.status}, accept-ranges ${head.headers.get('accept-ranges')}`);
const buf = await head.arrayBuffer();
ok('range request returned real payload bytes', buf.byteLength > 0, `${buf.byteLength} bytes`);

console.log('\nArtwork');
// An item with no poster 404s on /Images/Primary, so the client must only claim a
// thumb when ImageTags.Primary exists. Test the contract both ways.
const withArt = shows.find((s) => s.thumb);
const withoutArt = shows.find((s) => !s.thumb);
console.log('       with art:', withArt?.title, '| without:', withoutArt?.title);
if (withArt) {
  const img = await fetch(jf.imageUrl(withArt.thumb));
  ok('imageUrl serves an image for an item that HAS artwork',
     img.ok && (img.headers.get('content-type') || '').startsWith('image/'),
     `HTTP ${img.status} ${img.headers.get('content-type')}`);
} else { console.log('  skip  no item in the test library has artwork'); }
if (withoutArt) {
  ok('an item with no artwork reports thumb=null (no doomed image request)',
     withoutArt.thumb === null);
} else { console.log('  skip  every item in the test library has artwork'); }

console.log('\nBackend facade');
const backend = await import('../src/media/backend.js');
const viaFacade = backend.streamUrl(key);
ok('media/backend.js dispatches jf: to the Jellyfin client', viaFacade === su);

console.log(`\n${pass_} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

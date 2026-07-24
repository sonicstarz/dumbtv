/**
 * Checks everything Cathode needs before you waste time debugging.
 *   npm run doctor
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import { config, ROOT } from '../src/config.js';

const run = promisify(execFile);

const results = [];
function ok(name, detail) { results.push({ level: 'ok', name, detail }); }
function warn(name, detail) { results.push({ level: 'warn', name, detail }); }
function bad(name, detail) { results.push({ level: 'bad', name, detail }); }

const major = Number(process.versions.node.split('.')[0]);
if (major >= 20) ok('Node', `v${process.versions.node}`);
else bad('Node', `v${process.versions.node} — Cathode needs 20 or newer`);

try {
  const { stdout } = await run(config.mpvBinary, ['--version']);
  ok('mpv', stdout.split('\n')[0].trim());
} catch {
  warn(
    'mpv',
    'Not found. The browser TV at /tv still works — install mpv when you want a real full-screen player.'
  );
}

try {
  const { stdout } = await run('ffprobe', ['-version']);
  ok('ffprobe', stdout.split('\n')[0].trim());
} catch {
  warn('ffprobe', 'Not found. Commercials cannot be imported without it.');
}

try {
  const { default: Database } = await import('better-sqlite3');
  const test = new Database(':memory:');
  test.exec('CREATE TABLE t (a)');
  test.close();
  ok('SQLite', 'better-sqlite3 loaded');
} catch (err) {
  bad('SQLite', err.message);
}

for (const dir of [config.mediaDir, `${config.mediaDir}/ads`, `${config.mediaDir}/bumpers`]) {
  if (fs.existsSync(dir)) ok('Folder', dir.replace(ROOT, '.'));
  else warn('Folder', `${dir.replace(ROOT, '.')} missing — it will be created on first scan`);
}

try {
  const res = await fetch('https://plex.tv/api/v2/pins', {
    method: 'HEAD',
    signal: AbortSignal.timeout(6000),
  });
  ok('plex.tv', `reachable (${res.status})`);
} catch {
  warn('plex.tv', 'Could not reach it. Linking an account needs internet; playback does not.');
}

const width = Math.max(...results.map((r) => r.name.length));
const mark = { ok: '  ok  ', warn: ' warn ', bad: ' FAIL ' };

console.log('\nCathode environment check\n');
for (const r of results) {
  console.log(`${mark[r.level]} ${r.name.padEnd(width)}  ${r.detail}`);
}

const fails = results.filter((r) => r.level === 'bad').length;
console.log(
  fails === 0
    ? '\nGood to go. Run: npm start\n'
    : `\n${fails} problem(s) will stop Cathode from starting.\n`
);
process.exit(fails ? 1 : 0);

/**
 * Generates a handful of stand-in commercials and station IDs so the ad
 * breaks have something to play before you go find real ones.
 *
 *   node scripts/make-demo-ads.js
 *
 * Needs ffmpeg. Safe to delete the files afterwards.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.js';

const run = promisify(execFile);

const SPOTS = [
  { file: 'ads/demo-cereal-30.mp4', secs: 30, text: 'PART OF A COMPLETE BREAKFAST', colour: '#c0392b' },
  { file: 'ads/demo-toys-30.mp4', secs: 30, text: 'BATTERIES NOT INCLUDED', colour: '#2980b9' },
  { file: 'ads/demo-arcade-15.mp4', secs: 15, text: 'NOW AT YOUR LOCAL ARCADE', colour: '#8e44ad' },
  { file: 'ads/demo-soda-15.mp4', secs: 15, text: 'TASTE THE NINETIES', colour: '#16a085' },
  { file: 'ads/demo-cartoon-60.mp4', secs: 60, text: 'SATURDAY MORNINGS ONLY', colour: '#d35400' },
  { file: 'bumpers/demo-id-05.mp4', secs: 5, text: 'YOU ARE WATCHING DUMBTV', colour: '#1e1d28' },
  { file: 'bumpers/demo-backin-08.mp4', secs: 8, text: 'WE WILL BE RIGHT BACK', colour: '#1e1d28' },
];

function escapeDraw(t) {
  return t.replace(/:/g, '\\:').replace(/'/g, "\u2019");
}

const fontCandidates = [
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
  '/System/Library/Fonts/Helvetica.ttc',
  'C:/Windows/Fonts/arialbd.ttf',
];
const font = fontCandidates.find((f) => fs.existsSync(f));

console.log('\nBuilding demo commercials...\n');

let made = 0;
for (const spot of SPOTS) {
  const out = path.join(config.mediaDir, spot.file);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  if (fs.existsSync(out)) {
    console.log(`  skip   ${spot.file} (already there)`);
    continue;
  }

  const draw =
    `drawtext=text='${escapeDraw(spot.text)}':fontcolor=white:fontsize=48:` +
    `x=(w-text_w)/2:y=(h-text_h)/2` +
    (font ? `:fontfile=${font}` : '');

  const args = [
    '-y',
    '-f', 'lavfi', '-i', `color=c=${spot.colour}:s=640x480:d=${spot.secs}:r=24`,
    '-f', 'lavfi', '-i', `sine=frequency=420:duration=${spot.secs}`,
    '-vf', draw,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest',
    out,
  ];

  try {
    await run('ffmpeg', args);
    console.log(`  built  ${spot.file}  (${spot.secs}s)`);
    made++;
  } catch (err) {
    console.log(`  FAILED ${spot.file}: ${String(err.message).split('\n')[0]}`);
  }
}

console.log(
  `\n${made} file(s) created in ${config.mediaDir}.\n` +
    'Now open dumbTV, go to Commercials, and hit "Scan for new files".\n'
);

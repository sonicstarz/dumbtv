// xmltv.js — publish the schedule as XMLTV (R6).
//
// This is the CHEAP HALF of the competitor category's headline feature. Tunarr,
// ErsatzTV and dizqueTV all spoof an HDHomeRun tuner and serve a continuous
// encoded stream so Plex/Jellyfin/Channels can play their lineups. That half is
// permanent per-channel transcoding and collides head-on with invariant #2, so
// dumbTV does not do it — our answer to "watch it anywhere" is our own apps.
//
// But the GUIDE half costs almost nothing, because the schedule already exists
// as rows in a table. Publishing it buys: listings in third-party clients, an
// easy integration story, and compatibility with the Prevue-guide simulators
// that read XMLTV — which is a pleasing thing for this project in particular.
//
// No dependency: XMLTV is a small, stable format and this is a serialiser, not
// a parser. Invariant #8 stands.

import { db } from './db.js';
import { DAY } from './util/time.js';

/** XMLTV wants `YYYYMMDDHHMMSS +ZZZZ` in LOCAL time with an explicit offset. */
function xmltvTime(ms) {
  const d = new Date(ms);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const off = -d.getTimezoneOffset();          // minutes east of UTC
  const sign = off >= 0 ? '+' : '-';
  const oh = p(Math.floor(Math.abs(off) / 60));
  const om = p(Math.abs(off) % 60);
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
         `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())} ${sign}${oh}${om}`;
}

// Five characters, and every one of them matters in XML.
const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/**
 * The whole lineup as an XMLTV document.
 *
 * Only real programmes are listed — ad pods, bumpers and filler are omitted,
 * for the same reason the on-screen guide omits them: a listings grid never
 * announced the commercial standing between you and the next show. Off-air
 * blocks ARE listed, because "nothing is on" is real information to a guide.
 */
export function buildXmltv({ from = Date.now(), days = 7, baseUrl = '' } = {}) {
  const to = from + Math.max(1, Math.min(14, days)) * DAY;
  const channels = db.prepare(
    'SELECT id, number, name FROM channels WHERE enabled = 1 ORDER BY number'
  ).all();

  const rows = db.prepare(
    `SELECT channel_id, start_utc, end_utc, kind, title, subtitle, season_no, episode_no, airing_no
     FROM programs
     WHERE channel_id IN (SELECT id FROM channels WHERE enabled = 1)
       AND end_utc > ? AND start_utc < ?
       AND kind IN ('episode','movie','offair')
     ORDER BY channel_id, start_utc`
  ).all(from, to);

  const out = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push('<!DOCTYPE tv SYSTEM "xmltv.dtd">');
  out.push('<tv generator-info-name="dumbTV" generator-info-url="https://dumbtv.app">');

  for (const c of channels) {
    const id = `dumbtv.${c.number}`;
    out.push(`  <channel id="${esc(id)}">`);
    // Both spellings: clients variously show the number or the name, and a
    // guide listing "7" with no name is useless.
    out.push(`    <display-name>${esc(c.name)}</display-name>`);
    out.push(`    <display-name>${esc(String(c.number))}</display-name>`);
    out.push(`    <display-name>${esc(`${c.number} ${c.name}`)}</display-name>`);
    if (baseUrl) out.push(`    <url>${esc(`${baseUrl}/tv`)}</url>`);
    out.push('  </channel>');
  }

  const byId = new Map(channels.map((c) => [c.id, c]));
  for (const p of rows) {
    const c = byId.get(p.channel_id);
    if (!c) continue;
    const id = `dumbtv.${c.number}`;
    out.push(`  <programme start="${xmltvTime(p.start_utc)}" stop="${xmltvTime(p.end_utc)}" channel="${esc(id)}">`);
    out.push(`    <title>${esc(p.title)}</title>`);
    if (p.subtitle) out.push(`    <sub-title>${esc(p.subtitle)}</sub-title>`);
    if (p.season_no != null && p.episode_no != null) {
      // xmltv_ns is zero-based, which catches everyone out once.
      out.push(`    <episode-num system="xmltv_ns">${p.season_no - 1}.${p.episode_no - 1}.</episode-num>`);
      out.push(`    <episode-num system="onscreen">S${String(p.season_no).padStart(2, '0')}E${String(p.episode_no).padStart(2, '0')}</episode-num>`);
    }
    if (p.kind === 'offair') out.push('    <category>Off Air</category>');
    // A first airing on this channel is a premiere; anything else is a repeat.
    out.push(`    ${(p.airing_no ?? 1) === 1 ? '<premiere />' : '<previously-shown />'}`);
    out.push('  </programme>');
  }

  out.push('</tv>');
  return out.join('\n');
}

/**
 * Overlays are drawn with ASS markup straight onto mpv's OSD. No browser, no
 * compositor — which is what keeps channel changes instant on a Pi.
 *
 * Everything sits inside an 85% safe area because CRTs hide the edges behind
 * the bezel, and the whole point is that this ends up on a CRT.
 */

const W = 1280;
const H = 720;
const SAFE_X = Math.round(W * 0.075);
const SAFE_Y = Math.round(H * 0.075);
const SAFE_W = W - SAFE_X * 2;

// ASS colours are &HBBGGRR&
const C = {
  amber: '&H1FB4F2&',
  white: '&HE8E8E8&',
  dim: '&HA0A0A0&',
  black: '&H000000&',
  blue: '&H8F3A2B&',
  red: '&H3F48E0&',
  green: '&H81E07E&',
};

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/\\/g, '\\\\')
    .replace(/\{/g, '(')
    .replace(/\}/g, ')')
    .replace(/\r?\n/g, ' ');
}

function box(x, y, w, h, colour, alpha = '&H40&') {
  return (
    `{\\an7\\pos(${x},${y})\\bord0\\shad0\\1c${colour}\\1a${alpha}\\p1}` +
    `m 0 0 l ${w} 0 l ${w} ${h} l 0 ${h}{\\p0}`
  );
}

function text(x, y, str, { size = 34, colour = C.white, bold = 0, align = 7 } = {}) {
  return (
    `{\\an${align}\\pos(${x},${y})\\fs${size}\\b${bold}\\bord2\\shad0` +
    `\\3c${C.black}\\1c${colour}}${esc(str)}`
  );
}

function clock(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function timeRange(startUtc, endUtc) {
  return `${clock(startUtc)} – ${clock(endUtc)}`;
}

/** The banner that appears when you tune in, press Info, or a show starts. */
export function channelBanner({ channel, now, next }) {
  const h = 190;
  const y = H - SAFE_Y - h;
  const lines = [];

  lines.push(box(SAFE_X, y, SAFE_W, h, C.black, '&H30&'));
  lines.push(box(SAFE_X, y, 8, h, C.amber, '&H00&'));

  const padX = SAFE_X + 32;
  lines.push(
    text(padX, y + 22, String(channel.number).padStart(2, '0'), {
      size: 64,
      colour: C.amber,
      bold: 1,
    })
  );
  lines.push(
    text(padX + 110, y + 38, channel.name.toUpperCase(), {
      size: 34,
      colour: C.dim,
      bold: 1,
    })
  );
  lines.push(
    text(SAFE_X + SAFE_W - 32, y + 38, clock(Date.now()), {
      size: 34,
      colour: C.dim,
      align: 9,
    })
  );

  if (now) {
    lines.push(text(padX, y + 92, now.title, { size: 42, bold: 1 }));
    if (now.subtitle) {
      const ep =
        now.seasonNo != null && now.episodeNo != null
          ? `S${String(now.seasonNo).padStart(2, '0')}E${String(now.episodeNo).padStart(2, '0')}  `
          : '';
      lines.push(text(padX, y + 138, `${ep}${now.subtitle}`, { size: 28, colour: C.dim }));
    }
    lines.push(
      text(SAFE_X + SAFE_W - 32, y + 92, timeRange(now.startUtc, now.endUtc), {
        size: 28,
        colour: C.amber,
        align: 9,
      })
    );
    if (next) {
      lines.push(
        text(SAFE_X + SAFE_W - 32, y + 138, `NEXT  ${next.title}`, {
          size: 26,
          colour: C.dim,
          align: 9,
        })
      );
    }
  } else {
    lines.push(text(padX, y + 100, 'Nothing scheduled', { size: 40, bold: 1 }));
  }

  return lines.join('\n');
}

/** Big digits while someone types a channel number. */
export function tuneDigits(digits) {
  return [
    box(W - SAFE_X - 200, SAFE_Y, 200, 110, C.black, '&H30&'),
    text(W - SAFE_X - 100, SAFE_Y + 18, digits.padEnd(2, '-'), {
      size: 76,
      colour: C.amber,
      bold: 1,
      align: 8,
    }),
  ].join('\n');
}

/** Shown during the seconds of a slot that ads did not fill. */
export function fillerCard(channel) {
  return [
    box(0, 0, W, H, C.black, '&H00&'),
    text(W / 2, H / 2 - 60, String(channel.number).padStart(2, '0'), {
      size: 120,
      colour: C.amber,
      bold: 1,
      align: 5,
    }),
    text(W / 2, H / 2 + 40, channel.name.toUpperCase(), {
      size: 44,
      colour: C.white,
      bold: 1,
      align: 5,
    }),
  ].join('\n');
}

/** Colour bars for dark hours. A dead channel should still look like TV. */
export function offAirCard(channel, message) {
  const bars = [C.white, '&H00D1D1&', '&HD1D100&', '&H00D100&', '&HD100D1&', '&H0000D1&', '&HD10000&'];
  const bw = Math.floor(W / bars.length);
  const lines = bars.map((c, i) => box(i * bw, 0, bw, Math.floor(H * 0.72), c, '&H00&'));
  lines.push(box(0, Math.floor(H * 0.72), W, H - Math.floor(H * 0.72), C.black, '&H00&'));
  lines.push(
    text(W / 2, Math.floor(H * 0.78), `${String(channel.number).padStart(2, '0')}  ${channel.name.toUpperCase()}`, {
      size: 44,
      colour: C.amber,
      bold: 1,
      align: 8,
    })
  );
  lines.push(
    text(W / 2, Math.floor(H * 0.86), message || 'Programming resumes shortly', {
      size: 30,
      colour: C.dim,
      align: 8,
    })
  );
  return lines.join('\n');
}

/** SMPTE-style bars for a gap with no ad to fill it. A broadcaster's dead air. */
export function colorBars(channel) {
  const bars = [C.white, '&H00D1D1&', '&HD1D100&', '&H00D100&', '&HD100D1&', '&H0000D1&', '&HD10000&'];
  const bw = Math.floor(W / bars.length);
  const lines = bars.map((c, i) => box(i * bw, 0, bw, Math.floor(H * 0.72), c, '&H00&'));
  lines.push(box(0, Math.floor(H * 0.72), W, H - Math.floor(H * 0.72), C.black, '&H00&'));
  lines.push(
    text(W / 2, Math.floor(H * 0.8), 'PLEASE STAND BY', {
      size: 44,
      colour: C.amber,
      bold: 1,
      align: 8,
    })
  );
  if (channel) {
    lines.push(
      text(W / 2, Math.floor(H * 0.88), `${String(channel.number).padStart(2, '0')}  ${channel.name.toUpperCase()}`, {
        size: 28,
        colour: C.dim,
        align: 8,
      })
    );
  }
  return lines.join('\n');
}

export function troubleCard(message) {
  return [
    box(0, 0, W, H, C.black, '&H00&'),
    text(W / 2, H / 2 - 40, 'ONE MOMENT PLEASE', {
      size: 56,
      colour: C.amber,
      bold: 1,
      align: 5,
    }),
    text(W / 2, H / 2 + 30, message || 'We are experiencing technical difficulties', {
      size: 28,
      colour: C.dim,
      align: 5,
    }),
  ].join('\n');
}

/** Briefly flashed when a blocked key (pause/seek) is pressed. No pausing. */
export function blockedGlyph() {
  return text(W / 2, H / 2, '⊘', {
    size: 160,
    colour: C.white,
    bold: 1,
    align: 5,
  });
}

/** Brief confirmation when captions are toggled from the remote. */
/**
 * A brief centred acknowledgement — CC, MUTE, SLEEP. One helper rather than
 * three, because they are the same gesture: press a button on the remote, see
 * that it registered, get on with watching. `label` overrides the CC wording.
 */
export function captionFlash(on, label) {
  if (label) {
    return text(W / 2, H * 0.16, label, {
      size: 64, colour: on ? C.amber : C.dim, bold: 1, align: 8,
    });
  }
  return text(W / 2, H * 0.16, on ? 'CC  ON' : 'CC  OFF', {
    size: 64,
    colour: on ? C.amber : C.dim,
    bold: 1,
    align: 8,
  });
}

// ---- program guide -------------------------------------------------------

const GUIDE = {
  field: '&H6E2C1F&',      // deep Prevue blue  (#1f2c6e-ish, BGR)
  fieldLo: '&H4A1E14&',    // darker blue for the lower gradient band
  cell: '&H7A3524&',       // slightly lighter blue for program cells
  now: '&H3F48E0&',        // red now-line (#e0483f)
  rowSel: '&H1FB4F2&',     // amber wash for the selected row
};

function trunc(str, max) {
  const s = String(str == null ? '' : str);
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/**
 * The whole program-guide screen as one ASS overlay: a framed hole for the
 * shrunk live video (top-left), an info panel for what you're watching
 * (top-right), and a time-aligned grid below with a live progress bar on each
 * block and a red now-line. Pure presentation — it derives "live" and progress
 * from `now` versus each block's times.
 */
export function guideScreen({ info, rows, selectedIndex, rowOffset, winStart, winSpanMs, now }) {
  const out = [];

  // regions
  const vidX0 = SAFE_X, vidY0 = SAFE_Y, vidX1 = 566, vidY1 = 300;
  const infoX0 = 590, infoY0 = SAFE_Y, infoX1 = W - SAFE_X, infoY1 = 300;
  const gridX0 = SAFE_X, gridY0 = 318, gridX1 = W - SAFE_X, gridY1 = H - SAFE_Y;
  const labelW = 176;                         // channel-label column
  const timeX0 = gridX0 + labelW;
  const timeW = gridX1 - timeX0;
  const t2x = (t) => {
    const x = timeX0 + ((t - winStart) / winSpanMs) * timeW;
    return Math.max(timeX0, Math.min(gridX1, x));
  };

  // ---- video frame (leave the interior transparent for the live picture) ---
  out.push(
    `{\\an7\\pos(${vidX0},${vidY0})\\bord3\\shad0\\1a&HFF&\\3c${C.amber}\\3a&H00&\\p1}` +
    `m 0 0 l ${vidX1 - vidX0} 0 l ${vidX1 - vidX0} ${vidY1 - vidY0} l 0 ${vidY1 - vidY0}{\\p0}`
  );

  // ---- info panel ----------------------------------------------------------
  out.push(box(infoX0, infoY0, infoX1 - infoX0, infoY1 - infoY0, GUIDE.field, '&H14&'));
  out.push(text(infoX0 + 22, infoY0 + 20, 'NOW PLAYING', { size: 22, colour: C.amber, bold: 1, align: 7 }));
  if (info) {
    const chan = `${String(info.number).padStart(2, '0')}  ${(info.name || '').toUpperCase()}`;
    out.push(text(infoX0 + 22, infoY0 + 54, chan, { size: 26, colour: C.white, bold: 1, align: 7 }));
    out.push(text(infoX0 + 22, infoY0 + 96, trunc(info.title, 34), { size: 34, colour: C.white, bold: 1, align: 7 }));
    const ep = info.seasonNo != null && info.episodeNo != null
      ? `S${String(info.seasonNo).padStart(2, '0')}E${String(info.episodeNo).padStart(2, '0')}   ` : '';
    const sub = (ep + (info.subtitle || '')).trim();
    if (sub) out.push(text(infoX0 + 22, infoY0 + 140, trunc(sub, 40), { size: 24, colour: C.dim, align: 7 }));
    // progress bar
    const barX = infoX0 + 22, barY = infoY1 - 54, barW = infoX1 - infoX0 - 44;
    const pct = info.durationMs ? Math.max(0, Math.min(1, info.offsetMs / info.durationMs)) : 0;
    out.push(box(barX, barY, barW, 8, C.white, '&HB0&'));
    out.push(box(barX, barY, Math.max(2, Math.round(barW * pct)), 8, C.amber, '&H00&'));
    out.push(text(barX, barY + 16, `${clock(info.startUtc)} – ${clock(info.endUtc)}`, { size: 22, colour: C.amber, align: 7 }));
    out.push(text(infoX1 - 22, barY + 16, clock(now), { size: 22, colour: C.dim, align: 9 }));
  } else {
    out.push(text(infoX0 + 22, infoY0 + 90, 'Nothing on', { size: 30, colour: C.dim, align: 7 }));
  }

  // ---- grid field ----------------------------------------------------------
  out.push(box(gridX0, gridY0, gridX1 - gridX0, gridY1 - gridY0, GUIDE.field, '&H08&'));
  out.push(box(gridX0, Math.round((gridY0 + gridY1) / 2), gridX1 - gridX0, Math.round((gridY1 - gridY0) / 2), GUIDE.fieldLo, '&H30&'));
  out.push(`{\\an7\\pos(${gridX0},${gridY0})\\bord0\\shad0\\1c${C.amber}\\1a&H00&\\p1}m 0 0 l ${gridX1 - gridX0} 0 l ${gridX1 - gridX0} 3 l 0 3{\\p0}`);

  const headY = gridY0 + 10;
  out.push(text(gridX0 + 16, headY, 'GUIDE', { size: 24, colour: C.amber, bold: 1, align: 7 }));

  // time-tick labels along the top of the time area
  const HALF = 30 * 60 * 1000;
  const firstTick = Math.ceil(winStart / HALF) * HALF;
  for (let t = firstTick; t <= winStart + winSpanMs + 1; t += HALF) {
    const x = t2x(t);
    out.push(text(x + 6, headY, clock(t), { size: 20, colour: C.white, align: 7 }));
    out.push(`{\\an7\\pos(${Math.round(x)},${gridY0 + 42})\\bord0\\shad0\\1c${C.white}\\1a&HC0&\\p1}m 0 0 l 2 0 l 2 ${gridY1 - gridY0 - 42} l 0 ${gridY1 - gridY0 - 42}{\\p0}`);
  }

  // ---- rows ----------------------------------------------------------------
  const rowsTop = gridY0 + 46;
  const VISIBLE = 5;
  const rowH = Math.floor((gridY1 - rowsTop - 6) / VISIBLE);
  const shown = rows.slice(rowOffset, rowOffset + VISIBLE);
  shown.forEach((row, i) => {
    const idx = rowOffset + i;
    const y = rowsTop + i * rowH;
    const selected = idx === selectedIndex;
    if (selected) out.push(box(gridX0, y, gridX1 - gridX0, rowH - 2, GUIDE.rowSel, '&HC8&'));
    else if (i % 2) out.push(box(gridX0, y, gridX1 - gridX0, rowH - 2, C.black, '&HD8&'));

    // channel label
    if (selected) out.push(text(gridX0 + 8, y + rowH / 2 - 2, '▶', { size: 22, colour: C.amber, bold: 1, align: 4 }));
    out.push(text(gridX0 + 34, y + 8, String(row.number).padStart(2, '0'), { size: 26, colour: C.amber, bold: 1, align: 7 }));
    out.push(text(gridX0 + 34, y + 38, trunc(row.name.toUpperCase(), 12), { size: 17, colour: C.white, align: 7 }));

    // program blocks
    for (const p of row.programs || []) {
      if (p.endUtc <= winStart || p.startUtc >= winStart + winSpanMs) continue;
      const x = t2x(p.startUtc);
      const x2 = t2x(p.endUtc);
      const w = Math.max(6, x2 - x);
      const live = p.startUtc <= now && now < p.endUtc;
      out.push(box(x + 2, y + 4, w - 4, rowH - 10, GUIDE.cell, live ? '&H30&' : '&H60&'));
      if (live && p.endUtc > p.startUtc) {
        const fp = Math.max(0, Math.min(1, (now - p.startUtc) / (p.endUtc - p.startUtc)));
        out.push(box(x + 2, y + rowH - 12, Math.max(2, Math.round((w - 4) * fp)), 4, C.amber, '&H00&'));
      }
      const chars = Math.max(3, Math.floor((w - 12) / 9));
      out.push(text(x + 8, y + 8, trunc(p.title, chars), { size: 19, colour: C.white, bold: live ? 1 : 0, align: 7 }));
      if (p.subtitle && rowH > 46) out.push(text(x + 8, y + 32, trunc(p.subtitle, chars), { size: 15, colour: '&HB9C2F0&', align: 7 }));
    }
  });

  // ---- red now-line --------------------------------------------------------
  if (now >= winStart && now <= winStart + winSpanMs) {
    const nx = Math.round(t2x(now));
    const nh = gridY1 - (gridY0 + 40);
    out.push(`{\\an7\\pos(${nx},${gridY0 + 40})\\bord0\\shad0\\1c${GUIDE.now}\\1a&H00&\\p1}m 0 0 l 3 0 l 3 ${nh} l 0 ${nh}{\\p0}`);
  }

  // footer hint
  out.push(text(gridX1 - 16, gridY1 - 24, '↑↓ CHANNEL   ←→ HOURS   ENTER WATCH   1 CLOSE', { size: 18, colour: C.amber, align: 6 }));

  return out.join('\n');
}

export const OVERLAY_IDS = {
  card: 1,
  banner: 2,
  digits: 3,
  blocked: 4,
  guide: 5,
  captions: 6,
};

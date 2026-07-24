/**
 * The browser TV. Same rules as the real thing on the Pi:
 * what's on is what's on, you join it in progress, and you can't pause it.
 */

const $ = (s) => document.querySelector(s);

const video = $('#video');
const state = {
  channels: [],
  channelId: null,
  programId: null,
  program: null,
  guideOpen: false,
  guideIndex: 0,
  digits: '',
  digitTimer: null,
  bannerUntil: 0,
  helpUntil: Date.now() + 9000,
  fill: 'fit',
  captions: false,
};

const clock = (ts) =>
  new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Request failed');
  return res.json();
}

// ------------------------------------------------------------ screens

function show(which, opts = {}) {
  $('#filler').classList.toggle('on', which === 'filler');
  $('#bars').classList.toggle('on', which === 'bars');
  $('#trouble').classList.toggle('on', which === 'trouble');
  video.style.visibility = which === 'video' ? 'visible' : 'hidden';

  if (which === 'filler') {
    $('#fillerNum').textContent = String(opts.number ?? 0).padStart(2, '0');
    $('#fillerName').textContent = (opts.name || '').toUpperCase();
  }
  if (which === 'bars') {
    $('#barsTitle').textContent =
      `${String(opts.number ?? 0).padStart(2, '0')}  ${(opts.name || '').toUpperCase()}`;
    $('#barsMsg').textContent = opts.message || 'Programming resumes shortly';
  }
  if (which === 'trouble') {
    $('#troubleMsg').textContent = opts.message || 'We are experiencing technical difficulties';
  }
}

function flashNope() {
  const el = $('#nope');
  el.classList.add('on');
  setTimeout(() => el.classList.remove('on'), 450);
}

// ------------------------------------------------------------ display settings

function applyCaptions() {
  // Best-effort in the browser: embedded subs are only shown if the <video>
  // exposes them as text tracks. On the Pi, mpv handles this properly.
  const tracks = video.textTracks || [];
  for (const t of tracks) t.mode = state.captions ? 'showing' : 'hidden';
}

function applyDisplay() {
  document.body.classList.toggle('fill', state.fill === 'fill');
  applyCaptions();
}

async function loadDisplaySettings() {
  try {
    const s = await api('/api/settings');
    state.fill = s.displayFill === 'fill' ? 'fill' : 'fit';
    state.captions = !!s.captions;
    applyDisplay();
  } catch {}
}

// ------------------------------------------------------------ the loop

async function poll() {
  let data;
  try {
    data = await api('/api/onair');
  } catch {
    show('trouble', { message: 'Cannot reach the Cathode server' });
    return;
  }

  state.channels = data.channels;
  if (state.channels.length === 0) {
    show('trouble', { message: 'No channels have been set up yet' });
    return;
  }

  if (state.channelId == null || !state.channels.some((c) => c.channel.id === state.channelId)) {
    state.channelId = state.channels[0].channel.id;
    state.bannerUntil = Date.now() + 5000;
  }

  const entry = state.channels.find((c) => c.channel.id === state.channelId);
  const ch = entry.channel;
  const now = entry.now;
  state.program = now;

  if (!now) {
    show('trouble', { message: 'Nothing is scheduled on this channel' });
    state.programId = null;
    return;
  }

  const changed = now.id !== state.programId;
  state.programId = now.id;

  if (now.kind === 'offair') {
    if (changed) video.removeAttribute('src');
    show('bars', { number: ch.number, name: ch.name, message: now.subtitle });
  } else if (now.kind === 'filler' || !now.playable) {
    if (changed) video.removeAttribute('src');
    show('filler', { number: ch.number, name: ch.name });
  } else {
    show('video');
    if (changed) {
      // This is the whole trick: open the file, then jump to exactly how far
      // into the broadcast we are.
      video.src = now.source;
      video.currentTime = now.offsetMs / 1000;
      video.play().catch(() => {
        show('trouble', { message: 'Click anywhere to start the picture' });
      });
      applyCaptions();
      if (now.offsetMs < 4000 && (now.kind === 'episode' || now.kind === 'movie')) {
        state.bannerUntil = Date.now() + 5000;
      }
    } else {
      // Correct any drift between the tape and the clock.
      const want = now.offsetMs / 1000;
      if (Number.isFinite(video.currentTime) && Math.abs(video.currentTime - want) > 5) {
        video.currentTime = want;
      }
    }
  }
}

function paint() {
  const now = Date.now();
  const entry = state.channels.find((c) => c.channel.id === state.channelId);

  $('#help').classList.toggle('on', now < state.helpUntil);
  $('#digits').classList.toggle('on', state.digits.length > 0);
  $('#digits').textContent = state.digits.padEnd(2, '·');

  const showBanner = now < state.bannerUntil && !state.guideOpen;
  $('#banner').classList.toggle('on', showBanner);

  if (showBanner && entry) {
    const ch = entry.channel;
    const p = entry.now;
    $('#bNum').textContent = String(ch.number).padStart(2, '0');
    $('#bName').textContent = ch.name.toUpperCase();
    $('#bClock').textContent = clock(now);
    $('#bTitle').textContent = p ? p.title : 'Nothing scheduled';
    const ep =
      p && p.seasonNo != null && p.episodeNo != null
        ? `S${String(p.seasonNo).padStart(2, '0')}E${String(p.episodeNo).padStart(2, '0')}  `
        : '';
    $('#bSub').textContent = p && p.subtitle ? ep + p.subtitle : '';
    $('#bRange').textContent = p ? `${clock(p.startUtc)} – ${clock(p.endUtc)}` : '';
    $('#bNext').textContent = entry.next ? `NEXT  ${entry.next.title}` : '';
    const pct = p ? Math.min(100, (p.offsetMs / p.durationMs) * 100) : 0;
    $('#bProgress').style.width = `${pct}%`;
  }

  $('#guide').classList.toggle('on', state.guideOpen);
  $('#screen').classList.toggle('guiding', state.guideOpen);
  if (state.guideOpen) {
    $('#gClock').textContent = clock(now);
    $('#gRows').innerHTML = state.channels
      .map((c, i) => {
        const cells = [c.now, c.next]
          .map((p) =>
            p
              ? `<div class="gp">
                   <div class="tm">${clock(p.startUtc)}</div>
                   <div class="pt">${p.title}</div>
                   <div class="ps">${p.subtitle || ''}</div>
                 </div>`
              : '<div class="gp"><div class="ps">—</div></div>'
          )
          .join('');
        return `<div class="grow ${i === state.guideIndex ? 'sel' : ''}">
          <div class="gc"><div class="n">${String(c.channel.number).padStart(2, '0')}</div>
          <div class="t">${c.channel.name}</div></div>
          ${cells}
          <div class="gp"></div>
        </div>`;
      })
      .join('');
  }
}

// ------------------------------------------------------------ tuning

function tuneTo(channelId) {
  if (channelId === state.channelId) {
    state.bannerUntil = Date.now() + 5000;
    return;
  }
  state.channelId = channelId;
  state.programId = null;
  state.bannerUntil = Date.now() + 5000;
  poll();
}

function surf(dir) {
  const idx = state.channels.findIndex((c) => c.channel.id === state.channelId);
  const next = (idx + dir + state.channels.length) % state.channels.length;
  tuneTo(state.channels[next].channel.id);
}

function pressDigit(d) {
  state.digits = (state.digits + d).slice(-3);
  clearTimeout(state.digitTimer);
  state.digitTimer = setTimeout(() => {
    const num = Number(state.digits);
    state.digits = '';
    const hit = state.channels.find((c) => c.channel.number === num);
    if (hit) tuneTo(hit.channel.id);
    else flashNope();
  }, 2000);
}

// ------------------------------------------------------------ remote keys

const BLOCKED = new Set([' ', 'k', 'K', 'ArrowLeft', 'ArrowRight', 'j', 'J', 'l', 'L']);

document.addEventListener('keydown', async (e) => {
  if (BLOCKED.has(e.key)) {
    // No pausing, no seeking. That is the point.
    e.preventDefault();
    flashNope();
    return;
  }

  if (e.key >= '0' && e.key <= '9') {
    pressDigit(e.key);
    return;
  }

  switch (e.key) {
    case 'ArrowUp':
      e.preventDefault();
      if (state.guideOpen) {
        state.guideIndex = Math.max(0, state.guideIndex - 1);
      } else surf(-1);
      break;
    case 'ArrowDown':
      e.preventDefault();
      if (state.guideOpen) {
        state.guideIndex = Math.min(state.channels.length - 1, state.guideIndex + 1);
      } else surf(1);
      break;
    case 'Enter':
      if (state.guideOpen) {
        tuneTo(state.channels[state.guideIndex].channel.id);
        state.guideOpen = false;
      } else {
        state.bannerUntil = Date.now() + 5000;
      }
      break;
    case 'g':
    case 'G':
      state.guideOpen = !state.guideOpen;
      if (state.guideOpen) {
        state.guideIndex = Math.max(
          0,
          state.channels.findIndex((c) => c.channel.id === state.channelId)
        );
      }
      break;
    case 'Escape':
      state.guideOpen = false;
      break;
    case 'i':
    case 'I':
      state.bannerUntil = Date.now() + 5000;
      break;
    case 'c':
    case 'C':
      state.captions = !state.captions;
      applyCaptions();
      api('/api/settings', { method: 'POST', body: { captions: state.captions ? 1 : 0 } }).catch(() => {});
      state.bannerUntil = Date.now() + 2000;
      break;
    case 'r':
    case 'R':
      try {
        const r = await api('/api/dvr', { method: 'POST', body: { channelId: state.channelId } });
        state.bannerUntil = Date.now() + 2500;
        console.log('Recorded', r.recorded);
      } catch {
        flashNope();
      }
      break;
    case 'f':
    case 'F':
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen().catch(() => {});
      break;
    case 'h':
    case 'H':
      state.helpUntil = Date.now() < state.helpUntil ? 0 : Date.now() + 30000;
      break;
  }
});

// Browsers block autoplay with sound until the page is interacted with.
document.addEventListener('click', () => {
  video.play().catch(() => {});
});

let cursorTimer;
document.addEventListener('mousemove', () => {
  document.body.classList.add('showcursor');
  clearTimeout(cursorTimer);
  cursorTimer = setTimeout(() => document.body.classList.remove('showcursor'), 2500);
});

// Apply captions once a file's tracks are known.
video.addEventListener('loadeddata', applyCaptions);

// A finished file should never leave a frozen frame on screen.
video.addEventListener('ended', () => {
  state.programId = null;
  poll();
});
video.addEventListener('error', () => {
  if (state.program && state.program.playable) {
    show('trouble', { message: 'That file would not play' });
  }
});

poll();
loadDisplaySettings();
setInterval(poll, 1000);
setInterval(paint, 250);
// Pick up display-setting changes made from the config app.
setInterval(loadDisplaySettings, 10000);

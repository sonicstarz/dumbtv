// remote.js — the phone remote (R9).
//
// Every device already serves a config UI on the LAN, so this costs almost
// nothing and solves real problems: a Pi whose IR receiver hasn't arrived, a
// lost Siri remote, and testing a channel change without getting up. It also
// makes the phone-as-accessory story consistent with the NFC deck in Track M.
//
// It drives the SAME endpoints the TV's own keys do — /api/player/* — so this
// is a second input to one player, not a second player. Nothing here holds
// playback state; the engine re-derives everything from the schedule as always.

const $ = (s) => document.querySelector(s);

const state = { digits: '', channels: [], fails: 0 };

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function say(text, bad = false) {
  const el = $('#msg');
  el.textContent = text;
  el.classList.toggle('bad', bad);
  if (text) setTimeout(() => { if (el.textContent === text) el.textContent = ''; }, 3000);
}

const clock = (ts) => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

// ---- what's on -------------------------------------------------------------

async function refresh() {
  if (document.hidden) return;
  try {
    const data = await api('/api/onair');
    state.fails = 0;
    state.channels = data.channels;
    const player = await api('/api/player').catch(() => null);
    const tunedId = player?.channel?.id ?? null;
    const entry = state.channels.find((c) => c.channel.id === tunedId) ?? state.channels[0];

    $('#now').classList.remove('stale');
    if (!entry) {
      $('#nowCh').textContent = '—';
      $('#nowTitle').textContent = 'No channels yet';
      $('#nowSub').textContent = '';
      $('#nowNext').textContent = '';
      return;
    }
    const p = entry.now;
    $('#nowCh').textContent =
      `${String(entry.channel.number).padStart(2, '0')}  ${entry.channel.name.toUpperCase()}`;
    $('#nowTitle').textContent = p ? p.title : 'Nothing scheduled';
    $('#nowSub').textContent = p
      ? [p.subtitle, p.startUtc ? `${clock(p.startUtc)} – ${clock(p.endUtc)}` : '']
          .filter(Boolean).join('  ·  ')
      : '';
    $('#nowNext').textContent = entry.next ? `NEXT  ${entry.next.title}` : '';
  } catch {
    state.fails++;
    // Grey out rather than blanking: the last thing shown is still the best
    // guess at what is on, and a remote that goes empty looks broken.
    $('#now').classList.add('stale');
  }
}

// ---- controls --------------------------------------------------------------

// Always send a body, even an empty one: Fastify rejects a request that
// declares application/json and then sends nothing, so a parameterless POST
// like GUIDE or INFO would 400 without this.
const post = (path, body = {}) => api(path, { method: 'POST', body });

async function surf(direction) {
  try { await post('/api/player/surf', { direction }); await refresh(); }
  catch (e) { say(e.message, true); }
}

function drawEntry() {
  $('#entry').textContent = state.digits ? state.digits.padEnd(2, '·') : '';
  $('#go').disabled = state.digits.length === 0;
}

async function commit() {
  const num = Number(state.digits);
  state.digits = '';
  drawEntry();
  if (!Number.isFinite(num)) return;
  try {
    await post('/api/player/tune', { number: num });
    await refresh();
  } catch {
    // The TV flashes ⊘ for a channel that isn't there; say the same thing here.
    say(`No channel ${num}`, true);
  }
}

$('#pad').addEventListener('click', (e) => {
  const d = e.target.closest('button[data-d]')?.dataset.d;
  if (!d) return;
  state.digits = (state.digits + d).slice(-3);
  drawEntry();
});
$('#clear').addEventListener('click', () => { state.digits = ''; drawEntry(); });
$('#go').addEventListener('click', commit);
$('#chUp').addEventListener('click', () => surf(1));
$('#chDown').addEventListener('click', () => surf(-1));
$('#info').addEventListener('click', async () => {
  try { await post('/api/player/banner'); say('Banner shown on the TV'); }
  catch (e) { say(e.message, true); }
});
$('#guide').addEventListener('click', async () => {
  try {
    const r = await post('/api/player/guide');
    say(r.guideOpen ? 'Guide open on the TV' : 'Guide closed');
  } catch (e) { say(e.message, true); }
});
$('#rec').addEventListener('click', async () => {
  const entry = state.channels.find((c) => c.now);
  try {
    const r = await post('/api/dvr', { channelId: entry?.channel.id });
    say(`Recorded ${r.recorded}`);
  } catch (e) { say(e.message, true); }
});

// Hardware keys, for anyone who opens this on a laptop.
document.addEventListener('keydown', (e) => {
  if (e.key >= '0' && e.key <= '9') {
    state.digits = (state.digits + e.key).slice(-3);
    drawEntry();
  } else if (e.key === 'Enter') commit();
  else if (e.key === 'ArrowUp') surf(1);
  else if (e.key === 'ArrowDown') surf(-1);
  else if (e.key === 'Escape') { state.digits = ''; drawEntry(); }
});

// ---- loop ------------------------------------------------------------------

drawEntry();
refresh();

// Same manners as the TV (U-4): nothing while hidden, back off when the server
// is unreachable, and catch up immediately on return.
(function tick() {
  const delay = state.fails ? Math.min(10000, 2000 * 2 ** Math.min(state.fails, 3)) : 2000;
  setTimeout(() => { refresh().finally(tick); }, delay);
})();

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) { state.fails = 0; refresh(); }
});

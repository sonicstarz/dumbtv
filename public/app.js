import { escapeHtml } from './esc.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  status: null,
  channels: [],
  assets: [],
  sections: [],
  guideFrom: Date.now(),
  guideHours: 3,
  orderingModes: [],
};

// ---------------------------------------------------------------- helpers

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

function toast(message, bad = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (bad ? ' bad' : '');
  // An error should interrupt; a confirmation should wait its turn.
  el.setAttribute('role', bad ? 'alert' : 'status');
  el.textContent = message;
  $('#toastHost').append(el);
  setTimeout(() => el.remove(), 4200);
}

const clock = (ts) =>
  new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/** Which preset does this vibe document match? '' when it matches none. */
function vibeNameOf(v) {
  if (!v) return '';
  for (const [name, preset] of Object.entries(state.vibePresets || {})) {
    if (JSON.stringify(preset) === JSON.stringify(v)) return name;
  }
  return '';
}

function mins(ms) {
  return Math.round(ms / 60000);
}

// A spinning "server connected, loading" indicator (green ring = connected).
const loadingHTML = (msg) => `<div class="loading-row"><span class="spin"></span>${escapeHtml(msg)}</div>`;

// C4: a download line with bytes, speed, and ETA when the backend reports them.
function downloadStatus(prog) {
  const mb = (n) => (n / 1e6).toFixed(0);
  if (prog.bytesTotal > 0 && prog.startedAt) {
    const elapsed = Math.max(0.5, (Date.now() - prog.startedAt) / 1000);
    const speed = prog.bytesDone / elapsed; // bytes/s
    const eta = speed > 0 ? Math.max(0, Math.round((prog.bytesTotal - prog.bytesDone) / speed)) : null;
    const speedStr = `${(speed / 1e6).toFixed(1)} MB/s`;
    const etaStr = eta != null ? ` · ${eta > 90 ? `${Math.round(eta / 60)}m` : `${eta}s`} left` : '';
    return `↓ ${mb(prog.bytesDone)}/${mb(prog.bytesTotal)} MB · ${speedStr}${etaStr}`;
  }
  return `Downloading ${prog.done}/${prog.total}…`;
}

// ---------------------------------------------------------------- nav

$$('.navlink[data-view]').forEach((btn) =>
  btn.addEventListener('click', () => {
    $$('.navlink').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    $$('.view').forEach((v) => v.classList.remove('active'));
    $(`#view-${btn.dataset.view}`).classList.add('active');
    if (btn.dataset.view === 'guide') loadGuide();
    if (btn.dataset.view === 'packs') loadPacks();
    if (btn.dataset.view === 'commercials') { loadAssets(); loadAdSections(); }
    if (btn.dataset.view === 'setup') loadSetup();
    if (btn.dataset.view === 'schedule') loadSchedule();
    if (btn.dataset.view === 'calendar') loadCalendar();
    if (btn.dataset.view === 'settings') loadSettings();
  })
);

// ---------------------------------------------------------------- schedule

const sched = { channelId: null };
const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const fmtDay = (ts) => new Date(ts).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });

async function loadSchedule() {
  const { channels } = await api('/api/channels');
  if (channels.length === 0) { $('#ruleList').innerHTML = '<p class="sub">No channels yet.</p>'; return; }
  sched.channels = channels;
  const sel = $('#schChannel');
  sel.innerHTML = channels.map((c) => `<option value="${c.id}">${String(c.number).padStart(2, '0')} ${escapeHtml(c.name)}</option>`).join('');
  if (!sched.channelId || !channels.some((c) => c.id === sched.channelId)) sched.channelId = channels[0].id;
  sel.value = sched.channelId;
  populateSources();
  await loadRules();
  await runPreview();
}

function populateSources() {
  const ch = (sched.channels || []).find((c) => c.id === sched.channelId);
  const sources = (ch && ch.sources) || [];
  const opts = sources.map((s) => `<option value="${s.ratingKey}" data-type="${s.sourceType}">${escapeHtml(s.title || s.ratingKey)}</option>`).join('')
    || '<option value="">(no sources on this channel)</option>';
  $('#rAirSource').innerHTML = opts;
  $('#rPinSource').innerHTML = opts;
  loadPinEpisodes();
}

// When the pinned "content" is a show, offer its episodes; a movie plays as-is.
async function loadPinEpisodes() {
  const src = $('#rPinSource');
  const opt = src.options[src.selectedIndex];
  const wrap = $('#rPinEpisodeWrap');
  const epSel = $('#rPinEpisode');
  if (!opt || opt.dataset.type !== 'show') { wrap.style.display = 'none'; return; }
  wrap.style.display = 'block';
  epSel.innerHTML = '<option value="">Loading…</option>';
  try {
    const { episodes } = await api(`/api/library/show/${opt.value}/episodes`);
    epSel.innerHTML = episodes.length
      ? episodes.map((e) => `<option value="${e.ratingKey}">${e.seasonNo ?? '?'}·${String(e.episodeNo ?? '?').padStart(2, '0')} — ${escapeHtml(e.title || 'Untitled')}</option>`).join('')
      : '<option value="">(no episodes cached)</option>';
  } catch (err) { epSel.innerHTML = `<option value="">${escapeHtml(err.message)}</option>`; }
}

async function loadRules() {
  const { rules } = await api(`/api/channels/${sched.channelId}/rules`);
  $('#ruleList').innerHTML = rules.length
    ? rules.map((r) => {
        const when = r.kind === 'pinned'
          ? new Date(r.starts_at_utc).toLocaleString()
          : r.kind === 'airdate'
            ? `${r.airdate_mode === 'anniversary' ? 'on its original date' : 'weekly, original weekday'}${r.start_time ? ' · ' + r.start_time : ''}`
            : r.start_time
              ? `${(r.days_of_week || '').split(',').map((d) => dayNames[d] || '').join(' ')} ${r.start_time} · ${r.duration_min}m`
              : '';
        return `<div class="ruleRow">
          <span class="ruleKind k-${r.kind}">${r.kind}</span>
          <b>${escapeHtml(r.name || r.kind)}</b>
          <span class="sub">${escapeHtml(when)}</span>
          <span style="flex:1"></span>
          ${r.kind === 'rotation' ? '' : `<button class="sm danger" data-rule="${r.id}">Remove</button>`}
        </div>`;
      }).join('')
    : '<p class="sub">Just the default rotation.</p>';
  $$('[data-rule]').forEach((b) => b.addEventListener('click', async () => {
    await api(`/api/rules/${b.dataset.rule}`, { method: 'DELETE' });
    await loadRules(); await runPreview();
  }));
}

async function runPreview() {
  try {
    const p = await api(`/api/channels/${sched.channelId}/preview?days=7`);
    const rulesById = {};
    (await api(`/api/channels/${sched.channelId}/rules`)).rules.forEach((r) => (rulesById[r.id] = r));
    $('#schMeta').textContent = `${p.programs.length} blocks · ${fmtDay(p.from)} → ${fmtDay(p.until)}`;
    $('#conflicts').innerHTML = (p.conflicts || []).length
      ? `<div class="conflict">${p.conflicts.map((c) => `⚠ <b>${escapeHtml(c.rule)}</b> lost ${fmtDay(c.at)} ${fmtTime(c.at)} to ${escapeHtml(c.lostTo)}`).join('<br>')}</div>`
      : '';
    // group the show/movie/offair blocks by day (collapse ad/filler into the block)
    const blocks = p.programs.filter((x) => ['episode', 'movie', 'offair'].includes(x.kind)).slice(0, 240);
    let html = '', lastDay = '';
    for (const b of blocks) {
      const day = fmtDay(b.startUtc);
      if (day !== lastDay) { html += `<div class="tlDay">${day}</div>`; lastDay = day; }
      const rule = rulesById[b.ruleId];
      const reserved = rule && rule.kind !== 'rotation';
      const cls = b.kind === 'offair' ? 'tlBlk offair' : reserved ? 'tlBlk reserved' : 'tlBlk fill';
      const tag = reserved ? `<span class="tlTag">${escapeHtml(rule.name || rule.kind)}</span>` : '';
      html += `<div class="${cls}"><span class="tlTime">${fmtTime(b.startUtc)}</span> <span class="tlTitle">${escapeHtml(b.title)}${b.subtitle ? ' — ' + escapeHtml(b.subtitle) : ''}</span>${tag}</div>`;
    }
    $('#timeline').innerHTML = html || '<p class="sub">Nothing scheduled.</p>';
  } catch (err) { $('#timeline').innerHTML = `<p class="sub" style="color:var(--tally)">${escapeHtml(err.message)}</p>`; }
}

$('#schChannel').addEventListener('change', async (e) => { sched.channelId = Number(e.target.value); populateSources(); await loadRules(); await runPreview(); });
$('#schPreview').addEventListener('click', runPreview);
$('#printGuide').addEventListener('click', () => {
  const days = $('#printDays').value;
  window.open(`/api/schedule/print?days=${days}`, '_blank');
});
$('#schApply').addEventListener('click', async () => {
  try {
    await api('/api/schedule/regenerate', { method: 'POST', body: { channelId: sched.channelId } });
    toast('Schedule applied.'); await runPreview();
  } catch (err) { toast(err.message, true); }
});
$('#rKind').addEventListener('change', (e) => {
  const k = e.target.value;
  $('#rRecurring').style.display = (k === 'recurring' || k === 'blackout') ? 'block' : 'none';
  $('#rAirdate').style.display = k === 'airdate' ? 'block' : 'none';
  $('#rPinned').style.display = k === 'pinned' ? 'block' : 'none';
});
$('#rMode').addEventListener('change', (e) => {
  $('#rCadenceWrap').style.display = e.target.value === 'original_cadence' ? 'block' : 'none';
});
$('#rPinSource').addEventListener('change', loadPinEpisodes);
// R5: block presets are just the common shapes of a recurring rule. "Saturday
// morning cartoons" is days=6, start=08:00, 240 minutes — the scheduler already
// did this; nobody should have to work out the numbers.
$('#rBlockPreset')?.addEventListener('change', (e) => {
  if (!e.target.value) return;
  const [days, start, dur] = e.target.value.split('|');
  $('#rDays').value = days;
  $('#rStart').value = start;
  $('#rDur').value = dur;
});

// R2: picking a season fills the dates and turns on annual repeat, because a
// holiday window that only fires once is almost never what someone meant.
$('#rSeasonPreset')?.addEventListener('change', (e) => {
  const v = e.target.value;
  if (!v) return;
  const [from, to] = v.split(':');
  const y = new Date().getFullYear();
  $('#rEffFrom').value = `${y}-${from}`;
  // A window that wraps the new year ends in the FOLLOWING year.
  $('#rEffTo').value = `${to < from ? y + 1 : y}-${to}`;
  $('#rEffAnnual').checked = true;
});

$('#rAdd').addEventListener('click', async () => {
  const kind = $('#rKind').value;
  const body = { kind, name: $('#rName').value || null };
  if ($('#rEffFrom').value) body.effectiveFrom = $('#rEffFrom').value;
  if ($('#rEffTo').value) body.effectiveTo = $('#rEffTo').value;
  // R2: an annual window compares month/day only, so the season returns each
  // year instead of being a one-off range that silently expires.
  if ($('#rEffAnnual').checked) body.effectiveAnnual = true;
  if (kind === 'recurring' || kind === 'blackout') {
    body.daysOfWeek = $('#rDays').value.trim();
    body.startTime = $('#rStart').value.trim();
    body.durationMin = Number($('#rDur').value) || 0;
    // R1: tags turn a plain recurring block into a DAYPART — it draws from a
    // subset instead of the channel's whole rotation.
    const tags = $('#rTags').value.split(',').map((t) => t.trim()).filter(Boolean);
    if (tags.length && kind === 'recurring') {
      body.selectTags = tags;
      body.selectMode = $('#rTagAll').checked ? 'all' : 'any';
    }
  } else if (kind === 'airdate') {
    body.ratingKey = $('#rAirSource').value;
    body.sourceType = 'show';
    body.airdateMode = $('#rMode').value;
    body.startTime = $('#rAirStart').value.trim() || '08:00';
    if (body.airdateMode === 'original_cadence') body.cadenceCompress = Number($('#rCadence').value) || 1;
    if (!body.ratingKey) return toast('Pick a show for the airdate rule.', true);
  } else if (kind === 'pinned') {
    const at = Date.parse($('#rPinAt').value.replace(' ', 'T'));
    if (Number.isNaN(at)) return toast('Bad date — use YYYY-MM-DD HH:MM', true);
    body.startsAtUtc = at;
    const src = $('#rPinSource');
    const opt = src.options[src.selectedIndex];
    if (opt && opt.dataset.type === 'show') {
      // A show must resolve to one episode — the show key isn't playable itself.
      body.ratingKey = $('#rPinEpisode').value;
      body.sourceType = 'episode';
      if (!body.ratingKey) return toast('Pick which episode to pin.', true);
    } else {
      body.ratingKey = src.value;
      body.sourceType = 'movie';
      if (!body.ratingKey) return toast('Pick a movie to pin.', true);
    }
  }
  try {
    const { id } = await api(`/api/channels/${sched.channelId}/rules`, { method: 'POST', body });
    toast('Rule added — preview updated. Apply to make it air.');
    await loadRules(); await runPreview();
    showNextOccurrences(id);
  } catch (err) { toast(err.message, true); }
});

// After adding a rule, list its next few occurrences from the dry-run preview.
async function showNextOccurrences(ruleId) {
  try {
    const p = await api(`/api/channels/${sched.channelId}/preview?days=30`);
    const mine = p.programs.filter((x) => x.ruleId === ruleId && ['episode', 'movie', 'offair'].includes(x.kind)).slice(0, 3);
    $('#rNext').innerHTML = mine.length
      ? 'Next: ' + mine.map((m) => `${fmtDay(m.startUtc)} ${fmtTime(m.startUtc)}${m.title ? ' · ' + escapeHtml(m.title) : ''}`).join('  ·  ')
      : 'No occurrences in the next 30 days.';
  } catch { $('#rNext').textContent = ''; }
}

// ---------------------------------------------------------------- calendar

const HOUR_MS = 3600_000;
const DAY_MS = 86_400_000;
const PX_PER_HOUR = 46;
const cal = { channelId: null, weekStart: null };

function localMidnight(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

async function loadCalendar() {
  if (!state.channels.length) { try { state.channels = (await api('/api/channels')).channels; } catch {} }
  const sel = $('#calChannel');
  sel.innerHTML = state.channels
    .map((c) => `<option value="${c.id}">${c.number} · ${escapeHtml(c.name)}</option>`)
    .join('');
  if (!cal.channelId || !state.channels.some((c) => c.id === cal.channelId)) {
    cal.channelId = state.channels[0]?.id ?? null;
  }
  if (cal.channelId) sel.value = String(cal.channelId);
  if (!cal.weekStart) cal.weekStart = localMidnight(Date.now());
  await renderCalendar();
}

async function renderCalendar() {
  const head = $('#calHead');
  const body = $('#calBody');
  if (!cal.channelId) { head.innerHTML = ''; body.innerHTML = '<p class="sub" style="padding:20px">No channels yet.</p>'; return; }

  const from = cal.weekStart;
  const days = [...Array(7)].map((_, i) => from + i * DAY_MS);
  const today = localMidnight(Date.now());
  $('#calRange').textContent = `${fmtDay(days[0])} – ${fmtDay(days[6])}`;

  // Day headers (a spacer over the hour gutter, then 7 day columns).
  head.innerHTML =
    '<div class="cal-corner"></div>' +
    days
      .map((d) => {
        const dt = new Date(d);
        const isToday = d === today;
        return `<div class="cal-daylabel${isToday ? ' today' : ''}">
          <span class="dow">${dt.toLocaleDateString([], { weekday: 'short' })}</span>
          <span class="dnum">${dt.getMonth() + 1}/${dt.getDate()}</span>
        </div>`;
      })
      .join('');

  let data;
  try {
    data = await api(`/api/schedule/calendar?channel=${cal.channelId}&from=${from}&days=7`);
  } catch (err) { body.innerHTML = `<p class="sub" style="padding:20px">${escapeHtml(err.message)}</p>`; return; }

  // Hour gutter + 7 day columns, each PX_PER_HOUR per hour tall.
  const colHeight = 24 * PX_PER_HOUR;
  const gutter =
    '<div class="cal-gutter">' +
    [...Array(24)].map((_, h) => `<div class="cal-hour" style="height:${PX_PER_HOUR}px"><span>${h === 0 ? '12a' : h < 12 ? h + 'a' : h === 12 ? '12p' : h - 12 + 'p'}</span></div>`).join('') +
    '</div>';

  const cols = days.map((dayStart, di) => {
    const dayEnd = dayStart + DAY_MS;
    // Split each program into per-day segments so overnight blocks render in
    // both columns and nothing spills past midnight.
    let blocks = '';
    for (const p of data.programs) {
      if (p.endUtc <= dayStart || p.startUtc >= dayEnd) continue;
      const s = Math.max(p.startUtc, dayStart);
      const e = Math.min(p.endUtc, dayEnd);
      const top = ((s - dayStart) / HOUR_MS) * PX_PER_HOUR;
      const height = Math.max(13, ((e - s) / HOUR_MS) * PX_PER_HOUR);
      const off = p.kind === 'offair';
      const se = p.seasonNo && p.episodeNo ? ` S${p.seasonNo}·E${p.episodeNo}` : '';
      // Episode-title-first: on a one-show channel, sixty "VeggieTales" pills
      // are unreadable — "Gideon: Tuba Warrior" is what you actually scan for.
      const label = off
        ? escapeHtml(p.title || 'Off air')
        : `${p.isPremiere ? '<span class="prem">NEW</span> ' : ''}${escapeHtml(p.subtitle || p.title || 'Program')}`;
      const sub = off ? '' : `<span class="cb-sub">${fmtTime(p.startUtc)}${se}</span>`;
      blocks += `<div class="cal-block${off ? ' offair' : ''}" style="top:${top}px;height:${height}px"
        title="${escapeHtml((p.title || '') + ' — ' + fmtTime(p.startUtc))}">
        <span class="cb-title">${label}</span>${sub}</div>`;
    }
    // Now-line in today's column.
    let now = '';
    if (dayStart === today) {
      const y = ((Date.now() - dayStart) / HOUR_MS) * PX_PER_HOUR;
      now = `<div class="cal-now" style="top:${y}px"></div>`;
    }
    // Faint hour gridlines.
    const lines = [...Array(24)].map((_, h) => `<div class="cal-line" style="top:${h * PX_PER_HOUR}px"></div>`).join('');
    return `<div class="cal-col" style="height:${colHeight}px">${lines}${now}${blocks}</div>`;
  });

  body.innerHTML = gutter + cols.join('');
  // Scroll to a sensible hour (now if today is in view, else 7am).
  const scroll = $('.cal-scroll');
  const focusHour = days.includes(today) ? new Date().getHours() : 7;
  scroll.scrollTop = Math.max(0, (focusHour - 1) * PX_PER_HOUR);
}

$('#calChannel').addEventListener('change', (e) => { cal.channelId = Number(e.target.value); renderCalendar(); });
$('#calPrev').addEventListener('click', () => { cal.weekStart -= 7 * DAY_MS; renderCalendar(); });
$('#calNext').addEventListener('click', () => { cal.weekStart += 7 * DAY_MS; renderCalendar(); });
$('#calToday').addEventListener('click', () => { cal.weekStart = localMidnight(Date.now()); renderCalendar(); });

// ---------------------------------------------------------------- settings

async function loadSettings() {
  const s = await api('/api/auth/status');
  $('#pinStatus').textContent = s.configured
    ? (s.authed ? 'A PIN is set and you are unlocked.' : 'A PIN is set. Enter it to unlock edits.')
    : 'No PIN set — edits are open to anyone on the network.';
  $('#pinLabel').textContent = s.configured ? (s.authed ? 'CHANGE PIN' : 'ENTER PIN') : 'SET A PIN (4–6 digits)';
  $('#pinLogout').style.display = s.configured && s.authed ? 'inline-block' : 'none';
  $('#pinSave').textContent = s.configured && !s.authed ? 'Unlock' : 'Save';

  const cfg = await api('/api/settings');
  $('#tzStatus').textContent = `Active: ${cfg.activeTimezone || Intl.DateTimeFormat().resolvedOptions().timeZone}${cfg.timezone ? '' : ' (this device — no override set)'}`;
  $('#tzInput').value = cfg.timezone || '';
  $('#dispFill').value = cfg.displayFill === 'fill' ? 'fill' : 'fit';
  $('#dispCaptions').checked = !!cfg.captions;
  // L-V1: presets come from the server so the two sides cannot drift apart.
  state.vibePresets = cfg.vibePresets || {};
  // Offer the tag vocabulary that actually exists, most-used first — a daypart
  // picker that suggests nothing is a text box with extra steps.
  try {
    const { tags } = await api('/api/tags');
    const dl = $('#tagList');
    if (dl) dl.innerHTML = tags.map((t) => `<option value="${escapeHtml(t.tag)}">${t.n}</option>`).join('');
  } catch {}
  state.vibeDefault = cfg.vibeDefault || null;
  const dv = $('#dispVibe');
  if (dv) dv.value = vibeNameOf(cfg.vibeDefault) || 'off';

  try {
    const llm = await api('/api/llm/status');
    $('#llmState').textContent = llm.configured ? `connected · ${llm.model}` : 'not configured';
    $('#llmState').style.color = llm.configured ? 'var(--phosphor)' : 'var(--dim)';
  } catch {}
}

$('#llmSave').addEventListener('click', async () => {
  try {
    await api('/api/llm/settings', {
      method: 'POST',
      body: { url: $('#llmUrl').value.trim(), model: $('#llmModel').value.trim(), key: $('#llmKey').value },
    });
    $('#llmKey').value = '';
    toast('AI settings saved.');
    loadSettings();
  } catch (err) { toast(err.message, true); }
});

$('#dispFill').addEventListener('change', async (e) => {
  await api('/api/settings', { method: 'POST', body: { displayFill: e.target.value } });
  toast('Picture setting saved.');
});
$('#dispCaptions').addEventListener('change', async (e) => {
  await api('/api/settings', { method: 'POST', body: { captions: e.target.checked ? 1 : 0 } });
  toast(e.target.checked ? 'Captions on.' : 'Captions off.');
});
$('#dispVibe')?.addEventListener('change', async (e) => {
  const preset = state.vibePresets?.[e.target.value] ?? null;
  await api('/api/settings', { method: 'POST', body: { vibeDefault: preset } });
  state.vibeDefault = preset;
  toast(`Default look: ${e.target.selectedOptions[0].textContent.split('—')[0].trim()}.`);
});
$('#tzSave').addEventListener('click', async () => {
  try {
    const r = await api('/api/settings', { method: 'POST', body: { timezone: $('#tzInput').value.trim() } });
    if (r.error) return toast(r.error, true);
    toast('Timezone saved. Regenerate channels to shift the grid.');
    loadSettings();
  } catch (err) { toast(err.message, true); }
});
$('#tzOS').addEventListener('click', () => {
  $('#tzInput').value = Intl.DateTimeFormat().resolvedOptions().timeZone;
});
$('#cfgExport').addEventListener('click', async () => {
  const cfg = await api('/api/config/export');
  const blob = new Blob([JSON.stringify(cfg, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `dumbtv-config-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
});
$('#cfgImport').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (!(await confirmModal('Importing replaces the current lineup. Continue?', { ok: 'Import' }))) { e.target.value = ''; return; }
  try {
    const cfg = JSON.parse(await file.text());
    const r = await api('/api/config/import', { method: 'POST', body: cfg });
    toast(`Imported ${r.channels} channels, ${r.rules} rules.`);
    loadStatus();
  } catch (err) { toast(err.message, true); }
  e.target.value = '';
});
$('#pinSave').addEventListener('click', async () => {
  const pin = $('#pinInput').value.trim();
  const s = await api('/api/auth/status');
  try {
    if (s.configured && !s.authed) {
      await api('/api/auth/login', { method: 'POST', body: { pin } });
      toast('Unlocked.');
    } else {
      await api('/api/auth/setup', { method: 'POST', body: { pin } });
      toast('PIN saved.');
    }
    $('#pinInput').value = '';
    await loadSettings();
  } catch (err) { toast(err.message, true); }
});
$('#pinLogout').addEventListener('click', async () => {
  await api('/api/auth/logout', { method: 'POST' });
  toast('Logged out.'); await loadSettings();
});

// ---------------------------------------------------------------- on air strip

async function refreshOnAir() {
  let data;
  try {
    data = await api('/api/onair');
  } catch {
    return;
  }
  const tuned = state.status?.player?.channel?.id;

  $('#onair').innerHTML =
    data.channels
      .map((c) => {
        const n = c.now;
        const line = n
          ? `${escapeHtml(n.title)}${n.subtitle ? ` <small>${escapeHtml(n.subtitle)}</small>` : ''}`
          : '<small>nothing scheduled</small>';
        return `<button class="onair-item ${c.channel.id === tuned ? 'tuned' : ''}" data-tune="${c.channel.id}">
          <span class="num">${String(c.channel.number).padStart(2, '0')}</span>
          <span class="prog">${line}</span>
        </button>`;
      })
      .join('') || '<div style="padding:0 18px;color:var(--dim);font-size:13px">No channels yet</div>';

  $$('#onair [data-tune]').forEach((b) =>
    b.addEventListener('click', async () => {
      try {
        await api('/api/player/tune', { method: 'POST', body: { channelId: Number(b.dataset.tune) } });
        toast('Tuned in.');
        loadStatus();
      } catch (err) {
        toast(err.message, true);
      }
    })
  );
}

// ---------------------------------------------------------------- status

async function loadStatus() {
  try {
    state.status = await api('/api/status');
  } catch {
    // The server didn't answer — the dumbTV app/backend is gone. Grey the
    // whole page out so it's obvious this UI is dead until it's back.
    $('#tallyDot').classList.add('off');
    $('#tallyText').textContent = 'APP NOT RUNNING';
    document.body.classList.add('offline');
    return;
  }
  document.body.classList.remove('offline');
  const s = state.status;
  state.orderingModes = s.orderingModes || [];
  // Native app (Mac/iOS/tvOS): hide Node-only surfaces (folder scan, PDF print,
  // mpv display knobs, AI assist) instead of showing buttons that can't work.
  document.body.classList.toggle('native', !!s.native);

  const dot = $('#tallyDot');
  const txt = $('#tallyText');
  // The dot is lit whenever the backend is alive — this page is served BY the
  // player, so a response means dumbTV is running right here.
  dot.classList.remove('off');
  txt.textContent = s.player?.driver === 'mpv' ? 'ON AIR' : 'CONNECTED';

  $('#navChannels').textContent = s.counts.channels || '';
  $('#navAssets').textContent = s.counts.assets || '';
  $('#navPlex').textContent = s.linked ? (s.reachable ? '●' : '!') : '—';
  $('#navPlex').style.color = s.linked && s.reachable ? 'var(--phosphor)' : 'var(--dim)';

  // Kids Mode banner reflects current state.
  const kb = $('#kidsBar');
  if (kb) {
    const on = !!s.kidsMode;
    kb.classList.toggle('on', on);
    $('#kidsToggle').textContent = on ? 'Turn off' : 'Turn on';
    $('#kidsBarSub').textContent = on
      ? `On — the TV is limited to ${s.kidSafeCount} kid-safe channel${s.kidSafeCount === 1 ? '' : 's'}.`
      : (s.kidSafeCount
          ? `${s.kidSafeCount} channel${s.kidSafeCount === 1 ? '' : 's'} marked kid-safe. Turn on to lock the TV to them.`
          : 'Mark channels kid-safe below, then turn this on to lock the TV to them.');
  }

  // On the native apps the TV is the app window itself — a browser tab can't
  // direct-play the library (VLCKit does that natively). Point users there
  // instead of a browser /tv that would just show colour bars.
  const tv = $('#openTv');
  if (tv && s.native) {
    tv.textContent = 'The TV is the app window';
    tv.removeAttribute('href');
    tv.removeAttribute('target');
    tv.style.cursor = 'default';
    tv.style.opacity = '0.6';
  }
}

// ---------------------------------------------------------------- channels

async function loadChannels() {
  const data = await api('/api/channels');
  state.channels = data.channels;
  renderChannels();
}

function renderChannels() {
  const host = $('#channelList');

  if (state.channels.length === 0) {
    host.innerHTML = `<div class="empty-state">
      <strong>No channels yet</strong>
      Link Plex, then add a channel and pick the shows that live on it.
    </div>`;
    return;
  }

  host.innerHTML = state.channels
    .map((c) => {
      const mode = state.orderingModes.find((m) => m.id === c.orderingMode);
      const dark =
        c.darkStart && c.darkEnd ? `dark ${c.darkStart}–${c.darkEnd}` : 'on air 24h';
      const sources = c.sources.length
        ? c.sources
            .map(
              (s) => `<span class="chip">${escapeHtml(s.title)}
                <span class="n">${s.itemCount ?? ''}</span>
                ${s.sourceType === 'show' && !c.locked ? `<button class="chip-filter" data-filter="${c.id}:${s.id}" title="Choose which episodes air" aria-label="Choose which episodes of ${escapeHtml(s.title || 'this source')} air">⛃</button>` : ''}
                ${c.locked ? '' : `<button data-rm="${c.id}:${s.id}" title="Remove" aria-label="Remove ${escapeHtml(s.title || 'this source')} from ${escapeHtml(c.name)}">&times;</button>`}</span>`
            )
            .join('')
        : '<span class="chip empty">Nothing on this channel yet</span>';

      return `<div class="chan">
        <div class="chan-num">${String(c.number).padStart(2, '0')}<small>CH</small></div>
        <div>
          <h3>${escapeHtml(c.name)}</h3>
          <div class="meta">
            <b>${mode ? mode.label : c.orderingMode}</b> ·
            ${c.adsEnabled ? `up to ${c.maxAdsPerBreak} ads per break` : 'no ads'} ·
            ${dark}
          </div>
          <div class="chips">${sources}</div>
        </div>
        <div class="chan-actions">
          ${c.locked ? `
          <span class="chip lock" title="Built into dumbTV. You can turn it off, but it can't be edited or removed.">🔒 Built in</span>
          <button class="sm" data-watch="${c.id}">Watch</button>
          <button class="sm kid ${c.kidSafe ? 'on' : ''}" data-kid="${c.id}" title="Show this channel in Kids Mode">${c.kidSafe ? '🧸 Kid-safe' : '🧸 Mark kid-safe'}</button>
          <button class="sm" data-hide="${c.id}">${c.enabled ? 'Turn off' : 'Turn on'}</button>
          ` : `
          <button class="sm primary" data-add="${c.id}">Add content</button>
          <button class="sm" data-edit="${c.id}">Settings</button>
          <button class="sm" data-watch="${c.id}">Watch</button>
          <button class="sm kid ${c.kidSafe ? 'on' : ''}" data-kid="${c.id}" title="Show this channel in Kids Mode">${c.kidSafe ? '🧸 Kid-safe' : '🧸 Mark kid-safe'}</button>
          <button class="sm danger" data-del="${c.id}">Delete</button>
          `}
        </div>
      </div>`;
    })
    .join('');

  $$('[data-kid]', host).forEach((b) =>
    b.addEventListener('click', async () => {
      const c = state.channels.find((x) => x.id === Number(b.dataset.kid));
      try {
        await api(`/api/channels/${c.id}/kid-safe`, { method: 'POST', body: { on: !c.kidSafe } });
        loadChannels();
        loadStatus();
      } catch (err) { toast(err.message, true); }
    })
  );

  // S3: hideable, not editable. `enabled` is the one field the API lets through
  // on a locked channel — a channel you can neither remove nor hide is a hostage.
  $$('[data-hide]', host).forEach((b) =>
    b.addEventListener('click', async () => {
      const c = state.channels.find((x) => x.id === Number(b.dataset.hide));
      if (!c) return;
      try {
        await api(`/api/channels/${c.id}`, { method: 'PATCH', body: { enabled: !c.enabled } });
        toast(c.enabled ? 'Channel turned off.' : 'Channel turned on.');
        loadChannels();
        loadStatus();
      } catch (err) { toast(err.message, true); }
    })
  );

  $$('[data-add]', host).forEach((b) =>
    b.addEventListener('click', () => openPicker(Number(b.dataset.add)))
  );
  $$('[data-edit]', host).forEach((b) =>
    b.addEventListener('click', () => openSettings(Number(b.dataset.edit)))
  );
  $$('[data-watch]', host).forEach((b) =>
    b.addEventListener('click', async () => {
      await api('/api/player/tune', { method: 'POST', body: { channelId: Number(b.dataset.watch) } });
      toast('Tuned in.');
      refreshOnAir();
    })
  );
  $$('[data-del]', host).forEach((b) =>
    b.addEventListener('click', async () => {
      const c = state.channels.find((x) => x.id === Number(b.dataset.del));
      if (!c) return;
      if (!(await confirmModal(`Delete channel ${c.number} — ${c.name}? Its schedule goes with it.`, { danger: true }))) return;
      try {
        await api(`/api/channels/${c.id}`, { method: 'DELETE' });
        toast('Channel deleted.');
        loadChannels();
        loadStatus();
      } catch (err) {
        toast(`Couldn't delete: ${err.message}`, true);
      }
    })
  );
  $$('[data-rm]', host).forEach((b) =>
    b.addEventListener('click', async () => {
      const [ch, src] = b.dataset.rm.split(':');
      await api(`/api/channels/${ch}/sources/${src}`, { method: 'DELETE' });
      toast('Removed. Schedule rebuilt.');
      loadChannels();
    })
  );
  $$('[data-filter]', host).forEach((b) =>
    b.addEventListener('click', () => {
      const [ch, src] = b.dataset.filter.split(':').map(Number);
      const chan = state.channels.find((x) => x.id === ch);
      const source = chan?.sources.find((s) => s.id === src);
      if (source) openEpisodeFilter(ch, source);
    })
  );
}

// ---------------------------------------------------------------- episode filter

async function openEpisodeFilter(channelId, source) {
  const back = modal(`
    <h3>Choose episodes — ${escapeHtml(source.title)}</h3>
    <p class="sub" style="color:var(--dim);font-size:13px;margin:4px 0 14px">
      Unchecked episodes are filtered out of this channel. What's on air now finishes; it just won't come back.
    </p>
    <div class="row" style="margin-bottom:12px;align-items:center">
      <button class="sm" id="epAll">Check all</button>
      <button class="sm" id="epNone">Uncheck all</button>
      <span class="sub" id="epCount" style="margin-left:auto">Loading…</span>
    </div>
    <div id="epList" class="ep-list" style="max-height:52vh;overflow-y:auto">Loading episodes…</div>
    <div class="row" style="margin-top:20px;justify-content:flex-end">
      <button class="ghost" id="epCancel">Cancel</button>
      <button class="primary" id="epSave">Save &amp; rebuild</button>
    </div>
  `);

  $('#epCancel', back).addEventListener('click', () => back._close());

  let episodes = [];
  let otherExcludes = [];
  try {
    const [eps, exc] = await Promise.all([
      api(`/api/library/show/${source.ratingKey}/episodes?channel=${channelId}`),
      api(`/api/channels/${channelId}/excludes`),
    ]);
    episodes = eps.episodes || [];
    const showKeys = new Set(episodes.map((e) => e.ratingKey));
    otherExcludes = (exc.excludes || []).filter((k) => !showKeys.has(k)); // keep other shows' filters
  } catch (err) {
    $('#epList', back).innerHTML = `<p class="sub">${escapeHtml(err.message)}</p>`;
    return;
  }

  if (!episodes.length) {
    $('#epList', back).innerHTML = '<p class="sub">No episodes cached for this show yet.</p>';
    $('#epCount', back).textContent = '';
    return;
  }

  // PD Packs Task 3 — say plainly that a run is incomplete. Most public-domain
  // television is: each episode had to be renewed separately, so only the first
  // 55 Beverly Hillbillies are PD. Listing 6 of 274 episodes with no
  // explanation reads like a broken import, not a rights boundary.
  if (episodes.some((e) => e.seriesPartial)) {
    $('#epList', back).insertAdjacentHTML('beforebegin',
      `<p class="hint" style="margin:0 0 12px">
         <b>Partial run.</b> Only the episodes below are public domain — the rest
         of the series was renewed and is not included. Gaps are expected.
       </p>`);
  }

  // Group by season for a scannable list.
  const bySeason = {};
  for (const e of episodes) (bySeason[e.seasonNo ?? 0] ||= []).push(e);
  const seasons = Object.keys(bySeason).map(Number).sort((a, b) => a - b);

  $('#epList', back).innerHTML = seasons
    .map((sn) => {
      const rows = bySeason[sn]
        .map(
          (e) => `<label class="ep-row">
            <input type="checkbox" data-ep="${e.ratingKey}" ${e.excluded ? '' : 'checked'}>
            <span class="ep-no">${e.seasonNo ?? '?'}·${String(e.episodeNo ?? '?').padStart(2, '0')}</span>
            <span class="ep-title">${escapeHtml(e.title || 'Untitled')}</span>
          </label>`
        )
        .join('');
      return `<div class="ep-season"><div class="ep-season-h">Season ${sn || '—'}</div>${rows}</div>`;
    })
    .join('');

  const boxes = () => $$('[data-ep]', back);
  const updateCount = () => {
    const on = boxes().filter((b) => b.checked).length;
    $('#epCount', back).textContent = `${on} of ${episodes.length} airing`;
  };
  updateCount();
  back.addEventListener('change', (e) => { if (e.target.matches('[data-ep]')) updateCount(); });
  $('#epAll', back).addEventListener('click', () => { boxes().forEach((b) => (b.checked = true)); updateCount(); });
  $('#epNone', back).addEventListener('click', () => { boxes().forEach((b) => (b.checked = false)); updateCount(); });

  $('#epSave', back).addEventListener('click', async () => {
    const btn = $('#epSave', back);
    btn.disabled = true;
    btn.textContent = 'Rebuilding…';
    const excludedNow = boxes().filter((b) => !b.checked).map((b) => b.dataset.ep);
    try {
      await api(`/api/channels/${channelId}/excludes`, {
        method: 'PUT',
        body: { ratingKeys: [...otherExcludes, ...excludedNow] },
      });
      back._close();
      toast(`Filtered. ${excludedNow.length} episode${excludedNow.length === 1 ? '' : 's'} off this channel.`);
      loadChannels();
    } catch (err) {
      toast(err.message, true);
      btn.disabled = false;
      btn.textContent = 'Save & rebuild';
    }
  });
}

$('#addChannel').addEventListener('click', async () => {
  // N2: don't guess a number (they collide with preload channels) — let the
  // backend assign a free one, and open THAT channel by its returned id (not
  // positional-last, which opened the wrong channel).
  const { id } = await api('/api/channels', { method: 'POST', body: { name: 'New Channel' } });
  await loadChannels();
  loadStatus();
  if (id) openSettings(id, { isNew: true });   // A3: draft — cancel deletes it
});

// ---- AI: suggest a channel ----
$('#suggestChannel').addEventListener('click', async () => {
  const st = await api('/api/llm/status').catch(() => ({ configured: false }));
  if (!st.configured) {
    toast('Set up an AI endpoint in Settings first.', true);
    return;
  }
  openSuggestChannel();
});

function openSuggestChannel() {
  const back = modal(`
    <h3>✨ Suggest a channel</h3>
    <p class="sub" style="color:var(--dim);font-size:13px;margin:4px 0 14px">
      Describe the channel you want. The AI picks matching shows from your library — you review before anything is created.
    </p>
    <div class="field"><label>WHAT'S THE CHANNEL?</label>
      <input id="scBrief" placeholder="90s Saturday morning cartoons" style="width:100%">
    </div>
    <div id="scResult"></div>
    <div class="row" style="margin-top:16px;justify-content:flex-end">
      <button class="ghost" id="scCancel">Cancel</button>
      <button class="primary" id="scGo">Suggest</button>
    </div>
  `);
  $('#scCancel', back).addEventListener('click', () => back._close());
  $('#scBrief', back).focus();

  $('#scGo', back).addEventListener('click', async () => {
    const btn = $('#scGo', back);
    const brief = $('#scBrief', back).value.trim();
    if (!brief) return toast('Describe the channel first.', true);
    btn.disabled = true; btn.textContent = 'Thinking…';
    $('#scResult', back).innerHTML = '<p class="sub">Reading your library and composing…</p>';
    try {
      const { proposal } = await api('/api/llm/suggest-channel', { method: 'POST', body: { prompt: brief } });
      renderProposal(back, proposal);
    } catch (err) {
      $('#scResult', back).innerHTML = `<p class="sub" style="color:var(--tally)">${escapeHtml(err.message)}</p>`;
    }
    btn.disabled = false; btn.textContent = 'Suggest again';
  });
}

function renderProposal(back, p) {
  const rows = p.sources
    .map((s) => `<label class="ep-row"><input type="checkbox" data-sc="${escapeHtml(s.ratingKey)}" checked>
      <span class="ep-title">${escapeHtml(s.title)}</span>
      <span class="ep-no">${s.sourceType}</span></label>`)
    .join('');
  $('#scResult', back).innerHTML = `
    <div class="card" style="margin-top:14px;background:var(--panel-2)">
      <div class="row" style="gap:10px;align-items:flex-end">
        <div class="field" style="flex:1"><label>NAME</label><input id="scName" value="${escapeHtml(p.name)}" style="width:100%"></div>
        <div class="field"><label>CH #</label><input id="scNum" type="number" value="${p.number}" style="width:80px"></div>
        <div class="field"><label>ORDER</label><input id="scMode" value="${escapeHtml(p.orderingMode)}" readonly style="width:130px"></div>
      </div>
      <p class="sub" style="margin:12px 0 4px">Picked ${p.sources.length} — uncheck any you don't want:</p>
      <div class="ep-list" style="max-height:38vh;overflow-y:auto">${rows}</div>
      <button class="primary" id="scCreate" style="margin-top:14px">Create this channel</button>
    </div>`;
  $('#scCreate', back).addEventListener('click', async () => {
    const btn = $('#scCreate', back);
    const keep = $$('[data-sc]', back).filter((b) => b.checked).map((b) => b.dataset.sc);
    const sources = p.sources.filter((s) => keep.includes(s.ratingKey));
    if (!sources.length) return toast('Keep at least one show.', true);
    btn.disabled = true; btn.textContent = 'Creating…';
    try {
      const { id } = await api('/api/channels', {
        method: 'POST',
        body: { name: $('#scName', back).value.trim(), number: Number($('#scNum', back).value), orderingMode: p.orderingMode },
      });
      await api(`/api/channels/${id}/sources`, {
        method: 'POST',
        body: { items: sources.map((s) => ({ ratingKey: s.ratingKey, sourceType: s.sourceType, title: s.title, thumb: s.thumb || null })) },
      });
      back._close();
      toast('Channel created from the suggestion.');
      loadChannels();
      loadStatus();
    } catch (err) {
      toast(err.message, true);
      btn.disabled = false; btn.textContent = 'Create this channel';
    }
  });
}

$('#rebuildAll').addEventListener('click', async () => {
  const btn = $('#rebuildAll');
  btn.disabled = true;
  btn.textContent = 'Rebuilding…';
  try {
    await api('/api/schedule/regenerate', { method: 'POST', body: {} });
    toast('Schedules rebuilt.');
    loadChannels();
  } catch (err) {
    toast(err.message, true);
  }
  btn.disabled = false;
  btn.textContent = 'Rebuild all schedules';
});

$('#kidsToggle').addEventListener('click', async () => {
  const on = !state.status?.kidsMode;
  try {
    await api('/api/kids-mode', { method: 'POST', body: { on } });
    toast(on ? 'Kids Mode on — the TV is now limited to kid-safe channels.' : 'Kids Mode off.');
    await loadStatus();
  } catch (err) { toast(err.message, true); }
});

// ---------------------------------------------------------------- modal

function modal(html, onDismiss) {
  const back = document.createElement('div');
  back.className = 'modal-back';
  // Remember who opened this so focus can go home on close — losing focus to
  // the top of the document is disorienting and is the usual bug here.
  const opener = document.activeElement;
  back.innerHTML = `<div class="modal" role="dialog" aria-modal="true" tabindex="-1">${html}</div>`;
  back._opener = opener;

  // Closing is the same operation however it is triggered, so it happens in one
  // place: unhook the key handler, drop the node, and give focus back.
  const close = () => {
    document.removeEventListener('keydown', onKey);
    back.remove();
    if (opener && document.contains(opener)) opener.focus();
    onDismiss && onDismiss();
  };
  back._close = close;

  const FOCUSABLE =
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  function onKey(e) {
    if (e.key === 'Escape') { close(); return; }
    if (e.key !== 'Tab') return;
    // Trap: Tab used to walk straight out of the dialog and into the page
    // behind it, which is both confusing and lets you operate controls that
    // are visually covered.
    const items = [...back.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null);
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    else if (!back.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
  }

  back.addEventListener('click', (e) => { if (e.target === back) close(); });
  document.addEventListener('keydown', onKey);
  $('#modalHost').append(back);
  // Land focus inside the dialog. Callers that focus a specific field override
  // this immediately afterwards, which is the behaviour we want.
  (back.querySelector(FOCUSABLE) || back.firstElementChild)?.focus();
  return back;
}

// In-app confirmation. Native confirm() can be silently suppressed by the
// browser after a few dialogs ("prevent this page from creating more dialogs"),
// which makes destructive actions look broken. This never gets suppressed.
function confirmModal(message, { danger = false, ok = 'Delete', cancel = 'Cancel' } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const settle = (v) => { if (done) return; done = true; resolve(v); };
    // Dismissing by Escape or a backdrop click means "no". Without this the
    // promise never settled and the caller waited forever — a real hazard now
    // that Escape is a first-class way to leave a dialog.
    const back = modal(`
      <h3>Are you sure?</h3>
      <p class="sub" style="margin:8px 0 20px">${escapeHtml(message)}</p>
      <div class="row" style="justify-content:flex-end;gap:10px">
        <button class="ghost" id="cmCancel">${escapeHtml(cancel)}</button>
        <button class="${danger ? 'danger' : 'primary'}" id="cmOk">${escapeHtml(ok)}</button>
      </div>
    `, () => settle(false));

    const finish = (v) => { if (done) return; back._close(); settle(v); };
    $('#cmOk', back).addEventListener('click', () => finish(true));
    $('#cmCancel', back).addEventListener('click', () => finish(false));
    // The destructive choice is NOT focused by default — Enter should not
    // delete a channel because someone was still typing.
    $('#cmCancel', back).focus();
  });
}

// ---------------------------------------------------------------- settings

function openSettings(channelId, opts = {}) {
  const c = state.channels.find((x) => x.id === channelId);
  if (!c) return;

  // A3: a channel opened straight from "Add channel" is a draft — if the editor
  // is closed WITHOUT saving (Cancel, backdrop, Esc), delete it so a cancel
  // doesn't leave a blank phantom channel.
  let saved = false;
  const discardIfNew = () => {
    if (opts.isNew && !saved) {
      api(`/api/channels/${channelId}`, { method: 'DELETE' })
        .then(() => { loadChannels(); loadStatus(); }).catch(() => {});
    }
  };

  const modes = state.orderingModes
    .map(
      (m) =>
        `<option value="${m.id}" ${m.id === c.orderingMode ? 'selected' : ''}>${m.label}</option>`
    )
    .join('');

  const back = modal(`
    <h3>Channel settings</h3>
    <p class="sub" style="color:var(--dim);font-size:13px;margin:4px 0 20px">
      Changing anything here rebuilds everything that hasn't aired yet.
    </p>

    <div class="row">
      <div class="field"><label>NUMBER</label><input id="fNum" type="number" min="1" max="999" value="${c.number}" style="width:96px"></div>
      <div class="field" style="flex:1"><label>NAME</label><input id="fName" value="${escapeHtml(c.name)}" style="width:100%"></div>
    </div>

    <div class="row" style="margin-top:16px">
      <div class="field" style="flex:1">
        <label>ORDER</label>
        <select id="fMode">${modes}</select>
      </div>
      <div class="field" id="fMarWrap"><label>EPISODES PER RUN</label><input id="fMar" type="number" min="1" max="12" value="${c.marathonSize}" style="width:130px"></div>
    </div>
    <p class="hint" id="modeBlurb"></p>

    <div class="row" style="margin-top:20px">
      <div class="field" style="flex:1">
        <label>BEDTIME — CHANNEL GOES OFF AIR</label>
        <div class="chips" id="bedPresets" style="margin-bottom:10px">
          <button type="button" class="chip-btn" data-bed="">Always on</button>
          <button type="button" class="chip-btn" data-bed="20:00|07:00">Off 8pm – 7am</button>
          <button type="button" class="chip-btn" data-bed="21:00|07:00">Off 9pm – 7am</button>
          <button type="button" class="chip-btn" data-bed="19:30|09:00">Off 7:30pm – 9am</button>
        </div>
        <div class="row" style="align-items:flex-end">
          <div class="field"><label>OFF AT</label><input id="fDarkStart" type="time" value="${c.darkStart || ''}"></div>
          <div class="field"><label>BACK AT</label><input id="fDarkEnd" type="time" value="${c.darkEnd || ''}"></div>
        </div>
      </div>
    </div>
    <p class="hint">During off-air hours the channel shows colour bars — handy for a kids' channel at bedtime.</p>

    <details style="margin-top:22px">
      <summary style="cursor:pointer;font:600 13px var(--mono);letter-spacing:.08em;color:var(--dim)">ADVANCED — COMMERCIALS &amp; TIMING</summary>
      <div style="margin-top:16px">
        <div class="row">
          <div class="field">
            <label>ADS</label>
            <label style="display:flex;gap:8px;align-items:center;font-family:var(--sans);font-size:14px;color:var(--tape);letter-spacing:0">
              <input id="fAds" type="checkbox" ${c.adsEnabled ? 'checked' : ''}> Run commercials
            </label>
          </div>
          <div class="field"><label>MAX PER BREAK</label><input id="fMaxAds" type="number" min="0" max="30" value="${c.maxAdsPerBreak}" style="width:110px"></div>
          <div class="field" style="flex:1"><label>AD TAGS (OPTIONAL)</label><input id="fTags" value="${escapeHtml(c.adTags || '')}" placeholder="90s, toys" style="width:100%"></div>
        </div>
        <div class="row" style="margin-top:16px">
          <div class="field"><label>AD TIMING</label>
            <select id="fTiming">
              <option value="continuous" ${c.timingMode === 'continuous' ? 'selected' : ''}>Continuous — exact ad count</option>
              <option value="grid" ${c.timingMode === 'grid' ? 'selected' : ''}>Grid — lands on :00 / :30</option>
              <option value="auto" ${c.timingMode === 'auto' ? 'selected' : ''}>Auto — slot rounded to 5 min</option>
            </select>
          </div>
          <div class="field"><label>ADS BETWEEN SHOWS</label><input id="fAdsBetween" type="number" min="0" max="20" value="${c.adsBetween ?? 4}" style="width:120px"></div>
          <div class="field"><label>REPEAT COOLDOWN (days)</label><input id="fCooldown" type="number" min="0" max="30" value="${c.cooldownDays ?? 0}" style="width:130px"></div>
          <div class="field"><label>WHEN A PINNED EVENT HITS</label>
            <select id="fOverrun">
              <option value="protect" ${c.overrunPolicy === 'protect' ? 'selected' : ''}>Protect — finish the show first</option>
              <option value="cutin" ${c.overrunPolicy === 'cutin' ? 'selected' : ''}>Cut in — hard cut to the event</option>
            </select>
          </div>
        </div>
      </div>
    </details>

    <details style="margin-top:18px">
      <summary style="cursor:pointer;font:600 13px var(--mono);letter-spacing:.08em;color:var(--dim)">SIGN-OFF — WHAT HAPPENS WHEN IT GOES DARK</summary>
      <div style="margin-top:16px">
        <div class="row">
          <div class="field" style="flex:1">
            <label>SIGN-OFF FILM (OPTIONAL)</label>
            <select id="fSignoff">
              <option value="">Nothing — go straight to off air</option>
              ${(state.assets || []).filter((a) => a.kind === 'bumper')
                .map((a) => `<option value="${a.id}" ${c.signoffAssetId === a.id ? 'selected' : ''}>${escapeHtml(a.title)}</option>`).join('')}
            </select>
          </div>
          <div class="field" style="flex:1">
            <label>OFF-AIR SCREEN</label>
            <select id="fOffair">
              <option value="bars" ${(c.offairPattern || 'bars') === 'bars' ? 'selected' : ''}>Colour bars</option>
              <option value="snow" ${c.offairPattern === 'snow' ? 'selected' : ''}>Snow</option>
              <option value="card" ${c.offairPattern === 'card' ? 'selected' : ''}>Station card</option>
            </select>
          </div>
        </div>
        <p class="hint">
          Plays once at the start of a dark window, then the screen you pick until
          sign-on. Needs dark hours or an off-air rule to have anything to sign off
          from — and it is skipped if the window is too short to finish it.
        </p>
      </div>
    </details>

    <details style="margin-top:18px">
      <summary style="cursor:pointer;font:600 13px var(--mono);letter-spacing:.08em;color:var(--dim)">VIBE — HOW THIS CHANNEL LOOKS</summary>
      <div style="margin-top:16px">
        <div class="row">
          <div class="field" style="flex:1">
            <label>LOOK</label>
            <select id="fVibe" data-current="${escapeHtml(vibeNameOf(c.vibe))}">
              <option value="">Use the default look</option>
              <option value="off">Off — clean picture</option>
              <option value="crt">CRT — a tidy set in good condition</option>
              <option value="vhs">VHS — a tape that's been played a lot</option>
              <option value="rough">Rough — bent aerial, bar in the corner</option>
            </select>
          </div>
        </div>
        <p class="hint">
          4:3 cropping, scanlines, vignette, grain and dead pixels — all drawn
          over the picture, so nothing is re-encoded and playback is untouched.
          Set the default for every channel under Settings.
        </p>
      </div>
    </details>

    <div class="row" style="margin-top:26px;justify-content:flex-end">
      <button class="ghost" id="fCancel">Cancel</button>
      <button class="ghost" id="fRefresh">Re-read from Plex</button>
      <button class="primary" id="fSave">Save changes</button>
    </div>
  `, discardIfNew);

  const blurb = () => {
    const m = state.orderingModes.find((x) => x.id === $('#fMode', back).value);
    $('#modeBlurb', back).textContent = m ? m.blurb : '';
    $('#fMarWrap', back).style.display =
      $('#fMode', back).value === 'marathon' ? '' : 'none';
  };
  $('#fMode', back).addEventListener('change', blurb);
  // Show the channel's current look. A channel with no vibe of its own stays on
  // "use the default", which is the honest reading of NULL.
  $('#fVibe', back).value = $('#fVibe', back).dataset.current || '';
  blurb();

  // Bedtime quick-presets fill the time inputs (and highlight the active one).
  const syncBed = () => {
    const cur = `${$('#fDarkStart', back).value}|${$('#fDarkEnd', back).value}`;
    $$('#bedPresets .chip-btn', back).forEach((b) =>
      b.classList.toggle('on', (b.dataset.bed || '|') === (cur === '|' ? '' : cur)));
  };
  $$('#bedPresets .chip-btn', back).forEach((btn) =>
    btn.addEventListener('click', () => {
      const [s, e] = (btn.dataset.bed || '').split('|');
      $('#fDarkStart', back).value = s || '';
      $('#fDarkEnd', back).value = e || '';
      syncBed();
    }));
  $('#fDarkStart', back).addEventListener('input', syncBed);
  $('#fDarkEnd', back).addEventListener('input', syncBed);
  syncBed();

  $('#fCancel', back).addEventListener('click', () => { back._close(); discardIfNew(); });

  $('#fRefresh', back).addEventListener('click', async () => {
    const b = $('#fRefresh', back);
    b.disabled = true;
    b.textContent = 'Reading…';
    try {
      const r = await api(`/api/channels/${c.id}/refresh`, { method: 'POST' });
      const total = r.results.reduce((n, x) => n + (x.cached || 0), 0);
      toast(`Re-read ${total} items from Plex.`);
      loadChannels();
    } catch (err) {
      toast(err.message, true);
    }
    b.disabled = false;
    b.textContent = 'Re-read from Plex';
  });

  $('#fSave', back).addEventListener('click', async () => {
    const b = $('#fSave', back);
    b.disabled = true;
    b.textContent = 'Saving…';
    try {
      saved = true;   // A3: committed — the draft is now kept, not discarded
      await api(`/api/channels/${c.id}`, {
        method: 'PATCH',
        body: {
          number: Number($('#fNum', back).value),
          name: $('#fName', back).value,
          orderingMode: $('#fMode', back).value,
          marathonSize: Number($('#fMar', back).value),
          adsEnabled: $('#fAds', back).checked,
          signoffAssetId: $('#fSignoff', back).value ? Number($('#fSignoff', back).value) : null,
          offairPattern: $('#fOffair', back).value,
          // L-V1: '' means inherit the global default (stored as NULL).
          vibe: (() => {
            const v = $('#fVibe', back).value;
            return v === '' ? null : (state.vibePresets?.[v] ?? null);
          })(),
          maxAdsPerBreak: Number($('#fMaxAds', back).value),
          adTags: $('#fTags', back).value,
          timingMode: $('#fTiming', back).value,
          adsBetween: Number($('#fAdsBetween', back).value),
          cooldownDays: Number($('#fCooldown', back).value),
          overrunPolicy: $('#fOverrun', back).value,
          darkStart: $('#fDarkStart', back).value,
          darkEnd: $('#fDarkEnd', back).value,
        },
      });
      back._close();
      toast('Saved. Schedule rebuilt.');
      loadChannels();
    } catch (err) {
      toast(err.message, true);
      b.disabled = false;
      b.textContent = 'Save changes';
    }
  });
}

// ---------------------------------------------------------------- library picker

async function openPicker(channelId) {
  const back = modal(`
    <h3>Add content</h3>
    <p class="sub" style="color:var(--dim);font-size:13px;margin:4px 0 18px">
      Pick shows or movies. Everything inside a show gets pulled in.
    </p>
    <div class="row" style="margin-bottom:16px">
      <div class="field" style="flex:1">
        <label>LIBRARY</label>
        <select id="pSection" style="width:100%"><option>Loading…</option></select>
      </div>
      <div class="field" style="flex:1">
        <label>SEARCH</label>
        <input id="pFilter" placeholder="Search shows and movies" style="width:100%">
      </div>
    </div>
    <div class="picker-grid" id="pGrid">${loadingHTML('Connected — loading library…')}</div>
    <div class="row" style="margin-top:20px;justify-content:space-between;align-items:center">
      <span class="hint" id="pCount" style="margin:0">Nothing selected</span>
      <span>
        <button class="ghost" id="pCancel">Cancel</button>
        <button class="primary" id="pAdd" disabled>Add to channel</button>
      </span>
    </div>
  `);

  const selected = new Map();
  let items = [];

  $('#pCancel', back).addEventListener('click', () => back._close());

  try {
    if (state.sections.length === 0) {
      const s = await api('/api/library/sections');
      state.sections = s.sections.filter((x) => x.type === 'show' || x.type === 'movie');
    }
  } catch { /* Plex not linked / unreachable — content packs still work below */ }

  // Always offer content packs (no Plex needed), plus any Plex libraries (C3).
  $('#pSection', back).innerHTML =
    state.sections.map((s) => `<option value="${s.key}|${s.type}">${escapeHtml(s.title)}</option>`).join('')
    + '<option value="__packs__|pack">📦 Content packs</option>';

  // BUILD THE GRID ONCE PER SECTION. Filtering hides tiles (see applyFilter)
  // rather than re-running innerHTML.
  //
  // This used to re-render every tile on EVERY KEYSTROKE, which is what the
  // "I have to scroll before the images load" report was really about: each
  // rebuild destroyed every <img> mid-flight and started the loads again from
  // scratch, so on a library of any size the artwork never got to finish while
  // you were still typing. Scrolling afterwards was simply the first moment the
  // DOM stood still long enough. Keeping the nodes alive also makes typing
  // instant and stops re-attaching a click listener per tile per keystroke.
  const draw = () => {
    $('#pGrid', back).innerHTML =
      items
        .map((i, idx) => {
          const on = selected.has(String(i.ratingKey));
          // The first screenful loads eagerly so something is on screen without
          // touching the scroll wheel; the rest stays lazy so a 2000-title
          // library doesn't fire 2000 requests at once. Every one of these is a
          // server-side round trip to Plex through /api/image.
          const art = i.image
            ? `<img src="${i.image}" alt=""${idx < 24 ? '' : ' loading="lazy"'}>`
            : `<div class="ph">no art</div>`;
          const count =
            i.leafCount != null ? `${i.leafCount} eps` : i.year ? String(i.year) : '';
          return `<button class="pick ${on ? 'on' : ''}" data-k="${i.ratingKey}"
                    data-title="${escapeHtml(i.title.toLowerCase())}">
            ${art}
            <span class="cap">${escapeHtml(i.title)}<br><small>${count}</small></span>
          </button>`;
        })
        .join('')
      + '<div id="pNone" hidden style="color:var(--dim);padding:20px">Nothing matches that.</div>';

    $$('.pick', back).forEach((b) =>
      b.addEventListener('click', () => {
        const key = b.dataset.k;
        const item = items.find((i) => String(i.ratingKey) === key);
        if (selected.has(key)) selected.delete(key);
        else selected.set(key, item);
        b.classList.toggle('on');
        $('#pCount', back).textContent = selected.size
          ? `${selected.size} selected`
          : 'Nothing selected';
        $('#pAdd', back).disabled = selected.size === 0;
      })
    );
    applyFilter();   // a section loaded while the box has text in it still filters
  };

  /// Show/hide the tiles that already exist. No DOM rebuild, so artwork that has
  /// loaded stays loaded and in-flight requests are never cancelled.
  const applyFilter = () => {
    const q = $('#pFilter', back).value.trim().toLowerCase();
    let any = false;
    $$('.pick', back).forEach((b) => {
      const hit = !q || (b.dataset.title || '').includes(q);
      b.hidden = !hit;
      if (hit) any = true;
    });
    const none = $('#pNone', back);
    if (none) none.hidden = any;
  };

  // C3: the "Content packs" pseudo-library — installed packs are selectable
  // sources; not-installed ones are greyed with a Download button right here.
  const drawPacks = async () => {
    let data;
    try { data = await api('/api/packs'); }
    catch (err) { $('#pGrid', back).innerHTML = `<div style="color:var(--tally);padding:20px">${escapeHtml(err.message)}</div>`; return; }
    const packs = data.packs.filter((p) => p.kind !== 'ads');
    items = packs.filter((p) => p.installed).map((p) => ({
      ratingKey: `pack:${p.id}`, title: p.name, sourceType: 'pack',
    }));
    $('#pGrid', back).innerHTML = packs.map((p) => {
      const key = `pack:${p.id}`;
      const sub = `${p.installedItemCount ?? p.itemCount} items · ${Math.round((p.runtimeMs || 0) / 60000)} min`;
      // data-title on both branches: the packs pseudo-library shares #pGrid with
      // the Plex grid, so it goes through the same applyFilter — without it,
      // typing anything here would hide every pack.
      const t = escapeHtml(p.name.toLowerCase());
      if (!p.installed) {
        const dl = p.progress && p.progress.state === 'downloading'
          ? `<span class="pack-state" style="font-size:11px">${downloadStatus(p.progress)}</span>`
          : `<button class="ghost" data-pack-dl="${p.id}" style="font-size:11px;padding:4px 8px">Download</button>`;
        return `<div class="pick off" data-title="${t}" style="opacity:.55;cursor:default">
          <div class="ph">not installed</div>
          <span class="cap">${escapeHtml(p.name)}<br><small>${sub}</small><br>${dl}</span></div>`;
      }
      const on = selected.has(key);
      return `<button class="pick ${on ? 'on' : ''}" data-k="${key}" data-title="${t}">
        <div class="ph">📦</div>
        <span class="cap">${escapeHtml(p.name)}<br><small>${sub}</small></span></button>`;
    }).join('')
      + '<div id="pNone" hidden style="color:var(--dim);padding:20px">Nothing matches that.</div>';

    $$('.pick[data-k]', back).forEach((b) => b.addEventListener('click', () => {
      const k = b.dataset.k;
      if (selected.has(k)) selected.delete(k);
      else selected.set(k, items.find((i) => i.ratingKey === k));
      b.classList.toggle('on');
      $('#pCount', back).textContent = selected.size ? `${selected.size} selected` : 'Nothing selected';
      $('#pAdd', back).disabled = selected.size === 0;
    }));
    $$('[data-pack-dl]', back).forEach((b) => b.addEventListener('click', async () => {
      try { await api(`/api/packs/${b.dataset.packDl}/install`, { method: 'POST' }); toast('Downloading pack…'); }
      catch (e) { toast(e.message, true); }
    }));
    applyFilter();
  };

  const loadSection = async () => {
    const [key, type] = $('#pSection', back).value.split('|');
    $('#pGrid', back).innerHTML = loadingHTML('Connected — loading content…');
    if (key === '__packs__') { await drawPacks(); return; }
    try {
      const r = await api(`/api/library/sections/${key}/items?type=${type}`);
      items = r.items;
      draw();
    } catch (err) {
      $('#pGrid', back).innerHTML = `<div style="color:var(--tally);padding:20px">${escapeHtml(err.message)}</div>`;
    }
  };

  $('#pSection', back).addEventListener('change', loadSection);
  $('#pFilter', back).addEventListener('input', applyFilter);
  await loadSection();

  $('#pAdd', back).addEventListener('click', async () => {
    const b = $('#pAdd', back);
    b.disabled = true;
    b.textContent = 'Adding…';
    const [, type] = $('#pSection', back).value.split('|');
    try {
      const r = await api(`/api/channels/${channelId}/sources`, {
        method: 'POST',
        body: {
          items: [...selected.values()].map((i) => ({
            ratingKey: i.ratingKey,
            sourceType: i.sourceType || (type === 'movie' ? 'movie' : 'show'),
            title: i.title,
            thumb: i.thumb || null,   // doubles as the channel's artwork
          })),
        },
      });
      const total = r.results.reduce((n, x) => n + (x.cached || 0), 0);
      const bad = r.results.filter((x) => x.error);
      back._close();
      toast(
        `Added ${total} items.` + (bad.length ? ` ${bad.length} source(s) had trouble.` : '')
      );
      loadChannels();
      loadStatus();
    } catch (err) {
      toast(err.message, true);
      b.disabled = false;
      b.textContent = 'Add to channel';
    }
  });
}

// ---------------------------------------------------------------- guide

$('#guidePrev').addEventListener('click', () => {
  state.guideFrom -= state.guideHours * 3600_000;
  loadGuide();
});
$('#guideNext').addEventListener('click', () => {
  state.guideFrom += state.guideHours * 3600_000;
  loadGuide();
});
$('#guideNow').addEventListener('click', () => {
  state.guideFrom = Date.now();
  loadGuide();
});
$('#guideHours').addEventListener('change', (e) => {
  state.guideHours = Number(e.target.value);
  loadGuide();
});

async function loadGuide() {
  const from = state.guideFrom;
  const hours = state.guideHours;
  let g;
  try {
    g = await api(`/api/guide?from=${from}&hours=${hours}`);
  } catch (err) {
    $('#guideGrid').innerHTML = `<div style="padding:24px">${escapeHtml(err.message)}</div>`;
    return;
  }

  $('#guideDay').textContent = new Date(from).toLocaleDateString([], {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
  $('#guideClock').textContent = clock(Date.now());

  if (g.channels.length === 0) {
    $('#guideGrid').innerHTML =
      '<div style="padding:40px;text-align:center;color:#cdd6ff">No channels to list yet.</div>';
    return;
  }

  // Half-hour columns, anchored to the half hour before `from`.
  const slotMs = 30 * 60_000;
  const start = Math.floor(from / slotMs) * slotMs;
  const cols = Math.ceil((hours * 3600_000) / slotMs);
  const grid = $('#guideGrid');
  grid.style.gridTemplateColumns = `170px repeat(${cols}, minmax(150px, 1fr))`;

  let html = '<div class="g-chan" style="background:rgba(0,0,0,.4)"></div>';
  for (let i = 0; i < cols; i++) {
    html += `<div class="g-time">${clock(start + i * slotMs)}</div>`;
  }

  for (const ch of g.channels) {
    html += `<div class="g-chan">
      <div class="n">${String(ch.number).padStart(2, '0')}</div>
      <div class="t">${escapeHtml(ch.name)}</div>
    </div>`;

    for (let i = 0; i < cols; i++) {
      const cellStart = start + i * slotMs;
      const cellEnd = cellStart + slotMs;
      const p = ch.programs.find((x) => x.startUtc < cellEnd && x.endUtc > cellStart);

      if (!p) {
        const live = Date.now() >= cellStart && Date.now() < cellEnd;
        html += `<div class="g-slot ${live ? 'live' : ''}"><div class="ps">—</div></div>`;
        continue;
      }
      // Merge the columns this program covers into ONE block (no "(cont.)" spam)
      // — a 2½-hour movie reads as a single wide cell, like a printed guide.
      let span = 1;
      while (i + span < cols && p.endUtc > start + (i + span) * slotMs) span++;
      const blockEnd = start + (i + span) * slotMs;
      const live = Date.now() >= cellStart && Date.now() < blockEnd;
      const ep =
        p.seasonNo != null && p.episodeNo != null
          ? `S${String(p.seasonNo).padStart(2, '0')}E${String(p.episodeNo).padStart(2, '0')} `
          : '';
      html += `<div class="g-slot ${p.kind === 'offair' ? 'offair' : ''} ${live ? 'live' : ''}" style="grid-column: span ${span}">
        <div class="pt">${escapeHtml(p.title)}</div>
        <div class="ps">${p.subtitle ? ep + escapeHtml(p.subtitle) : `${clock(p.startUtc)} – ${clock(p.endUtc)}`}</div>
      </div>`;
      i += span - 1;
    }
  }

  grid.innerHTML = html;

  // Red playhead, positioned across the time columns.
  const now = Date.now();
  if (now >= start && now <= start + cols * slotMs) {
    const frac = (now - start) / (cols * slotMs);
    const head = document.createElement('div');
    head.className = 'playhead';
    head.style.left = `calc(170px + (100% - 170px) * ${frac})`;
    grid.append(head);
  }
}

// ---------------------------------------------------------------- assets

// ---------------------------------------------------------------- channel packs

// ── local folders (Track I, P5/P6) ──────────────────────────────────────────
//
// One UI, two grant models. On a Pi/Windows/Docker install there is no sandbox,
// so a path is enough and you type one. On a Mac the app IS sandboxed: it has
// to be handed the folder through a native panel, and permission only survives
// a relaunch as a security-scoped bookmark — so the grant happens in the Mac
// app's menu and everything afterwards happens right here.
//
// The wire shape is identical on both backends, so this function does not care
// which one it is talking to; only the "how do I add one" affordance differs.
async function loadLocalFolders() {
  const list = $('#localFolders');
  const add = $('#localAdd');
  if (!list) return;

  let folders = [];
  try { ({ folders } = await api('/api/local-folders')); }
  catch { list.innerHTML = ''; add.innerHTML = ''; return; }   // older backend — hide the whole block

  list.innerHTML = folders.length ? folders.map((f) => `
    <div class="chan" style="grid-template-columns:1fr auto;align-items:center">
      <div>
        <b>${escapeHtml(f.name)}</b>
        ${f.missing ? '<span class="chip" style="color:var(--tally)">NOT FOUND</span>' : ''}
        ${f.hasChannel ? '<span class="chip">ON AIR</span>' : ''}
        <div class="sub mono" style="font-size:12px">${escapeHtml(f.path)}</div>
        <div class="sub" style="font-size:12px">
          ${f.itemCount} item${f.itemCount === 1 ? '' : 's'}${f.lastScan ? ` · scanned ${fmtDay(f.lastScan)}` : ''}
        </div>
      </div>
      <div class="chan-actions">
        ${f.hasChannel ? '' : `<button class="sm" data-lf-channel="${escapeHtml(f.folderId)}">Make a channel</button>`}
        <button class="sm" data-lf-rescan="${escapeHtml(f.folderId)}">Rescan</button>
        <button class="sm ghost" data-lf-forget="${escapeHtml(f.folderId)}">Remove</button>
      </div>
    </div>`).join('') : '';

  // The missing-folder case is worth explaining rather than leaving as a chip:
  // it is nearly always an unplugged drive, not a broken app.
  if (folders.some((f) => f.missing)) {
    list.insertAdjacentHTML('beforeend',
      `<p class="hint" style="color:var(--tally)">A folder above is not where it was — usually an unplugged drive. Its channel keeps its place and starts playing again when the folder comes back.</p>`);
  }

  const native = state.status && state.status.platform !== 'node';
  add.innerHTML = native
    ? `<p class="hint">${folders.length ? '' : 'No folders yet. '}To add one, use <b>Channel ▸ Add Local Folder…</b> in the dumbTV menu bar on the Mac itself — macOS only lets an app read a folder you hand it directly.</p>`
    : `<div class="row" style="align-items:flex-end;gap:10px;margin-top:12px">
         <div class="field" style="flex:1">
           <label>FOLDER PATH ON THIS MACHINE</label>
           <input id="lfPath" placeholder="/media/cartoons" style="width:100%">
         </div>
         <button class="primary" id="lfAdd">Add folder</button>
       </div>`;

  list.querySelectorAll('[data-lf-rescan]').forEach((b) => (b.onclick = async () => {
    b.disabled = true; b.textContent = 'Scanning…';
    try {
      const r = await api(`/api/local-folders/${encodeURIComponent(b.dataset.lfRescan)}/rescan`, { method: 'POST', body: {} });
      toast(`Found ${r.items} item${r.items === 1 ? '' : 's'}.`);
    } catch (e) { toast(e.message, true); }
    loadLocalFolders();
  }));
  list.querySelectorAll('[data-lf-channel]').forEach((b) => (b.onclick = async () => {
    try {
      await api(`/api/local-folders/${encodeURIComponent(b.dataset.lfChannel)}/channel`, { method: 'POST', body: {} });
      toast('Channel created.');
      loadLocalFolders(); loadChannels();
    } catch (e) { toast(e.message, true); }
  }));
  list.querySelectorAll('[data-lf-forget]').forEach((b) => (b.onclick = async () => {
    if (!(await confirmModal('Remove this folder? Its files stay on disk. Any channel using it keeps its place and stands by until you add the folder again.', { danger: true, ok: 'Remove' }))) return;
    try { await api(`/api/local-folders/${encodeURIComponent(b.dataset.lfForget)}`, { method: 'DELETE' }); }
    catch (e) { return toast(e.message, true); }
    toast('Folder removed.');
    loadLocalFolders();
  }));

  const addBtn = $('#lfAdd');
  if (addBtn) addBtn.onclick = async () => {
    const p = $('#lfPath').value.trim();
    if (!p) return toast('Enter a folder path.', true);
    addBtn.disabled = true; addBtn.textContent = 'Scanning…';
    try {
      const r = await api('/api/local-folders', { method: 'POST', body: { path: p } });
      toast(`Added ${r.added} item${r.added === 1 ? '' : 's'}.`);
    } catch (e) { toast(e.message, true); }
    addBtn.disabled = false; addBtn.textContent = 'Add folder';
    loadLocalFolders();
  };
}

async function loadPacks() {
  loadLocalFolders();
  const host = $('#packList');
  if (!host.children.length) host.innerHTML = '<p class="hint">Loading…</p>';
  let data;
  try { data = await api('/api/packs'); }
  catch (e) { host.innerHTML = `<p class="hint">${escapeHtml(e.message)}</p>`; return; }
  if (!data.packs.length) { host.innerHTML = '<p class="hint">No packs available.</p>'; return; }
  host.innerHTML = data.packs.map(packCard).join('');
  host.querySelectorAll('[data-pack-install]').forEach((b) => (b.onclick = () => packInstall(b.dataset.packInstall)));
  host.querySelectorAll('[data-pack-channel]').forEach((b) => (b.onclick = () => packChannel(b.dataset.packChannel)));
  host.querySelectorAll('[data-pack-remove]').forEach((b) => (b.onclick = () => packRemove(b.dataset.packRemove)));
  // Keep the view live while a download runs.
  clearTimeout(loadPacks._t);
  if (data.packs.some((p) => p.progress && p.progress.state === 'downloading')) {
    loadPacks._t = setTimeout(loadPacks, 1500);
  }
}

function packCard(p) {
  const size = p.downloadBytes ? `${Math.round(p.downloadBytes / 1e6)} MB` : '';
  const runtime = p.runtimeMs ? `${Math.round(p.runtimeMs / 60000)} min` : '';
  // A bundled preload may ship a subset (e.g. 1 Superman episode of 17).
  const partial = p.installed && p.kind !== 'ads'
    && p.installedItemCount != null && p.installedItemCount < p.itemCount;
  const meta = [
    partial ? `${p.installedItemCount} of ${p.itemCount} items` : `${p.itemCount} ${p.kind === 'ads' ? 'spots' : 'items'}`,
    runtime, size,
  ].filter(Boolean).join(' · ');
  const prog = p.progress;
  let actions;
  if (prog && prog.state === 'downloading') {
    actions = `<span class="pack-state">${downloadStatus(prog)}</span>`;
  } else if (prog && prog.state === 'error') {
    actions = `<span class="pack-state bad">Failed</span> <button class="ghost" data-pack-install="${p.id}">Retry</button>`;
  } else if (!p.installed) {
    actions = `<button class="primary" data-pack-install="${p.id}">Install${size ? ` · ${size}` : ''}</button>`;
  } else if (p.kind === 'ads') {
    actions = `<span class="pack-state ok">Ad content added ✓</span> <button class="ghost" data-pack-remove="${p.id}">Remove</button>`;
  } else {
    // Installed shows pack: create-channel (or ✓), an optional "download the
    // rest" when partial (C-1), and remove.
    const parts = [];
    parts.push(p.hasChannel
      ? `<span class="pack-state ok">Channel added ✓</span>`
      : `<button class="primary" data-pack-channel="${p.id}">Create channel</button>`);
    if (partial) parts.push(`<button class="ghost" data-pack-install="${p.id}">Download all ${p.itemCount}${size ? ` · ${size}` : ''}</button>`);
    parts.push(`<button class="ghost" data-pack-remove="${p.id}">Remove</button>`);
    actions = parts.join(' ');
  }
  return `<div class="packcard">
    <div>
      <div class="packcard-name">${escapeHtml(p.name)}</div>
      <div class="packcard-desc">${escapeHtml(p.description || '')}</div>
      <div class="packcard-meta">${escapeHtml(meta)}</div>
    </div>
    <div class="packcard-actions">${actions}</div>
  </div>`;
}

async function packInstall(id) {
  try { await api(`/api/packs/${id}/install`, { method: 'POST' }); toast('Downloading pack…'); loadPacks(); }
  catch (e) { toast(e.message, true); }
}
async function packChannel(id) {
  try { await api(`/api/packs/${id}/channel`, { method: 'POST', body: {} }); toast('Channel created — it’s on the air'); loadPacks(); }
  catch (e) { toast(e.message, true); }
}
async function packRemove(id) {
  try { await api(`/api/packs/${id}`, { method: 'DELETE' }); toast('Pack removed'); loadPacks(); }
  catch (e) { toast(e.message, true); }
}

async function loadAssets() {
  const data = await api('/api/assets');
  state.assets = data.assets;

  const total = state.assets.length;
  const ads = state.assets.filter((a) => a.kind === 'ad').length;
  const secs = state.assets.reduce((n, a) => n + a.duration_ms, 0) / 1000;
  $('#assetSummary').textContent = total
    ? `${total} files — ${ads} commercials, ${total - ads} bumpers, ${Math.round(secs / 60)} minutes total.`
    : 'Nothing imported yet. Drop some files in and scan.';

  $('#assetTable').innerHTML = total
    ? `<thead><tr><th>TITLE</th><th>KIND</th><th>SOURCE</th><th>LENGTH</th><th>TAGS</th><th></th></tr></thead>
       <tbody>${state.assets
         .map(
           (a) => `<tr>
             <td>${escapeHtml(a.title)}</td>
             <td class="mono">${a.kind}</td>
             <td class="mono">${a.part_key ? 'Plex' : 'local'}</td>
             <td class="mono">${(a.duration_ms / 1000).toFixed(1)}s</td>
             <td class="mono">${escapeHtml(a.tags || '—')}</td>
             <td style="text-align:right"><button class="sm danger" data-ad="${a.id}">Remove</button></td>
           </tr>`
         )
         .join('')}</tbody>`
    : '';

  $$('[data-ad]').forEach((b) =>
    b.addEventListener('click', async () => {
      await api(`/api/assets/${b.dataset.ad}`, { method: 'DELETE' });
      loadAssets();
    })
  );
}

$('#scanAssets').addEventListener('click', async () => {
  const b = $('#scanAssets');
  b.disabled = true;
  b.textContent = 'Scanning…';
  try {
    const r = await api('/api/assets/scan', { method: 'POST' });
    toast(
      `Added ${r.added}. ${r.skipped ? `Skipped ${r.skipped} we couldn't read. ` : ''}${r.total} total.`
    );
    loadAssets();
    loadStatus();
  } catch (err) {
    toast(err.message, true);
  }
  b.disabled = false;
  b.textContent = 'Scan for new files';
});

// Populate the Plex library picker for commercial import.
async function loadAdSections() {
  const sel = $('#adSection');
  if (!sel) return;
  try {
    const { sections } = await api('/api/library/sections');
    if (!sections || sections.length === 0) {
      sel.innerHTML = '<option value="">No Plex libraries found</option>';
      return;
    }
    sel.innerHTML = sections
      .map((s) => `<option value="${s.key}">${escapeHtml(s.title)} (${s.type})</option>`)
      .join('');
  } catch {
    sel.innerHTML = '<option value="">Link Plex first…</option>';
  }
}

$('#importPlexAds').addEventListener('click', async () => {
  const b = $('#importPlexAds');
  const sectionKey = $('#adSection').value;
  if (!sectionKey) return toast('Pick a Plex library first.', true);
  b.disabled = true;
  b.textContent = 'Importing…';
  try {
    const r = await api('/api/assets/import-plex', {
      method: 'POST',
      body: { sectionKey },
    });
    toast(`Imported ${r.imported} commercial${r.imported === 1 ? '' : 's'} from Plex.`);
    loadAssets();
    loadStatus();
  } catch (err) {
    toast(err.message, true);
  }
  b.disabled = false;
  b.textContent = 'Import commercials';
});

$('#refreshPlexAds').addEventListener('click', async () => {
  const b = $('#refreshPlexAds');
  b.disabled = true;
  b.textContent = 'Refreshing…';
  try {
    const r = await api('/api/assets/refresh-plex', { method: 'POST' });
    const n = (r.results || []).reduce((sum, x) => sum + (x.imported || 0), 0);
    toast(r.sections.length ? `Re-pulled ${n} from ${r.sections.length} Plex librar${r.sections.length === 1 ? 'y' : 'ies'}.` : 'No Plex ad libraries saved yet.');
    loadAssets();
  } catch (err) {
    toast(err.message, true);
  }
  b.disabled = false;
  b.textContent = 'Refresh';
});

// ---------------------------------------------------------------- setup

function applyBackendPanel(backend) {
  const jelly = backend === 'jellyfin';
  $('#plexPanel').style.display = jelly ? 'none' : '';
  $('#jellyPanel').style.display = jelly ? '' : 'none';
  $('#bePlex').classList.toggle('primary', !jelly);
  $('#beJelly').classList.toggle('primary', jelly);
  $('#beActive').textContent = jelly ? 'Using Jellyfin' : 'Using Plex';
}

async function loadJellyfin() {
  try {
    const j = await api('/api/jellyfin/status');
    if (j.server) {
      $('#jellyStatus').innerHTML = `<span style="color:var(--phosphor)">Connected to ${escapeHtml(j.server.name || j.server.url)}.</span>`;
      $('#jfUrl').value = j.server.url || '';
      $('#jfLogout').style.display = 'inline-block';
    } else {
      $('#jfLogout').style.display = 'none';
    }
  } catch {}
}

async function loadSetup() {
  const s = state.status;
  if (!s) return;

  applyBackendPanel(s.backend || 'plex');
  loadJellyfin();

  // The iOS local-network permission is the one bit of platform-specific setup
  // advice that matters, and it belongs here rather than as an overlay on the TV
  // (F6). Only iPhone/iPad has the prompt.
  $('#lanCard').style.display = s.platform === 'ios' ? '' : 'none';

  // (Build 12 disabled this toggle on the native app as honest signposting —
  // Jellyfin only worked on Node. Build 13's J1 closed that gap: the embedded
  // Swift server implements the same endpoints, so the switch is live again on
  // every platform.)

  if (s.linked && s.backend !== 'jellyfin') {
    $('#linkBody').innerHTML = `<p style="color:var(--phosphor);margin:0">Linked to Plex.</p>`;
    $('#serverCard').style.display = '';
    try {
      const { servers } = await api('/api/plex/servers');
      $('#serverList').innerHTML = servers
        .map(
          (sv) => `<div class="row" style="align-items:center;padding:10px 0;border-bottom:1px solid var(--line)">
            <div style="flex:1">
              <strong>${escapeHtml(sv.name)}</strong>
              <div class="mono" style="font-size:11.5px;color:var(--dim)">${escapeHtml(sv.uri)}</div>
              ${sv.relayOnly ? '<div style="color:var(--tally);font-size:12px;margin-top:4px">Only reachable through Plex relay — direct play will struggle. Get this on the same network if you can.</div>' : ''}
            </div>
            <button class="sm ${s.server && (s.server.uri === sv.uri || s.server.name === sv.name) ? '' : 'primary'}" data-sv='${escapeHtml(JSON.stringify(sv))}'>
              ${s.server && (s.server.uri === sv.uri || s.server.name === sv.name) ? '● In use' : 'Use this one'}
            </button>
          </div>`
        )
        .join('');
      $$('[data-sv]').forEach((b) =>
        b.addEventListener('click', async () => {
          await api('/api/plex/server', { method: 'POST', body: JSON.parse(b.dataset.sv) });
          toast('Server selected.');
          await loadStatus();
          loadSetup();
        })
      );
    } catch (err) {
      $('#serverList').innerHTML = `<p style="color:var(--tally)">${escapeHtml(err.message)}</p>`;
    }

  }

  // The library list is backend-agnostic (/api/library/sections dispatches
  // server-side), so it renders for whichever server is connected — Plex or
  // Jellyfin. It used to live inside the Plex-only branch above.
  if (s.server) {
    $('#libCard').style.display = '';
    try {
      const { sections } = await api('/api/library/sections');
      $('#libList').innerHTML = sections
        .map(
          (x) =>
            `<span class="chip">${escapeHtml(x.title)} <span class="n">${x.type}</span></span>`
        )
        .join(' ');
    } catch (err) {
      $('#libList').innerHTML = `<p style="color:var(--tally)">${escapeHtml(err.message)}</p>`;
    }
  }
}

/// Copy to the clipboard, on a page that is NOT a secure context.
///
/// The config UI is served over plain http on a LAN address, so
/// `navigator.clipboard` is frequently undefined here — the modern API is gated
/// on https/localhost. Falls back to a throwaway textarea + execCommand, which
/// still works on insecure origins. Returns false if both routes fail, so the
/// button can say "select it yourself" rather than lying.
async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through to the old way */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch { return false; }
}

/// Pick a Plex server without asking — and PROVE it works before settling on it.
///
/// Linking used to drop the user on a list with one entry and a "Use this one"
/// button: a question with a single possible answer, asked at the exact moment
/// they expected to be finished.
///
/// Choosing for them is only an improvement if the choice is right, and the
/// obvious implementation gets it wrong. `local` is a Plex flag meaning "this
/// connection is on the same LAN as the SERVER" — not "reachable from the
/// machine you are sitting at". On the development Mac here, the local address
/// is unreachable and only the WAN one works, so picking the preferred entry
/// blind would have replaced a working link with a broken one and reported
/// success.
///
/// So: walk the candidates best-first and keep the first that actually answers.
/// `POST /api/plex/server` already pings and returns `reachable`, so this costs
/// nothing but the round trips, and only at link time.
async function autoPickServer() {
  try {
    const { servers } = await api('/api/plex/servers');
    if (!servers || !servers.length) return false;

    // Servers: direct before relay-only. Connections inside each are already
    // sorted local → direct remote → relay by /api/plex/servers.
    const ranked = servers.slice().sort((a, b) => (a.relayOnly ? 1 : 0) - (b.relayOnly ? 1 : 0));
    const candidates = [];
    for (const sv of ranked) {
      const conns = sv.connections?.length ? sv.connections : [{ uri: sv.uri, local: sv.local }];
      for (const c of conns) candidates.push({ ...sv, uri: c.uri, local: !!c.local, connections: undefined });
    }

    let first = null;
    for (const cand of candidates) {
      const r = await api('/api/plex/server', { method: 'POST', body: cand });
      if (!first) first = cand;
      if (r && r.reachable) return true;
    }
    // Nothing answered. Leave the preferred one selected so the library screen
    // has something to report on, and let them switch by hand.
    if (first) await api('/api/plex/server', { method: 'POST', body: first });
    return false;
  } catch {
    // Leave the picker on screen and let them choose by hand.
    return false;
  }
}

$('#startLink').addEventListener('click', async () => {
  const btn = $('#startLink');
  btn.disabled = true;
  try {
    const pin = await api('/api/plex/pin', { method: 'POST' });
    $('#linkBody').innerHTML = `
      <div class="pin">${escapeHtml(pin.code)}</div>
      <p class="row" style="gap:8px;align-items:center">
        <button class="sm" id="copyPin">Copy code</button>
        <a class="sm" href="https://plex.tv/link" target="_blank" rel="noopener">Open plex.tv/link</a>
      </p>
      <p>Enter that code at <a href="https://plex.tv/link" target="_blank" rel="noopener">plex.tv/link</a>.</p>
      <p class="hint" id="pinStatus">Waiting for you…</p>`;

    $('#copyPin').addEventListener('click', async () => {
      const ok = await copyText(pin.code);
      $('#copyPin').textContent = ok ? 'Copied' : 'Press ⌘/Ctrl+C';
      setTimeout(() => { const b = $('#copyPin'); if (b) b.textContent = 'Copy code'; }, 2000);
    });

    const started = Date.now();
    const poll = setInterval(async () => {
      if (Date.now() - started > 15 * 60_000) {
        clearInterval(poll);
        $('#pinStatus').textContent = 'That code expired. Try again.';
        return;
      }
      try {
        const r = await api(`/api/plex/pin/${pin.id}`);
        if (r.linked) {
          clearInterval(poll);
          const picked = await autoPickServer();
          toast(picked ? 'Linked to Plex — server selected.' : 'Linked to Plex.');
          await loadStatus();
          loadSetup();
        }
      } catch {
        /* keep waiting */
      }
    }, 2000);
  } catch (err) {
    toast(err.message, true);
    btn.disabled = false;
  }
});

$('#unlink').addEventListener('click', async () => {
  if (!(await confirmModal('Unlink this Plex account? Channels stay, but nothing will play until you link again.', { danger: true, ok: 'Unlink' }))) return;
  await api('/api/plex/logout', { method: 'POST' });
  location.reload();
});

// ---- backend switch + Jellyfin ----
$$('[data-backend]').forEach((b) =>
  b.addEventListener('click', async () => {
    await api('/api/media/backend', { method: 'POST', body: { backend: b.dataset.backend } });
    await loadStatus();
    loadSetup();
    toast(`Now using ${b.dataset.backend === 'jellyfin' ? 'Jellyfin' : 'Plex'}.`);
  })
);
$('#jfConnect').addEventListener('click', async () => {
  const btn = $('#jfConnect');
  btn.disabled = true; btn.textContent = 'Connecting…';
  try {
    await api('/api/jellyfin/connect', {
      method: 'POST',
      body: { url: $('#jfUrl').value.trim(), username: $('#jfUser').value.trim(), password: $('#jfPass').value },
    });
    toast('Connected to Jellyfin.');
    $('#jfPass').value = '';
    await loadStatus();
    loadSetup();
  } catch (err) { toast(err.message, true); }
  btn.disabled = false; btn.textContent = 'Connect';
});
$('#jfLogout').addEventListener('click', async () => {
  if (!(await confirmModal('Disconnect Jellyfin and switch back to Plex?', { danger: true, ok: 'Disconnect' }))) return;
  await api('/api/jellyfin/logout', { method: 'POST' });
  await loadStatus();
  loadSetup();
});

// ---------------------------------------------------------------- boot

async function boot() {
  await loadStatus();
  $('#mediaPath').textContent = 'media/ads and media/bumpers inside the dumbTV folder';
  await loadChannels().catch(() => {});
  await refreshOnAir();
  loadSetup();

  // Deep-link a view via the URL hash, e.g. /#schedule.
  const hv = location.hash.slice(1);
  if (hv) {
    const b = document.querySelector(`.navlink[data-view="${hv}"]`);
    if (b) b.click();
  }

  // U-4: nothing polls while the tab is hidden — this page is often left open
  // in a background tab all day, and a config screen nobody is looking at has
  // no reason to talk to the server five times a minute.
  const whenVisible = (fn, ms) => setInterval(() => { if (!document.hidden) fn(); }, ms);

  whenVisible(refreshOnAir, 5000);
  whenVisible(loadStatus, 5000);   // heartbeat — greys the page fast if the app quits
  whenVisible(() => {
    if ($('#view-guide').classList.contains('active')) {
      $('#guideClock').textContent = clock(Date.now());
    }
  }, 1000);

  // Coming back to the tab should show current state immediately, not up to
  // five seconds of stale.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { refreshOnAir(); loadStatus(); }
  });
}

boot();

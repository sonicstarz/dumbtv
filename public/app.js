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
  el.textContent = message;
  $('#toastHost').append(el);
  setTimeout(() => el.remove(), 4200);
}

const clock = (ts) =>
  new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );

function mins(ms) {
  return Math.round(ms / 60000);
}

// ---------------------------------------------------------------- nav

$$('.navlink[data-view]').forEach((btn) =>
  btn.addEventListener('click', () => {
    $$('.navlink').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    $$('.view').forEach((v) => v.classList.remove('active'));
    $(`#view-${btn.dataset.view}`).classList.add('active');
    if (btn.dataset.view === 'guide') loadGuide();
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
$('#rAdd').addEventListener('click', async () => {
  const kind = $('#rKind').value;
  const body = { kind, name: $('#rName').value || null };
  if ($('#rEffFrom').value) body.effectiveFrom = $('#rEffFrom').value;
  if ($('#rEffTo').value) body.effectiveTo = $('#rEffTo').value;
  if (kind === 'recurring' || kind === 'blackout') {
    body.daysOfWeek = $('#rDays').value.trim();
    body.startTime = $('#rStart').value.trim();
    body.durationMin = Number($('#rDur').value) || 0;
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
      const label = off
        ? escapeHtml(p.title || 'Off air')
        : `${p.isPremiere ? '<span class="prem">NEW</span> ' : ''}${escapeHtml(p.title || 'Program')}`;
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
  $('#tzStatus').textContent = `Active: ${cfg.activeTimezone}${cfg.timezone ? '' : ' (this device — no override set)'}`;
  $('#tzInput').value = cfg.timezone || '';
  $('#dispFill').value = cfg.displayFill === 'fill' ? 'fill' : 'fit';
  $('#dispCaptions').checked = !!cfg.captions;
}

$('#dispFill').addEventListener('change', async (e) => {
  await api('/api/settings', { method: 'POST', body: { displayFill: e.target.value } });
  toast('Picture setting saved.');
});
$('#dispCaptions').addEventListener('change', async (e) => {
  await api('/api/settings', { method: 'POST', body: { captions: e.target.checked ? 1 : 0 } });
  toast(e.target.checked ? 'Captions on.' : 'Captions off.');
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
  a.download = `cathode-config-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
});
$('#cfgImport').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (!confirm('Importing replaces the current lineup. Continue?')) { e.target.value = ''; return; }
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
    $('#tallyText').textContent = 'OFFLINE';
    return;
  }
  const s = state.status;
  state.orderingModes = s.orderingModes || [];

  const dot = $('#tallyDot');
  const txt = $('#tallyText');
  if (s.player?.driver === 'mpv') {
    dot.classList.remove('off');
    txt.textContent = 'ON AIR';
  } else {
    dot.classList.add('off');
    txt.textContent = 'BROWSER ONLY';
  }

  $('#navChannels').textContent = s.counts.channels || '';
  $('#navAssets').textContent = s.counts.assets || '';
  $('#navPlex').textContent = s.linked ? (s.reachable ? '●' : '!') : '—';
  $('#navPlex').style.color = s.linked && s.reachable ? 'var(--phosphor)' : 'var(--dim)';
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
                <span class="n">${s.itemCount}</span>
                ${s.sourceType === 'show' ? `<button class="chip-filter" data-filter="${c.id}:${s.id}" title="Choose which episodes air">⛃</button>` : ''}
                <button data-rm="${c.id}:${s.id}" title="Remove">&times;</button></span>`
            )
            .join('')
        : '<span class="chip empty">Nothing on this channel yet</span>';

      return `<div class="chan">
        <div class="chan-num">${String(c.number).padStart(2, '0')}<small>CH</small></div>
        <div>
          <h3>${escapeHtml(c.name)}</h3>
          <div class="meta">
            <b>${mode ? mode.label : c.orderingMode}</b> ·
            ${c.slotMinutes} min slots ·
            ${c.adsEnabled ? `up to ${c.maxAdsPerBreak} ads per break` : 'no ads'} ·
            ${dark}
          </div>
          <div class="chips">${sources}</div>
        </div>
        <div class="chan-actions">
          <button class="sm primary" data-add="${c.id}">Add content</button>
          <button class="sm" data-edit="${c.id}">Settings</button>
          <button class="sm" data-watch="${c.id}">Watch</button>
          <button class="sm danger" data-del="${c.id}">Delete</button>
        </div>
      </div>`;
    })
    .join('');

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
      if (!confirm(`Delete channel ${c.number} — ${c.name}? Its schedule goes with it.`)) return;
      await api(`/api/channels/${c.id}`, { method: 'DELETE' });
      toast('Channel deleted.');
      loadChannels();
      loadStatus();
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

  $('#epCancel', back).addEventListener('click', () => back.remove());

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
      back.remove();
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
  const n = state.channels.length;
  await api('/api/channels', {
    method: 'POST',
    body: { name: `Channel ${n + 2}`, number: n + 2 },
  });
  await loadChannels();
  loadStatus();
  const created = state.channels[state.channels.length - 1];
  openSettings(created.id);
});

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

// ---------------------------------------------------------------- modal

function modal(html) {
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `<div class="modal">${html}</div>`;
  back.addEventListener('click', (e) => {
    if (e.target === back) back.remove();
  });
  document.addEventListener(
    'keydown',
    function esc(e) {
      if (e.key === 'Escape') {
        back.remove();
        document.removeEventListener('keydown', esc);
      }
    }
  );
  $('#modalHost').append(back);
  return back;
}

// ---------------------------------------------------------------- settings

function openSettings(channelId) {
  const c = state.channels.find((x) => x.id === channelId);
  if (!c) return;

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
      <div class="field">
        <label>ORDER</label>
        <select id="fMode">${modes}</select>
      </div>
      <div class="field"><label>MARATHON SIZE</label><input id="fMar" type="number" min="1" max="12" value="${c.marathonSize}" style="width:96px"></div>
      <div class="field"><label>SLOT MINUTES</label><input id="fSlot" type="number" min="5" max="120" step="5" value="${c.slotMinutes}" style="width:110px"></div>
    </div>
    <p class="hint" id="modeBlurb"></p>

    <div class="row" style="margin-top:18px">
      <div class="field">
        <label>ADS</label>
        <label style="display:flex;gap:8px;align-items:center;font-family:var(--sans);font-size:14px;color:var(--tape);letter-spacing:0">
          <input id="fAds" type="checkbox" ${c.adsEnabled ? 'checked' : ''}> Run commercials
        </label>
      </div>
      <div class="field"><label>MAX PER BREAK</label><input id="fMaxAds" type="number" min="0" max="30" value="${c.maxAdsPerBreak}" style="width:110px"></div>
      <div class="field" style="flex:1"><label>AD TAGS (OPTIONAL)</label><input id="fTags" value="${escapeHtml(c.adTags || '')}" placeholder="90s, toys" style="width:100%"></div>
    </div>

    <div class="row" style="margin-top:18px">
      <div class="field"><label>AD TIMING</label>
        <select id="fTiming">
          <option value="continuous" ${c.timingMode === 'continuous' ? 'selected' : ''}>Continuous — exact ad count, no grid</option>
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

    <div class="row" style="margin-top:18px">
      <div class="field"><label>GOES DARK AT</label><input id="fDarkStart" type="time" value="${c.darkStart || ''}"></div>
      <div class="field"><label>COMES BACK AT</label><input id="fDarkEnd" type="time" value="${c.darkEnd || ''}"></div>
    </div>
    <p class="hint">Leave both blank to broadcast around the clock. During dark hours the channel shows colour bars.</p>

    <div class="row" style="margin-top:26px;justify-content:flex-end">
      <button class="ghost" id="fCancel">Cancel</button>
      <button class="ghost" id="fRefresh">Re-read from Plex</button>
      <button class="primary" id="fSave">Save changes</button>
    </div>
  `);

  const blurb = () => {
    const m = state.orderingModes.find((x) => x.id === $('#fMode', back).value);
    $('#modeBlurb', back).textContent = m ? m.blurb : '';
    $('#fMar', back).closest('.field').style.display =
      $('#fMode', back).value === 'marathon' ? '' : 'none';
  };
  $('#fMode', back).addEventListener('change', blurb);
  blurb();

  $('#fCancel', back).addEventListener('click', () => back.remove());

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
      await api(`/api/channels/${c.id}`, {
        method: 'PATCH',
        body: {
          number: Number($('#fNum', back).value),
          name: $('#fName', back).value,
          orderingMode: $('#fMode', back).value,
          marathonSize: Number($('#fMar', back).value),
          slotMinutes: Number($('#fSlot', back).value),
          adsEnabled: $('#fAds', back).checked,
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
      back.remove();
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
        <label>FILTER</label>
        <input id="pFilter" placeholder="Type to narrow it down" style="width:100%">
      </div>
    </div>
    <div class="picker-grid" id="pGrid"><div style="color:var(--dim);padding:20px">Loading…</div></div>
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

  $('#pCancel', back).addEventListener('click', () => back.remove());

  try {
    if (state.sections.length === 0) {
      const s = await api('/api/library/sections');
      state.sections = s.sections.filter((x) => x.type === 'show' || x.type === 'movie');
    }
  } catch (err) {
    $('#pGrid', back).innerHTML = `<div style="color:var(--tally);padding:20px">${escapeHtml(err.message)}</div>`;
    return;
  }

  if (state.sections.length === 0) {
    $('#pGrid', back).innerHTML =
      '<div style="color:var(--dim);padding:20px">No show or movie libraries found on that server.</div>';
    return;
  }

  $('#pSection', back).innerHTML = state.sections
    .map((s) => `<option value="${s.key}|${s.type}">${escapeHtml(s.title)}</option>`)
    .join('');

  const draw = () => {
    const q = $('#pFilter', back).value.toLowerCase();
    const shown = items.filter((i) => i.title.toLowerCase().includes(q));
    $('#pGrid', back).innerHTML =
      shown
        .map((i) => {
          const on = selected.has(String(i.ratingKey));
          const art = i.image
            ? `<img src="${i.image}" alt="" loading="lazy">`
            : `<div class="ph">no art</div>`;
          const count =
            i.leafCount != null ? `${i.leafCount} eps` : i.year ? String(i.year) : '';
          return `<button class="pick ${on ? 'on' : ''}" data-k="${i.ratingKey}">
            ${art}
            <span class="cap">${escapeHtml(i.title)}<br><small>${count}</small></span>
          </button>`;
        })
        .join('') || '<div style="color:var(--dim);padding:20px">Nothing matches that.</div>';

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
  };

  const loadSection = async () => {
    const [key, type] = $('#pSection', back).value.split('|');
    $('#pGrid', back).innerHTML = '<div style="color:var(--dim);padding:20px">Loading…</div>';
    try {
      const r = await api(`/api/library/sections/${key}/items?type=${type}`);
      items = r.items;
      draw();
    } catch (err) {
      $('#pGrid', back).innerHTML = `<div style="color:var(--tally);padding:20px">${escapeHtml(err.message)}</div>`;
    }
  };

  $('#pSection', back).addEventListener('change', loadSection);
  $('#pFilter', back).addEventListener('input', draw);
  await loadSection();

  $('#pAdd', back).addEventListener('click', async () => {
    const b = $('#pAdd', back);
    b.disabled = true;
    b.textContent = 'Reading from Plex…';
    const [, type] = $('#pSection', back).value.split('|');
    try {
      const r = await api(`/api/channels/${channelId}/sources`, {
        method: 'POST',
        body: {
          items: [...selected.values()].map((i) => ({
            ratingKey: i.ratingKey,
            sourceType: type === 'movie' ? 'movie' : 'show',
            title: i.title,
          })),
        },
      });
      const total = r.results.reduce((n, x) => n + (x.cached || 0), 0);
      const bad = r.results.filter((x) => x.error);
      back.remove();
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
      const live = Date.now() >= cellStart && Date.now() < cellEnd;

      if (!p) {
        html += `<div class="g-slot ${live ? 'live' : ''}"><div class="ps">—</div></div>`;
        continue;
      }
      const isStart = p.startUtc >= cellStart && p.startUtc < cellEnd;
      const ep =
        p.seasonNo != null && p.episodeNo != null
          ? `S${String(p.seasonNo).padStart(2, '0')}E${String(p.episodeNo).padStart(2, '0')} `
          : '';
      html += `<div class="g-slot ${p.kind === 'offair' ? 'offair' : ''} ${live ? 'live' : ''}">
        ${isStart ? `<div class="pt">${escapeHtml(p.title)}</div>
          <div class="ps">${p.subtitle ? ep + escapeHtml(p.subtitle) : clock(p.startUtc)}</div>`
          : `<div class="ps">${escapeHtml(p.title)} (cont.)</div>`}
      </div>`;
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

async function loadSetup() {
  const s = state.status;
  if (!s) return;

  if (s.linked) {
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
            <button class="sm ${s.server && s.server.uri === sv.uri ? '' : 'primary'}" data-sv='${escapeHtml(JSON.stringify(sv))}'>
              ${s.server && s.server.uri === sv.uri ? 'In use' : 'Use this one'}
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
}

$('#startLink').addEventListener('click', async () => {
  const btn = $('#startLink');
  btn.disabled = true;
  try {
    const pin = await api('/api/plex/pin', { method: 'POST' });
    $('#linkBody').innerHTML = `
      <div class="pin">${pin.code}</div>
      <p>Go to <a href="https://plex.tv/link" target="_blank" rel="noopener">plex.tv/link</a> and enter that code.</p>
      <p class="hint" id="pinStatus">Waiting for you…</p>`;

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
          toast('Linked to Plex.');
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
  if (!confirm('Unlink this Plex account? Channels stay, but nothing will play until you link again.')) return;
  await api('/api/plex/logout', { method: 'POST' });
  location.reload();
});

// ---------------------------------------------------------------- boot

async function boot() {
  await loadStatus();
  $('#mediaPath').textContent = 'media/ads and media/bumpers inside the Cathode folder';
  await loadChannels().catch(() => {});
  await refreshOnAir();
  loadSetup();

  // Deep-link a view via the URL hash, e.g. /#schedule.
  const hv = location.hash.slice(1);
  if (hv) {
    const b = document.querySelector(`.navlink[data-view="${hv}"]`);
    if (b) b.click();
  }

  setInterval(refreshOnAir, 5000);
  setInterval(loadStatus, 15000);
  setInterval(() => {
    if ($('#view-guide').classList.contains('active')) {
      $('#guideClock').textContent = clock(Date.now());
    }
  }, 1000);
}

boot();

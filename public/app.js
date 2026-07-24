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
  })
);

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

  setInterval(refreshOnAir, 5000);
  setInterval(loadStatus, 15000);
  setInterval(() => {
    if ($('#view-guide').classList.contains('active')) {
      $('#guideClock').textContent = clock(Date.now());
    }
  }, 1000);
}

boot();

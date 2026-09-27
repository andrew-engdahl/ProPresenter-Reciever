(() => {
  'use strict';
  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const LAYOUTS = { 'lower-third': 'Lower third', fullscreen: 'Full screen', 'scripture-focus': 'Scripture focus', clean: 'Clean (media only)' };

  let state = {}, config = {}, discovery = { instances: [] };
  const expanded = new Set();
  let autoExpanded = null;

  // ---- api ----------------------------------------------------------------------
  async function api(method, path, body) {
    const r = await fetch(path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || r.statusText);
    return j;
  }
  function toast(msg, bad) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = bad ? 'on bad' : 'on';
    clearTimeout(t._t);
    t._t = setTimeout(() => (t.className = ''), 2200);
  }
  const act = (method, path, body, ok) => api(method, path, body).then(() => ok && toast(ok)).catch(e => toast(e.message, true));

  // ---- connection + instances -------------------------------------------------------
  function renderConn() {
    const c = state.connection || {};
    const el = $('#conn');
    el.className = 'pill ' + (c.status === 'connected' ? 'ok' : c.status === 'idle' ? '' : 'warn');
    el.querySelector('.txt').textContent = c.status === 'connected'
      ? `${c.name || 'ProPresenter'} · ${c.host}:${c.port}`
      : c.status === 'idle' || !c.status ? 'Not connected' : `${c.status[0].toUpperCase()}${c.status.slice(1)} ${c.host ? `${c.host}:${c.port}` : ''}…`;
  }

  function renderInstances() {
    const c = state.connection || {};
    const list = discovery.instances || [];
    $('#instances').innerHTML = list.length ? list.map(i => {
      const current = c.host === i.host && +c.port === +i.port && c.status !== 'idle';
      return `<div class="inst ${current ? 'current' : ''}">
        <span class="dot ${i.online ? 'ok' : ''}"></span>
        <div class="meta"><div class="name">${esc(i.name)}${i.local ? '<span class="tag">this machine</span>' : ''}<span class="tag">${esc(i.source)}</span></div>
        <div class="addr">${esc(i.host)}:${i.port} · ${esc(i.platform || '')} ${esc(i.os || '')}</div></div>
        ${current ? '<button class="btn small ghost" data-disconnect>Disconnect</button>' : `<button class="btn small" data-connect="${esc(i.host)}:${i.port}" ${i.online ? '' : 'disabled'}>Connect</button>`}
      </div>`;
    }).join('') : `<p class="empty">${discovery.scanning ? 'Searching…' : 'No ProPresenter found yet.'}</p>`;
    $('#scanProgress').textContent = discovery.progress || '';
    $('#scan').disabled = !!discovery.scanning;
  }

  $('#instances').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.connect) {
      const [host, port] = b.dataset.connect.split(':');
      act('POST', '/api/connect', { host, port }, `Connecting to ${host}:${port}`);
    } else if ('disconnect' in b.dataset) act('POST', '/api/disconnect', null, 'Disconnected');
  });
  $('#scan').onclick = () => act('POST', '/api/discovery/scan', {}, 'Scanning the network…');
  $('#manual').addEventListener('submit', e => {
    e.preventDefault();
    const f = new FormData(e.target);
    const host = f.get('host').trim(), port = f.get('port');
    if (e.submitter && e.submitter.value === 'deep') return act('POST', '/api/discovery/scan', { deep: host }, `Deep scanning ${host}…`);
    if (!port) return toast('Enter a port, or use Deep scan', true);
    act('POST', '/api/connect', { host, port }, `Connecting to ${host}:${port}`);
  });

  // ---- live ---------------------------------------------------------------------------
  function renderNow() {
    const l = state.layout || {};
    $('#nowLook').textContent = state.look ? state.look.name : '—';
    $('#nowLayout').textContent = l.mode ? `${LAYOUTS[l.mode] || l.mode}${l.showText === false ? ' · text off' : ''}` : '—';
    const s = state.slide;
    $('#nowKind').textContent = s ? `${s.kind}${s.group ? ` · ${s.group}` : ''}` : '—';
    const m = state.media;
    $('#nowMedia').textContent = m ? `${m.name}${m.fallback ? ' (thumbnail)' : m.url ? '' : ' (file not found)'}${m.playing ? ' ▶' : ''}` : '—';

    const looks = [...(state.looks || [])];
    $('#looks').innerHTML = looks.length ? looks.map(lk => `<button class="chip ${state.look && state.look.name === lk.name ? 'on' : ''}" data-look="${esc(lk.uuid)}">${esc(lk.name)}</button>`).join('') : '<p class="empty">No looks.</p>';
  }
  const canControl = () => config.controlProPresenter !== false;
  $('#looks').addEventListener('click', e => { const b = e.target.closest('[data-look]'); if (b && canControl()) act('POST', '/api/pp/look', { uuid: b.dataset.look }); });
  $$('[data-pp]').forEach(b => (b.onclick = () => act('POST', `/api/pp/${b.dataset.pp}`)));
  $$('[data-clear]').forEach(b => (b.onclick = () => act('POST', '/api/pp/clear', { layer: b.dataset.clear })));

  // ---- playlist -------------------------------------------------------------------------
  let plSig = '';
  function renderPlaylist() {
    const pl = state.playlist;
    const live = state.slide ? state.slide.index : null;
    const livePres = state.presentation && state.presentation.uuid;
    const sig = JSON.stringify([pl, live, livePres, [...expanded]]);
    if (sig === plSig) return;
    plSig = sig;
    $('#plName').textContent = pl ? `${pl.name}${pl.live ? '' : ' · not live'}` : '';
    if (!pl) { $('#playlist').innerHTML = '<p class="empty">Trigger an item from a playlist in ProPresenter and it appears here.</p>'; renderSpeakerPicks([]); return; }

    // Open the item that's live, once per change.
    const activeItem = pl.items.find(i => i.uuid === livePres);
    if (activeItem && autoExpanded !== activeItem.uuid) { autoExpanded = activeItem.uuid; expanded.add(activeItem.uuid); }

    const speakers = [];
    $('#playlist').innerHTML = pl.items.map(it => {
      if (it.type === 'header') return `<div class="pl-header" style="--c:${it.color || '#8b93a7'}">${esc(it.name)}</div>`;
      const isLive = it.uuid === livePres;
      const slides = (it.groups || []).flatMap(g => g.slides.map(s => ({ ...s, text: (s.text || '').replace(/\r/g, '\n'), group: g.name, color: g.color })));
      slides.forEach(s => { if (s.kind === 'speaker') { const [name, ...rest] = s.text.split('\n'); speakers.push({ name, title: rest.join(' · ') }); } });
      const open = expanded.has(it.uuid);
      return `<div class="pl-item ${isLive ? 'active' : ''}">
        <button class="pl-title" data-toggle="${esc(it.uuid)}"><span>${open ? '▾' : '▸'}</span>${esc(it.name)}<span class="count">${slides.length ? `${slides.length} slide${slides.length === 1 ? '' : 's'}` : it.type}</span></button>
        ${open ? `<div class="slides">${slides.map((s, i) => `<button class="slide ${isLive && live === i ? 'live' : ''}" data-cue="${esc(it.uuid)}:${i}" style="--c:${s.color || '#444'}">
            <span class="sw"></span><span><span class="grp">${esc(s.group)}${s.label ? ` · ${esc(s.label)}` : ''}</span><span class="txt">${esc(s.text) || '<i>(no text)</i>'}</span></span><span class="kind ${s.kind}">${s.kind}</span>
          </button>`).join('')}</div>` : ''}
      </div>`;
    }).join('');
    renderSpeakerPicks(speakers);
  }
  $('#playlist').addEventListener('click', e => {
    const t = e.target.closest('[data-toggle]');
    if (t) { const id = t.dataset.toggle; expanded.has(id) ? expanded.delete(id) : expanded.add(id); plSig = ''; return renderPlaylist(); }
    const c = e.target.closest('[data-cue]');
    if (c && canControl()) { const [presentation, index] = c.dataset.cue.split(':'); act('POST', '/api/pp/cue', { presentation, index: +index }); }
  });

  // ---- speaker ----------------------------------------------------------------------------
  function renderSpeakerPicks(list) {
    const seen = new Set();
    const uniq = list.filter(s => s.name && !seen.has(s.name) && seen.add(s.name));
    $('#speakerPicks').innerHTML = uniq.map(s => `<button type="button" class="chip" data-name="${esc(s.name)}" data-title="${esc(s.title)}">${esc(s.name)}</button>`).join('');
  }
  $('#speakerPicks').addEventListener('click', e => {
    const b = e.target.closest('[data-name]');
    if (!b) return;
    const f = $('#speakerForm');
    f.name.value = b.dataset.name;
    f.title.value = b.dataset.title;
    f.requestSubmit();
  });
  $('#speakerForm').addEventListener('submit', e => {
    e.preventDefault();
    const f = new FormData(e.target);
    act('POST', '/api/speaker', { name: f.get('name'), title: f.get('title'), hold: +f.get('hold') || undefined }, 'Speaker title sent');
  });
  $('#speakerHide').onclick = () => act('POST', '/api/speaker/hide');

  // ---- settings ------------------------------------------------------------------------------
  const getPath = (o, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
  const patchFor = (p, v) => p.split('.').reverse().reduce((acc, k) => ({ [k]: acc }), v);

  function renderSettings() {
    for (const el of $$('[data-cfg]')) {
      if (document.activeElement === el) continue;
      const v = getPath(config, el.dataset.cfg);
      if (el.type === 'checkbox') el.checked = !!v;
      else if ('lines' in el.dataset) el.value = (v || []).join('\n');
      else if ('map' in el.dataset) el.value = (v || []).map(m => `${m.from} => ${m.to}`).join('\n');
      else if ('csv' in el.dataset) el.value = (v || []).join(', ');
      else el.value = v ?? '';
    }
    $('#speakerForm').hold.placeholder = config.speakerHoldSeconds;
    // Watch-only: nothing here may trigger or clear anything in ProPresenter.
    const canControl = config.controlProPresenter !== false;
    document.body.classList.toggle('watch-only', !canControl);
    for (const b of $$('[data-pp], [data-clear]')) { b.disabled = !canControl; b.title = canControl ? '' : 'Control of ProPresenter is off (Settings → Discovery)'; }
  }
  for (const el of $$('[data-cfg]')) {
    el.addEventListener('change', () => {
      let v;
      if (el.type === 'checkbox') v = el.checked;
      else if ('num' in el.dataset) v = +el.value;
      else if ('lines' in el.dataset) v = el.value.split('\n').map(s => s.trim()).filter(Boolean);
      else if ('map' in el.dataset) v = el.value.split('\n').map(l => l.split('=>').map(s => s.trim())).filter(p => p.length === 2 && p[0]).map(([from, to]) => ({ from, to }));
      else if ('csv' in el.dataset) v = el.value.split(/[,\s]+/).map(Number).filter(n => n > 0 && n < 65536);
      else v = el.value;
      act('PUT', '/api/config', patchFor(el.dataset.cfg, v), 'Saved');
    });
  }

  // Chroma presets: set the colour and switch the background to chroma in one go.
  $('#chromaPresets').addEventListener('click', e => {
    const b = e.target.closest('[data-chroma]');
    if (!b) return;
    $('#chromaColor').value = b.dataset.chroma;
    act('PUT', '/api/config', { theme: { chromaColor: b.dataset.chroma, background: 'chroma' } }, `Chroma key: ${b.textContent}`);
  });

  // Look → layout: exact-name rules sit in front of the keyword rules.
  const exactRule = name => `^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;
  function layoutFor(name) {
    for (const r of config.lookLayouts || []) { try { if (new RegExp(r.match, 'i').test(name)) return r.layout; } catch { /* skip */ } }
    return config.defaultLayout;
  }
  let mapSig = '';
  function renderLookMap() {
    const names = [...new Set([...(state.looks || []).map(l => l.name), ...(state.look ? [state.look.name] : [])])];
    const sig = JSON.stringify([names, config.lookLayouts, config.defaultLayout, state.look && state.look.name]);
    if (sig === mapSig) return;
    mapSig = sig;
    const opts = sel => Object.entries(LAYOUTS).map(([k, v]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${v}</option>`).join('');
    $('#lookMap').innerHTML = names.length ? names.map(n => `<div class="map-row"><span class="lname ${state.look && state.look.name === n ? 'live' : ''}">${esc(n)}</span><select data-look-name="${esc(n)}">${opts(layoutFor(n))}</select></div>`).join('') : '<p class="empty">Connect to see this instance\'s looks.</p>';
    $('#defaultLayout').innerHTML = opts(config.defaultLayout);
  }
  $('#lookMap').addEventListener('change', e => {
    const n = e.target.dataset.lookName;
    if (!n) return;
    const rules = (config.lookLayouts || []).filter(r => r.match !== exactRule(n));
    act('PUT', '/api/config', { lookLayouts: [{ match: exactRule(n), layout: e.target.value }, ...rules] }, `${n} → ${LAYOUTS[e.target.value]}`);
  });
  $('#defaultLayout').onchange = e => act('PUT', '/api/config', { defaultLayout: e.target.value }, 'Saved');

  // ---- outputs -----------------------------------------------------------------------------------
  function renderOutputs() {
    const o = location.origin;
    const outs = [
      ['Main output', '/display'],
      ['Key / browser source', '/display?bg=transparent'],
      ['Chroma key', '/display?bg=chroma'],
      ['Lower thirds only', '/display?layout=lower-third&media=0'],
      ['Room screen', '/display?layout=fullscreen&bg=black'],
      ['Debug', '/display?bg=black&debug=1'],
    ];
    $('#outputs').innerHTML = outs.map(([w, p]) => `<div class="out"><span class="what">${w}</span><code>${esc(o + p)}</code><a class="btn small ghost" href="${p}" target="_blank" rel="noopener">Open</a><button class="btn small ghost" data-copy="${esc(o + p)}">Copy</button></div>`).join('');
  }
  $('#outputs').addEventListener('click', e => {
    const b = e.target.closest('[data-copy]');
    if (b) navigator.clipboard.writeText(b.dataset.copy).then(() => toast('Copied'), () => toast(b.dataset.copy));
  });

  // ---- events ------------------------------------------------------------------------------------
  function renderAll() { renderConn(); renderInstances(); renderNow(); renderPlaylist(); renderLookMap(); }
  api('GET', '/api/state').then(r => { config = r.config; state = r.state; discovery = r.discovery; renderSettings(); renderAll(); renderOutputs(); });
  const es = new EventSource('/events?client=control');
  es.addEventListener('state', e => { state = JSON.parse(e.data); renderAll(); });
  es.addEventListener('discovery', e => { discovery = JSON.parse(e.data); renderInstances(); });
  es.addEventListener('config', () => api('GET', '/api/config').then(c => { config = c; renderSettings(); mapSig = ''; renderLookMap(); }));
  es.onerror = () => { state.connection = { status: 'receiver offline' }; renderConn(); };
})();

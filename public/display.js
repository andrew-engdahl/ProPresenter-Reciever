// Display output: renders server state onto a 1920×1080 stage.
//
// URL options (handy for several outputs from one server):
//   ?bg=transparent|black|green|blue   background (default from settings)
//   ?layout=lower-third|fullscreen|scripture-focus|clean   ignore the Look and force a layout
//   ?media=0        never show media        ?speaker=0   never show speaker titles
//   ?messages=0     never show messages     ?debug=1     connection badge
(() => {
  'use strict';
  const q = new URLSearchParams(location.search);
  const $ = s => document.querySelector(s);
  const stage = $('#stage'), content = $('#content'), mediaEl = $('#media');
  const video = $('#video'), image = $('#image'), speakerEl = $('#speaker'), messageEl = $('#message');

  let config = {}, state = {}, lastKey = null, currentCard = null;

  // ---- scale the stage to the window ----------------------------------------
  function fitStage() {
    const s = Math.min(innerWidth / 1920, innerHeight / 1080);
    stage.style.transform = `translate(-50%, -50%) scale(${s})`;
  }
  addEventListener('resize', fitStage);
  fitStage();
  if (q.get('debug')) document.body.classList.add('debug');

  // ---- theme ------------------------------------------------------------------
  function applyConfig(c) {
    config = c;
    const t = c.theme || {};
    const root = document.documentElement.style;
    root.setProperty('--accent', t.accent || '#3b82f6');
    if (t.font) root.setProperty('--font', `'${t.font}', 'Segoe UI', 'Helvetica Neue', 'Noto Sans', 'DejaVu Sans', Arial, sans-serif`);
    if (t.scriptureFont) root.setProperty('--scripture-font', `'${t.scriptureFont}', Georgia, 'Noto Serif', 'DejaVu Serif', serif`);
    root.setProperty('--scale', t.textScale || 1);
    const bg = q.get('bg') || t.background || 'transparent';
    const b = document.body.classList;
    [...b].filter(x => /^(bg|lyric|speaker)-/.test(x) || x === 'uppercase').forEach(x => b.remove(x));
    b.add(`bg-${bg}`, `lyric-${t.lyricStyle || 'scrim'}`, `speaker-${c.speakerStyle || 'accent'}`);
    if (t.uppercaseLyrics) b.add('uppercase');
    lastKey = null;
    render();
  }

  // ---- helpers ----------------------------------------------------------------
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const lineHtml = ls => ls.map(l => `<span class="line">${esc(l)}</span>`).join('');

  // Shrink text until it fits its box (max-height set in CSS). Lyric line breaks
  // are deliberate, so for lyrics we first try to keep each line on one row.
  function fitText(el, keepLines) {
    let size = parseFloat(getComputedStyle(el).fontSize);
    const min = size * 0.6;
    const shrink = () => { size -= 2; el.style.fontSize = size + 'px'; };
    if (keepLines) {
      el.classList.add('nowrap');
      while (el.scrollWidth > el.clientWidth + 1 && size > min) shrink();
      if (el.scrollWidth > el.clientWidth + 1) el.classList.remove('nowrap');
    }
    const max = parseFloat(getComputedStyle(el).maxHeight);
    if (!isFinite(max)) return;
    el.style.overflow = 'visible';
    while (el.scrollHeight > max + 1 && size > min * 0.9) shrink();
    el.style.overflow = '';
  }

  function layoutMode() {
    return q.get('layout') || (state.layout && state.layout.mode) || config.defaultLayout || 'lower-third';
  }

  function cardHtml(slide, mode) {
    const k = slide.kind;
    if (k === 'scripture') {
      const ref = slide.reference ? `<div class="ref">${esc(slide.reference)}</div>` : '';
      return `<div class="panel">${ref}<div class="text-fit">${lineHtml(slide.body && slide.body.length ? [slide.body.join(' ')] : slide.lines)}</div></div>`;
    }
    if (k === 'announcement' || k === 'point') {
      const kicker = k === 'point' && slide.group && !/point/i.test(slide.group) ? slide.group : (k === 'announcement' ? 'Announcement' : '');
      return `<div class="panel">${kicker ? `<div class="kicker">${esc(kicker)}</div>` : ''}<div class="title">${esc(slide.title)}</div>${slide.body && slide.body.length ? `<div class="body">${lineHtml(slide.body)}</div>` : ''}</div>`;
    }
    const next = config.theme && config.theme.showNextLine && state.next && mode !== 'fullscreen'
      ? `<div class="next-line">${esc(state.next.text.split('\n')[0])}</div>` : '';
    return `<div class="text-fit">${lineHtml(slide.lines)}</div>${next}`;
  }

  // ---- content ------------------------------------------------------------------
  function render() {
    const mode = layoutMode();
    stage.className = `layout-${mode}`;
    const layout = state.layout || {};
    const slide = state.slide;
    const showText = layout.showText !== false && mode !== 'clean';
    const visible = slide && showText && !['blank', 'speaker'].includes(slide.kind);
    stage.classList.toggle('has-text', !!visible);

    const key = visible ? `${mode}|${slide.kind}|${slide.uuid}|${slide.lines.join('\n')}` : 'none';
    if (key !== lastKey) {
      lastKey = key;
      if (currentCard) {
        const old = currentCard;
        old.classList.remove('in');
        old.classList.add('out');
        setTimeout(() => old.remove(), 450);
        currentCard = null;
      }
      if (visible) {
        const card = document.createElement('div');
        card.className = `card ${slide.kind}`;
        card.innerHTML = cardHtml(slide, mode);
        content.appendChild(card);
        // Measure once web fonts are in, or the fit is done against the fallback font.
        document.fonts.ready.then(() => card.querySelectorAll('.text-fit').forEach(el => fitText(el, slide.kind === 'lyrics' || slide.kind === 'text')));
        requestAnimationFrame(() => requestAnimationFrame(() => card.classList.add('in')));
        currentCard = card;
      }
    }

    if (spShowing) setTimeout(placeSpeaker, 60); // after the new card has laid out
    renderMedia(mode);
    renderMessages();
    const st = $('#status');
    const conn = state.connection || {};
    st.classList.toggle('connected', conn.status === 'connected');
    st.querySelector('.label').textContent = conn.status === 'connected' ? `${conn.name || 'ProPresenter'} · ${state.look ? state.look.name : ''} · ${mode}` : `ProPresenter: ${conn.status || 'idle'}`;
  }

  // ---- media --------------------------------------------------------------------
  let mediaUrl = null, lastTime = null;

  function renderMedia(mode) {
    const m = state.media;
    const allowed = q.get('media') !== '0' && state.layout && state.layout.showMedia;
    const on = !!(allowed && m && m.url);
    mediaEl.classList.toggle('on', on);
    stage.classList.toggle('has-media', on);
    if (!on) {
      if (mediaUrl) { video.pause(); video.classList.remove('on'); image.classList.remove('on'); mediaUrl = null; }
      return;
    }
    video.muted = !config.mediaAudio;
    if (m.url !== mediaUrl) {
      mediaUrl = m.url;
      if (m.kind === 'image') {
        image.onload = () => image.classList.add('on');
        image.src = m.url;
        video.classList.remove('on');
        video.pause();
      } else {
        image.classList.remove('on');
        video.src = m.url;
        video.oncanplay = () => { video.classList.add('on'); sync(); };
      }
    }
    if (m.kind !== 'image') {
      if (m.playing && video.paused) video.play().catch(() => {});
      if (!m.playing && !video.paused) video.pause();
    }
  }

  // Follow ProPresenter's transport clock: jump when far off, nudge the rate when close.
  function sync() {
    if (!lastTime || !mediaUrl || state.media.kind === 'image' || !video.duration) return;
    const expected = lastTime.time + (state.media.playing ? (performance.now() - lastTime.recv) / 1000 : 0);
    if (expected > video.duration + 0.5) return;
    const drift = video.currentTime - expected;
    if (Math.abs(drift) > 0.4) { video.currentTime = Math.max(0, expected); video.playbackRate = 1; } else if (Math.abs(drift) > 0.06) video.playbackRate = drift > 0 ? 0.96 : 1.04;
    else video.playbackRate = 1;
    // A loop in ProPresenter shows up as the clock jumping back after our copy has ended.
    if (state.media.playing && video.paused) video.play().catch(() => {});
  }

  // ---- messages -------------------------------------------------------------------
  function renderMessages() {
    const msgs = (state.messages || []).filter(m => m.text);
    const show = msgs.length && q.get('messages') !== '0' && state.layout && state.layout.showMessages;
    if (show) messageEl.textContent = msgs.map(m => m.text).join('   •   ');
    messageEl.classList.toggle('on', !!show);
  }

  // ---- speaker title ----------------------------------------------------------------
  let spTimer = null, spOutTimer = null, spQueue = null, spShowing = false;

  // Sit the title above whatever text is on screen so the two never overlap.
  function placeSpeaker() {
    let bottom = 150;
    const box = currentCard && !currentCard.classList.contains('out') && currentCard.querySelector('.panel, .text-fit');
    if (box) {
      const st = stage.getBoundingClientRect(), r = box.getBoundingClientRect();
      const scale = st.height / 1080;
      bottom = Math.max(bottom, Math.round((st.bottom - r.top) / scale) + 36);
    }
    speakerEl.style.bottom = `${Math.min(bottom, 700)}px`;
  }

  function playSpeaker(sp) {
    if (q.get('speaker') === '0') return;
    if (spShowing) { spQueue = sp; hideSpeaker(); return; }
    spShowing = true;
    placeSpeaker();
    speakerEl.querySelector('.sp-name span').textContent = sp.name;
    const t = speakerEl.querySelector('.sp-title');
    t.innerHTML = sp.title ? `<span>${esc(sp.title)}</span>` : '';
    speakerEl.classList.remove('out');
    void speakerEl.offsetWidth; // restart animations
    speakerEl.classList.add('in');
    clearTimeout(spTimer);
    spTimer = setTimeout(hideSpeaker, (1.4 + (+sp.hold || config.speakerHoldSeconds || 7)) * 1000);
  }

  function hideSpeaker() {
    clearTimeout(spTimer);
    if (!spShowing) return;
    speakerEl.classList.remove('in');
    void speakerEl.offsetWidth;
    speakerEl.classList.add('out');
    clearTimeout(spOutTimer);
    spOutTimer = setTimeout(() => {
      speakerEl.classList.remove('out');
      spShowing = false;
      if (spQueue) { const n = spQueue; spQueue = null; playSpeaker(n); }
    }, 900);
  }

  // ---- events -------------------------------------------------------------------------
  let lastSpeakerId = null;
  function connect() {
    const es = new EventSource('/events?client=display');
    es.addEventListener('config', e => applyConfig(JSON.parse(e.data)));
    es.addEventListener('state', e => { state = JSON.parse(e.data); render(); });
    es.addEventListener('time', e => { const t = JSON.parse(e.data); lastTime = { time: t.time, recv: performance.now() }; sync(); });
    es.addEventListener('speaker', e => {
      const sp = JSON.parse(e.data);
      if (sp.id === lastSpeakerId) return;
      lastSpeakerId = sp.id;
      playSpeaker(sp);
    });
    es.addEventListener('speaker-hide', () => { spQueue = null; hideSpeaker(); });
    es.onerror = () => { state.connection = { status: 'receiver offline' }; render(); };
  }
  connect();
})();

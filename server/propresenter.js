// Live connection to one ProPresenter instance.
//
// Uses the streaming endpoint POST /v1/status/updates to follow slides, looks,
// the active playlist, messages and media transport, then turns that into one
// `state` object the display renders. Emits:
//   'state'   (state)            whenever anything visible changes
//   'speaker' ({name, title})    when a speaker title should play
//   'time'    ({time, at})       media transport time, ~1/s while playing
'use strict';
const http = require('http');
const EventEmitter = require('events');
const { classify } = require('./classify');
const { readProFile } = require('./pro-file');

const STREAMS = [
  'status/slide', 'status/layers', 'presentation/slide_index', 'presentation/current', 'look/current',
  'playlist/active', 'messages', 'transport/presentation/current', 'transport/presentation/time',
];

const rgb = c => (c ? `rgb(${Math.round(c.red * 255)} ${Math.round(c.green * 255)} ${Math.round(c.blue * 255)})` : null);

class ProPresenter extends EventEmitter {
  constructor({ host, port }, { getConfig, media }) {
    super();
    this.host = host;
    this.port = +port;
    this.getConfig = getConfig;
    this.media = media;
    this.stopped = false;
    this.req = null;
    this.retry = 0;
    this.presentations = new Map(); // uuid -> { data, meta, fetchedAt }
    this.raw = { slide: null, layers: {}, slideIndex: null, look: null, playlist: null, messages: [], transport: null };
    this.playlist = null; // { uuid, name, items }
    this.status = 'connecting';
    this.version = null;
    this.lastSpeakerKey = null;
    this.activeMessages = new Set();
  }

  // ---- HTTP helpers --------------------------------------------------------

  request(method, path, body, { timeout = 4000, raw = false } = {}) {
    return new Promise((resolve, reject) => {
      const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
      const req = http.request({
        host: this.host, port: this.port, method, path, timeout,
        headers: data ? { 'content-type': 'application/json', 'content-length': data.length } : {},
      }, res => {
        if (raw) return resolve(res);
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode >= 400) return reject(new Error(`${method} ${path} → ${res.statusCode} ${text.slice(0, 120)}`));
          try { resolve(text ? JSON.parse(text) : null); } catch { resolve(text); }
        });
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });
  }

  get = (p) => this.request('GET', p);

  // ---- lifecycle -------------------------------------------------------------

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    clearTimeout(this.playlistTimer);
    clearTimeout(this.watchdog);
    if (this.req) this.req.destroy();
    this.status = 'disconnected';
    this.push();
  }

  async connect() {
    if (this.stopped) return;
    this.status = this.retry ? 'reconnecting' : 'connecting';
    this.push();
    try {
      this.version = await this.get('/version');
      await this.refreshAll();
      await this.openStream();
      this.retry = 0;
    } catch (e) {
      this.scheduleReconnect(e);
    }
  }

  scheduleReconnect(err) {
    if (this.stopped) return;
    if (err) console.warn(`[pp ${this.host}:${this.port}] ${err.message}`);
    this.status = 'reconnecting';
    this.push();
    const delay = Math.min(10000, 1000 * 2 ** Math.min(this.retry++, 4));
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  async refreshAll() {
    const [look, looks, playlist, messages, layers, slide, idx] = await Promise.all([
      this.get('/v1/look/current').catch(() => null),
      this.get('/v1/looks').catch(() => []),
      this.get('/v1/playlist/active').catch(() => null),
      this.get('/v1/messages').catch(() => []),
      this.get('/v1/status/layers').catch(() => ({})),
      this.get('/v1/status/slide').catch(() => null),
      this.get('/v1/presentation/slide_index').catch(() => null),
    ]);
    this.looks = looks || [];
    Object.assign(this.raw, { look, messages: messages || [], layers: layers || {}, slide, slideIndex: idx && idx.presentation_index });
    this.markMessages(true);
    await this.onPlaylistActive(playlist);
    await this.ensurePresentation(this.raw.slideIndex && this.raw.slideIndex.presentation_id && this.raw.slideIndex.presentation_id.uuid);
  }

  openStream() {
    const gen = this.gen = (this.gen || 0) + 1; // ignore events from superseded streams
    const lost = e => { if (gen === this.gen) { this.gen++; this.scheduleReconnect(e); } };
    return new Promise((resolve, reject) => {
      const body = Buffer.from(JSON.stringify(STREAMS));
      const req = http.request({
        host: this.host, port: this.port, method: 'POST', path: '/v1/status/updates',
        headers: { 'content-type': 'application/json', 'content-length': body.length },
      }, res => {
        if (res.statusCode !== 200) { res.resume(); return reject(new Error(`status/updates → ${res.statusCode}`)); }
        this.status = 'connected';
        this.push();
        resolve();
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', chunk => {
          if (gen !== this.gen) return;
          this.kick();
          buf += chunk;
          // Messages are JSON objects separated by blank lines ("\r\n\r\n").
          let i;
          while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
            const part = buf.slice(0, i).trim();
            buf = buf.slice(i).replace(/^\r?\n\r?\n/, '');
            if (part) { try { this.onUpdate(JSON.parse(part)); } catch (e) { console.warn('[pp] bad update', e.message); } }
          }
        });
        res.on('end', () => lost(new Error('stream ended')));
        res.on('error', lost);
        res.on('aborted', () => lost(new Error('stream aborted')));
      });
      req.on('error', e => (this.status === 'connected' ? lost(e) : reject(e)));
      req.end(body);
      this.req = req;
      this.kick();
    });
  }

  // ProPresenter sends timer/system_time every second, so silence means a dead link.
  kick() {
    clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => { if (this.req) this.req.destroy(new Error('stream stalled')); }, 8000);
  }

  // ---- updates ---------------------------------------------------------------

  async onUpdate({ url, data }) {
    switch (url) {
      case 'status/slide': this.raw.slide = data; break;
      case 'status/layers': this.raw.layers = data || {}; break;
      case 'presentation/slide_index':
        this.raw.slideIndex = data && data.presentation_index;
        await this.ensurePresentation(this.raw.slideIndex && this.raw.slideIndex.presentation_id && this.raw.slideIndex.presentation_id.uuid);
        break;
      case 'presentation/current':
        if (data && data.presentation) this.storePresentation(data.presentation);
        break;
      case 'look/current': this.raw.look = data; break;
      case 'playlist/active': await this.onPlaylistActive(data); break;
      case 'messages': this.raw.messages = data || []; this.markMessages(false); break;
      case 'transport/presentation/current': this.raw.transport = data; break;
      case 'transport/presentation/time':
        this.emit('time', { time: +data || 0, at: Date.now() });
        return;
      default: return;
    }
    this.push();
  }

  storePresentation(p) {
    const uuid = p.id && p.id.uuid;
    if (!uuid) return;
    // Through the path map, so a remote Receiver can read the .pro over a mounted share.
    const meta = (p.presentation_path && readProFile(this.media.mapPath(p.presentation_path))) || null;
    this.presentations.set(uuid, { data: p, meta, fetchedAt: Date.now() });
  }

  async ensurePresentation(uuid, force = false) {
    if (!uuid || (!force && this.presentations.has(uuid))) return this.presentations.get(uuid);
    try {
      const r = await this.get(`/v1/presentation/${uuid}`);
      if (r && r.presentation) this.storePresentation(r.presentation);
    } catch (e) { console.warn('[pp] presentation', uuid, e.message); }
    return this.presentations.get(uuid);
  }

  // Triggering from the library (not the playlist) clears ProPresenter's active
  // playlist; keep showing the last one rather than blanking the panel.
  async onPlaylistActive(data) {
    this.raw.playlist = data;
    const pl = data && data.presentation && data.presentation.playlist;
    if (!pl) return;
    const item = data.presentation.item;
    const known = this.playlist && this.playlist.uuid === pl.uuid;
    if (!known || (item && !this.playlist.items.some(i => i.id.uuid === item.uuid))) await this.loadPlaylist(pl);
  }

  async loadPlaylist(pl) {
    clearTimeout(this.playlistTimer);
    // Pick up edits made in ProPresenter while the playlist is loaded.
    this.playlistTimer = setTimeout(() => this.status === 'connected' && this.loadPlaylist(pl), 30000);
    try {
      const r = await this.get(`/v1/playlist/${pl.uuid}`);
      this.playlist = { uuid: pl.uuid, name: pl.name, items: (r && r.items) || [] };
      this.push();
      // Pre-load every presentation in the playlist so slides are ready before they go live.
      for (const it of this.playlist.items) {
        const id = it.presentation_info && it.presentation_info.presentation_uuid;
        if (it.type === 'presentation' && id) await this.ensurePresentation(id, true);
      }
      this.push();
    } catch (e) { console.warn('[pp] playlist', e.message); }
  }

  // Speaker titles from ProPresenter messages: fire once when a matching message goes active.
  markMessages(initial) {
    const re = new RegExp(this.getConfig().speakerMessageMatch || '^$', 'i');
    const nowActive = new Set();
    for (const m of this.raw.messages) {
      if (!m.is_active) continue;
      const id = m.id.uuid;
      nowActive.add(id);
      if (!initial && !this.activeMessages.has(id) && re.test(m.id.name)) {
        const tok = n => (m.tokens || []).find(t => n.test(t.name));
        const name = tok(/name/i), title = tok(/title|role|position/i);
        let parts = [name && name.text && name.text.text, title && title.text && title.text.text];
        if (!parts[0]) parts = this.messageText(m).split(/\s[—–|-]\s/);
        this.emit('speaker', { name: parts[0] || '', title: parts[1] || '', source: 'message' });
      }
    }
    this.activeMessages = nowActive;
  }

  messageText(m) {
    return (m.message || '').replace(/\{([^}]+)\}/g, (_, n) => {
      const t = (m.tokens || []).find(x => x.name === n);
      return t && t.text ? t.text.text : '';
    });
  }

  // ---- state for the display -------------------------------------------------

  layoutFor(look) {
    const cfg = this.getConfig();
    const name = (look && look.id && look.id.name) || '';
    for (const r of cfg.lookLayouts) {
      try { if (r.match && new RegExp(r.match, 'i').test(name)) return r.layout; } catch { /* bad regex */ }
    }
    return cfg.defaultLayout;
  }

  currentSlide() {
    const idx = this.raw.slideIndex;
    const s = this.raw.slide && this.raw.slide.current;
    const pres = idx && idx.presentation_id && this.presentations.get(idx.presentation_id.uuid);
    let group = null, slideInfo = null, next = null;
    if (pres && idx) {
      let n = 0;
      for (const g of pres.data.groups || []) {
        for (const sl of g.slides || []) {
          if (n === idx.index) { group = g; slideInfo = sl; } else if (n === idx.index + 1) next = { group: g, slide: sl };
          n++;
        }
      }
    }
    return { s, idx, pres, group, slideInfo, next };
  }

  buildState() {
    const cfg = this.getConfig();
    const look = this.raw.look;
    const screen = (look && look.screens && (look.screens[cfg.screenIndex] || look.screens[0])) || {};
    const layers = this.raw.layers || {};
    const { s, idx, pres, group, slideInfo, next } = this.currentSlide();

    let slide = null;
    if (s && layers.slide !== false && (s.text || s.uuid)) {
      const info = {
        text: s.text || '', notes: s.notes || (slideInfo && slideInfo.notes) || '',
        label: (slideInfo && slideInfo.label) || '', group: (group && group.name) || '',
        presentation: (pres && pres.data.id.name) || '', meta: (pres && pres.meta) || {},
      };
      slide = {
        uuid: s.uuid, index: idx ? idx.index : null, group: info.group, groupColor: rgb(group && group.color),
        presentation: info.presentation, ...classify(info),
      };
      if (!s.text) slide.kind = 'blank';
    }
    const nextText = this.raw.slide && this.raw.slide.next && this.raw.slide.next.text;

    // Media: cue media from the .pro file first, then the transport's file name.
    let media = null;
    const tr = this.raw.transport;
    if (layers.media && tr && tr.name) {
      let resolved = null;
      const cueId = s && s.uuid && s.uuid.toUpperCase();
      const cue = pres && pres.meta && cueId && pres.meta.cues[cueId];
      if (cue && cue.media) resolved = this.media.resolveFile(cue.media.file, cue.media.kind);
      if (!resolved) {
        // Media from an earlier cue can still be playing; search this presentation's cues by name.
        const all = pres && pres.meta ? Object.values(pres.meta.cues).map(c => c.media).filter(Boolean) : [];
        const byName = all.find(m => m.file.endsWith('/' + tr.name));
        resolved = byName ? this.media.resolveFile(byName.file, byName.kind) : this.media.resolveName(tr.name);
      }
      media = { name: tr.name, playing: !!tr.is_playing, duration: tr.duration || 0, uuid: tr.uuid, audioOnly: !!tr.audio_only, ...(resolved || {}) };
      if (!resolved && cfg.thumbnailFallback && pres && idx) {
        media.url = `/api/thumbnail/${pres.data.id.uuid}/${idx.index}`;
        media.kind = 'image';
        media.fallback = true;
      }
      if (media.audioOnly) media = null;
    }

    const messages = (this.raw.messages || []).filter(m => m.is_active).map(m => ({ id: m.id.uuid, name: m.id.name, text: this.messageText(m) }));
    const speakerRe = new RegExp(cfg.speakerMessageMatch || '^$', 'i');

    const active = this.raw.playlist && this.raw.playlist.presentation;
    const live = !!(active && active.playlist && this.playlist && active.playlist.uuid === this.playlist.uuid);
    const playlist = this.playlist && {
      uuid: this.playlist.uuid, name: this.playlist.name, live,
      activeIndex: live && active.item ? active.item.index : null,
      items: this.playlist.items.map((it, i) => {
        const id = it.presentation_info && it.presentation_info.presentation_uuid;
        const p = id && this.presentations.get(id);
        return {
          index: i, name: it.id.name, type: it.type, uuid: id || it.id.uuid,
          color: rgb(it.header_color),
          groups: p ? (p.data.groups || []).map(g => ({ name: g.name, color: rgb(g.color), slides: (g.slides || []).map(sl => ({ text: sl.text, label: sl.label, kind: classify({ text: sl.text, notes: sl.notes, label: sl.label, group: g.name, presentation: p.data.id.name, meta: p.meta || {} }).kind })) })) : null,
          hasMeta: !!(p && p.meta),
        };
      }),
    };

    return {
      connection: { status: this.status, host: this.host, port: this.port, name: this.version && this.version.host_description },
      look: look ? { uuid: look.id.uuid, name: look.id.name } : null,
      looks: (this.looks || []).map(l => ({ uuid: l.id.uuid, name: l.id.name })),
      layout: {
        mode: this.layoutFor(look),
        showText: screen.slide !== false,
        showMedia: cfg.showMedia && screen.media !== false,
        showMessages: cfg.messages.show && screen.messages !== false,
      },
      slide,
      next: nextText ? { text: nextText, group: next && next.group && next.group.name } : null,
      media,
      messages: messages.filter(m => !speakerRe.test(m.name)),
      presentation: pres ? { uuid: pres.data.id.uuid, name: pres.data.id.name, readable: !!pres.meta } : null,
      playlist,
    };
  }

  push() {
    clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(() => {
      const state = this.buildState();
      // A speaker slide going live plays the animated title (once per slide change).
      const sk = state.slide && state.slide.kind === 'speaker' ? `${state.slide.uuid}|${state.slide.name}` : null;
      if (sk && sk !== this.lastSpeakerKey) this.emit('speaker', { name: state.slide.name, title: state.slide.title, source: 'slide' });
      this.lastSpeakerKey = sk;
      this.emit('state', state);
    }, 15);
  }

  // ---- control passthrough --------------------------------------------------

  triggerLook(id) { return this.get(`/v1/look/${id}/trigger`); }
  triggerPlaylistItem(playlist, index) { return this.get(`/v1/playlist/${playlist}/${index}/trigger`); }
  triggerCue(presentation, index) { return this.get(`/v1/presentation/${presentation}/${index}/trigger`); }
  next() { return this.get('/v1/trigger/next'); }
  previous() { return this.get('/v1/trigger/previous'); }
  clear(layer) { return this.get(`/v1/clear/layer/${layer}`); }
  thumbnail(presentation, index) { return this.request('GET', `/v1/presentation/${presentation}/thumbnail/${index}?quality=960`, undefined, { raw: true }); }
}

module.exports = { ProPresenter };

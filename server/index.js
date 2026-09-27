#!/usr/bin/env node
// ProPresenter Receiver — renders lower-thirds, scripture, speaker titles and
// media from a live ProPresenter instance into a browser output.
//
//   http://<host>:8080/          control panel
//   http://<host>:8080/display   the output (full-screen it, or add as a browser source)
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { Discovery } = require('./discovery');
const { ProPresenter } = require('./propresenter');
const { MediaResolver } = require('./media');

const PORT = +process.env.PORT || 8080;
const PUBLIC = path.join(__dirname, '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

config.load();
const media = new MediaResolver(config.get);
const discovery = new Discovery(config.get);

let pp = null;
let state = { connection: { status: 'idle' } };
let speaker = null; // last speaker event, so late-joining displays don't replay it
let speakerSeq = 0;
const clients = new Set();

// ---- server-sent events -----------------------------------------------------

function send(res, event, data) { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
function broadcast(event, data) { for (const c of clients) send(c, event, data); }

function publicConfig() {
  const c = config.get();
  return { theme: c.theme, speakerHoldSeconds: c.speakerHoldSeconds, speakerStyle: c.speakerStyle, mediaAudio: c.mediaAudio, lookLayouts: c.lookLayouts, defaultLayout: c.defaultLayout };
}

function discoveryState() {
  return { instances: discovery.list(), scanning: discovery.scanning, progress: discovery.progress };
}

discovery.on('change', () => {
  broadcast('discovery', discoveryState());
  autoConnect();
});

// ---- connection management ---------------------------------------------------

function connect(host, port, { remember = true } = {}) {
  if (pp && pp.host === host && pp.port === +port && pp.status !== 'disconnected') return;
  if (pp) { pp.stop(); pp.removeAllListeners(); }
  pp = new ProPresenter({ host, port }, { getConfig: config.get, media });
  pp.on('state', s => { state = s; broadcast('state', s); });
  pp.on('speaker', s => showSpeaker(s));
  pp.on('time', t => broadcast('time', t));
  pp.start();
  if (remember) config.save({ connection: { host, port: +port } });
  console.log(`[receiver] connecting to ProPresenter at ${host}:${port}`);
}

function disconnect() {
  if (pp) { pp.stop(); pp.removeAllListeners(); pp = null; }
  config.save({ connection: null, autoConnect: false });
  state = { connection: { status: 'idle' } };
  broadcast('state', state);
}

// Connect on our own when there's an obvious choice: the saved instance, or the
// only one on the network.
function autoConnect() {
  const cfg = config.get();
  if (!cfg.autoConnect) return;
  const online = discovery.list().filter(i => i.online);
  if (pp && pp.status === 'connected') return;
  const saved = cfg.connection && online.find(i => i.port === cfg.connection.port && (i.host === cfg.connection.host || (i.local && /^(127\.|localhost)/.test(cfg.connection.host))));
  const pick = saved || (online.length === 1 ? online[0] : null);
  if (pick && !(pp && pp.host === pick.host && pp.port === pick.port)) connect(pick.host, pick.port);
}

function showSpeaker({ name, title, hold, source }) {
  if (!name) return;
  speaker = { id: ++speakerSeq, name, title: title || '', hold: +hold || config.get().speakerHoldSeconds, source: source || 'manual', at: Date.now() };
  broadcast('speaker', speaker);
}

// ---- HTTP -------------------------------------------------------------------

function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', c => { d += c; if (d.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function serveStatic(res, file) {
  const full = path.join(PUBLIC, file);
  if (!full.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(full, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(full)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(buf);
  });
}

const needPP = res => { if (!pp) { json(res, 409, { error: 'Not connected to ProPresenter' }); return false; } return true; };

const routes = {
  'GET /api/state': (req, res) => json(res, 200, { state, config: config.get(), discovery: discoveryState() }),
  'GET /api/config': (req, res) => json(res, 200, config.get()),
  'PUT /api/config': async (req, res) => {
    const c = config.save(await readBody(req));
    broadcast('config', publicConfig());
    if (pp) pp.push();
    json(res, 200, c);
  },
  'POST /api/discovery/scan': async (req, res) => {
    const { deep } = await readBody(req);
    discovery.run({ deep: deep || null });
    json(res, 202, { ok: true });
  },
  'POST /api/connect': async (req, res) => {
    const { host, port } = await readBody(req);
    if (!host || !port) return json(res, 400, { error: 'host and port required' });
    config.save({ autoConnect: true });
    connect(host, +port);
    json(res, 200, { ok: true });
  },
  'POST /api/disconnect': (req, res) => { disconnect(); json(res, 200, { ok: true }); },
  'POST /api/speaker': async (req, res) => { showSpeaker({ ...(await readBody(req)), source: 'manual' }); json(res, 200, speaker); },
  'POST /api/speaker/hide': (req, res) => { broadcast('speaker-hide', {}); json(res, 200, { ok: true }); },
  'POST /api/pp/look': async (req, res) => { if (!needPP(res)) return; await pp.triggerLook((await readBody(req)).uuid); json(res, 200, { ok: true }); },
  'POST /api/pp/playlist': async (req, res) => { if (!needPP(res)) return; const b = await readBody(req); await pp.triggerPlaylistItem(b.playlist, b.index); json(res, 200, { ok: true }); },
  'POST /api/pp/cue': async (req, res) => { if (!needPP(res)) return; const b = await readBody(req); await pp.triggerCue(b.presentation, b.index); json(res, 200, { ok: true }); },
  'POST /api/pp/next': async (req, res) => { if (!needPP(res)) return; await pp.next(); json(res, 200, { ok: true }); },
  'POST /api/pp/previous': async (req, res) => { if (!needPP(res)) return; await pp.previous(); json(res, 200, { ok: true }); },
  'POST /api/pp/clear': async (req, res) => { if (!needPP(res)) return; await pp.clear((await readBody(req)).layer || 'slide'); json(res, 200, { ok: true }); },
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    const route = routes[`${req.method} ${url.pathname}`];
    if (route) return await route(req, res);

    if (url.pathname === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      res.write('retry: 2000\n\n');
      send(res, 'config', publicConfig());
      send(res, 'state', state);
      send(res, 'discovery', discoveryState());
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 15000);
      req.on('close', () => { clearInterval(ping); clients.delete(res); });
      return;
    }
    if (url.pathname.startsWith('/media/')) return media.serve(req, res, decodeURIComponent(url.pathname.slice(7)));
    const thumb = /^\/api\/thumbnail\/([0-9A-Fa-f-]+)\/(\d+)$/.exec(url.pathname);
    if (thumb) {
      if (!needPP(res)) return;
      const up = await pp.thumbnail(thumb[1], thumb[2]);
      res.writeHead(up.statusCode, { 'content-type': up.headers['content-type'] || 'image/jpeg', 'cache-control': 'max-age=30' });
      return up.pipe(res);
    }
    if (req.method !== 'GET') return json(res, 404, { error: 'not found' });
    if (url.pathname === '/' || url.pathname === '/control') return serveStatic(res, 'control.html');
    if (url.pathname === '/display') return serveStatic(res, 'display.html');
    return serveStatic(res, url.pathname.slice(1));
  } catch (e) {
    console.error('[http]', req.method, url.pathname, e.message);
    if (!res.headersSent) json(res, 500, { error: e.message });
    else res.end();
  }
});

server.listen(PORT, () => {
  console.log(`[receiver] control panel  http://localhost:${PORT}/`);
  console.log(`[receiver] display output http://localhost:${PORT}/display`);
  const cfg = config.get();
  if (cfg.autoConnect && cfg.connection) connect(cfg.connection.host, cfg.connection.port, { remember: false });
  // Localhost gets a full port sweep once — cheap, and finds ProPresenter on any port when testing.
  discovery.run({ deep: '127.0.0.1' });
  // Keep looking while disconnected; re-check known instances otherwise.
  setInterval(() => {
    if (discovery.scanning) return;
    if (!pp || pp.status !== 'connected') discovery.run({ full: true });
    else discovery.quick().catch(() => {});
  }, 30000);
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { if (pp) pp.stop(); process.exit(0); });

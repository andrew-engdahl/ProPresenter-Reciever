// Resolves ProPresenter media references to files this server can stream, and
// serves them with HTTP range support (needed for <video> seeking).
//
// ProPresenter's API doesn't hand out media files, so we find them ourselves:
//   * cue media: the file path stored in the presentation's .pro document
//   * media-bin items: the transport's file name, looked up in media folders
// Paths are passed through `mediaPathMap` so a Linux box can reach the same
// files over a mounted share (e.g. /Users/av/Media → /mnt/propresenter/Media).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const TYPES = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp',
};
const HOME_DIRS = { '~home': '', '~Documents': 'Documents', '~Downloads': 'Downloads', '~Music': 'Music', '~Pictures': 'Pictures', '~Movies': 'Movies', '~Desktop': 'Desktop', '~': '' };

class MediaResolver {
  constructor(getConfig) {
    this.getConfig = getConfig;
    this.tokens = new Map(); // token -> absolute path
    this.byPath = new Map(); // absolute path -> token
    this.index = null; // lowercase basename -> path
    this.indexedAt = 0;
  }

  defaultFolders() {
    const pp = path.join(os.homedir(), 'Library/Application Support/RenewedVision/ProPresenter');
    return [pp, path.join(os.homedir(), 'Documents/ProPresenter'), path.join(os.homedir(), 'Movies')].filter(d => fs.existsSync(d));
  }

  mapPath(p) {
    if (!p) return null;
    const m = /^(~[A-Za-z]*)\/(.*)$/.exec(p);
    if (m) p = path.join(os.homedir(), HOME_DIRS[m[1]] ?? '', m[2]);
    for (const { from, to } of this.getConfig().mediaPathMap || []) {
      if (from && p.startsWith(from)) return path.join(to, p.slice(from.length));
    }
    return p;
  }

  register(file) {
    if (this.byPath.has(file)) return this.byPath.get(file);
    const token = crypto.createHash('sha1').update(file).digest('hex').slice(0, 16) + path.extname(file).toLowerCase();
    this.tokens.set(token, file);
    this.byPath.set(file, token);
    return token;
  }

  // → { url, kind } or null
  resolveFile(file, kind) {
    const mapped = this.mapPath(file);
    if (mapped && fs.existsSync(mapped)) return { url: `/media/${this.register(mapped)}`, kind, name: path.basename(mapped) };
    // The path may differ on this machine; fall back to a name lookup.
    return file ? this.resolveName(path.basename(file), kind) : null;
  }

  resolveName(name, kind) {
    if (!name) return null;
    const hit = this.lookup(name.toLowerCase());
    if (!hit) return null;
    const k = kind || (/^image\//.test(TYPES[path.extname(hit).toLowerCase()] || '') ? 'image' : 'video');
    return { url: `/media/${this.register(hit)}`, kind: k, name: path.basename(hit) };
  }

  lookup(lower) {
    if (!this.index || (Date.now() - this.indexedAt > 30000 && !this.index.has(lower))) this.buildIndex();
    return this.index.get(lower) || null;
  }

  buildIndex() {
    const index = new Map();
    const folders = [...new Set([...(this.getConfig().mediaFolders || []).map(f => this.mapPath(f)), ...this.defaultFolders()])];
    let budget = 50000;
    const walk = dir => {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (--budget < 0) return;
        if (e.name.startsWith('.')) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { if (!/^(Thumbnails|Database|Cache|Caches)$/i.test(e.name)) walk(full); } else if (TYPES[path.extname(e.name).toLowerCase()] && !index.has(e.name.toLowerCase())) index.set(e.name.toLowerCase(), full);
      }
    };
    folders.forEach(walk);
    this.index = index;
    this.indexedAt = Date.now();
  }

  serve(req, res, token) {
    const file = this.tokens.get(token);
    if (!file) { res.writeHead(404); return res.end(); }
    let st;
    try { st = fs.statSync(file); } catch { res.writeHead(404); return res.end(); }
    const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    const headers = { 'content-type': type, 'accept-ranges': 'bytes', 'cache-control': 'public, max-age=3600' };
    if (range) {
      const start = range[1] ? +range[1] : Math.max(0, st.size - +range[2]);
      const end = range[1] && range[2] ? Math.min(+range[2], st.size - 1) : st.size - 1;
      if (start >= st.size || start > end) { res.writeHead(416, { 'content-range': `bytes */${st.size}` }); return res.end(); }
      res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${st.size}`, 'content-length': end - start + 1 });
      fs.createReadStream(file, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { ...headers, 'content-length': st.size });
      fs.createReadStream(file).pipe(res);
    }
  }
}

module.exports = { MediaResolver };

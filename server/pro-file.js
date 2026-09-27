// Reads just enough of a ProPresenter .pro file (protobuf) to learn, per cue,
// which media file it triggers, plus whether the presentation is a song (CCLI)
// or a Bible passage. Hand-rolled so the server has no dependencies.
//
// Field numbers come from the community schema (greyshirtguy/ProPresenter7-Proto):
//   Presentation: 13 cues, 14 ccli (1 author, 3 song_title, 6 song_number), 15 bible_reference
//   Cue: 1 uuid, 10 actions          Action: 9 type, 20 media
//   MediaType: 5 element, 6 image, 7 video, 8 audio
//   Media: 2 url, 4 audio, 5 image, 6 video      URL: 1 absolute_string, 4 local
//   UUID: 1 string
'use strict';
const fs = require('fs');

function readVarint(buf, pos) {
  let n = 0, shift = 0, b;
  do {
    if (pos >= buf.length) throw new Error('truncated varint');
    b = buf[pos++];
    n += (b & 0x7f) * 2 ** shift;
    shift += 7;
  } while (b & 0x80);
  return [n, pos];
}

// Returns [{ field, wire, value }] where value is a Buffer for length-delimited
// fields and a number for varints.
function fields(buf) {
  const out = [];
  let pos = 0;
  while (pos < buf.length) {
    let key;
    [key, pos] = readVarint(buf, pos);
    const field = Math.floor(key / 8), wire = key & 7;
    let value;
    if (wire === 0) [value, pos] = readVarint(buf, pos);
    else if (wire === 1) { value = buf.subarray(pos, pos + 8); pos += 8; }
    else if (wire === 5) { value = buf.subarray(pos, pos + 4); pos += 4; }
    else if (wire === 2) {
      let len;
      [len, pos] = readVarint(buf, pos);
      value = buf.subarray(pos, pos + len);
      pos += len;
    } else throw new Error('unsupported wire type ' + wire);
    out.push({ field, wire, value });
  }
  return out;
}

const first = (fs_, n) => fs_.find(f => f.field === n);
const str = f => (f ? f.value.toString('utf8') : '');
const uuidOf = f => (f ? str(first(fields(f.value), 1)) : '');

const ACTION_TYPE_MEDIA = 2;
const LOCAL_ROOTS = { 2: 'home', 3: 'Documents', 4: 'Downloads', 5: 'Music', 6: 'Pictures', 7: 'Movies', 11: 'Desktop' };

function urlToPath(buf) {
  const u = fields(buf);
  const abs = str(first(u, 1));
  if (abs) {
    if (abs.startsWith('file://')) {
      try { return decodeURIComponent(new URL(abs).pathname); } catch { return null; }
    }
    return abs.startsWith('/') || /^[A-Za-z]:[\\/]/.test(abs) ? abs : null;
  }
  // Local-relative paths are kept as "~<root>/<path>" for the path map to resolve.
  const local = first(u, 4);
  if (local) {
    const l = fields(local.value);
    const root = first(l, 1), p = str(first(l, 2));
    if (p) return `~${LOCAL_ROOTS[root ? root.value : 0] || ''}/${p}`;
  }
  return null;
}

function mediaFromAction(actionBuf) {
  const a = fields(actionBuf);
  const type = first(a, 9);
  const mediaField = first(a, 20);
  if (!mediaField || (type && type.value !== ACTION_TYPE_MEDIA)) return null;
  const m = fields(mediaField.value);
  const element = first(m, 5);
  if (!element) return null;
  const e = fields(element.value);
  const url = first(e, 2);
  const file = url ? urlToPath(url.value) : null;
  if (!file) return null;
  let kind = first(m, 7) || first(e, 6) ? 'video' : first(m, 6) || first(e, 5) ? 'image' : first(m, 8) || first(e, 4) ? 'audio' : null;
  if (!kind) kind = /\.(png|jpe?g|gif|webp|heic|tiff?|bmp)$/i.test(file) ? 'image' : 'video';
  return { file, kind };
}

/**
 * @returns {{ cues: Object<string, {media: {file, kind}|null}>, isSong: boolean, isBible: boolean }}
 */
function parsePro(buf) {
  const top = fields(buf);
  const cues = {};
  for (const c of top.filter(f => f.field === 13)) {
    const cf = fields(c.value);
    const id = uuidOf(first(cf, 1)).toUpperCase();
    let media = null;
    for (const act of cf.filter(f => f.field === 10)) {
      const m = mediaFromAction(act.value);
      if (m && m.kind !== 'audio') { media = m; break; }
    }
    if (id) cues[id] = { media };
  }
  // ProPresenter writes an empty CCLI block into every document it saves, so only
  // count it as a song when the block names an author, title or song number.
  const ccli = first(top, 14);
  const isSong = !!ccli && fields(ccli.value).some(f => [1, 3, 6].includes(f.field) && (f.wire === 0 ? f.value > 0 : f.value.length > 0));
  return { cues, isSong, isBible: !!first(top, 15) };
}

const cache = new Map(); // path -> { mtimeMs, data }

function readProFile(file) {
  try {
    const st = fs.statSync(file);
    const hit = cache.get(file);
    if (hit && hit.mtimeMs === st.mtimeMs) return hit.data;
    const data = parsePro(fs.readFileSync(file));
    cache.set(file, { mtimeMs: st.mtimeMs, data });
    return data;
  } catch {
    return null;
  }
}

module.exports = { parsePro, readProFile };

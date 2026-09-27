#!/usr/bin/env node
// Adds the Receiver's audience Looks to ProPresenter's Workspace config.
//
// On ProPresenter 21.4, POST /v1/looks answers 200 but the look doesn't appear
// (in the UI or GET /v1/looks) until a restart, so this writes them into the
// config file directly. ProPresenter must be QUIT first (it rewrites the file on
// exit). A timestamped backup is made.
//
// The new looks are appended as raw protobuf records rather than re-encoding the
// whole file, so any fields the community schema doesn't know about survive.
//
// Duplicate looks (same name) are removed, keeping the first — repeated API
// POSTs pile up because the earlier ones aren't visible before a restart.
//
// usage: node looks.js [--workspace <path to Configuration/Workspace>]
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const protobuf = require('protobufjs');

const argi = process.argv.indexOf('--workspace');
const FILE = argi > 0 ? process.argv[argi + 1] : path.join(os.homedir(),
  'Library/Application Support/RenewedVision/ProPresenter/UserWorkspaces/ProPresenter/Configuration/Workspace');

// name → which layers the look shows on the audience screen
const LOOKS = [
  ['Lower Thirds', { slide: true, media: false, messages: true, props: true, video: true, announcements: true }],
  ['Full Screen Lyrics', { slide: true, media: true, messages: true, props: true, video: true, announcements: true }],
  ['Scripture Focus', { slide: true, media: true, messages: false, props: false, video: true, announcements: true }],
  ['Media + Lower Thirds', { slide: true, media: true, messages: true, props: true, video: true, announcements: true }],
  ['Clean Feed', { slide: false, media: true, messages: false, props: false, video: true, announcements: false }],
];

function running() {
  try { return execSync('pgrep -x ProPresenter', { stdio: 'pipe' }).toString().trim() !== ''; } catch { return false; }
}

function varint(n) {
  const out = [];
  while (n > 0x7f) { out.push((n & 0x7f) | 0x80); n >>>= 7; }
  out.push(n);
  return Buffer.from(out);
}

if (running() && !process.argv.includes('--force')) {
  console.error('ProPresenter is running. Quit it first (it overwrites this file on exit).');
  process.exit(1);
}

const root = new protobuf.Root();
root.resolvePath = (origin, target) => path.join(__dirname, 'proto', target);
root.loadSync('proworkspace.proto', { keepCase: true });
const Workspace = root.lookupType('rv.data.ProPresenterWorkspace');
const Look = root.lookupType('rv.data.ProAudienceLook');

function readVarint(buf, pos) {
  let n = 0, shift = 0, b;
  do { b = buf[pos++]; n += (b & 0x7f) * 2 ** shift; shift += 7; } while (b & 0x80);
  return [n, pos];
}

// Split the top-level message into raw field records.
function fields(buf) {
  const out = [];
  for (let pos = 0; pos < buf.length;) {
    const start = pos;
    let key; [key, pos] = readVarint(buf, pos);
    const wire = key & 7;
    let body = null;
    if (wire === 0) [, pos] = readVarint(buf, pos);
    else if (wire === 1) pos += 8;
    else if (wire === 5) pos += 4;
    else if (wire === 2) { let len; [len, pos] = readVarint(buf, pos); body = buf.subarray(pos, pos + len); pos += len; }
    else throw new Error('unsupported wire type ' + wire);
    out.push({ field: key >>> 3, raw: buf.subarray(start, pos), body });
  }
  return out;
}

const loaded = fs.readFileSync(FILE);
const seen = new Set();
let dropped = 0;
const kept = fields(loaded).filter(r => {
  if (r.field !== 2) return true;
  const name = Look.decode(r.body).name;
  if (seen.has(name)) { dropped++; console.log('  removing duplicate:', name); return false; }
  seen.add(name);
  return true;
});
const original = Buffer.concat(kept.map(r => r.raw));
const ws = Workspace.toObject(Workspace.decode(original), { defaults: false });
const have = new Set((ws.audience_looks || []).map(l => l.name));
const screens = [...new Set((ws.audience_looks || []).flatMap(l => (l.screen_looks || []).map(s => s.pro_screen_uuid.string)))];
if (!screens.length) throw new Error('No audience screen found in existing looks');

const records = [];
for (const [name, s] of LOOKS) {
  if (have.has(name)) { console.log('  exists:', name); continue; }
  const look = Look.encode(Look.fromObject({
    uuid: { string: crypto.randomUUID().toUpperCase() },
    name,
    transition_duration: 1,
    screen_looks: screens.map(id => ({
      pro_screen_uuid: { string: id },
      props_enabled: s.props,
      live_video_enabled: s.video,
      presentation_background_enabled: s.media,
      presentation_foreground_enabled: s.slide,
      announcements_enabled: s.announcements,
      props_layer_enabled: s.props,
      messages_layer_enabled: s.messages,
    })),
  })).finish();
  records.push(Buffer.from([0x12]), varint(look.length), Buffer.from(look)); // field 2, length-delimited
  console.log('  adding:', name);
}

if (!records.length && !dropped) { console.log('Nothing to do.'); process.exit(0); }
const backup = `${FILE}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
fs.copyFileSync(FILE, backup);
fs.writeFileSync(FILE, Buffer.concat([original, ...records]));
Workspace.decode(fs.readFileSync(FILE)); // sanity check
console.log(`Wrote ${FILE}\nBackup: ${backup}\nStart ProPresenter again.`);

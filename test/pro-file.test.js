'use strict';
// Builds tiny .pro documents by hand (protobuf wire format) and checks the reader.
const test = require('node:test');
const assert = require('node:assert');
const { parsePro } = require('../server/pro-file');

const varint = n => { const o = []; while (n > 0x7f) { o.push((n & 0x7f) | 0x80); n >>>= 7; } o.push(n); return Buffer.from(o); };
const field = (num, body) => Buffer.concat([varint((num << 3) | 2), varint(body.length), body]);
const vfield = (num, v) => Buffer.concat([varint(num << 3), varint(v)]);
const str = (num, s) => field(num, Buffer.from(s));
const uuid = s => str(1, s);

function mediaCue(id, file, kind = 'video') {
  const media = Buffer.concat([field(2, str(1, 'file://' + encodeURI(file))), field(kind === 'video' ? 6 : 5, Buffer.alloc(0))]);
  const mediaType = Buffer.concat([field(5, media), field(kind === 'video' ? 7 : 6, Buffer.alloc(0))]);
  const action = Buffer.concat([vfield(9, 2), field(20, mediaType)]);
  return field(13, Buffer.concat([field(1, uuid(id)), field(10, action)]));
}

test('finds per-cue media files and their kind', () => {
  const doc = Buffer.concat([
    str(3, 'Amazing Grace'),
    mediaCue('AAAA-1', '/Users/av/Media/Worship Loop.mp4'),
    mediaCue('bbbb-2', '/Users/av/Media/Still.jpg', 'image'),
    field(13, field(1, uuid('CCCC-3'))), // text-only cue
  ]);
  const r = parsePro(doc);
  assert.deepEqual(r.cues['AAAA-1'].media, { file: '/Users/av/Media/Worship Loop.mp4', kind: 'video' });
  assert.deepEqual(r.cues['BBBB-2'].media, { file: '/Users/av/Media/Still.jpg', kind: 'image' });
  assert.equal(r.cues['CCCC-3'].media, null);
});

test('empty CCLI block is not a song; a populated one is', () => {
  assert.equal(parsePro(field(14, Buffer.alloc(0))).isSong, false);
  assert.equal(parsePro(field(14, str(3, 'Amazing Grace'))).isSong, true);
  assert.equal(parsePro(field(15, str(2, 'John'))).isBible, true);
});

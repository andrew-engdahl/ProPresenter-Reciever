'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { classify } = require('../server/classify');

test('scripture: reference in its own text box', () => {
  const r = classify({ text: 'For God so loved the world…\rJohn 3:16 KJV', group: 'Scripture' });
  assert.equal(r.kind, 'scripture');
  assert.equal(r.reference, 'John 3:16 KJV');
  assert.deepEqual(r.body, ['For God so loved the world…']);
});

test('scripture: detected from a trailing reference with no group', () => {
  const r = classify({ text: 'Love is patient, love is kind.\n1 Corinthians 13:4 (NIV)' });
  assert.equal(r.kind, 'scripture');
  assert.equal(r.reference, '1 Corinthians 13:4 (NIV)');
});

test('scripture: Bible metadata from the .pro wins over plain text', () => {
  assert.equal(classify({ text: 'In the beginning', meta: { isBible: true } }).kind, 'scripture');
});

test('lyrics: song groups and CCLI', () => {
  assert.equal(classify({ text: 'Amazing grace', group: 'Verse 1' }).kind, 'lyrics');
  assert.equal(classify({ text: 'It is well', group: 'Chorus' }).kind, 'lyrics');
  assert.equal(classify({ text: 'Some line', group: 'Group', meta: { isSong: true } }).kind, 'lyrics');
});

test('speaker: group name, and name/title split by text box', () => {
  const r = classify({ text: 'Maya Chen\rWorship Director', group: 'Speaker' });
  assert.equal(r.kind, 'speaker');
  assert.equal(r.name, 'Maya Chen');
  assert.equal(r.title, 'Worship Director');
});

test('notes #tags override everything', () => {
  assert.equal(classify({ text: 'Jordan Ellis\nLead Pastor', group: 'Verse 1', notes: '#speaker' }).kind, 'speaker');
  assert.equal(classify({ text: 'anything', group: 'Verse 1', notes: 'cue: #hide' }).kind, 'blank');
});

test('announcement and sermon point titles', () => {
  const a = classify({ text: 'Community Lunch\rSunday after service', group: 'Announcement' });
  assert.deepEqual([a.kind, a.title, a.body], ['announcement', 'Community Lunch', ['Sunday after service']]);
  assert.equal(classify({ text: 'Rooted\nWeek 1', group: 'Sermon Title' }).kind, 'point');
});

test('empty slides are blank (media-only cues)', () => {
  assert.equal(classify({ text: '', group: 'Intro' }).kind, 'blank');
});

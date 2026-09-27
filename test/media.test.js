'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { MediaResolver, fileName } = require('../server/media');

test('fileName splits on either separator', () => {
  assert.equal(fileName('/Users/av/Movies/Loop.mp4'), 'Loop.mp4');
  assert.equal(fileName('C:\\Users\\av\\Videos\\Loop.mp4'), 'Loop.mp4');
  assert.equal(fileName('C:/Users/av/Videos/Loop.mp4'), 'Loop.mp4');
});

test('path map matches Windows paths with either slash and any case', () => {
  const r = new MediaResolver(() => ({ mediaPathMap: [{ from: 'C:\\Users\\AV\\Videos', to: '/mnt/pp/Media' }] }));
  assert.equal(r.mapPath('C:/Users/av/Videos/Sub/Loop.mp4'), path.join('/mnt/pp/Media', 'Sub', 'Loop.mp4'));
  assert.equal(r.mapPath('C:\\Users\\av\\Videos\\Loop.mp4'), path.join('/mnt/pp/Media', 'Loop.mp4'));
});

test('path map keeps macOS paths case-sensitive', () => {
  const r = new MediaResolver(() => ({ mediaPathMap: [{ from: '/Users/av/Movies', to: '/mnt/pp/Media' }] }));
  assert.equal(r.mapPath('/Users/av/Movies/Loop.mp4'), path.join('/mnt/pp/Media', 'Loop.mp4'));
  assert.equal(r.mapPath('/users/av/movies/Loop.mp4'), '/users/av/movies/Loop.mp4');
});

// Persistent settings (data/config.json). Everything here is editable from the
// control panel; unknown keys are ignored and missing keys fall back to defaults.
'use strict';
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.RECEIVER_DATA || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'config.json');

const DEFAULTS = {
  // Connection
  autoConnect: true,
  connection: null, // { host, port } last used / pinned instance
  manualHosts: [], // [{ host, port }] always probed during discovery
  scanPorts: [50679, 50001, 50000, 1025, 20652, 49152, 57131, 60157, 4031],
  scanSubnets: true,
  controlProPresenter: true, // false = watch only; never send triggers/clears back to ProPresenter

  // Looks → layouts. First matching rule wins; `layout` is one of
  // lower-third | fullscreen | scripture-focus | clean
  lookLayouts: [
    { match: 'clean', layout: 'clean' },
    { match: 'full', layout: 'fullscreen' },
    { match: 'scripture|focus', layout: 'scripture-focus' },
    { match: 'lower', layout: 'lower-third' },
  ],
  defaultLayout: 'lower-third',
  screenIndex: 0, // which audience screen of the Look to follow

  // Speaker titles
  speakerHoldSeconds: 7,
  speakerMessageMatch: 'speaker|name', // ProPresenter message names that trigger the title
  speakerStyle: 'accent', // accent | minimal

  // Media
  showMedia: true,
  mediaAudio: false, // ProPresenter usually owns audio; keep the browser muted
  mediaFolders: [], // extra folders to search by file name (media bin items)
  mediaPathMap: [], // [{ from: '/Users/av/Media', to: '/mnt/propresenter/Media' }]
  thumbnailFallback: true,

  // Look & feel
  theme: {
    accent: '#3b82f6',
    font: 'Inter',
    scriptureFont: 'Source Serif 4',
    textScale: 1,
    background: 'transparent', // transparent | black | chroma
    chromaColor: '#00b140', // used when background is 'chroma'
    lyricStyle: 'scrim', // scrim | panel | plain
    uppercaseLyrics: false,
    showNextLine: false,
  },
  messages: { show: true },
};

function merge(base, over) {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return over === undefined ? base : over;
  const out = { ...base };
  for (const k of Object.keys(over || {})) {
    if (!(k in base)) continue;
    out[k] = merge(base[k], over[k]);
  }
  return out;
}

let current = DEFAULTS;

function load() {
  try { current = merge(DEFAULTS, JSON.parse(fs.readFileSync(FILE, 'utf8'))); } catch { current = merge(DEFAULTS, {}); }
  // Older configs stored the chroma colour as the background name.
  const PRESETS = { green: '#00b140', blue: '#0047bb' };
  if (PRESETS[current.theme.background]) {
    current.theme = { ...current.theme, chromaColor: PRESETS[current.theme.background], background: 'chroma' };
  }
  return current;
}

function save(patch) {
  current = merge(current, patch);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(current, null, 2));
  return current;
}

module.exports = { load, save, get: () => current, DEFAULTS, DATA_DIR };

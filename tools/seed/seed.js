#!/usr/bin/env node
// Seeds a ProPresenter instance with test content for the Receiver:
//   * library presentations (.pro) — songs, scripture, speaker intros, sermon, media
//   * audience Looks, a "Speaker Name" message, and a service playlist (via the API)
//
// usage: node seed.js [--host localhost] [--port 50679] [--library <dir>] [--media <dir>]
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { presentation, slideCue, textElement, decode } = require('./pro');

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) =>
  v.startsWith('--') ? [...a, [v.slice(2), all[i + 1]]] : a, []));
const HOST = args.host || 'localhost';
const PORT = args.port || '50679';
const WS = path.join(os.homedir(), 'Library/Application Support/RenewedVision/ProPresenter/UserWorkspaces/ProPresenter');
const LIB = args.library || path.join(WS, 'Libraries/Default');
const MEDIA = args.media || path.join(WS, 'Media/Assets/Receiver Test');
const api = (p, opts = {}) => fetch(`http://${HOST}:${PORT}${p}`, {
  ...opts, headers: { 'content-type': 'application/json' },
  body: opts.body ? JSON.stringify(opts.body) : undefined,
}).then(async r => { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } });

// ---- slide helpers ---------------------------------------------------------
// Text boxes are laid out lower-third style so ProPresenter's own output matches.
const LYRIC_BOX = [160, 760, 1600, 260];
const lyric = (text, o = {}) => slideCue([textElement('Lyrics', text, LYRIC_BOX, { size: 64, bold: true })], o);
const scripture = (text, ref) => slideCue([
  textElement('Scripture', text, [160, 700, 1600, 260], { size: 50 }),
  textElement('Reference', ref, [160, 960, 1600, 80], { size: 34, bold: true }),
]);
const speaker = (name, title) => slideCue([
  textElement('Name', name, [120, 820, 1100, 90], { size: 64, bold: true, align: 'left' }),
  textElement('Title', title, [120, 910, 1100, 60], { size: 36, align: 'left' }),
], { notes: '#speaker' });
const card = (title, body, o = {}) => slideCue([
  textElement('Title', title, [160, 380, 1600, 140], { size: 96, bold: true }),
  textElement('Body', body, [160, 540, 1600, 200], { size: 48 }),
], o);

const blue = [0.11, 0.42, 0.95], teal = [0.05, 0.62, 0.62], violet = [0.49, 0.23, 0.93],
  amber = [0.96, 0.62, 0.04], rose = [0.88, 0.19, 0.42], slate = [0.35, 0.4, 0.48];
const verseGroups = (verses, color = blue) => verses.map((v, i) =>
  ({ name: `Verse ${i + 1}`, color, slides: v.map(t => lyric(t)) }));

const loop = { file: path.join(MEDIA, 'Worship Motion Loop.mp4'), type: 'video', loop: true };
const bumper = { file: path.join(MEDIA, 'Announcement Bumper.mp4'), type: 'video' };
const still = { file: path.join(MEDIA, 'Sermon Background.jpg'), type: 'image', width: 1920, height: 1080 };

// ---- content (all public domain) -------------------------------------------
const docs = [
  {
    name: 'Welcome Bumper', category: 'Media',
    groups: [{ name: 'Video', color: rose, slides: [slideCue([], { label: 'Welcome Bumper', media: bumper })] }],
  },
  {
    name: 'Announcements', category: 'Announcements',
    groups: [{
      name: 'Announcement', color: amber, slides: [
        card('Welcome Home', 'We are so glad you are here this morning.'),
        card('Community Lunch', 'Sunday after service · Fellowship Hall'),
        card('Youth Night', 'Wednesdays at 7 PM · Student Center'),
        card('Serve Team', 'Sign up at the Connect table in the lobby'),
      ],
    }],
  },
  {
    name: 'Amazing Grace', category: 'Songs',
    ccli: { author: 'John Newton', song_title: 'Amazing Grace', copyright_year: 1779, publisher: 'Public Domain', display: true },
    groups: [
      { name: 'Intro', color: slate, slides: [slideCue([], { label: 'Motion Loop', media: loop })] },
      ...verseGroups([
        ['Amazing grace! How sweet the sound\nThat saved a wretch like me!', 'I once was lost, but now am found;\nWas blind, but now I see.'],
        ['’Twas grace that taught my heart to fear,\nAnd grace my fears relieved;', 'How precious did that grace appear\nThe hour I first believed.'],
        ['Through many dangers, toils and snares,\nI have already come;', '’Tis grace hath brought me safe thus far,\nAnd grace will lead me home.'],
        ['When we’ve been there ten thousand years,\nBright shining as the sun,', 'We’ve no less days to sing God’s praise\nThan when we’d first begun.'],
      ]),
    ],
  },
  {
    name: 'It Is Well With My Soul', category: 'Songs',
    ccli: { author: 'Horatio G. Spafford, Philip P. Bliss', song_title: 'It Is Well With My Soul', copyright_year: 1873, publisher: 'Public Domain', display: true },
    groups: [
      { name: 'Verse 1', color: blue, slides: [lyric('When peace like a river attendeth my way,\nWhen sorrows like sea billows roll;'), lyric('Whatever my lot, Thou hast taught me to say,\nIt is well, it is well with my soul.')] },
      { name: 'Chorus', color: violet, slides: [lyric('It is well with my soul,\nIt is well, it is well with my soul.')] },
      { name: 'Verse 2', color: blue, slides: [lyric('Though Satan should buffet, though trials should come,\nLet this blest assurance control,'), lyric('That Christ hath regarded my helpless estate,\nAnd hath shed His own blood for my soul.')] },
      { name: 'Verse 3', color: blue, slides: [lyric('My sin, oh, the bliss of this glorious thought!\nMy sin, not in part but the whole,'), lyric('Is nailed to the cross, and I bear it no more,\nPraise the Lord, praise the Lord, O my soul!')] },
    ],
  },
  {
    name: 'Holy, Holy, Holy', category: 'Songs',
    ccli: { author: 'Reginald Heber, John B. Dykes', song_title: 'Holy, Holy, Holy', copyright_year: 1826, publisher: 'Public Domain', display: true },
    groups: verseGroups([
      ['Holy, holy, holy! Lord God Almighty!\nEarly in the morning our song shall rise to Thee;', 'Holy, holy, holy, merciful and mighty!\nGod in three Persons, blessed Trinity!'],
      ['Holy, holy, holy! All the saints adore Thee,\nCasting down their golden crowns around the glassy sea;', 'Cherubim and seraphim falling down before Thee,\nWhich wert, and art, and evermore shalt be.'],
    ], teal),
  },
  {
    name: 'Speaker Intros', category: 'Speakers',
    groups: [{
      name: 'Speaker', color: rose, slides: [
        speaker('Pastor Jordan Ellis', 'Lead Pastor'),
        speaker('Maya Chen', 'Worship Director'),
        speaker('Sam Okafor', 'Youth & Family Ministry'),
      ],
    }],
  },
  {
    name: 'John 3:16-17 (KJV)', category: 'Scripture',
    bible: { book_index: 43, book_name: 'John', chapter_range: { start: 3, end: 3 }, verse_range: { start: 16, end: 17 }, translation_name: 'King James Version', translation_display_abbreviation: 'KJV', translation_internal_abbreviation: 'KJV' },
    groups: [{
      name: 'Scripture', color: teal, slides: [
        scripture('For God so loved the world, that he gave his only begotten Son, that whosoever believeth in him should not perish, but have everlasting life.', 'John 3:16 KJV'),
        scripture('For God sent not his Son into the world to condemn the world; but that the world through him might be saved.', 'John 3:17 KJV'),
      ],
    }],
  },
  {
    name: 'Psalm 23:1-4 (KJV)', category: 'Scripture',
    bible: { book_index: 19, book_name: 'Psalms', chapter_range: { start: 23, end: 23 }, verse_range: { start: 1, end: 4 }, translation_name: 'King James Version', translation_display_abbreviation: 'KJV', translation_internal_abbreviation: 'KJV' },
    groups: [{
      name: 'Scripture', color: teal, slides: [
        scripture('The LORD is my shepherd; I shall not want. He maketh me to lie down in green pastures: he leadeth me beside the still waters.', 'Psalm 23:1-2 KJV'),
        scripture('He restoreth my soul: he leadeth me in the paths of righteousness for his name’s sake.', 'Psalm 23:3 KJV'),
        scripture('Yea, though I walk through the valley of the shadow of death, I will fear no evil: for thou art with me; thy rod and thy staff they comfort me.', 'Psalm 23:4 KJV'),
      ],
    }],
  },
  {
    name: 'Sermon – Rooted', category: 'Sermon',
    groups: [
      { name: 'Sermon Title', color: violet, slides: [card('Rooted', 'Week 1 · Growing Where You’re Planted', { media: still })] },
      {
        name: 'Sermon Point', color: violet, slides: [
          card('1. Planted on Purpose', 'Where you are is not an accident.'),
          card('2. Deep Before Wide', 'Growth starts below the surface.'),
          card('3. Fruit in Season', 'Faithfulness today, harvest tomorrow.'),
        ],
      },
    ],
  },
];

async function main() {
  const version = await api('/version').catch(() => null);
  if (!version || !version.name) throw new Error(`ProPresenter API not reachable at ${HOST}:${PORT}`);
  console.log(`Connected: ${version.host_description}`);

  // 1. Library presentations
  fs.rmSync(path.join(LIB, 'ZZ Probe.pro'), { force: true });
  for (const d of docs) {
    // ProPresenter names library items after the file, so ':' and '/' become '-'.
    d.file = d.name.replace(/[/:]/g, '-');
    const file = path.join(LIB, d.file + '.pro');
    // Keep the existing UUID on re-runs so playlists and ProPresenter's index stay valid.
    let id;
    try { id = decode(fs.readFileSync(file)).uuid.string; } catch { /* new file */ }
    const { buffer } = presentation({ ...d, id });
    fs.writeFileSync(file, buffer);
    console.log('  wrote', path.basename(file));
  }
  await new Promise(r => setTimeout(r, 2500)); // let ProPresenter index the files

  const libs = await api('/v1/libraries');
  const lib = await api(`/v1/library/${libs[0].uuid}`);
  const byFile = Object.fromEntries(lib.items.map(i => [i.name, i.uuid]));
  const byName = Object.fromEntries(docs.map(d => [d.name, byFile[d.file]]));

  // 2. Looks — POST /v1/looks doesn't persist on 21.4; looks.js writes them offline.
  const looks = (await api('/v1/looks')).map(l => l.id.name);
  if (!looks.includes('Lower Thirds')) console.log('  looks missing → quit ProPresenter and run: node looks.js');

  // 3. Messages: speaker name (tokens drive the animated title) + a general notice
  const msgs = await api('/v1/messages');
  const msgSpec = [
    { name: 'Speaker Name', message: '{Name} — {Title}', tokens: [{ name: 'Name', text: { text: 'Pastor Jordan Ellis' } }, { name: 'Title', text: { text: 'Lead Pastor' } }] },
    { name: 'Parent Notice', message: 'Parent of child #{Number}, please come to the nursery.', tokens: [{ name: 'Number', text: { text: '142' } }] },
  ];
  for (const m of msgSpec) {
    if (Array.isArray(msgs) && msgs.some(x => x.id.name === m.name)) { console.log('  message exists:', m.name); continue; }
    const r = await api('/v1/messages', {
      method: 'POST', body: {
        id: { name: m.name, uuid: '', index: 0 }, message: m.message, tokens: m.tokens,
        theme: { name: '', uuid: '', index: 0 }, visible_on_network: true, is_active: false,
      },
    });
    console.log('  message', m.name, r && r.id ? 'created' : JSON.stringify(r).slice(0, 200));
  }

  // 4. Service playlist
  const PL = 'Sunday Service (Receiver Test)';
  const pls = await api('/v1/playlists');
  let pl = pls.find(p => p.id.name === PL);
  if (!pl) pl = await api('/v1/playlists', { method: 'POST', body: { name: PL, type: 'playlist' } });
  // ProPresenter 21 rejects items unless every field is present.
  const base = { is_hidden: false, is_pco: false, duration: null, header_color: null, presentation_info: null, target_uuid: '' };
  const header = (name, c) => ({ ...base, id: { uuid: '', name, index: 0 }, type: 'header', header_color: { red: c[0], green: c[1], blue: c[2], alpha: 1 } });
  // A ':' in an item name makes ProPresenter answer 404, so use the file-safe name.
  const pres = name => ({
    ...base, id: { uuid: '', name: name.replace(/[/:]/g, '-'), index: 0 }, type: 'presentation', target_uuid: byName[name] || '',
    presentation_info: { presentation_uuid: byName[name] || '', arrangement_name: '', arrangement_uuid: '' },
  });
  const items = [
    header('Pre-Service', amber), pres('Welcome Bumper'), pres('Announcements'),
    header('Worship', blue), pres('Amazing Grace'), pres('It Is Well With My Soul'), pres('Holy, Holy, Holy'),
    header('The Word', teal), pres('Speaker Intros'), pres('John 3:16-17 (KJV)'), pres('Psalm 23:1-4 (KJV)'), pres('Sermon – Rooted'),
  ].map((it, index) => ({ ...it, id: { ...it.id, index } }));
  const missing = items.filter(i => i.type === 'presentation' && !i.target_uuid);
  if (missing.length) throw new Error('Not indexed yet: ' + missing.map(m => m.id.name).join(', '));
  const put = await fetch(`http://${HOST}:${PORT}/v1/playlist/${pl.id.uuid}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(items) });
  console.log('  playlist', PL, put.status, put.ok ? '' : await put.text());
  console.log('Done.');
}

main().catch(e => { console.error(e.message); process.exit(1); });

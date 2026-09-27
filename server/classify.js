// Decides what kind of content a slide is, so the display can pick a layout.
//
// Kinds: lyrics | scripture | speaker | announcement | point | text | blank
//
// Order of precedence:
//   1. a #tag in the slide notes (#lyrics #scripture #speaker #announcement #point #text #hide)
//   2. the group name / slide label
//   3. presentation metadata (CCLI → song, Bible reference → scripture)
//   4. the text itself (a trailing "John 3:16" style line → scripture)
'use strict';

const TAGS = {
  lyrics: 'lyrics', lyric: 'lyrics', song: 'lyrics',
  scripture: 'scripture', bible: 'scripture', verse: 'scripture',
  speaker: 'speaker', name: 'speaker',
  announcement: 'announcement', announce: 'announcement',
  point: 'point', sermon: 'point', title: 'point',
  text: 'text', hide: 'blank', blank: 'blank',
};

const GROUP_RULES = [
  [/\b(speaker|presenter|host|name ?tag|lower ?third name)\b/i, 'speaker'],
  [/\b(scripture|reading|bible|passage)\b/i, 'scripture'],
  [/\b(announce|announcement|event|welcome)\b/i, 'announcement'],
  [/\b(sermon|point|message|outline|takeaway)\b/i, 'point'],
  [/\b(verse|chorus|pre-?chorus|bridge|tag|refrain|intro|outro|ending|interlude|vamp|hook|turnaround|instrumental)\b/i, 'lyrics'],
];

// e.g. "John 3:16", "1 Corinthians 13:4-7 NIV", "Psalm 23:1–2 (KJV)", "Song of Songs 2:4"
const REF = /^(?:[1-3]\s?)?[A-Z][A-Za-z]+(?:\s(?:of\s)?[A-Z][a-z]+)*\.?\s\d{1,3}(?::\d{1,3}(?:\s?[-–]\s?\d{1,3}(?::\d{1,3})?)?)?(?:\s*\(?[A-Z]{2,6}\)?)?$/;

function tagFrom(notes) {
  const m = /#([a-z]+)/i.exec(notes || '');
  return m ? TAGS[m[1].toLowerCase()] || null : null;
}

// ProPresenter separates text boxes with \r and lines within a box with \n.
function boxes(text) {
  return (text || '').split('\r').map(b => b.split('\n').map(l => l.trim()).filter(Boolean)).filter(b => b.length);
}

function splitReference(ls) {
  if (ls.length > 1 && REF.test(ls[ls.length - 1])) return { body: ls.slice(0, -1), reference: ls[ls.length - 1] };
  if (ls.length > 1 && REF.test(ls[0])) return { body: ls.slice(1), reference: ls[0] };
  return null;
}

/**
 * @param {object} s
 * @param {string} s.text  slide text (all text boxes, newline-joined, as the API returns it)
 * @param {string} [s.notes]
 * @param {string} [s.label]  slide label
 * @param {string} [s.group]  group name
 * @param {string} [s.presentation]  presentation name
 * @param {{isSong?: boolean, isBible?: boolean}} [s.meta]  from the .pro file, when readable
 */
function classify({ text, notes = '', label = '', group = '', presentation = '', meta = {} }) {
  const bx = boxes(text);
  const ls = bx.flat();
  let kind = tagFrom(notes);
  if (!kind && !ls.length) kind = 'blank';
  if (!kind) {
    const hay = `${group} ${label}`;
    for (const [re, k] of GROUP_RULES) if (re.test(hay)) { kind = k; break; }
  }
  if (!kind && meta.isBible) kind = 'scripture';
  if (!kind && meta.isSong) kind = 'lyrics';
  if (!kind && splitReference(ls)) kind = 'scripture';
  if (!kind && /\b(speaker|intro)s?\b/i.test(presentation) && ls.length <= 3) kind = 'speaker';
  if (!kind) kind = 'text';

  const out = { kind, lines: ls };
  if (kind === 'scripture') {
    const split = splitReference(ls);
    out.body = split ? split.body : ls;
    out.reference = split ? split.reference : (REF.test(presentation.replace(/\s*\(.*\)$/, '')) ? presentation : '');
  } else if (kind === 'speaker') {
    const [name, ...rest] = bx.length > 1 ? [bx[0].join(' '), ...bx.slice(1).flat()] : ls;
    out.name = name || '';
    out.title = rest.join(' · ');
  } else if (kind === 'announcement' || kind === 'point') {
    // Separate boxes → the first box is the title; otherwise the first line is.
    out.title = bx.length > 1 ? bx[0].join(' ') : ls[0] || '';
    out.body = bx.length > 1 ? bx.slice(1).flat() : ls.slice(1);
  }
  return out;
}

module.exports = { classify, REF };

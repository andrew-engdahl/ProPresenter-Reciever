// Minimal ProPresenter .pro document writer (protobuf), built on the community
// reverse-engineered schema (proto/, MIT — greyshirtguy/ProPresenter7-Proto).
'use strict';
const path = require('path');
const crypto = require('crypto');
const protobuf = require('protobufjs');

const root = new protobuf.Root();
root.resolvePath = (origin, target) => path.join(__dirname, 'proto', target);
root.loadSync('presentation.proto', { keepCase: true });
const Presentation = root.lookupType('rv.data.Presentation');

const uuid = () => ({ string: crypto.randomUUID().toUpperCase() });
const color = (r, g, b, a = 1) => ({ red: r, green: g, blue: b, alpha: a });

const W = 1920, H = 1080;

function rtfEscape(s) {
  return s.replace(/\\/g, '\\\\').replace(/{/g, '\\{').replace(/}/g, '\\}')
    .replace(/[\u0080-\uffff]/g, c => `\\uc0\\u${c.charCodeAt(0)} `);
}

// Cocoa-flavoured RTF, which is what ProPresenter writes itself.
function rtf(text, { size = 72, bold = false, align = 'center', font = 'HelveticaNeue' } = {}) {
  const q = { center: '\\qc', left: '\\ql', right: '\\qr' }[align];
  const body = text.split('\n').map(rtfEscape).join('\\\n');
  return Buffer.from(
    `{\\rtf1\\ansi\\ansicpg1252\\cocoartf2761\n\\cocoatextscaling0\\cocoaplatform0` +
    `{\\fonttbl\\f0\\fnil\\fcharset0 ${font}${bold ? '-Bold' : ''};}\n` +
    `{\\colortbl;\\red255\\green255\\blue255;}\n{\\*\\expandedcolortbl;;\\csgenericrgb\\c100000\\c100000\\c100000;}\n` +
    `\\pard\\pardirnatural${q}\\partightenfactor0\n\n\\f0${bold ? '\\b' : ''}\\fs${size * 2} \\cf1 ${body}}`, 'utf8');
}

function textElement(name, text, rect, opts = {}) {
  return {
    element: {
      uuid: uuid(),
      name,
      bounds: { origin: { x: rect[0], y: rect[1] }, size: { width: rect[2], height: rect[3] } },
      opacity: 1,
      path: {
        closed: true,
        points: [[0, 0], [1, 0], [1, 1], [0, 1]].map(([x, y]) => ({ point: { x, y }, q0: { x, y }, q1: { x, y } })),
        shape: { type: 'TYPE_RECTANGLE' },
      },
      fill: { color: color(0, 0, 0, 0), enable: false },
      text: {
        rtf_data: rtf(text, opts),
        vertical_alignment: opts.valign || 'VERTICAL_ALIGNMENT_MIDDLE',
        scale_behavior: 'SCALE_BEHAVIOR_SCALE_FONT_DOWN',
        margins: { left: 20, right: 20, top: 10, bottom: 10 },
      },
    },
    info: 3, // template + text element
  };
}

// A slide = cue with one presentation-slide action. `elements` are text boxes.
function slideCue(elements, { label = '', notes = '', media = null } = {}) {
  const actions = [];
  if (media) actions.push(mediaAction(media));
  actions.push({
    uuid: uuid(),
    isEnabled: true,
    type: 'ACTION_TYPE_PRESENTATION_SLIDE',
    slide: {
      presentation: {
        base_slide: {
          uuid: uuid(),
          elements,
          size: { width: W, height: H },
          draws_background_color: false,
          background_color: color(0, 0, 0, 1),
        },
        notes: notes ? { rtf_data: rtf(notes, { size: 24, align: 'left' }) } : undefined,
      },
    },
  });
  return { uuid: uuid(), name: label, isEnabled: true, actions };
}

function mediaAction({ file, type = 'video', width = 1920, height = 1080, loop = false }) {
  const url = { platform: 'PLATFORM_MACOS', absolute_string: 'file://' + encodeURI(file) };
  const media = { uuid: uuid(), url, metadata: { format: path.extname(file).slice(1) } };
  const drawing = { natural_size: { width, height }, scale_behavior: 'SCALE_BEHAVIOR_FIT' };
  if (type === 'video') {
    media.video = {
      drawing,
      transport: { play_rate: 1, playback_behavior: loop ? 'PLAYBACK_BEHAVIOR_LOOP' : 'PLAYBACK_BEHAVIOR_STOP' },
      video: { frame_rate: 30 },
    };
  } else {
    media.image = { drawing };
  }
  return {
    uuid: uuid(),
    isEnabled: true,
    type: 'ACTION_TYPE_MEDIA',
    media: {
      element: media,
      layer_type: 'LAYER_TYPE_BACKGROUND',
      ...(type === 'video' ? { video: { playback_behavior: loop ? 'PLAYBACK_BEHAVIOR_LOOP' : 'PLAYBACK_BEHAVIOR_STOP' } } : { image: {} }),
    },
  };
}

/**
 * groups: [{ name, color:[r,g,b], slides: [cue, ...] }]
 */
function presentation({ name, category = '', groups, ccli, bible, notes = '', id }) {
  const cues = [];
  const cue_groups = groups.map(g => {
    cues.push(...g.slides);
    return {
      group: { uuid: uuid(), name: g.name, color: color(...(g.color || [0.3, 0.3, 0.3])) },
      cue_identifiers: g.slides.map(c => c.uuid),
    };
  });
  const doc = {
    application_info: {
      platform: 'PLATFORM_MACOS',
      application: 'APPLICATION_PROPRESENTER',
      application_version: { major_version: 21, minor_version: 4 },
    },
    uuid: id ? { string: id } : uuid(),
    name,
    category,
    notes,
    cue_groups,
    cues,
    arrangements: [],
    ccli,
    bible_reference: bible,
  };
  const err = Presentation.verify(Presentation.fromObject(doc));
  if (err) throw new Error(err);
  return { uuid: doc.uuid.string, buffer: Buffer.from(Presentation.encode(Presentation.fromObject(doc)).finish()) };
}

function decode(buf) {
  return Presentation.toObject(Presentation.decode(buf), { enums: String, bytes: String, defaults: false });
}

module.exports = { presentation, slideCue, textElement, rtf, color, decode, W, H };

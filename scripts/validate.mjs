// npm run validate
//   Checks every source file: JSON Schema, cross-references between files,
//   icon rules and translations. Exit code 1 when there are errors; warnings
//   are printed but do not fail the run.
//
// Options
//   --translations          list every text without de/fr/lb (default: only
//                           for files you changed, plus a one-line summary)
//   --changed-since <ref>   compare against this git ref to find "your" files
//                           (default: origin/main when it exists)

import { readFile, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import sharp from 'sharp';
import {
  ROOT, SLOTS, ICON_KINDS, ICON_FORMATS, ICON_SIZE, ICON_MAX_BYTES, FIRST_CONTENT_APP, DATA_FILES,
  fsReader, loadSource, listIcons, iconExt, missingLangs, createReporter, runCli, isMain, args,
  paint, plural, slugify, didYouMean, suggest,
} from './lib.mjs';

// ── JSON Schema ───────────────────────────────────────────────────────────
let ajvInstance;
export async function schemas() {
  if (ajvInstance) return ajvInstance;
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictTypes: false, verbose: true });
  addFormats(ajv);
  const dir = path.join(ROOT, 'schema');
  for (const name of (await readdir(dir)).filter((n) => n.endsWith('.schema.json')).sort()) {
    ajv.addSchema(JSON.parse(await readFile(path.join(dir, name), 'utf8')), name);
  }
  ajvInstance = ajv;
  return ajv;
}

const SCHEMA_FOR = {
  operators: 'operator.schema.json',
  weapons: 'weapon.schema.json',
  gadgets: 'gadget.schema.json',
  attachments: 'attachments.schema.json',
  classes: 'classes.schema.json',
  roles: 'roles.schema.json',
  meta: 'meta.schema.json',
  messages: 'messages.schema.json',
};

const TEMPLATE_HINT = {
  operators: 'Compare with templates/operator.json or an existing operator such as data/operators/sledge.json.',
  weapons: 'Compare with templates/weapon.json or an existing weapon such as data/weapons/dp27.json.',
  gadgets: 'Compare with templates/gadget.json or an existing gadget such as data/gadgets/claymore.json.',
};

/** "/loadout/primary/1" -> "loadout.primary[1]" */
export function fieldPath(pointer) {
  if (!pointer) return '';
  return pointer.slice(1).split('/').map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'))
    .reduce((acc, p) => (/^\d+$/.test(p) ? `${acc}[${p}]` : acc ? `${acc}.${p}` : p), '');
}

function show(v) {
  if (typeof v === 'string') return `"${v}"`;
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'a list';
  if (typeof v === 'object') return 'an object';
  return String(v);
}

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'a list';
  if (Number.isInteger(v)) return 'a whole number';
  return { string: 'text', number: 'a number', boolean: 'true/false', object: 'an object' }[typeof v] ?? typeof v;
}

const TYPE_WORDS = { string: 'text', integer: 'a whole number', number: 'a number', array: 'a list [ … ]', object: 'an object { … }', boolean: 'true or false', null: 'null' };

/** Turns one Ajv error into { message, hint } that a contributor can act on. */
export function explain(e, kind) {
  const loc = fieldPath(e.instancePath);
  const at = loc ? `${loc}: ` : '';
  const p = e.params;
  switch (e.keyword) {
    case 'required':
      return {
        message: `${loc ? `${loc} is ` : ''}missing the field "${p.missingProperty}".`,
        hint: TEMPLATE_HINT[kind] ?? `Add "${p.missingProperty}".`,
      };
    case 'additionalProperties': {
      const allowed = Object.keys(e.parentSchema?.properties ?? {}).filter((k) => k !== '$schema');
      return {
        message: `${at}unknown field "${p.additionalProperty}".${didYouMean(p.additionalProperty, allowed)}`,
        hint: allowed.length ? `Remove it or fix the spelling. Fields allowed here: ${allowed.join(', ')}.` : 'Remove it.',
      };
    }
    case 'enum': {
      const allowed = p.allowedValues ?? e.schema ?? [];
      return {
        message: `${at}${show(e.data)} is not allowed.${didYouMean(e.data, allowed)}`,
        hint: `Use one of: ${allowed.map((a) => (a === null ? 'null' : a)).join(', ')}.`,
      };
    }
    case 'const':
      return { message: `${at}must be ${show(p.allowedValue)}.` };
    case 'type': {
      const want = String(p.type).split(',').map((x) => TYPE_WORDS[x] ?? x).join(' or ');
      let hint;
      if (typeof e.data === 'string' && /^-?\d+$/.test(e.data) && /integer|number/.test(p.type)) hint = `Write the number without quotes: ${e.data}, not "${e.data}".`;
      else if (p.type === 'array' && typeof e.data === 'string') hint = `Put it in a list: ["${e.data}"].`;
      else if (p.type === 'object' && typeof e.data === 'string' && /name|title|body|note/.test(loc)) hint = `Localized texts are objects: { "en": "${e.data}" }.`;
      return { message: `${loc || 'The file'} must be ${want}, but it is ${typeOf(e.data)}.`, hint };
    }
    case 'pattern': {
      const pat = p.pattern;
      if (pat.includes('[a-z0-9]+(-[a-z0-9]+)*')) {
        const fix = slugify(e.data);
        return {
          message: `${at}${show(e.data)} is not a valid id.`,
          hint: `Ids use lowercase letters a-z, digits and single hyphens${fix && fix !== e.data ? `, for example "${fix}"` : ''}.`,
        };
      }
      if (pat.startsWith('^\\d{4}')) return { message: `${at}${show(e.data)} is not a valid version.`, hint: 'Versions look like 2026.09.0 (year, month, patch).' };
      if (pat === '^Y\\d+S\\d+(\\.\\d+)?$') return { message: `${at}${show(e.data)} is not a valid season label.`, hint: 'Labels look like Y11S3.0 (year, season, patch).' };
      if (pat === '^Y\\d+S\\d+$') return { message: `${at}${show(e.data)} is not a valid season.`, hint: 'Seasons look like Y11S3. Launch operators use Y1S0.' };
      if (pat === '^\\S(.*\\S)?$') return { message: `${at}starts or ends with a space.`, hint: 'Remove the extra spaces.' };
      if (pat === '^[ad]\\d+$') return { message: `${at}${show(e.data)} is not a valid legacy id.`, hint: 'Only operators from app 1.x have a legacyId. New operators leave it out.' };
      return { message: `${at}${show(e.data)} does not have the expected format (${pat}).` };
    }
    case 'minItems': {
      let hint;
      if (/^roles$/.test(loc)) hint = 'Add the role(s) from the in-game operator menu: anti-entry, anti-gadget, breach, crowd-control, front-line, intel, map-control, support, trapper.';
      else if (/^loadout\./.test(loc)) hint = 'Every operator needs at least one primary weapon, one secondary weapon and one gadget.';
      return { message: `${at}needs at least ${plural(p.limit, 'entry', 'entries')}.`, hint };
    }
    case 'maxItems':
      return { message: `${at}has more than ${plural(p.limit, 'entry', 'entries')}.` };
    case 'uniqueItems':
      return { message: `${at}lists the same value twice (positions ${p.j} and ${p.i}).`, hint: 'Remove the duplicate.' };
    case 'minimum':
      return { message: `${at}must be at least ${p.limit} (found ${show(e.data)}).` };
    case 'maximum':
      return { message: `${at}must be at most ${p.limit} (found ${show(e.data)}).` };
    case 'minLength':
      return { message: `${at}must not be empty.` };
    case 'maxLength':
      return { message: `${at}is longer than ${p.limit} characters.` };
    case 'format':
      return {
        message: `${at}${show(e.data)} is not a valid ${p.format}.`,
        hint: p.format === 'date' ? 'Dates look like 2026-09-01.' : p.format === 'date-time' ? 'Use 2026-09-01T17:00:00Z.' : undefined,
      };
    case 'minProperties':
      return { message: `${at}is empty.`, hint: 'Remove it when there is nothing to put in it.' };
    case 'propertyNames':
      return { message: `${at}${show(p.propertyName)} is not an allowed name here.${didYouMean(p.propertyName, e.parentSchema?.propertyNames?.enum ?? [])}` };
    default:
      return { message: `${at}${e.message}.` };
  }
}

function schemaCheck(ajv, kind, entry, report) {
  const validateFn = ajv.getSchema(SCHEMA_FOR[kind]);
  if (validateFn(entry.data)) return true;
  const seen = new Set();
  for (const e of validateFn.errors) {
    if (e.propertyName !== undefined && e.keyword !== 'propertyNames') continue; // reported by propertyNames
    const { message, hint } = explain(e, kind);
    if (seen.has(message)) continue;
    seen.add(message);
    report.error(entry.file, message, hint);
  }
  return false;
}

// ── icons ─────────────────────────────────────────────────────────────────
async function cornerAlpha(img) {
  const { data, info } = await img.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h, channels: c } = info;
  return [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]].map(([x, y]) => data[(y * w + x) * c + (c - 1)]);
}

function attrs(tag) {
  const out = {};
  for (const m of tag.matchAll(/([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) out[m[1].toLowerCase()] = m[3] ?? m[4];
  if (out.style) {
    for (const part of out.style.split(';')) {
      const [k, v] = part.split(':').map((s) => s && s.trim());
      if (k && v && !(k in out)) out[k.toLowerCase()] = v;
    }
  }
  return out;
}

function an(word) {
  return `${/^[aeiou]/i.test(word) ? 'an' : 'a'} ${word}`;
}

function num(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

/** Size of an SVG from viewBox, or width/height. */
export function svgBox(text) {
  const tag = /<svg\b[^>]*>/i.exec(text)?.[0];
  if (!tag) return null;
  const a = attrs(tag);
  const vb = (a.viewbox ?? '').trim().split(/[\s,]+/).map(Number);
  if (vb.length === 4 && vb.every(Number.isFinite) && vb[2] > 0 && vb[3] > 0) return { x: vb[0], y: vb[1], w: vb[2], h: vb[3], attrs: a };
  const w = num(a.width);
  const h = num(a.height);
  if (w && h && !/%/.test(a.width) && !/%/.test(a.height)) return { x: 0, y: 0, w, h, attrs: a };
  return { attrs: a };
}

function hasBackgroundRect(text, box) {
  const visible = text.replace(/<(defs|clipPath|mask|pattern|symbol|marker)\b[\s\S]*?<\/\1>/gi, '');
  for (const m of visible.matchAll(/<rect\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    const full = (v, size) => v == null || /^100(\.0+)?%$/.test(v) || (num(v) ?? 0) >= size * 0.98;
    const start = (v, origin, size) => v == null || Math.abs((num(v) ?? 0) - origin) <= size * 0.02;
    if (!full(a.width, box.w) || !full(a.height, box.h) || a.width == null || a.height == null) continue;
    if (!start(a.x, box.x, box.w) || !start(a.y, box.y, box.h)) continue;
    const fill = (a.fill ?? '#000').toLowerCase();
    if (fill === 'none' || fill === 'transparent') continue;
    if (num(a.opacity) === 0 || num(a['fill-opacity']) === 0) continue;
    return true;
  }
  return /<svg\b[^>]*style\s*=\s*["'][^"']*background/i.test(text);
}

async function checkSvg(file, buf, report) {
  const text = buf.toString('utf8');
  if (!/<svg[\s>]/i.test(text)) {
    report.error(file, 'This is not an SVG file.', 'Export the icon as SVG, or use PNG/WebP with the matching file extension.');
    return;
  }
  if (/<script[\s>]/i.test(text) || /\son[a-z]+\s*=/i.test(text)) {
    report.error(file, 'The SVG contains scripts or event handlers.', 'Icons must be plain drawings. Remove <script> elements and on…= attributes.');
    return;
  }
  if (/(?:xlink:)?href\s*=\s*["']\s*(?:https?:|\/\/|file:)/i.test(text) || /url\(\s*["']?\s*(?:https?:|\/\/)/i.test(text)) {
    report.error(file, 'The SVG loads files from the internet.', 'Icons must be self-contained. Remove links to external images, fonts or stylesheets.');
    return;
  }
  if (/<image[\s>]/i.test(text)) {
    report.error(file, 'The SVG wraps a raster image.', 'Send that image as PNG or WebP instead, or redraw it as vector paths.');
    return;
  }
  if (/<text[\s>]/i.test(text)) {
    report.warn(file, 'The SVG contains <text>; fonts differ between devices.', 'Convert text to paths in your editor (Inkscape: Path → Object to Path).');
  }
  const box = svgBox(text);
  if (!box?.w) {
    report.error(file, 'The SVG has no viewBox (and no width/height in pixels), so it cannot be scaled.', 'Add viewBox="0 0 256 256" (or the size of your drawing) to the <svg> element.');
    return;
  }
  if (Math.abs(box.w - box.h) > Math.max(box.w, box.h) * 0.01) {
    report.error(file, `The SVG is not square (${+box.w.toFixed(2)} × ${+box.h.toFixed(2)}).`, 'Make the viewBox square and centre the drawing in it; do not stretch the drawing.');
  }
  const rect = hasBackgroundRect(text, box);
  if (rect) {
    report.error(file, 'The SVG has a full-size background (a <rect> or style that covers the whole canvas).', 'Delete the background so the icon sits on transparency. The app draws its own background.');
  }
  try {
    const corners = await cornerAlpha(sharp(buf, { density: 72 }).resize(64, 64, { fit: 'inside' }));
    if (!rect && corners.some((a) => a >= 16)) {
      report.error(file, 'The background is not transparent: the corners of the rendered icon are filled.', 'Remove the background shape so only the drawing remains.');
    }
  } catch (err) {
    report.error(file, `The SVG could not be rendered (${err.message.split('\n')[0]}).`, 'Open and re-save it in Inkscape or Figma, then try again.');
  }
}

async function checkRaster(file, buf, ext, report) {
  let meta;
  try {
    meta = await sharp(buf).metadata();
  } catch {
    report.error(file, 'The file cannot be read as an image.', 'Re-export it as PNG or WebP.');
    return;
  }
  if (meta.format !== ext) {
    report.error(file, `The file is really a ${String(meta.format).toUpperCase()} image but is named .${ext}.`, `Export it as ${ext.toUpperCase()} (renaming is not enough), or use the matching extension.`);
    return;
  }
  const { width: w, height: h } = meta;
  if (w !== h) report.error(file, `The image is not square (${w} × ${h} px).`, 'Add transparent space around the drawing until width and height are equal; do not stretch it.');
  if (Math.min(w, h) < ICON_SIZE) report.error(file, `The image is too small (${w} × ${h} px). At least ${ICON_SIZE} × ${ICON_SIZE} px is needed.`, 'Export a larger version, or send an SVG.');
  if (!meta.hasAlpha) {
    report.error(file, 'The image has no transparency (alpha channel).', 'Export as PNG or WebP with transparency and remove the background.');
    return;
  }
  const corners = await cornerAlpha(sharp(buf));
  if (corners.some((a) => a >= 16)) {
    report.error(file, 'The background is not transparent: the corner pixels are filled.', 'Remove the background and export with transparency. The app draws its own background.');
  }
}

async function checkIconFile(file, buf, report) {
  const ext = iconExt(file);
  if (buf.length > ICON_MAX_BYTES) {
    report.error(file, `The file is ${Math.round(buf.length / 1024)} KB; the limit is ${ICON_MAX_BYTES / 1024} KB.`,
      ext === 'svg' ? 'Simplify the paths or run the file through an SVG optimiser (for example SVGOMG).' : 'Export at 256 to 512 px; larger files do not look better in the app.');
  }
  if (ext === 'svg') await checkSvg(file, buf, report);
  else await checkRaster(file, buf, ext, report);
}

// ── changed files (to show translation warnings where they matter) ─────────
export function changedFiles(base) {
  const git = (argv) => {
    try {
      return execFileSync('git', argv, { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8').split('\n').filter(Boolean);
    } catch {
      return null;
    }
  };
  const set = new Set();
  if (!git(['rev-parse', '--verify', '--quiet', 'HEAD'])) return set; // not a git checkout, or no commits yet
  let ref = base;
  if (!ref && git(['rev-parse', '--verify', '--quiet', 'origin/main'])) ref = 'origin/main';
  if (ref) (git(['diff', '--name-only', `${ref}...HEAD`]) ?? []).forEach((f) => set.add(f));
  (git(['diff', '--name-only', 'HEAD']) ?? []).forEach((f) => set.add(f));
  (git(['ls-files', '--others', '--exclude-standard']) ?? []).forEach((f) => set.add(f));
  return set;
}

// ── the full check ──────────────────────────────────────────────────────────
/**
 * Runs every check. Returns { report, src, icons }.
 * options.translations: list all translation warnings.
 * options.changed: Set of repository paths whose translation warnings are listed.
 */
export async function validate(options = {}) {
  const reader = options.reader ?? fsReader();
  const report = createReporter();
  const ajv = await schemas();
  const src = await loadSource(reader);
  src.issues.forEach((i) => report.push(i));
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  const translationNotes = [];

  // 1. schema
  const valid = new Set();
  for (const kind of ['operators', 'weapons', 'gadgets']) {
    for (const entry of src[kind]) if (schemaCheck(ajv, kind, entry, report)) valid.add(entry);
  }
  for (const kind of ['attachments', 'classes', 'roles', 'meta', 'messages']) {
    const entry = src[kind];
    if (entry.data && schemaCheck(ajv, kind, entry, report)) valid.add(entry);
  }

  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  const list = (v) => (Array.isArray(v) ? v : []);

  // 2. ids, file names, aliases
  function index(kind, label) {
    const byId = new Map();
    const alias = new Map();
    for (const entry of src[kind]) {
      const d = entry.data;
      if (!isObj(d) || typeof d.id !== 'string') continue;
      const stem = path.basename(entry.file, '.json');
      if (stem !== d.id) {
        report.error(entry.file, `The file name and the id differ: the file is "${stem}.json", the id is "${d.id}".`, `Rename the file to ${d.id}.json, or change the id to "${stem}".`);
      }
      if (byId.has(d.id)) {
        report.error(entry.file, `The ${label} id "${d.id}" is also used by ${byId.get(d.id).file}.`, 'Ids must be unique. Pick a different id for one of them.');
        continue;
      }
      byId.set(d.id, entry);
    }
    for (const entry of byId.values()) {
      for (const a of list(entry.data.aliases)) {
        if (a === entry.data.id) report.error(entry.file, `aliases contains the ${label}'s own id "${a}".`, 'Aliases list earlier ids only. Remove it.');
        else if (byId.has(a)) report.error(entry.file, `The alias "${a}" is the id of another ${label} (${byId.get(a).file}).`, 'An alias may not be a current id.');
        else if (alias.has(a)) report.error(entry.file, `The alias "${a}" is also an alias of ${alias.get(a).file}.`, 'Each old id can point to one entry only.');
        else alias.set(a, entry);
      }
    }
    return { byId, alias };
  }
  const OPS = index('operators', 'operator');
  const WPN = index('weapons', 'weapon');
  const GDG = index('gadgets', 'gadget');

  // 3. attachments catalogue and class defaults
  const catalogue = new Map();
  const attFile = DATA_FILES.attachments;
  for (const [i, a] of list(src.attachments.data?.attachments).entries()) {
    if (!isObj(a) || typeof a.id !== 'string') continue;
    if (catalogue.has(a.id)) report.error(attFile, `attachments[${i}]: the id "${a.id}" is listed twice.`, 'Remove the duplicate.');
    else catalogue.set(a.id, a);
    if (isObj(a.name)) {
      const miss = missingLangs(a.name);
      if (miss.length) translationNotes.push({ file: attFile, group: 'attachment names', what: `attachment "${a.id}"`, miss });
    }
  }
  function checkAttachmentIds(file, where, slot, ids) {
    for (const id of list(ids)) {
      const att = catalogue.get(id);
      if (!att) {
        report.error(file, `${where}: unknown attachment "${id}".${didYouMean(id, [...catalogue.keys()])}`, `Use an id from ${attFile}, or add the attachment there first.`);
      } else if (att.slot !== slot) {
        report.error(file, `${where}: "${id}" is ${an(att.slot)} attachment, not ${an(slot)} attachment.`, `Move it to the ${att.slot} slot.`);
      }
    }
  }
  const classes = isObj(src.classes.data?.classes) ? src.classes.data.classes : {};
  for (const [cls, slots] of Object.entries(classes)) {
    if (!isObj(slots)) continue;
    for (const slot of SLOTS) checkAttachmentIds(DATA_FILES.classes, `classes.${cls}.${slot}`, slot, slots[slot]);
  }

  // 4. weapons
  for (const entry of WPN.byId.values()) {
    const w = entry.data;
    const defaults = classes[w.class];
    if (typeof w.class === 'string' && !defaults && src.classes.data) {
      report.error(entry.file, `The class "${w.class}" has no attachment defaults in ${DATA_FILES.classes}.`, 'Add the class there, or use one of: ' + Object.keys(classes).join(', ') + '.');
    }
    if (!isObj(w.attachments)) continue;
    for (const slot of SLOTS) {
      const o = w.attachments[slot];
      if (!isObj(o)) continue;
      for (const op of ['replace', 'remove', 'add']) checkAttachmentIds(entry.file, `attachments.${slot}.${op}`, slot, o[op]);
      if (!defaults) continue;
      const base = list(defaults[slot]);
      if (o.replace && (o.remove || o.add)) {
        report.warn(entry.file, `attachments.${slot}: "replace" already sets the full list, so "remove"/"add" are applied on top of it.`, 'Usually only "replace" is needed. Put the final list there.');
      }
      if (Array.isArray(o.replace) && o.replace.length === base.length && o.replace.every((x) => base.includes(x))) {
        report.warn(entry.file, `attachments.${slot}.replace is the same as the ${w.class} default.`, `Remove the "${slot}" override.`);
      }
      const after = Array.isArray(o.replace) ? o.replace : base;
      for (const id of list(o.remove)) if (!after.includes(id)) report.warn(entry.file, `attachments.${slot}.remove: "${id}" is not in the ${w.class} default, so removing it has no effect.`, 'Remove it from the list.');
      for (const id of list(o.add)) if (after.includes(id)) report.warn(entry.file, `attachments.${slot}.add: "${id}" is already in the ${w.class} default.`, 'Remove it from the list.');
    }
  }

  // 5. gadgets: translations
  for (const entry of GDG.byId.values()) {
    const miss = missingLangs(entry.data.name);
    if (isObj(entry.data.name) && miss.length) translationNotes.push({ file: entry.file, group: 'gadget names', what: 'name', miss });
  }

  // 6. operators: loadout references and rules
  const abilities = new Map();
  const legacy = new Map();
  for (const entry of OPS.byId.values()) {
    const o = entry.data;
    const lo = isObj(o.loadout) ? o.loadout : {};
    const name = typeof o.name === 'string' ? o.name.trim() : o.id;
    const side = ['attack', 'defense'].includes(o.side) ? o.side : null;

    for (const slot of ['primary', 'secondary']) {
      for (const [i, wid] of list(lo[slot]).entries()) {
        if (typeof wid !== 'string') continue;
        const w = WPN.byId.get(wid);
        if (!w) {
          const renamed = WPN.alias.get(wid);
          if (renamed) report.error(entry.file, `loadout.${slot}[${i}]: "${wid}" is an old id; the weapon is now "${renamed.data.id}".`, `Replace it with "${renamed.data.id}".`);
          else report.error(entry.file, `loadout.${slot}[${i}]: "${wid}" is not a known weapon.${didYouMean(wid, [...WPN.byId.keys()])}`, 'Use a file name from data/weapons/ (without .json), or add the weapon first: npm run new -- weapon ' + slugify(wid));
        } else if (w.data.slot && w.data.slot !== slot) {
          report.error(entry.file, `loadout.${slot}[${i}]: "${wid}" is a ${w.data.slot} weapon, but it is listed as ${slot}.`, `Move it to loadout.${w.data.slot}, or correct "slot" in ${w.file}.`);
        }
      }
    }
    for (const [i, gid] of list(lo.gadgets).entries()) {
      if (typeof gid !== 'string') continue;
      const g = GDG.byId.get(gid);
      if (!g) {
        const renamed = GDG.alias.get(gid);
        if (renamed) report.error(entry.file, `loadout.gadgets[${i}]: "${gid}" is an old id; the gadget is now "${renamed.data.id}".`, `Replace it with "${renamed.data.id}".`);
        else report.error(entry.file, `loadout.gadgets[${i}]: "${gid}" is not a known gadget.${didYouMean(gid, [...GDG.byId.keys()])}`, 'Use a file name from data/gadgets/ (without .json). Unique abilities belong in "ability", not in gadgets.');
      } else if (side && g.data.side && g.data.side !== side) {
        report.error(entry.file, `loadout.gadgets[${i}]: "${gid}" is ${an(g.data.side)} gadget, but ${name} is on ${side}.`, `Pick ${an(side)} gadget. The ${side} gadgets are: ${[...GDG.byId.values()].filter((x) => x.data.side === side).map((x) => x.data.id).join(', ')}.`);
      }
    }

    const type = o.type ?? 'standard';
    const picks = lo.gadgetPicks ?? 1;
    const gadgets = list(lo.gadgets);
    if (type === 'gadgetKit') {
      if (picks < 2) report.error(entry.file, `${name} is a gadget-kit operator, so loadout.gadgetPicks must be at least 2 (found ${picks}).`, 'Set "gadgetPicks": 2.');
      else if (gadgets.length <= picks) report.error(entry.file, `A gadget kit needs more gadgets than picks: ${plural(gadgets.length, 'gadget')} for ${picks} picks.`, 'List the whole pool the operator can choose from.');
    } else if (type === 'standard' && picks !== 1) {
      report.error(entry.file, `loadout.gadgetPicks is ${picks}, but only gadget-kit operators pick more than one gadget.`, 'Remove "gadgetPicks", or set "type": "gadgetKit" if the operator really chooses from a pool.');
    }

    if (isObj(o.ability) && typeof o.ability.id === 'string') {
      if (abilities.has(o.ability.id)) {
        report.error(entry.file, `ability.id "${o.ability.id}" is also used by ${abilities.get(o.ability.id).file}.`, `Ability ids must be unique. Prefix it with the operator id, for example "${o.id}-${o.ability.id}".`);
      } else abilities.set(o.ability.id, entry);
      const miss = missingLangs(o.ability.name);
      if (isObj(o.ability.name) && miss.length) translationNotes.push({ file: entry.file, group: 'ability names', what: 'ability.name', miss });
    }
    if (typeof o.legacyId === 'string') {
      if (legacy.has(o.legacyId)) report.error(entry.file, `legacyId "${o.legacyId}" is also used by ${legacy.get(o.legacyId).file}.`, 'Legacy ids are fixed; check which operator really had it.');
      else legacy.set(o.legacyId, entry);
    }
  }

  // 7. roles
  const roleIds = new Set(list(src.roles.data?.roles).map((r) => r?.id));
  const seenRoles = new Set();
  for (const [i, r] of list(src.roles.data?.roles).entries()) {
    if (!isObj(r)) continue;
    if (seenRoles.has(r.id)) report.error(DATA_FILES.roles, `roles[${i}]: "${r.id}" is listed twice.`, 'Remove the duplicate.');
    seenRoles.add(r.id);
    const miss = missingLangs(r.name);
    if (isObj(r.name) && miss.length) translationNotes.push({ file: DATA_FILES.roles, group: 'role names', what: `role "${r.id}"`, miss });
  }
  if (src.roles.data) {
    for (const entry of OPS.byId.values()) {
      for (const role of list(entry.data.roles)) {
        if (typeof role === 'string' && !roleIds.has(role) && valid.has(entry)) {
          report.error(entry.file, `The role "${role}" has no name in ${DATA_FILES.roles}.`, `Add it to ${DATA_FILES.roles}.`);
        }
      }
    }
  }

  // 8. meta
  const meta = src.meta.data;
  if (isObj(meta)) {
    if (Number.isInteger(meta.minApp) && meta.minApp < FIRST_CONTENT_APP) {
      report.warn(DATA_FILES.meta, `minApp ${meta.minApp} is below ${FIRST_CONTENT_APP}; app versions before 2.0.0 (${FIRST_CONTENT_APP}) do not read content packs anyway.`, `Use ${FIRST_CONTENT_APP} or higher.`);
    }
    if (isObj(meta.note)) {
      const miss = missingLangs(meta.note);
      if (miss.length) report.warn(DATA_FILES.meta, `The release note has no ${miss.join(', ')} translation; players with that language see English.`, 'Add the missing languages before tagging the release.');
    }
  }

  // 9. messages
  const msgIds = new Set();
  for (const [i, m] of list(src.messages.data?.messages).entries()) {
    if (!isObj(m)) continue;
    const at = `messages[${i}]${m.id ? ` ("${m.id}")` : ''}`;
    if (msgIds.has(m.id)) report.error(DATA_FILES.messages, `${at}: the id is used twice.`, 'Every message needs its own id; players see each id once.');
    msgIds.add(m.id);
    if (Number.isInteger(m.minApp) && Number.isInteger(m.maxApp) && m.minApp > m.maxApp) {
      report.error(DATA_FILES.messages, `${at}: minApp (${m.minApp}) is higher than maxApp (${m.maxApp}), so no app would show it.`, 'Swap the values or set maxApp to null.');
    }
    if (m.from && m.until && m.from > m.until) {
      report.error(DATA_FILES.messages, `${at}: "from" (${m.from}) is after "until" (${m.until}).`, 'Check the dates (YYYY-MM-DD).');
    }
    if (m.until && m.until < today) {
      report.warn(DATA_FILES.messages, `${at}: ended on ${m.until}; the build leaves it out.`, 'Delete it when convenient.');
    }
    for (const key of ['title', 'body']) {
      const miss = missingLangs(m[key]);
      if (isObj(m[key]) && miss.length) report.warn(DATA_FILES.messages, `${at}: ${key} has no ${miss.join(', ')} translation; players with that language see English.`, 'Add the missing languages before publishing.');
    }
  }

  // 10. icons
  const icons = await listIcons(reader);
  const expected = {
    operators: new Map([...OPS.byId.values()].map((e) => [e.data.id, { entry: e, what: 'operator' }])),
    abilities: new Map([...abilities].map(([id, e]) => [id, { entry: e, what: 'ability' }])),
    weapons: new Map([...WPN.byId.values()].map((e) => [e.data.id, { entry: e, what: 'weapon' }])),
    gadgets: new Map([...GDG.byId.values()].map((e) => [e.data.id, { entry: e, what: 'gadget' }])),
  };
  const resolvedIcons = {};
  for (const kind of ICON_KINDS) {
    resolvedIcons[kind] = new Map();
    const files = icons[kind];
    for (const [id, { entry, what }] of expected[kind]) {
      const found = (files.get(id) ?? []);
      const usable = found.filter((f) => ICON_FORMATS.includes(iconExt(f)));
      if (!found.length) {
        const close = suggest(id, [...files.keys()].filter((k) => !expected[kind].has(k)));
        report.error(entry.file, `No icon for the ${what} "${id}".${close ? ` There is an unused icons/${kind}/${close}.*; is its name misspelled?` : ''}`,
          `Add icons/${kind}/${id}.svg (preferred), .png or .webp: square, transparent background, PNG/WebP at least ${ICON_SIZE} × ${ICON_SIZE} px.`);
        continue;
      }
      if (found.length > 1) {
        report.error(found[0], `There are ${found.length} icons for "${id}": ${found.map((f) => path.basename(f)).join(', ')}.`, 'Keep one file per id (SVG preferred) and delete the others.');
      }
      for (const f of found) {
        if (!ICON_FORMATS.includes(iconExt(f))) {
          report.error(f, `.${iconExt(f) || '(no extension)'} is not an accepted icon format.`, 'Use SVG (preferred), PNG or WebP with a transparent background.');
        }
      }
      if (usable.length === 1) resolvedIcons[kind].set(id, usable[0]);
    }
    for (const [stem, list_] of files) {
      if (expected[kind].has(stem)) continue;
      const what = { operators: 'operator', abilities: 'ability', weapons: 'weapon', gadgets: 'gadget' }[kind];
      const close = suggest(stem, [...expected[kind].keys()]);
      for (const f of list_) {
        if (!ICON_FORMATS.includes(iconExt(f))) {
          report.error(f, `.${iconExt(f) || '(no extension)'} is not an accepted icon format.`, 'Use SVG (preferred), PNG or WebP with a transparent background.');
        }
        report.warn(f, `Not used: no ${what} has the id "${stem}".${close ? ` Did you mean "${close}"?` : ''}`, close ? `Rename the file to ${close}.${iconExt(f)}.` : 'Rename it to match an id, or delete it.');
      }
    }
  }
  for (const kind of ICON_KINDS) {
    for (const file of resolvedIcons[kind].values()) {
      const buf = await reader.read(file);
      if (buf) await checkIconFile(file, buf, report);
    }
  }

  // 11. translations (warnings only)
  const changed = options.changed ?? new Set();
  const listed = translationNotes.filter((n) => options.translations || changed.has(n.file));
  const grouped = new Map();
  for (const n of listed) {
    const key = `${n.file}|${n.group}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(n);
  }
  for (const notes of grouped.values()) {
    const { file } = notes[0];
    if (notes.length === 1) {
      report.warn(file, `${notes[0].what} has no ${notes[0].miss.join(', ')} translation; players with that language see English.`, 'Optional: add "de", "fr" or "lb" next to "en" using the game\'s own wording.');
    } else {
      const langs = [...new Set(notes.flatMap((n) => n.miss))];
      report.warn(file, `${notes.length} ${notes[0].group} have no ${langs.join('/')} translation yet; players with that language see English.`, 'Optional: add "de", "fr" or "lb" next to "en" using the game\'s own wording.');
    }
  }
  const unlisted = translationNotes.length - listed.length;

  return {
    report,
    src,
    icons: resolvedIcons,
    counts: {
      operators: OPS.byId.size,
      weapons: WPN.byId.size,
      gadgets: GDG.byId.size,
      attachments: catalogue.size,
      icons: ICON_KINDS.reduce((n, k) => n + resolvedIcons[k].size, 0),
      untranslated: unlisted,
      untranslatedFiles: new Set(translationNotes.filter((n) => !listed.includes(n)).map((n) => n.file)).size,
    },
  };
}

export function printSummary({ report, counts }, { title = 'Checked' } = {}) {
  report.print();
  console.log('');
  console.log(`${title} ${plural(counts.operators, 'operator')}, ${plural(counts.weapons, 'weapon')}, ${plural(counts.gadgets, 'gadget')}, ${plural(counts.attachments, 'attachment')} and ${plural(counts.icons, 'icon')}.`);
  if (counts.untranslated) {
    console.log(paint('dim', `Translations: ${plural(counts.untranslated, 'text')} in ${plural(counts.untranslatedFiles, 'other file')} ha${counts.untranslated === 1 ? 's' : 've'} no de/fr/lb yet (English is shown). List them with: npm run validate -- --translations`));
  }
  const e = report.errors.length;
  const w = report.warnings.length;
  if (e) console.log(paint('red', `${plural(e, 'error')}, ${plural(w, 'warning')}. Fix the errors above, then run npm run validate again.`));
  else console.log(paint('green', `No errors${w ? `, ${plural(w, 'warning')}` : ''}.`));
}

async function main() {
  const usage = 'npm run validate [-- --translations] [-- --changed-since origin/main]';
  const { values } = args({
    translations: { type: 'boolean', default: false },
    'changed-since': { type: 'string' },
  }, usage);
  const result = await validate({ translations: values.translations, changed: changedFiles(values['changed-since']) });
  printSummary(result);
  return result.report.errors.length ? 1 : 0;
}

if (isMain(import.meta)) runCli(main);

// Shared helpers for the content scripts: loading source data (from the
// working tree or from a git tag), resolving the roster, i18n helpers,
// error reporting and small utilities. No dependencies beyond Node 22.

import { readFile, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const LANGS = ['en', 'de', 'fr', 'lb'];
export const OPTIONAL_LANGS = ['de', 'fr', 'lb'];
export const SLOTS = ['sight', 'barrel', 'grip', 'underbarrel'];
export const ICON_KINDS = ['operators', 'abilities', 'weapons', 'gadgets'];
export const ICON_FORMATS = ['svg', 'png', 'webp'];
export const ICON_SIZE = 256;
export const ICON_MAX_BYTES = 512 * 1024;
export const FIRST_CONTENT_APP = 30; // 2.0.0 is the first app version that reads content packs

export const ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const VERSION_PATTERN = /^\d{4}\.\d{2}\.\d+$/;
export const LABEL_PATTERN = /^Y\d+S\d+(\.\d+)?$/;

export const DATA_FILES = {
  attachments: 'data/attachments/attachments.json',
  classes: 'data/attachments/classes.json',
  roles: 'data/roles.json',
  meta: 'data/meta.json',
  messages: 'data/messages.json',
};

// ── errors meant for people, not stack traces ─────────────────────────
export class UserError extends Error {
  constructor(message, hint) {
    super(message);
    this.hint = hint;
  }
}

/** Runs a CLI entry point and turns UserErrors into a short message + exit code 1. */
export async function runCli(main) {
  try {
    const code = await main();
    if (typeof code === 'number') process.exitCode = code;
  } catch (err) {
    if (err instanceof UserError) {
      console.error(`${paint('red', 'error')}  ${err.message}`);
      if (err.hint) console.error(`       ${paint('dim', 'Fix: ' + err.hint)}`);
      if (process.env.GITHUB_ACTIONS === 'true') console.log(`::error::${escapeData(err.message + (err.hint ? ' Fix: ' + err.hint : ''))}`);
      process.exitCode = 1;
    } else {
      throw err;
    }
  }
}

/** True when the module was started directly with `node scripts/x.mjs`. */
export function isMain(meta) {
  return Boolean(process.argv[1]) && pathToFileURL(path.resolve(process.argv[1])).href === meta.url;
}

/** node:util parseArgs with a friendly message for unknown or malformed options. */
export function args(options, usage) {
  try {
    return parseArgs({ options, allowPositionals: true, strict: true });
  } catch (err) {
    const opt = /'([^']+)'/.exec(err.message)?.[1];
    if (err.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' && opt) throw new UserError(`Unknown option ${opt}.`, usage);
    throw new UserError(err.message.split('. ')[0].replace(/^.*?: /, '') + '.', usage);
  }
}

// ── terminal colours (also used in GitHub Actions logs) ───────────────
const COLOR = !process.env.NO_COLOR && (process.stdout.isTTY || process.env.GITHUB_ACTIONS === 'true');
const CODES = { red: 31, yellow: 33, green: 32, cyan: 36, dim: 2, bold: 1 };
export function paint(color, s) {
  return COLOR ? `\u001b[${CODES[color]}m${s}\u001b[0m` : String(s);
}

// ── GitHub Actions workflow commands ──────────────────────────────────
export function escapeData(s) {
  return String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}
export function escapeProperty(s) {
  return escapeData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

// ── readers: the same loading code works on the working tree and on a git tag
export function fsReader(root = ROOT) {
  return {
    label: 'working tree',
    root,
    async list(dir) {
      try {
        const entries = await readdir(path.join(root, dir), { withFileTypes: true });
        return entries.filter((e) => e.isFile()).map((e) => `${dir}/${e.name}`).sort();
      } catch (err) {
        if (err.code === 'ENOENT') return [];
        throw err;
      }
    },
    async read(rel) {
      try {
        return await readFile(path.join(root, rel));
      } catch (err) {
        if (err.code === 'ENOENT' || err.code === 'EISDIR') return null;
        throw err;
      }
    },
  };
}

export function gitReader(ref, root = ROOT) {
  const git = (argv) => execFileSync('git', argv, { cwd: root, maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  } catch {
    throw new UserError(`Git ref "${ref}" was not found.`, 'Fetch the tags first (git fetch --tags) and check the name, for example content-2026.03.0.');
  }
  return {
    label: ref,
    root,
    async list(dir) {
      try {
        return git(['ls-tree', '--name-only', `${ref}:${dir}`]).toString('utf8')
          .split('\n').filter(Boolean).map((name) => `${dir}/${name}`).sort();
      } catch {
        return [];
      }
    },
    async read(rel) {
      try {
        return git(['show', `${ref}:${rel}`]);
      } catch {
        return null;
      }
    },
  };
}

// ── JSON helpers ───────────────────────────────────────────────────────
function lineCol(text, pos) {
  const before = text.slice(0, pos).split('\n');
  return `line ${before.length}, column ${before[before.length - 1].length + 1}`;
}

/** Parses JSON and reports problems with a line number instead of a stack trace. */
export function parseJson(buf, file) {
  const text = buf.toString('utf8').replace(/^﻿/, '');
  try {
    return { data: JSON.parse(text) };
  } catch (err) {
    let msg = err.message;
    const pos = /position (\d+)/.exec(msg);
    if (pos) msg = `${msg.replace(/\s*(in JSON )?at position \d+.*$/, '')} (${lineCol(text, Number(pos[1]))})`;
    return {
      issue: {
        level: 'error',
        file,
        message: `Not valid JSON: ${msg}`,
        hint: 'Look for a missing or extra comma, or a missing quote, around that line. Editors such as VS Code underline the exact spot.',
      },
    };
  }
}

export function stringify(value) {
  return JSON.stringify(value, null, 2) + '\n';
}

export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

// ── loading the source files ──────────────────────────────────────────
/**
 * Reads every data file. Returns { operators, weapons, gadgets, attachments,
 * classes, roles, meta, messages, issues }. List entries are { file, data };
 * single files are { file, data } with data null when missing or broken.
 */
export async function loadSource(reader = fsReader()) {
  const issues = [];

  async function one(file, required = true) {
    const buf = await reader.read(file);
    if (!buf) {
      if (required) issues.push({ level: 'error', file, message: 'File is missing.', hint: 'Restore it from the main branch (git checkout origin/main -- ' + file + ').' });
      return { file, data: null };
    }
    const { data, issue } = parseJson(buf, file);
    if (issue) issues.push(issue);
    return { file, data: data ?? null };
  }

  async function many(dir) {
    const out = [];
    for (const file of await reader.list(dir)) {
      if (path.basename(file).startsWith('.')) continue;
      if (!file.endsWith('.json')) {
        issues.push({ level: 'error', file, message: 'Only .json files belong in this folder.', hint: 'Icons go to icons/<kind>/; rename or move the file.' });
        continue;
      }
      const entry = await one(file);
      if (entry.data) out.push(entry);
    }
    return out;
  }

  const src = {
    operators: await many('data/operators'),
    weapons: await many('data/weapons'),
    gadgets: await many('data/gadgets'),
    attachments: await one(DATA_FILES.attachments),
    classes: await one(DATA_FILES.classes),
    roles: await one(DATA_FILES.roles),
    meta: await one(DATA_FILES.meta),
    messages: await one(DATA_FILES.messages, false),
    issues,
  };
  if (!src.messages.data) src.messages.data = { messages: [] };
  return src;
}

/** Icon files by kind: Map(stem -> [file, ...]). */
export async function listIcons(reader = fsReader()) {
  const out = {};
  for (const kind of ICON_KINDS) {
    const map = new Map();
    for (const file of await reader.list(`icons/${kind}`)) {
      const base = path.basename(file);
      if (base.startsWith('.')) continue;
      const stem = base.includes('.') ? base.slice(0, base.lastIndexOf('.')) : base;
      if (!map.has(stem)) map.set(stem, []);
      map.get(stem).push(file);
    }
    out[kind] = map;
  }
  return out;
}

export function iconExt(file) {
  return path.extname(file).slice(1).toLowerCase();
}

// ── i18n ────────────────────────────────────────────────────────────────
/** Text in one language with English fallback; plain strings pass through. */
export function t(text, lang = 'en') {
  if (text == null) return '';
  if (typeof text === 'string') return text;
  return text[lang] ?? text.en ?? '';
}

/** Optional languages that a localized text does not have yet. */
export function missingLangs(text) {
  if (!text || typeof text !== 'object') return [];
  return OPTIONAL_LANGS.filter((l) => !text[l]);
}

/** Copies a localized text with keys in the fixed order en, de, fr, lb. */
export function orderedText(text) {
  if (!text || typeof text !== 'object') return text;
  const out = {};
  for (const l of LANGS) if (text[l]) out[l] = text[l];
  return out;
}

// ── versions and seasons ────────────────────────────────────────────────
export function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

function seasonKey(s) {
  const m = /^Y(\d+)S(\d+)/.exec(s || '');
  return m ? Number(m[1]) * 10 + Number(m[2]) : 9999;
}

// ── resolving: defaults filled in, attachments expanded ──────────────────
/** Class defaults + per-weapon override (replace, then remove, then add). */
export function resolveAttachments(weapon, classes, order = new Map()) {
  const base = classes?.[weapon.class] ?? {};
  const rank = (id) => order.get(id) ?? Number.MAX_SAFE_INTEGER;
  const out = {};
  for (const slot of SLOTS) {
    const o = weapon.attachments?.[slot] ?? {};
    let list = Array.isArray(o.replace) ? [...o.replace] : [...(base[slot] ?? [])];
    if (o.remove) list = list.filter((id) => !o.remove.includes(id));
    for (const id of o.add ?? []) if (!list.includes(id)) list.push(id);
    out[slot] = list.sort((a, b) => rank(a) - rank(b));
  }
  return out;
}

function compareOperators(a, b) {
  if (a.side !== b.side) return a.side === 'attack' ? -1 : 1;
  const s = seasonKey(a.released) - seasonKey(b.released);
  if (s) return s;
  return a.name.localeCompare(b.name, 'en');
}

const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * The complete roster as the app sees it, without image paths
 * (build.mjs adds those). Works on any loaded source, including an old tag.
 */
export function resolveRoster(src) {
  const catalogue = src.attachments.data?.attachments ?? [];
  const order = new Map(catalogue.map((a, i) => [a.id, i]));
  const classes = src.classes.data?.classes ?? {};

  const weapons = src.weapons.map(({ data: w }) => ({
    id: w.id,
    name: w.name,
    slot: w.slot,
    class: w.class,
    attachments: resolveAttachments(w, classes, order),
    ...(w.aliases ? { aliases: w.aliases } : {}),
  })).sort(byId);

  const gadgets = src.gadgets.map(({ data: g }) => ({
    id: g.id,
    name: orderedText(g.name),
    side: g.side,
    ...(g.aliases ? { aliases: g.aliases } : {}),
  })).sort((a, b) => (a.side !== b.side ? (a.side === 'attack' ? -1 : 1) : byId(a, b)));

  const operators = src.operators.map(({ data: o }) => ({
    id: o.id,
    ...(o.legacyId ? { legacyId: o.legacyId } : {}),
    name: o.name,
    side: o.side,
    type: o.type ?? 'standard',
    roles: o.roles ?? [],
    armor: o.armor,
    speed: o.speed,
    released: o.released,
    ability: { id: o.ability?.id, name: orderedText(o.ability?.name) },
    loadout: {
      primary: o.loadout?.primary ?? [],
      secondary: o.loadout?.secondary ?? [],
      gadgets: o.loadout?.gadgets ?? [],
      gadgetPicks: o.loadout?.gadgetPicks ?? 1,
    },
    ...(o.aliases ? { aliases: o.aliases } : {}),
  })).sort(compareOperators);

  return {
    roles: (src.roles.data?.roles ?? []).map((r) => ({ id: r.id, name: orderedText(r.name) })),
    attachments: catalogue.map((a) => ({ id: a.id, slot: a.slot, name: orderedText(a.name) })),
    operators,
    weapons,
    gadgets,
  };
}

// ── reporting ───────────────────────────────────────────────────────────
/**
 * Collects errors and warnings and prints them grouped by file, with a fix
 * hint under each. In GitHub Actions it also emits ::error / ::warning
 * annotations so problems show up on the pull request's "Files changed" tab.
 */
export function createReporter() {
  const items = [];
  const add = (level) => (file, message, hint) => items.push({ level, file: file || '', message, hint });
  return {
    items,
    error: add('error'),
    warn: add('warning'),
    push: (issue) => items.push({ hint: undefined, ...issue }),
    get errors() { return items.filter((i) => i.level === 'error'); },
    get warnings() { return items.filter((i) => i.level === 'warning'); },
    print() {
      const files = [...new Set(items.map((i) => i.file))].sort((a, b) => {
        const ea = items.some((i) => i.file === a && i.level === 'error');
        const eb = items.some((i) => i.file === b && i.level === 'error');
        return ea === eb ? a.localeCompare(b) : ea ? -1 : 1;
      });
      for (const file of files) {
        console.log('');
        console.log(paint('bold', file || '(general)'));
        for (const i of items.filter((x) => x.file === file).sort((a, b) => (a.level === b.level ? 0 : a.level === 'error' ? -1 : 1))) {
          const tag = i.level === 'error' ? paint('red', 'error  ') : paint('yellow', 'warning');
          console.log(`  ${tag}  ${i.message}`);
          if (i.hint) console.log(`           ${paint('dim', 'Fix: ' + i.hint)}`);
        }
      }
      if (process.env.GITHUB_ACTIONS === 'true') {
        for (const i of items) {
          const props = [i.file ? `file=${escapeProperty(i.file)}` : '', `title=${escapeProperty(i.level === 'error' ? 'Content error' : 'Content warning')}`].filter(Boolean).join(',');
          console.log(`::${i.level} ${props}::${escapeData(i.message + (i.hint ? '\nFix: ' + i.hint : ''))}`);
        }
      }
    },
  };
}

// ── small text helpers ──────────────────────────────────────────────────
export function plural(n, one, many = one + 's') {
  return `${n} ${n === 1 ? one : many}`;
}

export function slugify(s) {
  return String(s).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function distance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d[a.length][b.length];
}

/** Closest candidate for a probable typo, or null. */
export function suggest(value, candidates) {
  if (typeof value !== 'string' || !value) return null;
  let best = null;
  let bestD = Infinity;
  for (const c of candidates) {
    const dist = distance(value.toLowerCase(), String(c).toLowerCase());
    if (dist < bestD) { best = c; bestD = dist; }
  }
  return bestD > 0 && bestD <= Math.max(2, Math.floor(value.length / 3)) ? best : null;
}

export function didYouMean(value, candidates) {
  const s = suggest(value, candidates);
  return s ? ` Did you mean "${s}"?` : '';
}

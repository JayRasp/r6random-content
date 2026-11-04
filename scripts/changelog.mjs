// npm run changelog -- --base content-2026.03.0
//   Prints what changed between a published release and the working tree:
//   added / removed / renamed operators, weapons and gadgets, loadout
//   changes per operator and other field changes. build.mjs uses the same
//   code to write the "changes" of a changelog entry.
//
// Options
//   --base <tag>        compare against a git tag (default: newest content-* tag)
//   --head <ref>        compare up to this git ref instead of the working tree
//   --previous <file>   compare against a built manifest.json or pack .json
//   --json              print the change objects as JSON

import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import {
  ROOT, SLOTS, UserError, fsReader, gitReader, loadSource, resolveRoster, sha256, t,
  runCli, isMain, args, paint, plural,
} from './lib.mjs';

const TARGETS = [['operators', 'operator'], ['weapons', 'weapon'], ['gadgets', 'gadget']];

function setDiff(a = [], b = []) {
  const added = b.filter((x) => !a.includes(x));
  const removed = a.filter((x) => !b.includes(x));
  const out = {};
  if (added.length) out.added = added;
  if (removed.length) out.removed = removed;
  return Object.keys(out).length ? out : null;
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function nameOf(entry) {
  return t(entry?.name);
}

/**
 * Compares two resolved rosters (pack files or resolveRoster() output) and
 * returns change objects: { kind, target, id, name?, detail? }.
 * kind: added | removed | renamed | loadout | changed
 */
export function diffRosters(prev, next) {
  const groups = { added: [], renamed: [], loadout: [], changed: [], removed: [] };

  for (const [key, target] of TARGETS) {
    const before = new Map((prev[key] ?? []).map((x) => [x.id, x]));
    const after = new Map((next[key] ?? []).map((x) => [x.id, x]));
    const movedFrom = new Map();
    for (const x of after.values()) {
      for (const old of x.aliases ?? []) if (before.has(old) && !after.has(old)) movedFrom.set(x.id, old);
    }
    const consumed = new Set(movedFrom.values());

    for (const [id, x] of after) {
      const oldId = before.has(id) ? id : movedFrom.get(id);
      const old = oldId ? before.get(oldId) : null;
      if (!old) {
        groups.added.push({ kind: 'added', target, id });
        continue;
      }
      if (oldId !== id) {
        groups.renamed.push({ kind: 'renamed', target, id, detail: { fromId: oldId, from: nameOf(old), to: nameOf(x) } });
      } else if (nameOf(old) !== nameOf(x)) {
        groups.renamed.push({ kind: 'renamed', target, id, detail: { from: nameOf(old), to: nameOf(x) } });
      }

      if (target === 'operator') {
        const lo = {};
        for (const k of ['primary', 'secondary', 'gadgets']) {
          const d = setDiff(old.loadout?.[k], x.loadout?.[k]);
          if (d) lo[k] = d;
        }
        const pa = old.loadout?.gadgetPicks ?? 1;
        const pb = x.loadout?.gadgetPicks ?? 1;
        if (pa !== pb) lo.gadgetPicks = { from: pa, to: pb };
        if (Object.keys(lo).length) groups.loadout.push({ kind: 'loadout', target, id, detail: lo });

        const ch = {};
        for (const f of ['side', 'type', 'armor', 'speed', 'released']) {
          if (old[f] !== x[f] && old[f] !== undefined) ch[f] = { from: old[f], to: x[f] };
        }
        const roles = setDiff(old.roles, x.roles);
        if (roles) ch.roles = roles;
        if (old.ability?.id !== x.ability?.id || nameOf(old.ability) !== nameOf(x.ability)) {
          ch.ability = { from: nameOf(old.ability), to: nameOf(x.ability) };
        }
        if (Object.keys(ch).length) groups.changed.push({ kind: 'changed', target, id, detail: ch });
      }

      if (target === 'weapon') {
        const ch = {};
        for (const f of ['slot', 'class']) if (old[f] !== x[f]) ch[f] = { from: old[f], to: x[f] };
        const att = {};
        for (const s of SLOTS) {
          const d = setDiff(old.attachments?.[s], x.attachments?.[s]);
          if (d) att[s] = d;
        }
        if (Object.keys(att).length) ch.attachments = att;
        if (Object.keys(ch).length) groups.changed.push({ kind: 'changed', target, id, detail: ch });
      }

      if (target === 'gadget' && old.side !== x.side) {
        groups.changed.push({ kind: 'changed', target, id, detail: { side: { from: old.side, to: x.side } } });
      }
    }

    for (const [id, x] of before) {
      if (!after.has(id) && !consumed.has(id)) groups.removed.push({ kind: 'removed', target, id, name: nameOf(x) });
    }
  }
  return [...groups.added, ...groups.renamed, ...groups.loadout, ...groups.changed, ...groups.removed];
}

// ── human-readable text ──────────────────────────────────────────────────
const SLOT_WORD = { primary: 'primary', secondary: 'secondary', gadgets: 'gadget' };

function joinNames(list) {
  if (list.length <= 1) return list.join('');
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

/** One line of English text for a change. `prev` and `next` supply names. */
export function describe(change, prev, next) {
  const lookup = (key, id) => {
    const hit = (next[key] ?? []).find((x) => x.id === id) ?? (prev[key] ?? []).find((x) => x.id === id);
    return hit ? nameOf(hit) : id;
  };
  const key = `${change.target}s`;
  const name = change.name ?? lookup(key, change.id);
  const d = change.detail ?? {};
  switch (change.kind) {
    case 'added':
      return `Added ${change.target} ${name}`;
    case 'removed':
      return `Removed ${change.target} ${name}`;
    case 'renamed':
      return `Renamed ${change.target} ${d.from} to ${d.to}${d.fromId ? ` (id ${d.fromId} → ${change.id})` : ''}`;
    case 'loadout': {
      const parts = [];
      for (const k of ['primary', 'secondary', 'gadgets']) {
        if (!d[k]) continue;
        const list = k === 'gadgets' ? 'gadgets' : 'weapons';
        const added = (d[k].added ?? []).map((id) => lookup(list, id));
        const removed = (d[k].removed ?? []).map((id) => lookup(list, id));
        if (added.length === 1 && removed.length === 1) {
          parts.push(`${removed[0]} replaced by ${added[0]}`);
        } else {
          if (added.length) parts.push(`${joinNames(added)} added as ${SLOT_WORD[k]}`);
          if (removed.length) parts.push(`${joinNames(removed)} removed from ${SLOT_WORD[k]}${k === 'gadgets' ? 's' : ''}`);
        }
      }
      if (d.gadgetPicks) parts.push(`picks ${d.gadgetPicks.to} gadgets instead of ${d.gadgetPicks.from}`);
      return `${name}: ${parts.join('; ')}`;
    }
    case 'changed': {
      const parts = [];
      for (const [f, v] of Object.entries(d)) {
        if (f === 'attachments') {
          for (const [slot, s] of Object.entries(v)) {
            const att = (id) => nameOf((next.attachments ?? []).find((a) => a.id === id) ?? (prev.attachments ?? []).find((a) => a.id === id)) || id;
            if (s.added) parts.push(`${slot}: added ${joinNames(s.added.map(att))}`);
            if (s.removed) parts.push(`${slot}: removed ${joinNames(s.removed.map(att))}`);
          }
        } else if (f === 'roles') {
          if (v.added) parts.push(`role ${joinNames(v.added)} added`);
          if (v.removed) parts.push(`role ${joinNames(v.removed)} removed`);
        } else {
          parts.push(`${f} ${v.from} → ${v.to}`);
        }
      }
      return `${name}: ${parts.join('; ')}`;
    }
    default:
      return `${change.kind} ${change.target} ${name}`;
  }
}

// ── loading the "before" side ────────────────────────────────────────────
/** Reads a manifest (follows pack.url and checks its sha256) or a pack file. */
export async function readPrevious(file) {
  let raw;
  try {
    raw = await readFile(file);
  } catch {
    throw new UserError(`Cannot read ${file}.`, 'Download the live manifest first: curl -fsSL https://content.jojaweb.com/v1/manifest.json -o dist-prev/v1/manifest.json');
  }
  const json = JSON.parse(raw.toString('utf8'));
  if (json.operators) return { pack: json, manifest: null, packFile: file, packBytes: raw };
  if (!json.pack?.url) throw new UserError(`${file} is neither a manifest nor a pack.`);
  const packFile = path.join(path.dirname(file), json.pack.url);
  let packBytes;
  try {
    packBytes = await readFile(packFile);
  } catch {
    throw new UserError(`The pack ${packFile} named in ${file} is missing.`, `Download it next to the manifest: curl -fsSL https://content.jojaweb.com/v1/${json.pack.url} -o ${packFile}`);
  }
  if (sha256(packBytes) !== json.pack.sha256) {
    throw new UserError(`${packFile} does not match the sha256 in ${file}.`, 'Download both files again; they must come from the same release.');
  }
  return { pack: JSON.parse(packBytes.toString('utf8')), manifest: json, packFile, packBytes };
}

export function latestTag(root = ROOT) {
  try {
    return execFileSync('git', ['describe', '--tags', '--abbrev=0', '--match', 'content-*'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8').trim();
  } catch {
    return null;
  }
}

export async function rosterAt(ref) {
  const src = await loadSource(gitReader(ref));
  const broken = src.issues.filter((i) => i.level === 'error');
  if (broken.length) console.warn(paint('yellow', `note: ${plural(broken.length, 'file')} in ${ref} could not be read and are skipped (${broken[0].file}…)`));
  return resolveRoster(src);
}

async function main() {
  const usage = 'npm run changelog -- --base content-2026.03.0   or   npm run changelog -- --previous dist-prev/v1/manifest.json';
  const { values } = args({
    base: { type: 'string' },
    head: { type: 'string' },
    previous: { type: 'string' },
    json: { type: 'boolean', default: false },
  }, usage);

  let prev;
  let fromLabel;
  if (values.previous) {
    const p = await readPrevious(values.previous);
    prev = p.pack;
    fromLabel = `${p.pack.version} (${p.pack.label})`;
  } else {
    const base = values.base ?? latestTag();
    if (!base) throw new UserError('There is no content-* tag to compare against yet.', 'Pass --base <tag or commit>, or --previous <manifest.json>.');
    prev = await rosterAt(base);
    fromLabel = base;
  }
  const next = values.head ? await rosterAt(values.head) : resolveRoster(await loadSource(fsReader()));
  const changes = diffRosters(prev, next);

  if (values.json) {
    console.log(JSON.stringify(changes, null, 2));
    return 0;
  }
  console.log(`Changes since ${fromLabel} → ${values.head ?? 'working tree'}: ${changes.length ? plural(changes.length, 'change') : 'none'}`);
  for (const c of changes) console.log(`  ${describe(c, prev, next)}`);
  return 0;
}

if (isMain(import.meta)) runCli(main);

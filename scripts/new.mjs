// npm run new -- operator noor
// npm run new -- weapon glaive-12
// npm run new -- gadget frag-grenade
//   Creates data/<kind>s/<id>.json from templates/<kind>.json and tells you
//   which icon files to add next.
//
// Options
//   --name "Display Name"   default: guessed from the id
//   --side attack|defense   operators and gadgets

import { readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { ROOT, ID_PATTERN, UserError, runCli, isMain, args, paint, slugify, didYouMean } from './lib.mjs';

const KINDS = { operator: 'operators', weapon: 'weapons', gadget: 'gadgets' };

function guessName(id) {
  return id.split('-').map((w) => (/^\d/.test(w) ? w : w[0].toUpperCase() + w.slice(1))).join(' ');
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const usage = 'npm run new -- operator noor   (or weapon <id>, gadget <id>)';
  const { values, positionals } = args({
    name: { type: 'string' },
    side: { type: 'string' },
  }, usage);
  const [kind, rawId] = positionals;
  if (!kind || !KINDS[kind]) {
    throw new UserError(kind ? `Unknown kind "${kind}".${didYouMean(kind, Object.keys(KINDS))}` : 'What should be created?', usage);
  }
  if (!rawId) throw new UserError(`The ${kind} id is missing.`, usage);
  const id = rawId;
  if (!ID_PATTERN.test(id)) {
    throw new UserError(`"${id}" is not a valid id.`, `Ids use lowercase letters a-z, digits and single hyphens, for example "${slugify(id)}".`);
  }
  if (values.side && !['attack', 'defense'].includes(values.side)) {
    throw new UserError(`--side must be attack or defense, not "${values.side}".`);
  }

  const dir = KINDS[kind];
  const target = path.join(ROOT, 'data', dir, `${id}.json`);
  if (await exists(target)) throw new UserError(`data/${dir}/${id}.json already exists.`, 'Edit that file instead, or pick another id.');

  let season = 'Y11S1';
  try {
    const meta = JSON.parse(await readFile(path.join(ROOT, 'data', 'meta.json'), 'utf8'));
    season = String(meta.label).replace(/\.\d+$/, '');
  } catch { /* keep the default */ }

  const name = values.name ?? guessName(id);
  let text = await readFile(path.join(ROOT, 'templates', `${kind}.json`), 'utf8');
  text = text.replaceAll('__ID__', id).replaceAll('__NAME__', name.replace(/"/g, '\\"')).replaceAll('__SEASON__', season);
  if (values.side) text = text.replace('"side": "attack or defense"', `"side": "${values.side}"`);
  JSON.parse(text);
  await writeFile(target, text);

  console.log(paint('green', `Created data/${dir}/${id}.json`));
  console.log('');
  console.log('Next:');
  if (kind === 'operator') {
    console.log('  1. Fill in side, roles, armor, speed, ability and loadout (ids from data/weapons and data/gadgets).');
    console.log(`  2. Add icons/operators/${id}.svg and icons/abilities/<ability id>.svg (PNG/WebP also accepted: square, transparent, 256 px or more).`);
  } else if (kind === 'weapon') {
    console.log('  1. Check the name and set slot and class. Add "attachments" only where the weapon differs from its class.');
    console.log(`  2. Add icons/weapons/${id}.svg (PNG/WebP also accepted: square, transparent, 256 px or more).`);
  } else {
    console.log('  1. Check the name and set side.');
    console.log(`  2. Add icons/gadgets/${id}.svg (PNG/WebP also accepted: square, transparent, 256 px or more).`);
  }
  console.log('  3. npm run validate');
  return 0;
}

if (isMain(import.meta)) runCli(main);

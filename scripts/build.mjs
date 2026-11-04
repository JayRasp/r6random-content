// npm run build -- --version 2026.09.0 --label Y11S3.0 [--previous dist-prev/v1/manifest.json]
//   Validates, resolves the roster, normalises icons to 256 px WebP and writes
//     dist/v1/packs/<version>.json   the full resolved roster
//     dist/v1/img/<kind>/<id>.<hash32>.webp  <hash32> = first 32 hex characters (128 bits) of the
//                                            file's SHA-256; the app recomputes it before using the image
//     dist/v1/manifest.json          version, pack sha256, changelog, messages
//     dist/CNAME, dist/index.html
//   Sign the manifest afterwards with: npm run sign -- dist/v1/manifest.json
//
// Options
//   --version <YYYY.MM.patch>  required (except with --dry-run)
//   --label <Y11S3.0>          default: data/meta.json "label"
//   --previous <manifest>      live manifest: keeps its changelog, diffs against its pack
//   --base <git ref>           diff against a git tag instead (when there is no --previous)
//   --date <ISO date-time>     publication time (default: now)
//   --out <dir>                output folder (default: dist)
//   --dry-run                  do everything except writing files

import { mkdir, rm, writeFile, copyFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { optimize } from 'svgo';
import {
  ROOT, ICON_KINDS, ICON_SIZE, VERSION_PATTERN, LABEL_PATTERN, UserError,
  fsReader, resolveRoster, iconExt, sha256, stringify, compareVersions, orderedText,
  runCli, isMain, args, paint, plural,
} from './lib.mjs';
import { validate, schemas, printSummary } from './validate.mjs';
import { diffRosters, describe, readPrevious, rosterAt, latestTag } from './changelog.mjs';

const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 };

/** SVG → optimised → rendered; raster → resized. Always a square 256 px WebP. */
export async function normaliseIcon(buf, file) {
  let img;
  if (iconExt(file) === 'svg') {
    const svg = Buffer.from(optimize(buf.toString('utf8'), { path: file, multipass: true }).data);
    const meta = await sharp(svg).metadata();
    const density = Math.min(2400, Math.max(1, Math.ceil((72 * ICON_SIZE) / Math.max(meta.width || ICON_SIZE, meta.height || ICON_SIZE))));
    img = sharp(svg, { density });
  } else {
    img = sharp(buf);
  }
  return img
    .resize(ICON_SIZE, ICON_SIZE, { fit: 'contain', background: TRANSPARENT, kernel: 'lanczos3' })
    .webp({ quality: 90, alphaQuality: 100, effort: 5, smartSubsample: true })
    .toBuffer();
}

function isoSeconds(d) {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

async function main() {
  const usage = 'npm run build -- --version 2026.09.0 --label Y11S3.0 [--previous dist-prev/v1/manifest.json]';
  const { values } = args({
    version: { type: 'string' },
    label: { type: 'string' },
    previous: { type: 'string' },
    base: { type: 'string' },
    date: { type: 'string' },
    out: { type: 'string', default: 'dist' },
    'dry-run': { type: 'boolean', default: false },
  }, usage);
  const dry = values['dry-run'];

  // ── arguments ──
  const version = values.version ?? (dry ? '0000.00.0' : null);
  if (!version) throw new UserError('--version is missing.', usage);
  if (!VERSION_PATTERN.test(version)) throw new UserError(`"${version}" is not a valid version.`, 'Versions look like 2026.09.0 (year, month, patch).');
  const published = values.date ? new Date(values.date) : new Date();
  if (Number.isNaN(published.getTime())) throw new UserError(`"${values.date}" is not a valid date.`, 'Use an ISO date-time such as 2026-09-01T17:00:00Z.');
  const out = path.resolve(ROOT, values.out);
  if (out === ROOT || ROOT.startsWith(out + path.sep)) throw new UserError(`--out ${values.out} would overwrite the repository.`, 'Use a separate folder such as dist.');

  console.log(paint('bold', `${dry ? 'Dry run' : 'Building'} ${version}`));

  // ── 1. validate ──
  const result = await validate({ reader: fsReader() });
  if (result.report.errors.length) {
    printSummary(result);
    throw new UserError('The data has errors, so nothing was built.', 'Fix the errors listed above (npm run validate shows the same list).');
  }
  const { src, icons } = result;
  const meta = src.meta.data;
  const label = values.label ?? meta.label;
  if (!LABEL_PATTERN.test(label)) throw new UserError(`"${label}" is not a valid label.`, 'Labels look like Y11S3.0.');
  if (values.label && values.label !== meta.label) {
    console.log(paint('yellow', `  note: --label ${values.label} differs from data/meta.json (${meta.label}); using ${values.label}.`));
  }
  console.log(`  validate     ok${result.report.warnings.length ? ` (${plural(result.report.warnings.length, 'warning')}; run npm run validate to see them)` : ''}`);

  // ── 2. previous release ──
  let previous = null;
  if (values.previous) {
    previous = await readPrevious(values.previous);
    if (!previous.manifest) throw new UserError('--previous must point to a manifest.json, not a pack.', 'Use dist-prev/v1/manifest.json.');
    if (compareVersions(version, previous.manifest.version) <= 0) {
      const [y, m, p] = previous.manifest.version.split('.');
      throw new UserError(`Version ${version} is not higher than the live version ${previous.manifest.version}.`, `Use a higher version, for example ${y}.${m}.${Number(p) + 1} for a patch.`);
    }
  }

  // ── 3. resolve ──
  const roster = resolveRoster(src);
  console.log(`  roster       ${plural(roster.operators.length, 'operator')}, ${plural(roster.weapons.length, 'weapon')}, ${plural(roster.gadgets.length, 'gadget')}, ${plural(roster.attachments.length, 'attachment')}`);

  // ── 4. icons ──
  const images = [];
  const imagePath = new Map();
  for (const kind of ICON_KINDS) {
    for (const [id, file] of icons[kind]) {
      const webp = await normaliseIcon(await readFile(path.join(ROOT, file)), file);
      const rel = `img/${kind}/${id}.${sha256(webp).slice(0, 32)}.webp`;
      images.push({ rel, webp });
      imagePath.set(`${kind}/${id}`, rel);
    }
  }
  const imageBytes = images.reduce((n, i) => n + i.webp.length, 0);
  console.log(`  images       ${images.length} WebP files, ${Math.round(imageBytes / 1024)} KB`);

  const pack = {
    schema: 1,
    version,
    label,
    minApp: meta.minApp,
    roles: roster.roles,
    attachments: roster.attachments,
    operators: roster.operators.map((o) => {
      const { ability, loadout, aliases, ...rest } = o;
      return {
        ...rest,
        icon: imagePath.get(`operators/${o.id}`),
        ability: { ...ability, icon: imagePath.get(`abilities/${ability.id}`) },
        loadout,
        ...(aliases ? { aliases } : {}),
      };
    }),
    weapons: roster.weapons.map(({ attachments, aliases, ...w }) => ({ ...w, icon: imagePath.get(`weapons/${w.id}`), attachments, ...(aliases ? { aliases } : {}) })),
    gadgets: roster.gadgets.map(({ aliases, ...g }) => ({ ...g, icon: imagePath.get(`gadgets/${g.id}`), ...(aliases ? { aliases } : {}) })),
  };

  // ── 5. changelog ──
  let before = null;
  let since = null;
  if (previous) {
    before = previous.pack;
    since = `${previous.manifest.version} (${previous.manifest.label})`;
  } else if (values.base) {
    before = await rosterAt(values.base);
    since = values.base;
  }
  const changes = before ? diffRosters(before, pack) : [];
  const date = isoSeconds(published).slice(0, 10);
  const entry = { version, label, date, ...(meta.note ? { note: orderedText(meta.note) } : {}), changes };
  const changelog = [entry, ...(previous?.manifest.changelog ?? []).filter((e) => e.version !== version)];
  if (since) {
    console.log(`  changelog    ${changes.length ? plural(changes.length, 'change') : 'no changes'} since ${since}`);
    for (const c of changes) console.log(`                 ${describe(c, before, pack)}`);
  } else {
    console.log('  changelog    first release (nothing to compare with)');
  }
  if (!values.previous && !values.base && latestTag()) {
    console.log(paint('yellow', `  note: no --previous or --base given; the changelog entry lists no changes. Compare with --base ${latestTag()}.`));
  }

  // ── 6. messages ──
  const all = src.messages.data.messages ?? [];
  const messages = all
    .filter((m) => !m.until || m.until >= date)
    .map((m) => ({
      id: m.id,
      severity: m.severity,
      minApp: m.minApp ?? null,
      maxApp: m.maxApp ?? null,
      from: m.from ?? null,
      until: m.until ?? null,
      title: orderedText(m.title),
      body: orderedText(m.body),
    }));
  if (messages.length !== all.length) console.log(`  messages     ${messages.length} active (${all.length - messages.length} ended, left out)`);
  else console.log(`  messages     ${messages.length} active`);

  // ── 7. pack + manifest ──
  const packBytes = Buffer.from(JSON.stringify(pack));
  const manifest = {
    schema: 1,
    version,
    label,
    minApp: meta.minApp,
    published: isoSeconds(published),
    pack: { url: `packs/${version}.json`, sha256: sha256(packBytes), bytes: packBytes.length },
    images: { bytes: imageBytes, count: images.length },
    changelog,
    messages,
  };
  const ajv = await schemas();
  for (const [name, data] of [['pack.schema.json', pack], ['manifest.schema.json', manifest]]) {
    const check = ajv.getSchema(name);
    if (!check(data)) {
      throw new UserError(`The built ${name.replace('.schema.json', '')} does not match schema/${name}: ${check.errors.map((e) => `${e.instancePath || '/'} ${e.message}`).slice(0, 5).join('; ')}`, 'This is a bug in the build script or the schema; please open an issue.');
    }
  }
  const manifestBytes = Buffer.from(stringify(manifest));
  console.log(`  pack         packs/${version}.json, ${Math.round(packBytes.length / 1024)} KB, sha256 ${manifest.pack.sha256.slice(0, 12)}…`);

  if (dry) {
    console.log(paint('green', 'Dry run finished; nothing was written.'));
    return 0;
  }

  // ── 8. write ──
  await rm(path.join(out, 'v1'), { recursive: true, force: true });
  await mkdir(path.join(out, 'v1', 'packs'), { recursive: true });
  for (const kind of ICON_KINDS) await mkdir(path.join(out, 'v1', 'img', kind), { recursive: true });
  for (const img of images) await writeFile(path.join(out, 'v1', img.rel), img.webp);
  await writeFile(path.join(out, 'v1', 'packs', `${version}.json`), packBytes);
  if (previous && previous.manifest.version !== version) {
    // keep the previous pack reachable for apps that fetched the old manifest moments ago
    await writeFile(path.join(out, 'v1', 'packs', `${previous.manifest.version}.json`), previous.packBytes);
  }
  await writeFile(path.join(out, 'v1', 'manifest.json'), manifestBytes);
  await copyFile(path.join(ROOT, 'CNAME'), path.join(out, 'CNAME'));
  await writeFile(path.join(out, 'index.html'), [
    '<!doctype html><meta charset="utf-8"><title>R6 Siege Randomizer content</title>',
    '<p>This host serves operator, weapon and gadget data for the R6 Siege Randomizer app.',
    `<p>Current content: ${label} (${version}). <a href="v1/manifest.json">manifest</a>`,
    '<p>Documentation: <a href="https://jojaweb.com/r6random/docs/">jojaweb.com/r6random/docs</a>',
    '',
  ].join('\n'));

  console.log(`  manifest     ${path.relative(process.cwd(), path.join(out, 'v1', 'manifest.json'))}`);
  console.log(paint('green', `Built ${label} (${version}).`) + ' Next: npm run sign -- ' + path.relative(process.cwd(), path.join(out, 'v1', 'manifest.json')));
  return 0;
}

if (isMain(import.meta)) runCli(main);

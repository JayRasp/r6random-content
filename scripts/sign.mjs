// npm run sign -- dist/v1/manifest.json
//   Signs the exact bytes of the manifest with Ed25519 and writes the base64
//   signature to manifest.json.sig. The private key (PEM) comes from the
//   environment variable CONTENT_SIGNING_KEY, or from --key <file>.
//
// npm run sign -- --verify dist/v1/manifest.json
// npm run sign -- --verify https://content.jojaweb.com/v1/manifest.json
//   Checks a signature (local file or live URL) against every key in signing/
//   (public.pem, plus the next key while a rotation is under way), or against
//   --public-key <pem file | base64> (repeatable).

import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT, UserError, runCli, isMain, args, paint, sha256 } from './lib.mjs';
import { PUBLIC_KEY_FILE, rawPublicKey } from './keygen.mjs';

const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** Accepts a PEM string, a PEM file path or the app's raw base64 key. */
export async function loadPublicKey(value) {
  let text = value.trim();
  if (!text.includes('BEGIN') && !/^[A-Za-z0-9+/]{43}=$/.test(text)) {
    try {
      text = (await readFile(path.resolve(text), 'utf8')).trim();
    } catch {
      throw new UserError(`Cannot read the public key "${value}".`, `Pass a PEM file, the base64 key from the app, or commit ${PUBLIC_KEY_FILE} (created by npm run keygen).`);
    }
  }
  if (text.includes('BEGIN')) return createPublicKey(text);
  return createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(text, 'base64')]), format: 'der', type: 'spki' });
}

async function fetchBytes(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'r6random-content-verify' } });
  if (!res.ok) throw new UserError(`${url} answered HTTP ${res.status}.`, 'Check the URL and that the latest publish workflow finished.');
  return Buffer.from(await res.arrayBuffer());
}

async function readTarget(target) {
  if (/^https?:\/\//.test(target)) return { manifest: await fetchBytes(target), sig: (await fetchBytes(`${target}.sig`)).toString('utf8') };
  let manifest;
  let sig;
  try {
    manifest = await readFile(target);
  } catch {
    throw new UserError(`Cannot read ${target}.`, 'Build first: npm run build -- --version … ');
  }
  try {
    sig = await readFile(`${target}.sig`, 'utf8');
  } catch {
    throw new UserError(`${target}.sig is missing.`, `Sign the manifest first: npm run sign -- ${target}`);
  }
  return { manifest, sig };
}

async function verifyMode(target, keys) {
  const { manifest, sig } = await readTarget(target);
  const signature = Buffer.from(sig.trim(), 'base64');
  if (signature.length !== 64) throw new UserError(`${target}.sig is not an Ed25519 signature (expected 64 bytes, found ${signature.length}).`);
  let candidates = keys;
  if (!candidates.length) {
    const dir = path.join(ROOT, path.dirname(PUBLIC_KEY_FILE));
    candidates = (await readdir(dir).catch(() => [])).filter((f) => f.endsWith('.pem')).sort().map((f) => path.join(dir, f));
    if (!candidates.length) throw new UserError(`No public key in ${path.dirname(PUBLIC_KEY_FILE)}/.`, `Commit ${PUBLIC_KEY_FILE} (created by npm run keygen), or pass --public-key <file or base64>.`);
  }
  for (const k of candidates) {
    const key = await loadPublicKey(k);
    if (verify(null, manifest, key, signature)) {
      const json = JSON.parse(manifest.toString('utf8'));
      console.log(paint('green', `Signature valid`) + ` for ${json.label} (${json.version}), key ${rawPublicKey(key).slice(0, 12)}…`);
      console.log(`  manifest sha256 ${sha256(manifest)}`);
      return 0;
    }
  }
  console.error(paint('red', 'Signature INVALID') + ` for ${target}.`);
  console.error('  The manifest was changed after signing, or it was signed with a different key. The app would reject it.');
  return 1;
}

async function signMode(target, keyFile) {
  let pem = process.env.CONTENT_SIGNING_KEY;
  if (keyFile) pem = await readFile(keyFile, 'utf8');
  if (!pem || !pem.includes('PRIVATE KEY')) {
    throw new UserError('No private key: CONTENT_SIGNING_KEY is not set.', 'In GitHub Actions the publish workflow sets it from the secret of the "production" environment. Locally: CONTENT_SIGNING_KEY="$(cat keys/private.pem)" npm run sign -- dist/v1/manifest.json, or pass --key keys/private.pem.');
  }
  const privateKey = createPrivateKey(pem);
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new UserError(`The key is ${privateKey.asymmetricKeyType}, not Ed25519.`, 'Create the key with npm run keygen.');
  let manifest;
  try {
    manifest = await readFile(target);
  } catch {
    throw new UserError(`Cannot read ${target}.`, 'Build first: npm run build -- --version … ');
  }
  const signature = sign(null, manifest, privateKey);
  if (!verify(null, manifest, createPublicKey(privateKey), signature)) throw new Error('Signature self-check failed.');
  await writeFile(`${target}.sig`, signature.toString('base64'));
  console.log(paint('green', 'Signed') + ` ${target} → ${target}.sig`);
  console.log(`  public key ${rawPublicKey(createPublicKey(privateKey))}`);
  return 0;
}

async function main() {
  const usage = 'npm run sign -- dist/v1/manifest.json   or   npm run sign -- --verify <manifest file or URL>';
  const { values, positionals } = args({
    verify: { type: 'boolean', default: false },
    key: { type: 'string' },
    'public-key': { type: 'string', multiple: true },
  }, usage);
  const target = positionals[0];
  if (!target) throw new UserError('Which manifest? The file path is missing.', usage);
  return values.verify ? verifyMode(target, values['public-key'] ?? []) : signMode(target, values.key);
}

if (isMain(import.meta)) runCli(main);

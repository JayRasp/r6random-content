// npm run keygen
//   Creates the Ed25519 key pair that signs v1/manifest.json. Maintainer
//   only, once (and again only when rotating the key).
//     keys/private.pem    → secret CONTENT_SIGNING_KEY of the "production" environment, then delete
//                           or keep offline. Never commit it (keys/ is ignored).
//     signing/public.pem  → commit it; sign.mjs --verify uses it.
//   The printed base64 public key goes into the app.
//
// Options
//   --force   overwrite existing keys (key rotation; read the maintainer guide first)

import { generateKeyPairSync } from 'node:crypto';
import { mkdir, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { ROOT, UserError, runCli, isMain, args, paint } from './lib.mjs';

export const PRIVATE_KEY_FILE = 'keys/private.pem';
export const PUBLIC_KEY_FILE = 'signing/public.pem';

/** The raw 32-byte Ed25519 public key, base64 (what the app embeds). */
export function rawPublicKey(publicKey) {
  return publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
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
  const { values } = args({ force: { type: 'boolean', default: false } }, 'npm run keygen [-- --force]');
  const priv = path.join(ROOT, PRIVATE_KEY_FILE);
  const pub = path.join(ROOT, PUBLIC_KEY_FILE);
  if (!values.force && ((await exists(priv)) || (await exists(pub)))) {
    throw new UserError(`A key already exists (${PRIVATE_KEY_FILE} or ${PUBLIC_KEY_FILE}).`, 'A new key only makes sense when rotating keys; see "Rotating the signing key" in the maintainer guide, then run npm run keygen -- --force.');
  }
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  await mkdir(path.dirname(priv), { recursive: true });
  await mkdir(path.dirname(pub), { recursive: true });
  await writeFile(priv, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
  await writeFile(pub, publicKey.export({ format: 'pem', type: 'spki' }));
  const raw = rawPublicKey(publicKey);

  console.log(paint('green', 'Created an Ed25519 key pair.'));
  console.log(`  private key  ${PRIVATE_KEY_FILE}   (secret: never commit or share)`);
  console.log(`  public key   ${PUBLIC_KEY_FILE}   (commit this file)`);
  console.log('');
  console.log('Public key for the app (base64, 32 bytes):');
  console.log(`  ${raw}`);
  console.log('');
  console.log('Next steps:');
  console.log(`  1. gh secret set CONTENT_SIGNING_KEY --env production < ${PRIVATE_KEY_FILE}`);
  console.log(`  2. git add ${PUBLIC_KEY_FILE} && git commit -m "Add content signing public key"`);
  console.log('  3. Put the base64 key above into the app (ContentKeys.kt) and ship that app version.');
  console.log(`  4. Move ${PRIVATE_KEY_FILE} to an offline backup (password manager) and delete it here.`);
  return 0;
}

if (isMain(import.meta)) runCli(main);

import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { validateSignedEnrollmentRelease } from '../cloud/upgrade-enrollment-release.mjs';
import { verifyUpgradeRelease } from '../cloud/upgrade-plan.mjs';
import { readPrivateFile } from '../src/private-directory.mjs';
import { verifyPublishedArchive } from './release-archive.mjs';

const hex = bytes => createHash('sha256').update(bytes).digest('hex');

// Release engineering entry point only. The production CLI never accepts a custom fetch.
export async function signWebUpgrade({ worker, keyFile, version, minimumVersion, channel, output, enrollmentCatalog,
  request = fetch, issued = Date.now() }) {
  const bundle = await readFile(worker);
  const workerSha256 = hex(bundle);
  const format = enrollmentCatalog === undefined ? 1 : 2;
  const release = {
    schema: format, product: 'nodrelay-management', channel, version, minimumVersion,
    issuedAt: new Date(issued).toISOString(), expiresAt: new Date(issued + 30 * 86400_000).toISOString(),
    workerBundle: 'worker.js', workerSha256,
  };
  if (format === 2) {
    const catalog = JSON.parse(await readFile(enrollmentCatalog, 'utf8'));
    if (catalog?.workerBundle !== './worker.js' || catalog.workerSha256 !== workerSha256) {
      throw new Error('Enrollment catalog does not bind the exact Worker bundle');
    }
    release.enrollment = { protocol: 'intent-v1', releases: catalog.releases };
  }
  const manifest = Buffer.from(JSON.stringify(release, null, 2) + '\n');
  if (format === 2) {
    const approved = validateSignedEnrollmentRelease({ release, manifestSha256: hex(manifest) });
    for (const [platform, asset] of Object.entries(approved.releases)) {
      const url = new URL(asset.url);
      const expected = `devspace-fleet-${asset.version}-${platform}.${platform === 'windows-x64' ? 'zip' : 'tgz'}`;
      if (/(^|\.)invalid$/.test(url.hostname) || basename(url.pathname) !== expected) {
        throw new Error(`${platform}: publish to the canonical versioned HTTPS archive name before signing`);
      }
    }
    for (const [platform, asset] of Object.entries(approved.releases)) {
      await verifyPublishedArchive(platform, asset, (url, init) => request(url, { ...init, credentials: 'omit' }), { intent: true });
    }
  }

  const key = createPrivateKey(await readPrivateFile(keyFile));
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Expected Nodrelay Ed25519 publisher key');
  const signature = sign(null, manifest, key);
  const publicKey = await crypto.subtle.importKey('spki',
    createPublicKey(key).export({ type: 'spki', format: 'der' }), { name: 'Ed25519' }, false, ['verify']);
  await verifyUpgradeRelease({ manifest, signature, bundle, publicKey, channel, currentVersion: minimumVersion, now: issued, format });
  await mkdir(output, { mode: 0o700 });
  for (const [filename, bytes] of [['manifest.json', manifest], ['manifest.json.sig', signature], ['worker.js', bundle]]) {
    await writeFile(join(output, filename), bytes, { flag: 'wx' });
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { 'enrollment-catalog': { type: 'string' } } });
  if (positionals.length !== 6) {
    throw new Error('Usage: node packaging/sign-web-upgrade.mjs WORKER_JS PRIVATE_KEY VERSION MINIMUM_VERSION CHANNEL NEW_DIRECTORY [--enrollment-catalog RELEASE_JSON]');
  }
  const [worker, keyFile, version, minimumVersion, channel, output] = positionals;
  await signWebUpgrade({ worker, keyFile, version, minimumVersion, channel, output, enrollmentCatalog: values['enrollment-catalog'] });
}

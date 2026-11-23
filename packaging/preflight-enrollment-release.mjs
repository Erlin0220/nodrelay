// Offline check of reviewed native assets; never performs signing or deployment.
import { createHash } from 'node:crypto';
import { openAsBlob } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { supportedEnrollmentTargets } from '../cloud/device-paths.mjs';
import { mergeEnrollmentBootstrapHistory } from '../cloud/enrollment-bootstrap.mjs';
import { validateReleaseCatalog } from '../src/setup-core.mjs';
import { verifyPublishedArchive } from './release-archive.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const manifestFile = process.argv[2];
const historyFile = process.argv[3];
if (!manifestFile || process.argv.length > 4) throw new Error('Usage: node packaging/preflight-enrollment-release.mjs RELEASE_JSON [PREVIOUS_APPROVED_HISTORY_JSON]');

const releaseDir = dirname(resolve(manifestFile));
const input = JSON.parse(await readFile(manifestFile, 'utf8'));
const releases = validateReleaseCatalog(input.releases);
const previous = historyFile ? JSON.parse(await readFile(historyFile, 'utf8')) : {};
const history = mergeEnrollmentBootstrapHistory(previous, releases);
if (!supportedEnrollmentTargets.every(platform => Object.hasOwn(releases, platform))) {
  throw new Error('The enrollment preflight requires all currently supported native targets');
}
if (input.workerBundle !== './worker.js' || hash(await readFile(join(releaseDir, 'worker.js'))) !== input.workerSha256) {
  throw new Error('The local Worker bundle differs from the reviewed manifest');
}

for (const [platform, asset] of Object.entries(releases)) {
  if (!asset.url) throw new Error(`${platform}: intent flow requires a hosted archive`);
  const filename = basename(new URL(asset.url).pathname);
  const expectedFilename = `devspace-fleet-${asset.version}-${platform}.${platform === 'windows-x64' ? 'zip' : 'tgz'}`;
  if (filename !== expectedFilename) throw new Error(`${platform}: use the canonical versioned release filename`);
  const archive = join(releaseDir, filename);
  if (!(await lstat(archive)).isFile()) throw new Error(`${platform}: expected a local regular archive file`);

  await verifyPublishedArchive(platform, asset, async url => {
    if (url.href !== asset.url) throw new Error('Unexpected source identifier; no network permitted');
    return new Response((await openAsBlob(archive)).stream());
  }, { intent: true });
  console.log(`${platform}: SHA-256, metadata, and exact enrollment client/installer sources verified offline`);
}
console.log(`Approved history has ${Object.values(history).reduce((count, versions) => count + Object.keys(versions).length, 0)} immutable OS/version entries after merge.`);
console.log('Preflight is not a signature, publication, availability, native execution or hosting retention check.');

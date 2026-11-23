import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { validateReleaseCatalog } from '../src/setup-core.mjs';
import { verifyPublishedArchive } from './release-archive.mjs';

const exec = promisify(execFile);
const packer = new URL('./pack.mjs', import.meta.url);
const shaPattern = /^[a-f0-9]{64}$/;

async function sha256(stream) {
  const hash = createHash('sha256');
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
}

async function build(spec, output) {
  const base = new URL(spec.downloadBase);
  if (!base.href.endsWith('/') || base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) {
    throw new Error('Supply a directory-style HTTPS downloadBase for the versioned archives');
  }
  if (!isAbsolute(spec.workerBundle ?? '') || !/^[0-9][A-Za-z0-9._-]{0,39}$/.test(spec.version ?? '')) {
    throw new Error('Supply an absolute Worker bundle path and a release version');
  }
  const planned = Object.fromEntries(Object.keys(spec.platforms ?? {}).map(platform => {
    const file = `devspace-fleet-${spec.version}-${platform}.${platform === 'windows-x64' ? 'zip' : 'tgz'}`;
    return [platform, { url: new URL(file, base).href, version: spec.version, sha256: '0'.repeat(64) }];
  }));
  validateReleaseCatalog(planned);
  const parent = dirname(output);
  await mkdir(parent, { recursive: true });
  const stage = await mkdtemp(join(parent, '.fleet-release-'));
  try {
    const releases = {};
    const hashes = [];
    await cp(spec.workerBundle, join(stage, 'worker.js'), { force: false, errorOnExist: true });
    const workerSha256 = await sha256(createReadStream(join(stage, 'worker.js')));
    hashes.push([workerSha256, 'worker.js']);
    const workerNotice = 'worker-jose-license.txt';
    await cp(fileURLToPath(new URL('../licenses/jose.txt', import.meta.url)), join(stage, workerNotice));
    hashes.push([await sha256(createReadStream(join(stage, workerNotice))), workerNotice]);
    // The management console served by the Worker embeds Tabler Icons.
    const iconNotice = 'worker-tabler-icons-license.txt';
    await cp(fileURLToPath(new URL('../licenses/tabler-icons.txt', import.meta.url)), join(stage, iconNotice));
    hashes.push([await sha256(createReadStream(join(stage, iconNotice))), iconNotice]);
    for (const [platform, payload] of Object.entries(spec.platforms)) {
      for (const field of ['nodeSha256', 'cloudflaredSha256']) {
        if (!shaPattern.test(payload[field] ?? '')) throw new Error(`${platform} requires independently reviewed binary hashes`);
      }
      for (const field of ['nodeLicense', 'cloudflaredLicense']) {
        if (typeof payload[field] !== 'string' || !isAbsolute(payload[field])) {
          throw new Error(`${platform} requires an absolute path to its upstream ${field} notice`);
        }
      }
      const file = basename(new URL(planned[platform].url).pathname);
      const manifest = join(stage, 'pack.json');
      await writeFile(manifest, JSON.stringify({ ...payload, platform, version: spec.version, output: join(stage, file), localInstaller: true }), { mode: 0o600 });
      const { stdout } = await exec(process.execPath, [fileURLToPath(packer), manifest]);
      await rm(manifest);
      const packed = JSON.parse(stdout);
      releases[platform] = { ...planned[platform], sha256: packed.sha256, browser: packed.browser };
      hashes.push([packed.sha256, file], [packed.installerSha256, packed.installer]);
    }
    await writeFile(join(stage, 'release.json'), JSON.stringify({
      workerBundle: './worker.js', workerSha256, releases: validateReleaseCatalog(releases),
    }, null, 2) + '\n');
    await writeFile(join(stage, 'SHA256SUMS'), hashes.map(([hash, name]) => `${hash}  ${name}\n`).join(''));
    await mkdir(output);
    for (const [, file] of hashes) await rename(join(stage, file), join(output, file));
    await rename(join(stage, 'SHA256SUMS'), join(output, 'SHA256SUMS'));
    await rename(join(stage, 'release.json'), join(output, 'release.json'));
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

const { values, positionals } = parseArgs({ allowPositionals: true, options: { 'verify-published': { type: 'boolean' } } });
if (values['verify-published'] ? positionals.length !== 1 : positionals.length !== 2) {
  throw new Error('Usage: npm run pack:release -- manifest.json NEW_OUTPUT or --verify-published release.json');
}
const manifest = JSON.parse(await readFile(resolve(positionals[0]), 'utf8'));
if (values['verify-published']) {
  for (const [platform, asset] of Object.entries(validateReleaseCatalog(manifest.releases))) {
    await verifyPublishedArchive(platform, asset);
    console.log(`${platform}: anonymous HTTPS download, SHA-256 and archive metadata verified`);
  }
} else {
  const output = resolve(positionals[1]);
  await build(manifest, output);
  console.log(join(output, 'release.json'));
}

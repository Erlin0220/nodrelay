import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const maximumArchiveBytes = 1024 ** 3;
const archiveInspectionOptions = { timeout: 60000 };
export const browserEntryPoints = ['setup.mjs', 'preflight.mjs'];
export const tarOwnership = process.platform === 'linux'
  ? ['--numeric-owner', '--owner=0', '--group=0']
  : ['--uid=0', '--gid=0', '--uname=', '--gname='];

async function downloadArchive(asset, output, request, maxBytes) {
  let url = new URL(asset.url);
  const signal = AbortSignal.timeout(300000);
  for (let hops = 0; hops <= 5; hops++) {
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Archive redirect must preserve HTTPS without embedded credentials');
    const response = await request(url, { redirect: 'manual', credentials: 'omit', signal });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('Location');
      await response.body?.cancel();
      if (!location) break;
      url = new URL(location, url);
      continue;
    }
    if (response.status !== 200 || !response.body) {
      await response.body?.cancel();
      throw new Error('Release archive is unavailable to unauthenticated devices');
    }
    const oversize = () => new Error('Release archive exceeds the compressed download size limit');
    if (Number(response.headers.get('Content-Length')) > maxBytes) {
      await response.body.cancel();
      throw oversize();
    }
    const hash = createHash('sha256');
    let downloaded = 0;
    const hashChunks = new Transform({ transform(chunk, _encoding, done) {
      downloaded += chunk.length;
      if (downloaded > maxBytes) return done(oversize());
      hash.update(chunk);
      done(null, chunk);
    } });
    await pipeline(response.body, hashChunks, createWriteStream(output, { flags: 'wx', mode: 0o600 }), { signal });
    if (hash.digest('hex') !== asset.sha256) throw new Error('Published archive differs from the pinned SHA-256');
    return;
  }
  throw new Error('Archive exceeded the allowed redirect limit');
}

async function inspectArchive(platform, asset, filename, zip, intent) {
  const useUnzip = zip && process.platform !== 'win32';
  const command = useUnzip ? 'unzip' : process.platform === 'win32' ? 'tar.exe' : 'tar';
  // GNU tar warns for each macOS/libarchive PAX provenance header. A valid
  // release can exceed execFile's stderr limit before the manifest is returned.
  // Suppress only that warning category; keep all tar errors and exit status.
  const prefix = !useUnzip && process.platform === 'linux' ? ['--warning=no-unknown-keyword'] : [];
  const inspect = (args, options) => exec(command, [...prefix, ...args], { ...archiveInspectionOptions, ...options });
  const { stdout } = await inspect([useUnzip ? '-Z1' : '-tf', filename], { maxBuffer: 8 * 1024 * 1024 });
  const entries = new Map();
  for (const name of stdout.split(/\r?\n/).filter(Boolean)) {
    const logical = name.replace(/^\.\//, '');
    if (!entries.has(logical)) entries.set(logical, []);
    entries.get(logical).push(name);
  }
  const requireEntry = name => {
    const found = entries.get(name);
    if (found?.length !== 1 || entries.has(name + '/')) throw new Error(`Release archive needs exactly one ${name}`);
    return found[0];
  };
  const manifest = requireEntry('bundle.json');
  const metadata = await inspect([useUnzip ? '-p' : '-xOf', filename, manifest], { maxBuffer: 32768 });
  const { schema, platform: target, version, browser } = JSON.parse(metadata.stdout);
  if (schema !== 1) throw new Error('Published archive has an unsupported bundle schema');
  if (target !== platform) throw new Error('Published archive platform differs from the release catalog');
  if (version !== asset.version) throw new Error('Published archive version differs from the release catalog');
  if (browser !== asset.browser) throw new Error('Published archive browser capability differs from the release catalog');
  for (const entry of [zip ? 'install.ps1' : 'install.sh', zip ? 'bin/node.exe' : 'bin/node',
    zip ? 'bin/cloudflared.exe' : 'bin/cloudflared', 'fleet/src/install-device.mjs', 'personal/dist/server.js']) requireEntry(entry);
  if (intent) {
    for (const [entry, path] of [
      ['fleet/src/enrollment-claim-client.mjs', '../src/enrollment-claim-client.mjs'],
      ['fleet/src/install-device.mjs', '../src/install-device.mjs'],
      [zip ? 'install.ps1' : 'install.sh', zip ? './install.ps1' : './install.sh'],
    ]) {
      const embedded = await inspect([useUnzip ? '-p' : '-xOf', filename, requireEntry(entry)],
        { encoding: 'buffer', maxBuffer: 1048576 });
      if (!embedded.stdout.equals(await readFile(new URL(path, import.meta.url)))) {
        throw new Error(`Published archive contains a stale ${entry}`);
      }
    }
  }
  for (const entry of browserEntryPoints.map(name => 'browser/' + name)) {
    if (browser) requireEntry(entry);
    else if (entries.has(entry) || entries.has(entry + '/')) throw new Error('A development-only archive contains a browser companion entry point');
  }
}

export async function verifyPublishedArchive(platform, asset, request = fetch, { intent = false, maxBytes = maximumArchiveBytes } = {}) {
  if (!asset.url) throw new Error('This entry refers to a pre-staged local archive');
  const temporary = await mkdtemp(join(tmpdir(), 'nodrelay-release-check-'));
  const zip = platform.startsWith('windows-');
  const output = join(temporary, zip ? 'archive.zip' : 'archive.tgz');
  try {
    await downloadArchive(asset, output, request, maxBytes);
    await inspectArchive(platform, asset, output, zip, intent);
  } catch (error) {
    throw new Error(`${platform}: ${error.message}`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

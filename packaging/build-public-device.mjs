import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { openAsBlob, createReadStream } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { verifyPublishedArchive } from './release-archive.mjs';

const run = promisify(execFile);
const nodeVersion = '24.22.3';
// Node.js vendor release archive digests and prior signed Nodrelay device catalog pins.
const inputs = {
  'macos-arm64': ['darwin-arm64', 'tgz', 'ff6e17d4874b76d272212b908cc020d6e815fba5a6c7eaaa06add725840307fd', 'debff1e147751192740e6acf87f622b66b3724f67a3979c26165c88ff35fefa2'],
  'windows-x64': ['win-x64', 'zip', 'e612af99f626ab415ea225af6bce5c971feb448cb5cae250bb1c3fa50c5f7d9f', '1c4a530a490bc12da0a848c874b16a6c51fd24f80cebde9f1eb2d9558c2c879b'],
  'linux-x64': ['linux-x64', 'tgz', '061ec3e3062115705b56b51fa9cc330ab50d34b6969387d4e4b1a50c6809acc2', '5574eb116452645baf88ab4b859bdf9c3a144eb3d502071728ac564a60601f7d'],
};
const [target, version, outputArg, ...extra] = process.argv.slice(2);
const actual = ({ darwin: 'macos', win32: 'windows', linux: 'linux' })[process.platform] + '-' + process.arch;
if (!Object.hasOwn(inputs, target) || target !== actual || !/^0\.[1-9]\d{0,2}\.(?:0|[1-9]\d{0,2})-preview\.[1-9]\d{0,3}$/.test(version ?? '') ||
    !outputArg || extra.length) throw new Error('Expected a native target, explicit preview version and new output directory');
const [nodeTarget, suffix, nodeHash, previousHash] = inputs[target];
const nodeFolder = 'node-v' + nodeVersion + '-' + nodeTarget;
const windows = process.platform === 'win32';
const macos = process.platform === 'darwin';
const nodeArchive = nodeFolder + (windows ? '.zip' : '.tar.gz');
const previousName = 'devspace-fleet-0.1.0-' + target + '.' + suffix;
const output = resolve(outputArg);
const temp = await mkdtemp(join(tmpdir(), 'nodrelay-public-build-'));
async function digest(path) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest('hex');
}
async function fetchPinned(url, name, sha) {
  const file = join(temp, name);
  await run(windows ? 'curl.exe' : 'curl', [
    '--disable', '--fail', '--show-error', '--silent', '--location', '--max-redirs', '5',
    '--connect-timeout', '20', '--max-time', '300', '--retry', '2',
    '--max-filesize', '536870912', '--proto', '=https', '--proto-redir', '=https',
    '--output', file, url,
  ], { timeout: 660000 });
  if (await digest(file) !== sha) throw new Error(name + ' SHA-256 does not match its reviewed input pin');
  return file;
}
try {
  const [vendor, previous] = await Promise.all([
    fetchPinned('https://nodejs.org/dist/v' + nodeVersion + '/' + nodeArchive, nodeArchive, nodeHash),
    fetchPinned('https://github.com/Erlin0220/nodrelay-downloads/releases/download/v0.1.0/' + previousName, previousName, previousHash),
  ]);
  const upstream = join(temp, 'upstream'), legacy = join(temp, 'legacy');
  await Promise.all([mkdir(upstream), mkdir(legacy)]);
  const tar = windows ? 'tar.exe' : 'tar';
  const quietPax = process.platform === 'linux' ? ['--warning=no-unknown-keyword'] : [];
  await run(tar, ['-xf', vendor, '-C', upstream], { timeout: 120000 });
  await run(tar, [...quietPax, '-xf', previous, '-C', legacy], { timeout: 240000 });
  const node = join(upstream, nodeFolder, ...(windows ? ['node.exe'] : ['bin', 'node']));
  const cloudflared = join(legacy, 'bin', windows ? 'cloudflared.exe' : 'cloudflared');
  const personal = join(legacy, 'personal');
  const license = join(legacy, 'licenses');
  const { stdout: v } = await run(node, ['--version'], { timeout: 15000 });
  if (v.trim() !== 'v' + nodeVersion) throw new Error('Vendor binary reports an unexpected Node.js version');
  await copyFile(join(license, 'personal-devspace.txt'), join(personal, 'LICENSE'));
  if (!macos) {
    const platformModule = join(personal, 'personal', 'desktop', 'platform.mjs');
    const source = await readFile(platformModule, 'utf8');
    if (source.includes('\r\n')) await writeFile(platformModule, source.replaceAll('\r\n', '\n'));
    const patch = resolve('packaging', windows ? 'windows-personal-payload.patch' : 'linux-personal-payload.patch');
    const reverse = ['-c', 'core.autocrlf=false', 'apply', '--reverse', '--whitespace=error'];
    await run('git', [...reverse, '--check', patch], { cwd: legacy });
    await run('git', [...reverse, patch], { cwd: legacy });
  }

  await mkdir(output);
  const filename = 'devspace-fleet-' + version + '-' + target + '.' + suffix;
  const archive = join(output, filename);
  const spec = join(temp, 'pack.json');
  await writeFile(spec, JSON.stringify({
    platform: target, version, output: archive, node, nodeSha256: await digest(node),
    cloudflared, cloudflaredSha256: await digest(cloudflared), personal, localInstaller: true,
    nodeLicense: join(upstream, nodeFolder, 'LICENSE'), cloudflaredLicense: join(license, 'cloudflared.txt'),
  }), { flag: 'wx', mode: 0o600 });
  const { stdout } = await run(process.execPath, ['packaging/pack.mjs', spec], { timeout: 240000 });
  const packed = JSON.parse(stdout);
  const url = 'https://artifacts.invalid/' + filename;
  await verifyPublishedArchive(target, { url, version, sha256: packed.sha256, browser: false },
    async got => {
      if (got.href !== url) throw new Error('Unexpected network URL in offline archive preflight');
      return new Response((await openAsBlob(archive)).stream());
    }, { intent: true });
  if (await digest(join(output, packed.installer)) !== packed.installerSha256) throw new Error('Installer checksum changed after packing');
  await writeFile(join(output, 'SHA256SUMS'),
    packed.sha256 + '  ' + filename + '\n' + packed.installerSha256 + '  ' + packed.installer + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ source: process.env.GITHUB_SHA, ...packed }));
} finally {
  await rm(temp, { recursive: true, force: true });
}

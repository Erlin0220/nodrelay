import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { access, chmod, cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { targetPlatforms } from '../src/setup-core.mjs';
import { localInstallerName, writeLocalInstaller } from './local-installer.mjs';
import { verifyNativeTarget } from './native-target.mjs';
import { browserEntryPoints, tarOwnership } from './release-archive.mjs';

const exec = promisify(execFile);
const input = process.argv[2];
if (!input) throw new Error('Supply the reviewed packaging manifest path');
const spec = JSON.parse(await readFile(input, 'utf8'));
const windows = spec.platform?.startsWith('windows-');
const linux = spec.platform?.startsWith('linux-');
if (!targetPlatforms.includes(spec.platform) ||
    !/^[0-9][A-Za-z0-9._-]{0,39}$/.test(spec.version ?? '') ||
    [spec.node, spec.cloudflared, spec.personal, spec.output, ...(spec.browser ? [spec.browser] : [])]
      .some(path => typeof path !== 'string' || !isAbsolute(path)) ||
    !(windows ? spec.output.endsWith('.zip') : spec.output.endsWith('.tgz'))) {
  throw new Error('Supply platform, version, absolute verified payload paths and the platform archive extension');
}
if (await access(spec.output).then(() => true, () => false)) throw new Error('Use a new versioned archive path');
if (spec.localInstaller === true) {
  const installer = localInstallerName(spec.platform, basename(spec.output));
  if (await access(join(dirname(spec.output), installer)).then(() => true, () => false)) throw new Error('Use a new local installer path');
}
if (spec.browser) {
  for (const file of browserEntryPoints) {
    if (!await lstat(join(spec.browser, file)).then(entry => entry.isFile(), () => false)) {
      throw new Error(`The browser companion needs a regular ${file}`);
    }
  }
}
async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

const root = fileURLToPath(new URL('../', import.meta.url));
const excludedWindowsDependencies = [
  ['@anthropic-ai', 'claude-agent-sdk'],
  ['@anthropic-ai', 'claude-agent-sdk-win32-x64'],
  ['@mariozechner', 'clipboard'],
  ['@mariozechner', 'clipboard-win32-x64-msvc'],
];
// node-pty's generated makefiles contain absolute paths from the build host.
// The runtime loads the compiled binding without these files.
const linuxBuildOnlyFiles = [
  'build/Makefile', 'build/pty.target.mk', 'build/config.gypi',
  'node-addon-api/node_addon_api_maybe.target.mk', 'node-addon-api/node_addon_api.target.mk',
  'node-addon-api/node_addon_api_except.target.mk',
];
const stage = await mkdtemp(join(tmpdir(), 'fleet-package-'));
try {
  await mkdir(join(stage, 'bin'));
  await mkdir(join(stage, 'fleet'));
  await mkdir(join(stage, 'personal'));
  for (const name of ['node', 'cloudflared']) {
    const destination = join(stage, 'bin', windows ? name + '.exe' : name);
    await cp(await realpath(spec[name]), destination);
    const approved = spec[name + 'Sha256'];
    if (approved !== undefined && (!/^[a-f0-9]{64}$/.test(approved) || await sha256(destination) !== approved)) {
      throw new Error(name + ' differs from the approved binary SHA-256');
    }
    await verifyNativeTarget(destination, spec.platform, name);
  }
  if (!windows) for (const file of ['node', 'cloudflared']) await chmod(join(stage, 'bin', file), 0o755);
  for (const file of ['src', 'cloud', 'LICENSE', 'package.json', 'node_modules']) {
    await cp(join(root, file), join(stage, 'fleet', file), { recursive: true, verbatimSymlinks: true });
  }
  for (const file of ['dist', 'node_modules', 'package.json']) {
    await cp(join(spec.personal, file), join(stage, 'personal', file), {
      recursive: true, verbatimSymlinks: true,
      filter: source => !windows || !excludedWindowsDependencies.some(parts =>
        source.endsWith(sep + ['node_modules', ...parts].join(sep))),
    });
  }
  for (const file of ['assets', 'bin', 'desktop', 'upstream.json', 'artifact.mjs', 'bin.mjs', 'build-native.mjs',
    'config.mjs', 'gc.mjs', 'install.mjs', 'legacy-import.mjs', 'ownership.mjs', 'runtime.mjs', 'state.mjs',
    'upgrade.mjs', 'upstream.mjs', 'verification.mjs', 'verify.mjs']) {
    await cp(join(spec.personal, 'personal', file), join(stage, 'personal', 'personal', file), { recursive: true, verbatimSymlinks: true });
  }
  if (windows || linux) {
    const patchName = windows ? 'windows-personal-payload.patch' : 'linux-personal-payload.patch';
    const patch = fileURLToPath(new URL('./' + patchName, import.meta.url));
    if (linux) {
      const pty = join(stage, 'personal', 'node_modules', 'node-pty');
      const personalBin = join(stage, 'personal', 'personal', 'bin');
      const windowsHelpers = ['personal-launcher.exe', 'personal-devspace-tray.exe'];
      await Promise.all([
        ...linuxBuildOnlyFiles.map(file => rm(join(pty, file), { force: true })),
        ...windowsHelpers.map(file => rm(join(personalBin, file), { force: true })),
      ]);
      const platformModule = join(stage, 'personal', 'personal', 'desktop', 'platform.mjs');
      const source = await readFile(platformModule, 'utf8');
      if (source.includes('\r\n')) await writeFile(platformModule, source.replaceAll('\r\n', '\n'));
    }
    await exec('git', ['apply', '--whitespace=error', patch], { cwd: stage });
    if (linux) {
      const manifest = join(stage, 'personal', 'node_modules', '@earendil-works', 'pi-coding-agent', 'package.json');
      const pi = await readFile(manifest, 'utf8').catch(error => {
        if (error.code !== 'ENOENT') throw error;
        return '{}';
      });
      if (JSON.parse(pi).version === '1.5.2') {
        const compiled = join(stage, 'personal', 'dist', 'local-agent-pi.js');
        const source = await readFile(compiled, 'utf8');
        if (source.includes('\r\n')) await writeFile(compiled, source.replaceAll('\r\n', '\n'));
        const migration = fileURLToPath(new URL('./linux-personal-pi-runtime.patch', import.meta.url));
        const alreadyMigrated = await exec('git', ['apply', '--reverse', '--check', migration], { cwd: stage })
          .then(() => true, () => false);
        if (!alreadyMigrated) await exec('git', ['apply', '--whitespace=error', migration], { cwd: stage });
      }
    }
    const upstreamPath = join(stage, 'personal', 'personal', 'upstream.json');
    const upstream = JSON.parse(await readFile(upstreamPath, 'utf8'));
    delete upstream.desktopSnapshot;
    await writeFile(upstreamPath, JSON.stringify(upstream, null, 2) + '\n');
  }
  if (spec.browser) {
    await cp(spec.browser, join(stage, 'browser'), { recursive: true, verbatimSymlinks: true });
  }
  if (spec.nodeLicense || spec.cloudflaredLicense) {
    const notices = join(stage, 'licenses');
    await mkdir(notices);
    await cp(spec.nodeLicense, join(notices, 'node.txt'));
    await cp(spec.cloudflaredLicense, join(notices, 'cloudflared.txt'));
    await cp(join(spec.personal, 'LICENSE'), join(notices, 'personal-devspace.txt'));
  }
  const installer = windows ? 'install.ps1' : 'install.sh';
  await cp(join(root, 'packaging', installer), join(stage, installer));
  await writeFile(join(stage, 'bundle.json'), JSON.stringify({
    schema: 1, platform: spec.platform, version: spec.version, browser: Boolean(spec.browser),
  }));
  await mkdir(dirname(spec.output), { recursive: true });
  const options = { cwd: stage, maxBuffer: 262144, env: { ...process.env, COPYFILE_DISABLE: '1' } };
  if (windows && process.platform === 'win32') await exec('tar.exe', ['-caf', spec.output, ...tarOwnership, '.'], options);
  else if (windows) await exec('zip', ['-Xqr', spec.output, '.'], options);
  else await exec('tar', ['-czf', spec.output, ...tarOwnership, '.'], options);
  const digest = await sha256(spec.output);
  const localInstaller = spec.localInstaller === true ? await writeLocalInstaller(spec.platform, spec.output, digest) : {};
  console.log(JSON.stringify({ platform: spec.platform, version: spec.version, file: basename(spec.output),
    browser: Boolean(spec.browser), sha256: digest, ...localInstaller }, null, 2));
} finally {
  await rm(stage, { recursive: true, force: true });
}

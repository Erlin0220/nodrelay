import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readlink, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { renderLocalInstaller } from '../packaging/local-installer.mjs';
import { stageDeviceRelease } from '../src/install-device.mjs';

const sha = 'a'.repeat(64);

test('each local installer pins the archive before extraction and supports same-version repair', async () => {
  for (const [platform, extension, command, extract, ticketPrompt] of [
    ['macos-arm64', 'tgz', 'sh', 'tar -xzf', 'stty -echo'],
    ['linux-x64', 'tgz', 'sh', 'tar -xzf', 'stty -echo'],
    ['windows-x64', 'zip', 'ps1', 'Expand-Archive', '-AsSecureString'],
  ]) {
    const archive = `nodrelay-0.1.0-${platform}.${extension}`;
    const { name, body } = await renderLocalInstaller(platform, archive, sha);
    assert.equal(name, `install-nodrelay-0.1.0-${platform}.${command}`);
    assert.ok(body.includes(archive));
    assert.ok(body.includes(sha) && body.indexOf(sha) < body.indexOf(extract));
    assert.ok(body.includes('--repair') && body.includes(ticketPrompt));
    assert.doesNotMatch(body, /@ARCHIVE@|@SHA256@/);
  }
});

test('local installer rejects unsafe archive names and incomplete hashes', async () => {
  for (const archive of ['../release.tgz', "bad'archive.tgz", 'windows.zip']) {
    await assert.rejects(renderLocalInstaller('linux-x64', archive, sha), /portable archive filename/);
  }
  await assert.rejects(renderLocalInstaller('linux-x64', 'release.tgz', 'bad'), /SHA-256/);
});

test('repair without a local installation refuses before creating state or redeeming a ticket', async t => {
  const home = await mkdtemp(join(tmpdir(), 'nodrelay-repair-test-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const os = { darwin: 'macos', linux: 'linux', win32: 'windows' }[process.platform];
  await writeFile(join(home, 'bundle.json'), JSON.stringify({ schema: 1, version: '1.0.0', platform: os + '-' + process.arch }));
  const installer = fileURLToPath(new URL('../src/install-device.mjs', import.meta.url));
  const run = promisify(execFile);
  await assert.rejects(run(process.execPath, [installer, home, '--repair'], {
    env: { ...process.env, HOME: home, USERPROFILE: home, DEVSPACE_FLEET_MANAGER: 'https://repair.example.invalid',
      DEVSPACE_FLEET_DEVICE: 'fixture-device', DEVSPACE_FLEET_TICKET: '' },
    timeout: 5000,
  }), /Same-version repair requires the existing local installation and credentials/);
  await assert.rejects(access(join(home, '.devspace-fleet')), { code: 'ENOENT' });
});

test('Linux refuses a missing user service manager before consuming any enrollment or writing device state', {
  skip: process.platform !== 'linux', timeout: 10000,
}, async t => {
  const home = await mkdtemp(join(tmpdir(), 'nodrelay-user-manager-test-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const bin = join(home, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'systemctl'), '#!/bin/sh\nprintf "%s\\n" "$*" > "$HOME/systemd-probe"\necho PRIVATE-FIXTURE-DIAGNOSTIC >&2\nexit 1\n', { mode: 0o700 });
  await writeFile(join(home, 'bundle.json'), JSON.stringify({ schema: 1, version: '1.0.0', platform: 'linux-' + process.arch }));
  const installer = fileURLToPath(new URL('../src/install-device.mjs', import.meta.url));
  await assert.rejects(promisify(execFile)(process.execPath, [installer, home], {
    env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`,
      DEVSPACE_FLEET_MANAGER: 'https://test.example.invalid', DEVSPACE_FLEET_DEVICE: 'fixture-device',
      DEVSPACE_FLEET_TICKET: 'x'.repeat(43) }, timeout: 5000,
  }), error => {
    assert.match(error.stderr, /systemd user service is unavailable.*while signed in/i);
    assert.doesNotMatch(error.stderr, /PRIVATE-FIXTURE-DIAGNOSTIC/);
    return true;
  });
  await access(join(home, 'systemd-probe'));
  await assert.rejects(access(join(home, '.devspace-fleet')), { code: 'ENOENT' });
});


test('installer stops at an occupied fixed port before creating state or claiming enrollment', {
  skip: process.platform === 'win32', timeout: 10000,
}, async t => {
  const home = await mkdtemp(join(tmpdir(), 'nodrelay-port-preflight-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const bin = join(home, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'systemctl'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const platform = process.platform === 'darwin' ? 'macos' : 'linux';
  await writeFile(join(home, 'bundle.json'), JSON.stringify({
    schema: 1, version: '1.0.0', platform: platform + '-' + process.arch,
  }));
  const occupied = createServer();
  const ours = await new Promise((resolve, reject) => {
    occupied.once('error', error => error.code === 'EADDRINUSE' ? resolve(false) : reject(error));
    occupied.listen(7829, '127.0.0.1', () => resolve(true));
  });
  if (ours) t.after(() => new Promise(resolve => occupied.close(resolve)));
  const preload = join(home, 'fetch-guard.mjs');
  await writeFile(preload, `globalThis.fetch = async () => {
    console.error('FIXTURE_NETWORK_ATTEMPT'); throw Error('Unexpected attempt');
  };`);
  const installer = fileURLToPath(new URL('../src/install-device.mjs', import.meta.url));
  await assert.rejects(promisify(execFile)(process.execPath, ['--import', preload, installer, home], {
    env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`,
      DEVSPACE_FLEET_MANAGER: 'https://test.example.invalid', DEVSPACE_FLEET_DEVICE: 'fixture-device',
      DEVSPACE_FLEET_TICKET: 'x'.repeat(43) }, timeout: 5000,
  }), error => {
    assert.match(error.stdout, /1\/5 检查/);
    assert.doesNotMatch(error.stdout, /2\/5/);
    assert.match(error.stderr, /7829（MCP）.*安装未领取设备票据/);
    assert.doesNotMatch(error.stderr, /FIXTURE_NETWORK_ATTEMPT/);
    return true;
  });
  await assert.rejects(access(join(home, '.devspace-fleet')), { code: 'ENOENT' });
  if (ours) assert.equal(occupied.listening, true);
});

test('installed npm links still resolve after the extracted device archive is removed', {
  skip: process.platform === 'win32',
}, async t => {
  const home = await mkdtemp(join(tmpdir(), 'nodrelay-device-copy-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const source = join(home, 'extracted');
  const release = join(home, 'release-1.0.0');
  const manifest = { schema: 1, version: '1.0.0' };
  const modules = join(source, 'personal', 'node_modules');
  await mkdir(join(modules, '.bin'), { recursive: true });
  await mkdir(join(modules, 'example'));
  await writeFile(join(source, 'bundle.json'), JSON.stringify(manifest));
  await writeFile(join(modules, 'example', 'cli.js'), 'bundled CLI');
  await symlink('../example/cli.js', join(modules, '.bin', 'example'));
  await stageDeviceRelease(source, release, manifest);
  await rm(source, { recursive: true });
  const installed = join(release, 'personal', 'node_modules', '.bin', 'example');
  assert.equal(await readlink(installed), '../example/cli.js');
  assert.equal(await readFile(installed, 'utf8'), 'bundled CLI');
  await stageDeviceRelease(source, release, manifest);
  await assert.rejects(stageDeviceRelease(source, release, { ...manifest, browser: true }), /different local payload/);
});

test('a failed stage promotion leaves the existing directory intact and clears its temporary copy', async t => {
  const home = await mkdtemp(join(tmpdir(), 'nodrelay-device-stage-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const source = join(home, 'extracted');
  const release = join(home, 'release-1.0.0');
  const manifest = { schema: 1, version: '1.0.0' };
  await mkdir(source);
  await mkdir(release);
  await writeFile(join(release, 'existing.txt'), 'preserve');
  await writeFile(join(source, 'bundle.json'), JSON.stringify(manifest));
  await assert.rejects(stageDeviceRelease(source, release, manifest));
  assert.equal(await readFile(join(release, 'existing.txt'), 'utf8'), 'preserve');
  assert.deepEqual((await readdir(home)).sort(), ['extracted', 'release-1.0.0']);
});

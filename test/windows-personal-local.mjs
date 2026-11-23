import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { setTimeout as wait } from 'node:timers/promises';
import test from 'node:test';
import { preparePersonal } from '../src/prepare-personal.mjs';

const exec = promisify(execFile);
test('isolated Windows Personal Runtime starts at least privilege without replacing shortcuts', {
  skip: process.platform !== 'win32' || !process.env.FLEET_TEST_WINDOWS_PAYLOAD,
  timeout: 90000,
}, async t => {
  const runtime = resolve(process.env.FLEET_TEST_WINDOWS_PAYLOAD);
  const fixture = await mkdtemp(join(tmpdir(), 'nodrelay-personal-test-'));
  const root = join(fixture, 'private');
  const home = join(root, 'personal');
  const { jobName, jobAction, taskXml, ownerId, normalizeJobOptions } = await import(pathToFileURL(join(runtime, 'personal/desktop/platform.mjs')));
  assert.deepEqual(normalizeJobOptions({ schema: 1 }), { runLevel: 'HighestAvailable', desktopEntries: true });
  assert.match(taskXml({ home, component: 'runtime', root: runtime, node: process.execPath, sid: 'S-1-5-0' }),
    /<RunLevel>HighestAvailable<\/RunLevel>/);
  assert.throws(() => normalizeJobOptions({ runLevel: null }), /Invalid installed/);
  assert.throws(() => normalizeJobOptions({ desktopEntries: 'false' }), /Invalid installed/);
  assert.throws(() => taskXml({runLevel: 'invalid'}), /run level/);
  const shortcuts = [join(homedir(), 'Desktop', 'Personal DevSpace.lnk'),
    join(process.env.APPDATA, 'Microsoft/Windows/Start Menu/Programs/Personal DevSpace.lnk')];
  const digest = async path => readFile(path).then(data => createHash('sha256').update(data).digest('hex'),
    error => { if (error.code === 'ENOENT') return null; throw error; });
  const before = await Promise.all(shortcuts.map(digest));
  t.after(async () => {
    for (const component of ['desktop', 'runtime']) {
      await jobAction(home, component, 'stop');
      await jobAction(home, component, 'remove');
    }
    await rm(fixture, { recursive: true, force: true });
    assert.deepEqual(await Promise.all(shortcuts.map(digest)), before);
  });
  await preparePersonal(runtime, root);
  const installedBefore = JSON.parse(await readFile(join(home, 'install.json'), 'utf8'));
  assert.equal(installedBefore.runLevel, 'LeastPrivilege');
  assert.equal(installedBefore.desktopEntries, false);
  const { operations } = await import(pathToFileURL(join(runtime, 'personal/desktop/main.mjs')));
  await operations(home).repair();
  const installedAfter = JSON.parse(await readFile(join(home, 'install.json'), 'utf8'));
  assert.equal(installedAfter.runLevel, 'LeastPrivilege');
  assert.equal(installedAfter.desktopEntries, false);
  for (const component of ['runtime', 'desktop']) {
    const name = jobName(home, component);
    const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `(Get-ScheduledTask -TaskName '${name}').Principal.RunLevel`]);
    assert.equal(stdout.trim(), 'Limited');
  }
  const { ownerToken } = JSON.parse(await readFile(join(home, 'runtime/auth.json'), 'utf8'));
  let ready = false;
  for (let n = 0; n < 40; n++) {
    ready = await fetch('http://127.0.0.1:7830/personal-healthz', { headers: { Authorization: `Bearer ${ownerToken}` },
      signal: AbortSignal.timeout(1000) }).then(async r => {
        if (!r.ok) return false;
        const health = await r.json();
        return health.name === 'personal-devspace' && health.owner === ownerId(home);
      }, () => false);
    if (ready) break;
    await wait(500);
  }
  assert.equal(ready, true, 'Dedicated Personal Runtime health endpoint');
});

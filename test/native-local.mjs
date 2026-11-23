import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { promisify } from 'node:util';
import test from 'node:test';
import { installService } from '../src/os-service.mjs';

const exec = promisify(execFile);

test('macOS installs and restarts a dedicated user service', {
  skip: process.platform !== 'darwin' || process.env.FLEET_TEST_NATIVE !== '1',
  timeout: 35000,
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'fleet-native-check-'));
  const label = 'devspace-fleet-' + randomBytes(6).toString('hex');
  const name = `gui/${process.getuid()}/${label}`;
  const plist = join(homedir(), 'Library', 'LaunchAgents', label + '.plist');
  const run = args => exec('/bin/launchctl', args, { timeout: 8000 });
  t.after(async () => {
    const contents = await readFile(plist, 'utf8').catch(() => '');
    if (contents.includes(label) && contents.includes(root)) {
      await run(['bootout', name]);
      await rm(plist, { force: true });
      let loaded = true;
      for (let attempt = 0; attempt < 30 && loaded; attempt++) {
        loaded = await run(['print', name]).then(() => true, () => false);
        if (loaded) await wait(200);
      }
      assert.equal(loaded, false);
    }
    await rm(root, { recursive: true, force: true });
  });

  const worker = join(root, 'worker.mjs');
  await writeFile(worker, `
import { appendFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
const [root] = process.argv.slice(2);
appendFileSync(join(root, 'started'), process.pid + '\\n');
setInterval(() => {
  const flag = join(root, 'crash');
  if (existsSync(flag)) { unlinkSync(flag); process.exit(1); }
}, 100);
`);
  const generations = async expected => {
    for (let n = 0; n < 100; n++) {
      const body = await readFile(join(root, 'started'), 'utf8').catch(() => '');
      const pids = body.trim().split(/\s+/).filter(Boolean);
      if (pids.length >= expected) return pids;
      await wait(250);
    }
    throw new Error('The dedicated test LaunchAgent did not reach the expected generation');
  };
  await installService(label, process.execPath, [worker, root], root);
  const [first] = await generations(1);
  await installService(label, process.execPath, [worker, root], root);
  await writeFile(join(root, 'crash'), '');
  const pids = await generations(2);
  assert.notEqual(pids[1], first);
  assert.equal((await run(['print', name])).stdout.includes(label), true);
});

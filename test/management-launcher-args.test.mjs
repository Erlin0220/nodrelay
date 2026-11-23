import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const exec = promisify(execFile);

test('macOS setup shell forwards the printed Portal readiness arguments to Node', {
  skip: process.platform === 'win32' && 'POSIX shell test',
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'nodrelay-launcher-args-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const kit = join(root, 'packaging');
  await mkdir(kit);
  const wrapper = join(kit, 'setup-macos.sh');
  await copyFile(new URL('../packaging/setup-macos.sh', import.meta.url), wrapper);
  await writeFile(join(root, 'uname'), '#!/bin/sh\nprintf "%s\\n" Darwin\n', { mode: 0o755 });
  await writeFile(join(root, 'node-fixture'), '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
  await writeFile(join(kit, 'pinned-node.sh'), 'node_version=fixture\nfleet_node_platform() { :; }\nfleet_prepare_node() { node="$FIXTURE_NODE"; }\n');
  const manifest = join(root, 'signed.json'), key = join(root, 'key.pem');
  for (const file of [manifest, manifest + '.sig', key]) await writeFile(file, '');
  const env = { ...process.env, PATH: root + ':' + process.env.PATH, FIXTURE_NODE: join(root, 'node-fixture') };
  const legacy = [manifest, key, '--check', 'https://manager.example.test', 'https://issuer.example.test'];
  const forwarded = join(await realpath(root), 'src', 'management-setup.mjs');
  for (const args of [legacy, [...legacy, '--portal', 'https://portal.example.test/mcp']]) {
    const { stdout } = await exec('sh', [wrapper, ...args], { env });
    assert.deepEqual(stdout.trimEnd().split('\n'), [forwarded, ...args]);
  }
});

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { systemdUnit } from '../src/os-service.mjs';

const id = 'devspace-fleet-123456abcdef';

test('same-version Linux repair keeps ordinary deployed units byte-identical', () => {
  const root = '/home/lin/.devspace-fleet/' + id.slice(-12);
  assert.equal(systemdUnit(id, `${root}/node`, [`${root}/service.mjs`], root),
    `[Unit]\nDescription=${id}\nAfter=network-online.target\n[Service]\nType=simple\nWorkingDirectory=${root}\n` +
    `ExecStart="${root}/node" "${root}/service.mjs"\nRestart=on-failure\nRestartSec=10\nKillMode=control-group\n` +
    '[Install]\nWantedBy=default.target\n');
});

test('Linux unit disables environment substitution only for paths with literal dollars', () => {
  const root = '/home/lin/QA ${HOME} 100%';
  const unit = systemdUnit(id, `${root}/node`, [`${root}/service.mjs`, `${root}/a"b\\c.json`], root);
  assert.ok(unit.includes('WorkingDirectory=/home/lin/QA ${HOME} 100%%\n'));
  assert.ok(unit.includes('ExecStart=:"/home/lin/QA ${HOME} 100%%/node"'));
  assert.ok(unit.includes('"/home/lin/QA ${HOME} 100%%/a\\"b\\\\c.json"'));
});

test('Linux only migrates the exact private old special-character unit and only restarts on migration', {
  skip: process.platform !== 'linux',
}, async t => {
  const temp = await mkdtemp(join(tmpdir(), 'nodrelay-unit-test-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const bin = join(temp, 'bin');
  const units = join(temp, '.config', 'systemd', 'user');
  const unitPath = join(units, `${id}.service`);
  const calls = join(temp, 'calls');
  await Promise.all([mkdir(bin), mkdir(units, { recursive: true })]);
  await writeFile(join(bin, 'systemctl'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$HOME/calls"\n', { mode: 0o700 });
  const root = join(temp, 'literal ${HOME} and 100%');
  const node = join(root, 'node');
  const args = [join(root, 'device-service.mjs')];
  const desired = systemdUnit(id, node, args, root);
  const legacy = desired.replace('ExecStart=:', 'ExecStart=');
  await writeFile(unitPath, legacy, { mode: 0o600 });
  const module = new URL('../src/os-service.mjs', import.meta.url).href;
  const run = () => promisify(execFile)(process.execPath, ['--input-type=module', '-e',
    `import { installService } from ${JSON.stringify(module)}; await installService(...${JSON.stringify([id, node, args, root])});`], {
    env: { ...process.env, HOME: temp, PATH: `${bin}${delimiter}${process.env.PATH}` }, timeout: 5000,
  });
  await run();
  assert.equal(await readFile(unitPath, 'utf8'), desired);
  assert.equal((await lstat(unitPath)).mode & 0o777, 0o600);
  const normalOrder = `--user daemon-reload\n--user enable --now ${id}.service\n`;
  const migrationOrder = `--user daemon-reload\n--user try-restart ${id}.service\n--user enable --now ${id}.service\n`;
  assert.equal(await readFile(calls, 'utf8'), migrationOrder);
  await run();
  assert.equal(await readFile(calls, 'utf8'), migrationOrder + normalOrder);
  await writeFile(unitPath, legacy + '# custom entries\n');
  await assert.rejects(run(), /An unrelated local background service/);
  assert.equal(await readFile(unitPath, 'utf8'), legacy + '# custom entries\n');
  assert.equal(await readFile(calls, 'utf8'), migrationOrder + normalOrder);
  const adjacent = join(temp, 'other.service');
  await rm(unitPath);
  await writeFile(adjacent, legacy, { mode: 0o600 });
  await symlink(adjacent, unitPath);
  await assert.rejects(run(), /must be a private regular file/);
  assert.equal(await readFile(adjacent, 'utf8'), legacy);
  assert.equal((await lstat(unitPath)).isSymbolicLink(), true);
});

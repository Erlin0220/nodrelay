import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { ensurePrivateDirectory, readPrivateFile, writePrivateFile } from '../src/private-directory.mjs';

const exec = promisify(execFile);
test('native Windows creates owner-only credentials without replacing files and rejects changed ACLs and junctions', {
  skip: process.platform !== 'win32' || process.env.FLEET_TEST_WINDOWS_ACL !== '1',
  timeout: 40000,
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'fleet-windows-acl-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'private');
  await ensurePrivateDirectory(directory);
  const token = join(directory, 'token');
  await writePrivateFile(token, 'fixture');
  await assert.rejects(writePrivateFile(token, 'replacement'), { code: 'EEXIST' });
  assert.equal(await readPrivateFile(token), 'fixture');

  const junction = join(root, 'junction');
  await symlink(directory, junction, 'junction');
  await assert.rejects(readPrivateFile(join(junction, 'token')), /free of reparse points/);

  const icacls = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe');
  await exec(icacls, [token, '/grant', '*S-1-1-0:R'], { windowsHide: true });
  const { stdout: before } = await exec(icacls, [token], { windowsHide: true });
  await assert.rejects(readPrivateFile(token), /private regular file/);
  const { stdout: after } = await exec(icacls, [token], { windowsHide: true });
  assert.equal(before, after, 'Rejection preserves the existing ACL');
});

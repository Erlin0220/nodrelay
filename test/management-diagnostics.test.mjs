import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { CloudflareError } from '../cloud/cloudflare.mjs';
import { managementFailureRecord, writeManagementFailure } from '../src/management-diagnostics.mjs';

const exec = promisify(execFile);
const onWindows = process.platform === 'win32';
const secret = 'never-log-this-token';

test('failure record preserves bounded status and lock evidence, never arbitrary strings', () => {
  const cause = new CloudflareError('POST', 403, [7403, secret], {
    path: '/accounts/' + secret + '/d1/database/private-id/query', rayId: 'a5ef557e0ee7fb84-LAX',
  });
  const error = Object.assign(new Error(secret, { cause }), { code: 'management_lock_unconfirmed',
    diagnostic: { changes: 1, rows: 0, stage: 'acquire', ownership: 'unknown', owner: secret }, token: secret });
  const { timestamp, ...fields } = managementFailureRecord(error, {
    stage: 'deployment', mode: 'install', version: '0.1.5-preview.18', account: secret,
  });
  assert.ok(Number.isFinite(Date.parse(timestamp)));
  assert.deepEqual(fields, { schema: 1, stage: 'deployment', mode: 'install', version: '0.1.5-preview.18',
    code: 'management_lock_unconfirmed', cloudflare: { status: 403, codes: [7403], rayId: 'a5ef557e0ee7fb84-LAX' },
    lock: { changes: 1, rows: 0, stage: 'acquire', ownership: 'unknown' } });
  assert.equal(JSON.stringify(fields).includes(secret), false);
  const hostile = managementFailureRecord({ code: secret, status: 403, rayId: secret,
    diagnostic: { ownership: secret } }, { stage: secret, mode: secret, version: secret });
  assert.equal(hostile.code, 'unexpected_error');
  assert.equal(hostile.stage, 'unknown');
  assert.equal(hostile.mode, 'unknown');
  assert.equal(hostile.version, undefined);
  assert.equal(hostile.cloudflare, undefined);
  assert.equal(hostile.lock, undefined);
});

test('management entrypoint reports the original failure and saves one private diagnostic', { skip: onWindows }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'nodrelay-diagnostic-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const file = fileURLToPath(new URL('../src/management-setup.mjs', import.meta.url));
  await assert.rejects(exec(process.execPath, [file, join(home, secret), join(home, 'missing-public-key'), '--plan'],
    { env: { ...process.env, HOME: home } }), error => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /脱敏诊断日志：.*failure-[\da-f-]+\.json/);
    return true;
  });
  const root = join(home, '.nodrelay'), directory = join(root, 'management-logs');
  const [name, ...rest] = await readdir(directory);
  assert.equal(rest.length, 0);
  for (const dir of [root, directory]) assert.equal((await lstat(dir)).mode & 0o777, 0o700);
  const path = join(directory, name);
  assert.equal((await lstat(path)).mode & 0o777, 0o600);
  const bytes = await readFile(path, 'utf8');
  assert.equal(bytes.includes(secret), false);
  const record = JSON.parse(bytes);
  assert.equal(record.stage, 'release_verification');
  assert.equal(record.mode, 'plan');
});

test('diagnostics refuse a symlinked storage directory', { skip: onWindows }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'nodrelay-diagnostic-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const root = join(home, '.nodrelay'), outside = join(home, 'outside');
  await mkdir(root, { mode: 0o700 });
  await mkdir(outside, { mode: 0o700 });
  await symlink(outside, join(root, 'management-logs'));
  await assert.rejects(writeManagementFailure(new Error(secret), {}, { home }), /private and owned/);
  assert.deepEqual(await readdir(outside), []);
});

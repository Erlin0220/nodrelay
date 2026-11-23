import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { revokeResponse } from '../cloud/device-revocation.mjs';
import { monitorConnection } from '../src/device-connection.mjs';
import { preparePersonal } from '../src/prepare-personal.mjs';
import { assertPrivateFile, ensurePrivateDirectory, readPrivateFile, verifyWindowsDirectory, verifyWindowsFile } from '../src/private-directory.mjs';

const manager = 'https://manager.example.invalid';
const deviceId = 'fixture-device';
const token = 'f'.repeat(43);
const sid = 'S-1-5-21-100-200-300-1001';

test('transient authorization failures and forged responses retry; verified revocation stops once', async () => {
  const revoked = await revokeResponse(manager, deviceId, token);
  const messages = [
    new Response('login required', { status: 401 }),
    new Response('budget policy block', { status: 403 }),
    Response.json({ ...revoked, proof: 'A'.repeat(43) }, { status: 410 }),
    Response.json(await revokeResponse('https://other.example.invalid', deviceId, token), { status: 410 }),
    new Response('<html>Access page</html>', { headers: { 'Content-Type': 'text/html' } }),
    new Error('connection failed'),
    Response.json({ status: 'active' }),
    new Response('edge temporarily blocked', { status: 403 }),
    Response.json(revoked, { status: 410 }),
  ];
  const delays = [], reports = [];
  const result = await monitorConnection({ manager, deviceId }, token, new AbortController().signal, {
    async request(url, init) {
      assert.equal(url, manager + '/device/activate');
      assert.equal(init.redirect, 'error');
      assert.ok(messages.length > 0, 'No more checks after explicit revocation');
      const response = messages.shift();
      if (response instanceof Error) throw response;
      return response;
    },
    sleep: async ms => { delays.push(ms); },
    report: async state => { reports.push(state); },
  });
  assert.equal(result, 'revoked');
  assert.deepEqual(delays, [1500, 3000, 6000, 12000, 24000, 30000, 60000, 1500]);
  assert.deepEqual(reports, [
    { status: 'unconfirmed', reason: 'http', httpStatus: 401 },
    { status: 'unconfirmed', reason: 'http', httpStatus: 403 },
    { status: 'unconfirmed', reason: 'invalid_response', httpStatus: 410 },
    { status: 'unconfirmed', reason: 'invalid_response', httpStatus: 200 },
    { status: 'unconfirmed', reason: 'network' },
    { status: 'active' },
    { status: 'unconfirmed', reason: 'http', httpStatus: 403 },
    { status: 'revoked' },
  ]);
});

test('existing Windows state requires correct owner and a protected inheritable DACL without reparse points', () => {
  const rule = { sid, type: 0, flags: 3, mask: 0x1f01ff };
  const secure = { directory: true, reparse: false, currentUser: sid, owner: sid,
    protected: true, daclPresent: true, entries: [rule] };
  assert.doesNotThrow(() => verifyWindowsDirectory(secure));
  const unsafe = [
    { directory: false }, { reparse: true }, { owner: 'S-1-5-32-544' }, { protected: false },
    { daclPresent: false }, { entries: [] }, { entries: [rule, { ...rule, sid: 'S-1-1-0' }] },
    { entries: [{ ...rule, flags: 19 }] }, { entries: [{ ...rule, flags: 0 }] },
    { entries: [{ ...rule, type: 1 }] }, { entries: [{ ...rule, mask: 0x120089 }] },
  ];
  for (const difference of unsafe) {
    assert.throws(() => verifyWindowsDirectory({ ...secure, ...difference }), /owned by this user/);
  }
});

test('Windows credential files allow private inherited or Personal ACLs and reject unsafe existing files', () => {
  const owner = { sid, type: 0, flags: 16, mask: 0x1f01ff };
  const file = { directory: false, reparse: false, currentUser: sid, owner: sid,
    protected: false, daclPresent: true, entries: [owner] };
  assert.doesNotThrow(() => verifyWindowsFile(file));
  assert.doesNotThrow(() => verifyWindowsFile({ ...file, protected: true, entries: [
    { ...owner, flags: 0 }, { ...owner, flags: 0, sid: 'S-1-5-18' },
  ] }));
  for (const difference of [
    { directory: true }, { reparse: true }, { owner: 'S-1-5-32-544' }, { daclPresent: false },
    { entries: [{ ...owner, sid: 'S-1-5-18' }] },
    { entries: [owner, { ...owner, sid: 'S-1-1-0' }] },
    { entries: [owner, { ...owner, sid: 'S-1-5-32-544' }] },
    { entries: [{ ...owner, type: 1 }] }, { entries: [{ ...owner, flags: 3 }] },
    { entries: [{ ...owner, mask: 0x120088 }] },
  ]) assert.throws(() => verifyWindowsFile({ ...file, ...difference }), /private regular file/);
});

test('POSIX state is restored idempotently and refuses shared folders or symbolic links', {
  skip: process.platform === 'win32',
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'fleet-private-check-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const safe = join(root, 'private'), shared = join(root, 'shared'), linked = join(root, 'linked');
  await ensurePrivateDirectory(safe);
  await ensurePrivateDirectory(safe);
  await mkdir(shared);
  await chmod(shared, 0o755);
  await symlink(safe, linked);
  await assert.rejects(ensurePrivateDirectory(shared), /must be private/);
  await assert.rejects(ensurePrivateDirectory(linked), /must be private/);
});

test('existing credential reads reject shared files and symbolic links', {
  skip: process.platform === 'win32',
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'fleet-file-check-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'token'), link = join(root, 'token-link');
  await writeFile(file, 'fixture', { mode: 0o600 });
  assert.equal(await readPrivateFile(file), 'fixture');
  await symlink(file, link);
  await assert.rejects(assertPrivateFile(link), /private regular file/);
  await chmod(file, 0o644);
  await assert.rejects(readPrivateFile(file), /private regular file/);
});

test('headless Linux prepares only the Runtime, while a Linux desktop install preserves desktop jobs', async t => {
  const tmp = await mkdtemp(join(tmpdir(), 'fleet-headless-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const runtime = join(tmp, 'runtime');
  const payload = join(runtime, 'personal');
  const callLog = join(tmp, 'jobs.jsonl');
  await mkdir(join(payload, 'desktop'), { recursive: true });
  await writeFile(join(payload, 'state.mjs'), `
import { mkdir, writeFile } from 'node:fs/promises';
export const secureStateDirectory = path => mkdir(path, { recursive: true, mode: 0o700 });
export const atomicJson = (path, value) => writeFile(path, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
`);
  await writeFile(join(payload, 'desktop', 'platform.mjs'), `
import { appendFile } from 'node:fs/promises';
const record = args => appendFile(${JSON.stringify(callLog)}, JSON.stringify(args) + '\\n');
export const registerJobs = (_home, _runtime, jobs) => record(jobs);
export const jobAction = (_home, name, action) => record([name, action]);
export const registerDesktopEntries = () => record(['desktop entries']);
`);
  const calls = async () => (await readFile(callLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const headless = join(tmp, 'headless');
  await preparePersonal(runtime, headless, { platform: 'linux', env: {} });
  assert.deepEqual(await calls(), [['runtime'], ['runtime', 'start']]);
  const json = async file => JSON.parse(await readFile(join(headless, 'personal', file), 'utf8'));
  const auth = await json('runtime/auth.json');
  assert.match(auth.ownerToken, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(auth.ownerToken, (await json('auth.json')).apiToken);
  const config = await json('runtime/config.json');
  assert.equal(config.stateDir, join(headless, 'personal', 'runtime-state'));
  assert.equal(config.worktreeRoot, join(headless, 'personal', 'worktrees'));
  await preparePersonal(runtime, headless, { platform: 'linux', env: {} });
  assert.deepEqual(await json('runtime/auth.json'), auth);
  await writeFile(callLog, '');
  await preparePersonal(runtime, join(tmp, 'desktop'), { platform: 'linux', env: { WAYLAND_DISPLAY: 'session' } });
  assert.deepEqual(await calls(), [['runtime', 'desktop'], ['runtime', 'start'], ['desktop', 'start'], ['desktop entries']]);
});

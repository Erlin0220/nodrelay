import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { automaticResumeSpec, deployManagement } from '../src/management-setup.mjs';
import { InstallationCancelled } from '../src/management-terminal.mjs';
import { takeManagementLock } from '../src/management-lock.mjs';
import { cloudFixture, catalog, spec } from './cloudflare-fixture.mjs';

const namespace = 'demo';
const zone = { id: spec.zoneId, account: { id: spec.accountId }, status: 'active', name: spec.zone };
const grant = { access: 'administrator-test-auth', refresh: 'r'.repeat(48),
  expiresAt: Math.floor(Date.now() / 1000) + 3600, zeroTrustBootstrap: true };
const release = { clientId: 'test-preview-client', automaticAdministrator: true, zeroTrustBootstrap: true, bundle: 'export default {}', releases: catalog };
const route = '/accounts/' + spec.accountId + '/workers/subdomain';
const database = 'c'.repeat(32);
const owner = spec.ownerEmail;

function snapshot() {
  return { spec, installationId: spec.installationId, databaseId: database, ticketKey: 't'.repeat(43), oauthKey: 'k'.repeat(43),
    oauthUserDetails: true, oauthBootstrapGranted: true, oauthZeroTrustBootstrap: true, oauthClientId: release.clientId };
}

function classify(s, overrides = {}) {
  return automaticResumeSpec(s, overrides.release ?? release, overrides.grant ?? grant, overrides.zone ?? zone, overrides.profile ?? owner, namespace);
}

test('receipt mode distinguishes fresh and completed; never changes owner, target or grant', () => {
  assert.equal(classify(undefined), undefined);
  assert.deepEqual(classify(snapshot()), spec);
  assert.throws(() => classify({ ...snapshot(), bound: true }), /已有完成回执/);
  assert.throws(() => classify(snapshot(), { grant: { ...grant, zeroTrustBootstrap: false } }), /授权与原回执/);
  assert.throws(() => classify(snapshot(), { release: { ...release, clientId: 'different-client' } }), /授权配置与原安装回执不符/);
  assert.throws(() => classify(snapshot(), { zone: { ...zone, id: 'd'.repeat(32) } }), /当前安装目标/);
  assert.throws(() => classify(snapshot(), { profile: 'different@example.test' }), /登录身份与原安装回执/);
  assert.throws(() => classify({ ...snapshot(), oauthKey: undefined }), /凭据记录/);
  assert.throws(() => classify({ zeroTrustBootstrap: { organization: 'pending' } }), /完整部署回执/);
  const sso = { ...snapshot(), ssoIdentity: { providerId: 'd'.repeat(32), issuer: 'https://example.cloudflareaccess.com' },
    oauthProfileEmail: 'cloudflare@example.test' };
  assert.deepEqual(classify(sso, { profile: 'cloudflare@example.test' }), spec);
  assert.throws(() => classify(sso), /登录身份与原安装回执/);
});

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'nodrelay-resume-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const target = createHash('sha256').update(JSON.stringify([zone.account.id, zone.id, namespace])).digest('hex').slice(0, 24);
  const receipt = join(home, '.nodrelay', 'management', target + '.json');
  const otp = { id: '3'.repeat(32), type: 'onetimepin' };
  const native = { id: '2'.repeat(32), type: 'cloudflare' };
  const providers = [otp, native];
  const cf = cloudFixture({ directPolicies: true, databaseId: database, identityProviders: providers });
  const calls = [], decisions = [], notes = [];
  let accountSubdomain, blockFirstUseRead = false, approve = true, nativeVisible = true;
  const ui = {
    note: (...entry) => notes.push(entry), info: message => notes.push([message]),
    confirm: async (message, action, initialValue) => { decisions.push({ message, action, initialValue }); return approve || action !== "确定"; },
  };
  const request = async (url, init) => {
    const path = new URL(url).pathname.replace('/client/v4', '');
    calls.push([init.method, path]);
    const unavailable = (code, status) => Response.json({ success: false, result: null, errors: [{ code }] }, { status });
    if (init.method === 'GET' && path.endsWith('/access/identity_providers') && !nativeVisible) {
      return Response.json({ success: true, result: providers.filter(row => row.type !== 'cloudflare') });
    }
    if (init.method === 'POST' && path.endsWith('/access/identity_providers')) {
      const body = JSON.parse(init.body);
      assert.deepEqual(body, { name: 'Cloudflare', type: 'cloudflare', config: { restrict_to_account_members: true } });
      nativeVisible = true;
      return Response.json({ success: true, result: native });
    }
    if (init.method === 'GET' && path.endsWith('/settings')) {
      const item = cf.db.scripts.find(x => x.id === path.split('/').at(-2));
      if (!item?.metadata) return unavailable(10007, 404);
      return Response.json({ success: true, result: { bindings: item.metadata.bindings } });
    }
    if (init.method === 'PUT' && /\/workers\/scripts\/fleet-demo-[a-f0-9]+$/.test(path) && !accountSubdomain) return unavailable(10063, 403);
    if (path === route) {
      if (blockFirstUseRead && init.method === 'GET') return unavailable(10063, 403);
      if (init.method === 'PUT') accountSubdomain = JSON.parse(init.body).subdomain;
      if (!accountSubdomain) return unavailable(10007, 404);
      return Response.json({ success: true, result: { subdomain: accountSubdomain } });
    }
    // Fixture needs the deployment's actual reflected Worker name; it stores
    // upload metadata and the same tag under the dynamically generated ID.
    if (init.method === 'PUT' && /\/workers\/scripts\/fleet-demo-[a-f0-9]+$/.test(path)) {
      const meta = JSON.parse(await init.body.get('metadata').text());
      cf.db.scripts.push({ id: path.split('/').at(-1), tags: meta.tags, metadata: meta });
      return Response.json({ success: true, result: {} });
    }
    if (/\/workers\/scripts\/fleet-demo-[a-f0-9]{12}\/subdomain$/.test(path)) {
      assert.deepEqual(JSON.parse(init.body), { enabled: false, previews_enabled: false });
      return Response.json({ success: true, result: {} });
    }
    return cf.request(url, init);
  };
  const run = (options = {}, profile = owner, readWorkersSettings = true) => {
    blockFirstUseRead = !readWorkersSettings;
    return deployManagement(ui, release, grant, zone, profile, namespace, options, { request, home, previewAccount: '' });
  };
  return { run, receipt, calls, decisions, cf, notes, decline() { approve = false; }, legacyLogin() { nativeVisible = false; const app = cf.db.apps.find(a => a.domain === new URL(spec.origin).hostname); app.allowed_idps = [otp.id]; app.auto_redirect_to_identity = false; } };
}

test('same command replays a preview.2 10063 partial deployment and keeps material consent', { skip: process.platform === 'win32' && 'macOS terminal installer workflow' }, async t => {
  const f = await fixture(t);
  // Generate a receipt with an initial refused upload: exactly the late state
  // left by preview.2 before Workers could be provisioned.
  await assert.rejects(f.run({}, owner, false), /10063/);
  const original = JSON.parse(await readFile(f.receipt));
  assert.equal(original.bound, undefined);
  assert.equal(original.databaseId, database);
  assert.equal(original.pendingCreates, undefined);
  // Older preview.2 receipt did not record the separate Cloudflare profile.
  delete original.oauthProfileEmail;
  await writeFile(f.receipt, JSON.stringify(original), { mode: 0o600 });
  const apps = f.cf.db.apps.length, portal = f.cf.db.portal.id;
  f.decisions.length = 0; f.calls.length = 0;
  const result = await f.run();
  assert.equal(result.management, spec.origin);
  assert.deepEqual(f.decisions.map(({ action, initialValue }) => [action, initialValue]), [['确定', true]]);
  assert.equal(f.calls.filter(([method, path]) => method === 'PUT' && path === route).length, 1);
  assert.equal(f.cf.db.apps.length, apps);
  assert.equal(f.cf.db.portal.id, portal);
  const complete = JSON.parse(await readFile(f.receipt));
  assert.equal(complete.installationId, original.installationId);
  assert.equal(complete.bound, true);
  assert.equal(complete.databaseId, database);
  assert.ok(!f.notes.some(([str]) => String(str).includes('首次登录')));
  f.legacyLogin();
  f.calls.length = 0; f.decisions.length = 0;
  assert.equal((await f.run()).loginRepaired, true);
  assert.deepEqual(f.decisions, [], 'Existing owners do not get a login migration confirmation');
  const writes = f.calls.filter(([method]) => method !== 'GET');
  assert.deepEqual(writes.map(([method]) => method), ['POST', 'PUT']);
  assert.match(writes[0][1], /\/access\/identity_providers$/);
  assert.match(writes[1][1], /\/access\/apps\/[0-9]+$/);
  f.calls.length = 0; f.decisions.length = 0;
  assert.equal((await f.run()).loginRepaired, true);
  assert.deepEqual(f.decisions, []);
  assert.ok(f.calls.every(([method]) => method === 'GET'));
  f.calls.length = 0;
  await assert.rejects(f.run({}, 'other-admin@example.test'), /原管理台管理员不符/);
  assert.deepEqual(f.calls, []);
});

test('pending create and mismatched OAuth profile stop before any Cloudflare requests', { skip: process.platform === 'win32' && 'macOS terminal installer workflow' }, async t => {
  const f = await fixture(t);
  await assert.rejects(f.run({}, owner, false), /10063/);
  const state = JSON.parse(await readFile(f.receipt));
  f.calls.length = 0; f.decisions.length = 0;
  await assert.rejects(f.run({}, 'other-admin@example.test'), /登录身份与原安装回执/);
  assert.deepEqual(f.calls, []);
  state.pendingCreates = [JSON.stringify(['/accounts/' + spec.accountId + '/access/apps', 'missing-pending-app'])];
  await writeFile(f.receipt, JSON.stringify(state));
  for (const flags of [{}, { resume: true }]) {
    await assert.rejects(f.run(flags), /missing-pending-app.*未重新发送/);
  }
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.decisions, []);
});

test('read-only proof rejects missing resources without creating or prompting', { skip: process.platform === 'win32' && 'macOS terminal installer workflow' }, async t => {
  const f = await fixture(t);
  await assert.rejects(f.run({}, owner, false), /10063/);
  f.cf.db.apps.shift();
  f.calls.length = 0; f.decisions.length = 0;
  await assert.rejects(f.run({ resume: true }), /无法只读确认上次配置的资源/);
  assert.ok(f.calls.length > 0);
  assert.ok(f.calls.every(([method]) => method === 'GET'));
  assert.deepEqual(f.decisions, []);
});

test('same command does not take an active target lock or call Cloudflare', { skip: process.platform === 'win32' && 'macOS terminal installer workflow' }, async t => {
  const f = await fixture(t);
  await mkdir(join(f.receipt, '..'), { recursive: true, mode: 0o700 });
  const release = await takeManagementLock(f.receipt + '.lock');
  try { await assert.rejects(f.run(), error => error.kind === 'active'); }
  finally { await release(); }
  assert.deepEqual(f.calls, []);
});

test('same command retires a dead lock only for an eligible unfinished installation', {
  skip: process.platform === 'win32' && 'macOS terminal installer workflow',
}, async t => {
  const f = await fixture(t);
  await assert.rejects(f.run({}, owner, false), /10063/);
  const child = spawn(process.execPath, ['-e', '']);
  await once(child, 'exit');
  const lock = f.receipt + '.lock';
  const record = JSON.stringify({ version: 1, pid: child.pid, id: 'c'.repeat(32) });
  await writeFile(lock, record, { mode: 0o600 });
  const saved = JSON.parse(await readFile(f.receipt));
  const retired = lock + '.retired';
  f.calls.length = 0; f.decisions.length = 0;

  await assert.rejects(f.run({}, 'other-admin@example.test'), /登录身份与原安装回执/);
  const pendingCreates = [JSON.stringify([route, 'unknown-create'])];
  await writeFile(f.receipt, JSON.stringify({ ...saved, pendingCreates }));
  await assert.rejects(f.run(), /unknown-create.*未重新发送/);
  assert.equal(await readFile(lock, 'utf8'), record);
  await assert.rejects(readFile(retired), { code: 'ENOENT' });
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.decisions, []);

  await writeFile(f.receipt, JSON.stringify(saved));
  assert.equal((await f.run()).management, spec.origin);
  assert.equal(await readFile(retired, 'utf8'), record);
  assert.deepEqual(f.decisions.map(({ action }) => action), ['确定'], 'Only Workers subdomain registration needs confirmation');
  const done = JSON.parse(await readFile(f.receipt));
  assert.equal(done.bound, true);
  assert.equal(done.databaseId, saved.databaseId);
  assert.equal(done.installationId, saved.installationId);
});

test('original command does not start a new deployment if a dead lock has no receipt', {
  skip: process.platform === 'win32' && 'macOS terminal installer workflow',
}, async t => {
  const f = await fixture(t);
  await mkdir(join(f.receipt, '..'), { recursive: true, mode: 0o700 });
  const child = spawn(process.execPath, ['-e', '']);
  await once(child, 'exit');
  const lock = f.receipt + '.lock';
  const record = JSON.stringify({ version: 1, pid: child.pid, id: 'd'.repeat(32) });
  await writeFile(lock, record, { mode: 0o600 });
  await assert.rejects(f.run(), { kind: 'interrupted' });
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.decisions, []);
  assert.equal(await readFile(lock, 'utf8'), record);
  await assert.rejects(readFile(lock + '.retired'), { code: 'ENOENT' });
});

test('ambiguous Worker upload and account-subdomain attempts never reissue writes', {
  skip: process.platform === 'win32' && 'macOS terminal installer workflow',
}, async t => {
  const f = await fixture(t);
  await assert.rejects(f.run({}, owner, false), /10063/);
  const state = JSON.parse(await readFile(f.receipt));
  f.calls.length = 0; f.decisions.length = 0;
  f.cf.db.scripts.push({ id: state.spec.worker, tags: [state.spec.label] });
  await assert.rejects(f.run(), /Worker 或管理台域名已存在/);
  assert.ok(f.calls.every(([method]) => method === 'GET'));
  f.cf.db.scripts.length = 0;
  f.calls.length = 0;
  state.workersSubdomainAttempt = 'nodrelay-' + createHash('sha256').update('nodrelay-workers-dev:' + zone.account.id).digest('hex').slice(0, 20);
  await writeFile(f.receipt, JSON.stringify(state));
  await assert.rejects(f.run(), /账户 Workers 子域注册结果尚未确认/);
  assert.ok(f.calls.every(([method]) => method === 'GET'));
  assert.deepEqual(f.decisions, []);
});

test('fresh installation defaults to confirming Workers registration without bypassing cancellation', {
  skip: process.platform === 'win32' && 'macOS terminal installer workflow',
}, async t => {
  const fresh = await fixture(t);
  assert.equal((await fresh.run()).management, spec.origin);
  assert.ok(fresh.decisions.length > 0);
  assert.ok(fresh.decisions.every(({ initialValue }) => initialValue === true));
  assert.equal(fresh.calls.filter(([method, path]) => method === 'PUT' && path === route).length, 1);

  const declined = await fixture(t);
  declined.decline();
  await assert.rejects(declined.run(), InstallationCancelled);
  assert.deepEqual(declined.decisions.filter(({ action }) => action === "确定").map(({ action, initialValue }) => [action, initialValue]), [['确定', true]]);
  assert.equal(declined.calls.filter(([method, path]) => method === 'PUT' && path === route).length, 0);
});

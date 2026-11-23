import assert from 'node:assert/strict';
import test from 'node:test';
import { createUpgradeAdmin, UpgradeAdminError } from '../cloud/upgrade-admin.mjs';
import { UpgradeOperationError } from '../cloud/upgrade-operation.mjs';

const installed = '0.1.5', update = '0.1.6', now = Date.parse('2026-11-20T12:00:00Z');
const operationId = '11111111-2222-4333-8444-555555555555';
const activeVersion = '11111111-2222-3333-4444-555555555555';
const candidateVersion = '22222222-3333-4444-5555-666666666666';
const binding = { accountId: 'a'.repeat(32), zoneId: 'b'.repeat(32), worker: 'fleet-fixture-111111111111',
  origin: 'https://fixture.example.test', ownerEmail: 'owner@example.test' };
const target = { ...binding, accessAudience: 'fixture-access-audience' };
const db = {};
const oauthNamespace = {};
const feed = 'https://updates.example.test/releases/';
const key = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
const spki = Buffer.from(await crypto.subtle.exportKey('spki', key.publicKey)).toString('base64url');
const bytes = Buffer.from('export default {};');
const hash = Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex');
const manifest = Buffer.from(JSON.stringify({
  schema: 1, product: 'nodrelay-management', channel: 'stable', version: update, minimumVersion: installed,
  issuedAt: '2026-11-19T12:00:00.000Z', expiresAt: '2026-12-19T12:00:00.000Z', workerBundle: 'worker.js', workerSha256: hash,
}));
const sig = new Uint8Array(await crypto.subtle.sign('Ed25519', key.privateKey, manifest));
const paths = new Map([
  ['stable/manifest.json', manifest], ['stable/manifest.json.sig', sig], ['stable/worker.js', bytes],
]);
const env = {
  APP_ORIGIN: target.origin, OWNER_EMAIL: target.ownerEmail, ACCESS_AUD: target.accessAudience, TICKETS: db,
  NODRELAY_RELEASE_VERSION: installed, NODRELAY_UPGRADE_FEED: feed, NODRELAY_UPGRADE_CHANNEL: 'stable', NODRELAY_UPGRADE_PUBLIC_KEY: spki,
  FLEET_SPEC: JSON.stringify({ ...binding, accountScopedAccess: true, label: target.worker }),
  FLEET_OAUTH_MODE: 'managed', FLEET_OAUTH_RECOVERY: '1', PROVISIONER_OAUTH: oauthNamespace,
};
const record = { operationId, phase: 'confirmed', baseVersion: activeVersion, releaseVersion: update,
  releaseSha256: hash, candidateVersion };
const staged = { ...record, phase: 'staged' };
function fixture(overrides = {}) {
  const calls = [];
  const state = { deployments: [{ version_id: activeVersion, percentage: 100 }], latestVersion: activeVersion };
  const journal = {};
  const api = {
    readDeployment(input) {
      calls.push('deployment');
      assert.deepEqual(input, target);
      return state;
    },
  };
  const dependencies = {
    clock: () => now,
    async request(url, init) {
      calls.push('feed');
      assert.equal(init.method, 'GET');
      assert.equal(init.redirect, 'manual');
      assert.ok(!new Headers(init.headers).has('Authorization'));
      assert.ok(url.startsWith(feed));
      const data = paths.get(url.slice(feed.length));
      return new Response(data, { status: data ? 200 : 404 });
    },
    async oauthAccess(namespace) {
      calls.push('oauth');
      assert.equal(namespace, oauthNamespace);
      return 'fixture.access.token.valid';
    },
    readJournal(database, input) {
      calls.push('status');
      assert.equal(database, db);
      assert.deepEqual(input, target);
    },
    createJournal(input) {
      calls.push('journal');
      assert.equal(input, db);
      return journal;
    },
    createAdapter(input, pinned) {
      calls.push('adapter');
      assert.equal(typeof input.get, 'function');
      assert.deepEqual(pinned, target);
      return api;
    },
    async runOperation(input) {
      calls.push('run');
      assert.deepEqual(input.expected, { ...target, currentVersion: installed, activeVersion });
      assert.equal(input.operationId, operationId);
      assert.equal(input.artifact.channel, 'stable');
      assert.ok(input.artifact.publicKey instanceof CryptoKey);
      assert.equal(input.api, api);
      assert.equal(input.journal, journal);
      assert.equal(input.now, now);
      return { status: 'deployment_confirmed', version: update, versionId: candidateVersion };
    },
    ...overrides,
  };
  return { admin: createUpgradeAdmin(env, dependencies), calls, dependencies, state };
}
const input = { operationId, version: update, releaseSha256: hash };
const code = expected => error => error instanceof UpgradeAdminError && error.code === expected && !error.cause;

test('owner can inspect pre-cutover status without accessing the update feed or starting a new operation', async () => {
  for (const [row, status] of [[{ ...staged, phase: 'uploading', candidateVersion: undefined }, 'baseline_active_upload_unconfirmed'],
    [staged, 'baseline_active_candidate_staged']]) {
    let forwarded;
    const { admin, calls } = fixture({ readJournal: () => row, confirmOperation: async input => {
      forwarded = input;
      return { status, version: update, operationId };
    } });
    assert.deepEqual(await admin.reconcile({ operationId }), { status, version: update, operationId });
    assert.deepEqual(forwarded.expected, { ...target, currentVersion: installed, activeVersion });
    assert.deepEqual(calls, ['oauth', 'adapter', 'journal']);
    await assert.rejects(admin.start(input), code('reconciliation_required'));
    assert.deepEqual(calls, ['oauth', 'adapter', 'journal']);
  }
});

test('owner adapter has no side effects without trusted deployment bindings or a valid request', async () => {
  const { dependencies, calls } = fixture();
  for (const changed of [
    { NODRELAY_UPGRADE_FEED: undefined }, { NODRELAY_UPGRADE_FEED: 'https://updates.example.test/releases/?x=1' },
    { NODRELAY_UPGRADE_PUBLIC_KEY: 'bad' }, { PROVISIONER_TOKEN: 'fallback' }, { OWNER_EMAIL: 'different@example.test' },
  ]) {
    const admin = createUpgradeAdmin({ ...env, ...changed }, dependencies);
    assert.deepEqual(await admin.check(), { available: false });
    assert.deepEqual(await admin.status(), { phase: 'idle' });
    await assert.rejects(admin.start(input), code('unavailable'));
  }
  const admin = createUpgradeAdmin(env, dependencies);
  for (const value of [null, [], { ...input, feed: 'https://attacker.example/' },
    { ...input, operationId: activeVersion }, { ...input, version: 'v0.1.6' }, { operationId, version: update }]) {
    await assert.rejects(admin.start(value), code('invalid_request'));
  }
  assert.deepEqual(calls, []);
});

test('check verifies actual detached signature and bundle with no OAuth or journal side effects', async () => {
  const { admin, calls, dependencies } = fixture();
  assert.deepEqual(await admin.check(), { currentVersion: installed, nextVersion: update, releaseSha256: hash });
  assert.deepEqual(calls, ['feed', 'feed', 'feed', 'feed']);
  const { admin: damaged } = fixture({
    request: (url, init) => url.endsWith('worker.js') ? new Response('changed') : dependencies.request(url, init),
  });
  await assert.rejects(damaged.check(), code('feed_unavailable'));
});

test('start re-verifies exact release and prevents origin, version, target and credential override', async () => {
  const { admin, calls } = fixture();
  assert.deepEqual(await admin.start(input), { status: 'deployment_confirmed', version: update, operationId });
  assert.deepEqual(calls, ['status', 'feed', 'feed', 'feed', 'feed', 'oauth', 'adapter', 'deployment', 'journal', 'run']);

  const { admin: changed, calls: changedCalls } = fixture();
  await assert.rejects(changed.start({ ...input, version: '0.1.7' }), code('release_changed'));
  assert.deepEqual(changedCalls, ['status', 'feed', 'feed', 'feed', 'feed']);
  const other = fixture();
  await assert.rejects(other.admin.start({ ...input, releaseSha256: 'f'.repeat(64) }), code('release_changed'));
  assert.deepEqual(other.calls, ['status', 'feed', 'feed', 'feed', 'feed']);
});

test('status and finalized replay are sanitized and do not call downstream providers', async () => {
  const readJournal = () => ({ ...record, extra: 'raw-secret-fixture' });
  const { calls, dependencies } = fixture({ readJournal });
  const admin = createUpgradeAdmin({ ...env, NODRELAY_RELEASE_VERSION: update }, dependencies);
  assert.deepEqual(await admin.status(), { phase: 'confirmed', operationId, version: update, currentVersion: update });
  assert.deepEqual(await admin.start(input), { status: 'previously_confirmed', operationId, version: update });
  await assert.rejects(admin.start({ ...input, version: '0.1.7' }), code('operation_conflict'));
  await assert.rejects(admin.start({ ...input, releaseSha256: 'f'.repeat(64) }), code('operation_conflict'));
  assert.deepEqual(calls, []);
});

test('after an external rollback status keeps the historic journal separate from the responding Worker version', async () => {
  const { admin, calls } = fixture({ readJournal: () => record });
  assert.deepEqual(await admin.status(), { phase: 'confirmed', operationId, version: update, currentVersion: installed });
  assert.deepEqual(await admin.reconcile({ operationId }), { status: 'previously_confirmed', operationId, version: update });
  assert.deepEqual(calls, []);
});

test('uncertain or malformed journal and unsettled OAuth block starts; no blind retries', async () => {
  const { admin, calls } = fixture({ readJournal: () => staged });
  assert.deepEqual(await admin.status(), { phase: 'staged', operationId, version: update, currentVersion: installed });
  await assert.rejects(admin.start(input), code('reconciliation_required'));
  await assert.rejects(admin.start({ ...input, operationId: '22222222-3333-4444-8555-666666666666' }), code('reconciliation_required'));
  assert.deepEqual(calls, []);
  const unavailable = fixture({ readJournal: () => ({ ...record, releaseSha256: 'key-like-fixture' }) }).admin;
  await assert.rejects(unavailable.status(), code('status_unavailable'));
  await assert.rejects(unavailable.start(input), code('status_unavailable'));
  for (const opts of [{ FLEET_OAUTH_SEED: 'still-present' }, { FLEET_OAUTH_RECONNECT: 'still-present' }]) {
    const { dependencies, calls: blocked } = fixture();
    await assert.rejects(createUpgradeAdmin({ ...env, ...opts }, dependencies).start(input), code('authorization_unavailable'));
    assert.deepEqual(blocked, ['status', 'feed', 'feed', 'feed', 'feed']);
  }
  await assert.rejects(fixture({ oauthAccess: () => undefined }).admin.start(input), code('authorization_unavailable'));
});

test('refuses nonfinal or racing deployment; safe errors never reveal provider metadata', async () => {
  for (const drift of [
    state => { state.latestVersion = 'not-a-version'; },
    state => { state.deployments.push({ version_id: candidateVersion, percentage: 100 }); },
    state => { state.deployments[0].percentage = 99; },
  ]) {
    const { admin, calls, state } = fixture();
    drift(state);
    await assert.rejects(admin.start(input), code('target_drift'));
    assert.ok(!calls.includes('run'));
  }
  const raw = 'private-cloudflare-response';
  for (const error of [new Error(raw), new UpgradeOperationError('deployment_unconfirmed', raw)]) {
    const { admin } = fixture({ runOperation: () => { throw error; } });
    await assert.rejects(admin.start(input), output => !JSON.stringify(output).includes(raw) && !output.message.includes(raw) &&
      code(error instanceof UpgradeOperationError ? 'deployment_unconfirmed' : 'operation_unavailable')(output));
  }
});

test('a valid active version different from the latest upload is explained without a rollout or journal change', async () => {
  const { admin, calls, state } = fixture({ readJournal: () => record });
  state.latestVersion = candidateVersion;
  const retry = { ...input, operationId: '22222222-3333-4444-8555-666666666666' };
  await assert.rejects(admin.start(retry), output => code('baseline_version_mismatch')(output) &&
    output.status === 409 && !output.message.includes(activeVersion) && !output.message.includes(candidateVersion));
  assert.deepEqual(calls, ['feed', 'feed', 'feed', 'feed', 'oauth', 'adapter', 'deployment']);
  assert.deepEqual(await admin.status(), { phase: 'confirmed', operationId, version: update, currentVersion: installed });
});

test('v2 picks exact manifest intent; failure of the v2 feed never falls back to v1', async () => {
  const five = Object.fromEntries(['macos-arm64', 'macos-x64', 'linux-x64', 'linux-arm64', 'windows-x64'].map(platform =>
    [platform, { version: update, url: feed + 'device/' + platform, sha256:'a'.repeat(64), browser:false }]));
  const v2 = Buffer.from(JSON.stringify({ ...JSON.parse(manifest), schema: 2, enrollment:{ protocol:'intent-v1', releases:five } }));
  const sign = new Uint8Array(await crypto.subtle.sign('Ed25519', key.privateKey, v2));
  const manifestSha256 = Buffer.from(await crypto.subtle.digest('SHA-256', v2)).toString('hex');
  const uses = [];
  const v2Paths = new Map([['manifest.json', v2], ['manifest.json.sig', sign], ['worker.js', bytes]]);
  const base2 = 'stable/v2/';
  const { calls, admin, dependencies } = fixture({
    async request(url) {
      uses.push(url);
      assert.ok(url.startsWith(feed + base2));
      const value = v2Paths.get(url.slice((feed+base2).length));
      return new Response(value, { status: value ? 200 : 404 });
    },
    async runOperation(input) {
      assert.equal(input.enrollmentApproval.manifestSha256, manifestSha256);
      await input.enrollmentApproval.inspect();
      return { status:'deployment_confirmed', version:update };
    },
    async inspectEnrollment({ spec }) { assert.equal(spec.worker, binding.worker); },
  });
  assert.deepEqual(await admin.check(), { currentVersion:installed, nextVersion:update, includesEnrollment:true, manifestSha256 });
  await assert.rejects(admin.start(input), code('release_changed'));
  assert.ok(!calls.includes('oauth'));
  assert.deepEqual(await admin.start({ operationId, version:update, manifestSha256 }), { status:'deployment_confirmed', version:update, operationId });
  assert.ok(uses.length >= 9);
  const blocked = createUpgradeAdmin(env, { ...dependencies, async request(url) {
    assert.equal(url, feed + base2 + 'manifest.json');
    return new Response(null, {status:503});
  } });
  await assert.rejects(blocked.check(), code('feed_unavailable'));
});

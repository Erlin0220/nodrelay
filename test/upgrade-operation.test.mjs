import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { enrollmentUpgradeAccessPaths } from '../cloud/upgrade-enrollment-release.mjs';
import { legacyPreviewFeed, publicPreviewFeed } from '../cloud/upgrade-feed-migration.mjs';
import { confirmRecordedDeployment, runUpgradeOperation } from '../cloud/upgrade-operation.mjs';

const activeVersion = '11111111-2222-3333-4444-555555555555';
const candidateVersion = '22222222-3333-4444-5555-666666666666';
const foreignVersion = '33333333-4444-5555-6666-777777777777';
const operationId = '11111111-2222-4333-8444-555555555555';
const now = Date.parse('2026-11-20T12:00:00.000Z');
const expected = {
  accountId: 'a'.repeat(32), zoneId: 'b'.repeat(32), worker: 'fleet-fixture-111111111111',
  origin: 'https://fixture-fleet.example.test', ownerEmail: 'owner@example.test', accessAudience: 'fixture-access-audience',
  activeVersion, currentVersion: '0.1.5',
};
const plain = {
  APP_ORIGIN: expected.origin, ACCESS_ISSUER: 'https://fixture.cloudflareaccess.com', ACCESS_AUD: expected.accessAudience,
  OWNER_EMAIL: expected.ownerEmail,
  FLEET_SPEC: JSON.stringify({ ...expected, label: expected.worker, accountScopedAccess: true }),
  RELEASE_CATALOG: '{}', FLEET_OAUTH_CLIENT_ID: 'fixture-client', FLEET_OAUTH_MODE: 'managed',
  FLEET_OAUTH_RECOVERY: '1', NODRELAY_RELEASE_VERSION: expected.currentVersion,
};
const active = {
  id: activeVersion, etag: 'provider_etag_for_active',
  bindings: [
    ...Object.entries(plain).map(([name, text]) => ({ name, type: 'plain_text', text })),
    { name: 'TICKETS', type: 'd1', id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' },
    { name: 'PROVISIONER_OAUTH', type: 'durable_object_namespace', class_name: 'OAuthProvisioner', namespace_id: 'b'.repeat(32) },
    { name: 'TICKET_KEY', type: 'secret_text' }, { name: 'FLEET_OAUTH_KEY', type: 'secret_text' },
  ],
  runtime: { compatibilityDate: '2026-07-30', compatibilityFlags: ['flag-b', 'flag-a'],
    migrationTag: 'nodrelay-oauth-v1', usageModel: 'standard' },
};
const candidate = {
  ...structuredClone(active), id: candidateVersion, etag: 'provider_etag_for_candidate',
  bindings: active.bindings.map(binding => binding.name === 'NODRELAY_RELEASE_VERSION'
    ? { ...binding, text: '0.1.6' } : { ...binding }),
};
const bundle = Buffer.from('export default { fetch: (request) => new Response("N+1") };');
const release = { schema: 1, product: 'nodrelay-management', channel: 'stable', version: '0.1.6', minimumVersion: '0.1.4',
  issuedAt: '2026-11-19T12:00:00.000Z', expiresAt: '2026-12-19T12:00:00.000Z', workerBundle: 'worker.js',
  workerSha256: createHash('sha256').update(bundle).digest('hex') };
const key = await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify']);
const testPublicKey = Buffer.from(await crypto.subtle.exportKey('spki', key.publicKey)).toString('base64url');
const manifest = Buffer.from(JSON.stringify(release));
const signature = new Uint8Array(await crypto.subtle.sign('Ed25519', key.privateKey, manifest));
const artifact = { bundle, manifest, signature, publicKey: key.publicKey, channel: 'stable' };

function fixture({ failUpload, failDeploy, staleBeforeUpload, staleAfterUpload, staleAfterDeploy, wrongCandidate,
  runtimeDrift, bindingDrift, activeDrift, failGuard, initialJournal, format2 = false, feed } = {}) {
  const log = [];
  const before = format2 ? structuredClone(active) : active;
  if (format2) before.bindings.find(b => b.name === 'RELEASE_CATALOG').text =
    JSON.stringify({ old: { version: '0.1.5', url: 'https://legacy.example.test/device.tgz', sha256: 'f'.repeat(64) } });
  if (format2 && feed) before.bindings.push(...Object.entries({
    NODRELAY_UPGRADE_FEED: feed, NODRELAY_UPGRADE_CHANNEL: 'preview', NODRELAY_UPGRADE_PUBLIC_KEY: testPublicKey,
  }).map(([name, text]) => ({ name, type: 'plain_text', text })));
  let uploadedBindings;
  let staged = false, rolled = false, state = initialJournal, locked = false, checks = 0, guards = 0;
  const journal = {
    async withLock(target, fn) {
      assert.deepEqual(target, expected);
      if (locked) throw new Error('fixture operation lock busy');
      locked = true;
      try {
        return await fn({
          read: () => state,
          async write(record) {
            assert.ok(locked);
            log.push(['journal', record.phase]);
            state = structuredClone(record);
          },
          assertHeld() {
            guards += 1;
            assert.ok(locked);
            if (failGuard === guards) throw new Error('fixture lock lost');
          },
        });
      } finally { locked = false; }
    },
  };
  const api = {
    async readDeployment(target) {
      assert.deepEqual(target, expected);
      log.push(['read deployment']);
      checks += 1;
      const current = rolled && !staleAfterDeploy ? candidateVersion : activeVersion;
      const latest = (staleBeforeUpload && checks === 2) || (staged && staleAfterUpload) ? foreignVersion
        : staged ? candidateVersion : activeVersion;
      return { deployments: [{ version_id: current, percentage: 100 }], latestVersion: latest };
    },
    async readVersion(target, id) {
      assert.deepEqual(target, expected);
      log.push(['read version', id]);
      const response = structuredClone(id === activeVersion ? before : candidate);
      if (format2 && id === candidateVersion) response.bindings = structuredClone(uploadedBindings);
      if (id === activeVersion && activeDrift) response.bindings.find(b => b.name === 'ACCESS_AUD').text = 'different';
      if (id === candidateVersion) {
        if (wrongCandidate) response.etag = 'different_provider_etag';
        if (runtimeDrift) response.runtime.migrationTag = 'different';
        if (bindingDrift) response.bindings.find(b => b.name === 'TICKETS').id = 'bbbbbbbb-aaaa-cccc-dddd-eeeeeeeeeeee';
      }
      return response;
    },
    async uploadVersion(target, options) {
      assert.deepEqual(target, expected);
      assert.equal(state.phase, 'uploading');
      log.push(['upload', options]);
      if (format2) uploadedBindings = options.bindings.map(b => b.type === 'inherit' ? before.bindings.find(x => x.name === b.name) : b);
      staged = true;
      if (failUpload) throw new Error('fixture lost response');
      return { id: candidateVersion, etag: candidate.etag };
    },
    async deployVersion(target, options) {
      assert.deepEqual(target, expected);
      assert.equal(state.phase, 'deploying');
      log.push(['deploy', options]);
      rolled = true;
      if (failDeploy) throw new Error('fixture lost response');
      return { id: 'fixture-deployment' };
    },
  };
  return { log, journal, api, state: () => state,
    run: (overrides = {}) => runUpgradeOperation({ expected, artifact, operationId, journal, api, now, ...overrides }) };
}

test('stages verified code with strict inheritance before a single rollout and provider readback', async () => {
  const f = fixture();
  const result = await f.run();
  assert.deepEqual(result, { status: 'deployment_confirmed', version: '0.1.6', versionId: candidateVersion });
  const upload = f.log.find(([name]) => name === 'upload')[1];
  assert.deepEqual(Buffer.from(upload.bundle), bundle);
  assert.equal(upload.bindingsInherit, 'strict');
  assert.deepEqual(upload.bindings.find(binding => binding.name === 'TICKETS'), { name: 'TICKETS', type: 'inherit' });
  assert.deepEqual(upload.bindings.find(binding => binding.name === 'TICKET_KEY'), { name: 'TICKET_KEY', type: 'inherit' });
  assert.deepEqual(upload.bindings.find(binding => binding.name === 'NODRELAY_RELEASE_VERSION'),
    { name: 'NODRELAY_RELEASE_VERSION', type: 'plain_text', text: '0.1.6' });
  assert.deepEqual(upload.compatibilityFlags, ['flag-a', 'flag-b']);
  assert.ok(!('migrations' in upload));
  assert.deepEqual(f.log.find(([name]) => name === 'deploy')[1],
    { strategy: 'percentage', versions: [{ version_id: candidateVersion, percentage: 100 }] });
  assert.deepEqual(f.log.filter(([name]) => name === 'journal').map(entry => entry[1]),
    ['uploading', 'staged', 'deploying', 'confirmed']);
  assert.equal((await f.run()).status, 'previously_confirmed');
  assert.equal(f.log.filter(([name]) => name === 'upload').length, 1);
  assert.equal(f.log.filter(([name]) => name === 'deploy').length, 1);
});

test('target mismatch and invalid signed bytes do not touch Cloudflare writes', async () => {
  const f = fixture({ activeDrift: true });
  await assert.rejects(f.run(), { code: 'target_drift' });
  assert.equal(f.state(), undefined);
  await assert.rejects(f.run({ expected: { ...expected, worker: 'arbitrary-worker' } }), { code: 'invalid_target' });
  await assert.rejects(f.run({ artifact: { ...artifact, bundle: Buffer.from('tampered') } }), /SHA-256/);
  assert.ok(!f.log.some(([name]) => name === 'upload' || name === 'deploy'));
});

test('stale active/latest or a lost operation fence prevent the next Cloudflare write', async () => {
  const before = fixture({ staleBeforeUpload: true });
  await assert.rejects(before.run(), { code: 'deployment_drift' });
  assert.ok(!before.log.some(([name]) => name === 'upload'));
  const stale = fixture({ staleAfterUpload: true });
  await assert.rejects(stale.run(), { code: 'deployment_drift' });
  assert.ok(stale.log.some(([name]) => name === 'upload'));
  assert.ok(!stale.log.some(([name]) => name === 'deploy'));
  const lost = fixture({ failGuard: 3 });
  await assert.rejects(lost.run(), /fixture lock lost/);
  assert.ok(!lost.log.some(([name]) => name === 'deploy'));
});

test('candidate readback, runtime, and D1 identity drift block rollout', async () => {
  for (const [options, error] of [[{ wrongCandidate: true }, { code: 'candidate_unproven' }],
    [{ runtimeDrift: true }, { code: 'runtime_drift' }], [{ bindingDrift: true }, /approved upgrade plan/]]) {
    const f = fixture(options);
    await assert.rejects(f.run(), error);
    assert.equal(f.state().phase, 'staged');
    assert.ok(!f.log.some(([name]) => name === 'deploy'));
  }
});

test('ambiguous staging blocks retried requests and never attempts deployment', async () => {
  const f = fixture({ failUpload: true });
  await assert.rejects(f.run(), { code: 'upload_unconfirmed' });
  await assert.rejects(f.run(), { code: 'reconciliation_required' });
  assert.equal(f.state().phase, 'uploading');
  assert.equal(f.log.filter(([name]) => name === 'upload').length, 1);
  assert.ok(!f.log.some(([name]) => name === 'deploy'));
});

test('pre-cutover readback after lost upload acknowledges only old traffic and never replays or clears anything', async () => {
  const f = fixture({ failUpload: true });
  await assert.rejects(f.run(), { code: 'upload_unconfirmed' });
  assert.deepEqual(await confirmRecordedDeployment({ expected, operationId, api: f.api, journal: f.journal }),
    { status: 'baseline_active_upload_unconfirmed', version: release.version, operationId });
  assert.equal(f.state().phase, 'uploading');
  // The second write keeps what is known about the failure; it never clears the record.
  assert.deepEqual(f.log.filter(([action]) => action === 'journal').map(([, phase]) => phase), ['uploading', 'uploading']);
  assert.deepEqual(f.state().uploadFailure, { kind: 'unknown' });
  assert.equal(f.state().uploadStartedAt, now);
  assert.equal(f.log.filter(([action]) => action === 'upload').length, 1);
  assert.equal(f.log.filter(([action]) => action === 'deploy').length, 0);
});

test('the locked preflight stops when a newer upload appears while the previously read version still serves all traffic', async () => {
  const f = fixture();
  const changed = { ...f.api, readDeployment: () => ({
    deployments: [{ version_id: activeVersion, percentage: 100 }], latestVersion: foreignVersion,
  }) };
  await assert.rejects(f.run({ api: changed }), { code: 'baseline_version_mismatch' });
  assert.equal(f.state(), undefined);
  assert.deepEqual(f.log, []);
});

test('after staged read fails, exact candidate and old 100% traffic can be verified without cutting over', async () => {
  const f = fixture();
  const unreachableRead = { ...f.api, readVersion(target, id) {
    if (id === candidateVersion) throw new Error('fixture provider timeout');
    return f.api.readVersion(target, id);
  } };
  await assert.rejects(f.run({ api: unreachableRead }), /fixture provider timeout/);
  const mismatches = [
    { ...f.api, readDeployment: () => ({ deployments: [{ version_id: candidateVersion, percentage: 100 }], latestVersion: candidateVersion }) },
    { ...f.api, async readVersion(target, id) {
      const read = await f.api.readVersion(target, id);
      if (id === candidateVersion) read.etag = 'invalid_candidate_etag';
      return read;
    } },
  ];
  for (const api of mismatches) await assert.rejects(confirmRecordedDeployment({ expected, operationId, api, journal: f.journal }));
  assert.deepEqual(await confirmRecordedDeployment({ expected, operationId, api: f.api, journal: f.journal }),
    { status: 'baseline_active_candidate_staged', version: release.version, operationId });
  assert.equal(f.state().phase, 'staged');
  assert.deepEqual(f.log.filter(([action]) => action === 'journal').map(([, phase]) => phase), ['uploading', 'staged']);
  assert.equal(f.log.filter(([action]) => action === 'upload').length, 1);
  assert.equal(f.log.filter(([action]) => action === 'deploy').length, 0);
});

test('ambiguous deployment response or live readback never triggers a second deploy or rollback', async () => {
  for (const options of [{ failDeploy: true }, { staleAfterDeploy: true }]) {
    const f = fixture(options);
    await assert.rejects(f.run(), { code: 'deployment_unconfirmed' });
    await assert.rejects(f.run(), { code: 'reconciliation_required' });
    assert.equal(f.state().phase, 'deploying');
    assert.equal(f.log.filter(([name]) => name === 'deploy').length, 1);
  }
});

test('explicit reconciliation records only an exact already-live deployment, even if its acknowledgement was lost', async () => {
  const valid = fixture({ failDeploy: true });
  await assert.rejects(valid.run(), { code: 'deployment_unconfirmed' });
  const reconcile = f => confirmRecordedDeployment({ expected, operationId, api: f.api, journal: f.journal });
  assert.deepEqual(await reconcile(valid), { status: 'deployment_confirmed', version: release.version, operationId });
  assert.equal(valid.state().phase, 'confirmed');
  assert.deepEqual(await reconcile(valid), { status: 'previously_confirmed', version: release.version, operationId });
  assert.equal(valid.log.filter(([name]) => name === 'deploy').length, 1);
  const notLive = fixture({ staleAfterDeploy: true });
  await assert.rejects(notLive.run(), { code: 'deployment_unconfirmed' });
  assert.deepEqual(await reconcile(notLive),
    { status: 'baseline_active_rollout_unconfirmed', version: release.version, operationId });
  const candidateIsNotLatest = {
    ...notLive.api,
    async readDeployment(target) {
      return { ...await notLive.api.readDeployment(target), latestVersion: foreignVersion };
    },
  };
  await assert.rejects(confirmRecordedDeployment({ expected, operationId, api: candidateIsNotLatest, journal: notLive.journal }),
    { code: 'deployment_drift' });
  const changesDuringReadback = {
    ...notLive.api,
    async readDeployment(target) {
      const state = await notLive.api.readDeployment(target);
      if (++reads === 2) state.deployments = [{ version_id: candidateVersion, percentage: 100 }];
      return state;
    },
  };
  let reads = 0;
  await assert.rejects(confirmRecordedDeployment({ expected, operationId, api: changesDuringReadback, journal: notLive.journal }),
    { code: 'deployment_drift' });
  assert.equal(notLive.state().phase, 'deploying');
  assert.equal(notLive.log.filter(([name]) => name === 'deploy').length, 1);
});

test('schema 2 requires exact owner-approved signed bytes and provider readiness before adding only intent bindings', async () => {
  const releases = Object.fromEntries(['macos-arm64', 'macos-x64', 'linux-x64', 'linux-arm64', 'windows-x64'].map(platform =>
    [platform, { version: '0.1.6', url: 'https://signed.example.test/v0.1.6/' + platform, sha256: 'a'.repeat(64), browser: false }]));
  const body = Buffer.from(JSON.stringify({ ...release, schema: 2, enrollment: { protocol: 'intent-v1', releases } }));
  const signed = new Uint8Array(await crypto.subtle.sign('Ed25519', key.privateKey, body));
  const v2 = { ...artifact, manifest: body, signature: signed, format: 2 };
  const manifestSha256 = createHash('sha256').update(body).digest('hex');
  const exactAccessRoutes = Object.fromEntries(enrollmentUpgradeAccessPaths.map(path => [path, true]));
  const enrollmentApproval = { manifestSha256, inspect: async () => ({ verifiedD1: true, exactAccessRoutes }) };
  const id = fixture({ format2: true });
  await assert.rejects(id.run({ artifact: v2 }), { code: 'format_not_enabled' });
  await assert.rejects(id.run({ artifact: v2, enrollmentApproval: { ...enrollmentApproval, manifestSha256: 'c'.repeat(64) } }),
    { code: 'format_not_enabled' });
  await assert.rejects(id.run({ artifact: v2, enrollmentApproval: { ...enrollmentApproval, inspect: async () => ({ verifiedD1: true }) } }),
    { code: 'enrollment_not_ready' });
  assert.equal(id.log.some(([name]) => name === 'upload' || name === 'deploy'), false);
  const lost = fixture({ format2: true, failDeploy: true });
  await assert.rejects(lost.run({ artifact: v2, enrollmentApproval }), { code: 'deployment_unconfirmed' });
  assert.equal(lost.state().manifestSha256, manifestSha256);
  assert.match(lost.state().enrollmentChangesSha256, /^[a-f0-9]{64}$/);
  const upload = lost.log.find(([name]) => name === 'upload')[1];
  assert.deepEqual(upload.bindings.find(({ name }) => name === 'RELEASE_CATALOG'), { name: 'RELEASE_CATALOG', type: 'inherit' });
  assert.equal(upload.bindings.filter(({ name, type }) => name.startsWith('FLEET_ENROLLMENT_') && type === 'plain_text').length, 3);
  await confirmRecordedDeployment({ expected, operationId, api: lost.api, journal: lost.journal });
  assert.equal(lost.state().phase, 'confirmed');
  assert.equal(lost.log.filter(([name]) => name === 'deploy').length, 1);
});

test('signed preview feed migration preserves legacy devices and reconciles a lost rollout response exactly once', async () => {
  const releases = Object.fromEntries(['macos-arm64', 'linux-x64', 'windows-x64'].map(platform =>
    [platform, { version: '0.1.6', url: 'https://signed.example.test/v0.1.6/' + platform, sha256: 'a'.repeat(64), browser: false }]));
  const migration = { from: legacyPreviewFeed, to: publicPreviewFeed };
  const body = Buffer.from(JSON.stringify({ ...release, schema: 2, channel: 'preview', version: '0.1.6-preview.1',
    feedMigration: migration, enrollment: { protocol: 'intent-v1', releases } }));
  const signature = new Uint8Array(await crypto.subtle.sign('Ed25519', key.privateKey, body));
  const v2 = { ...artifact, channel: 'preview', manifest: body, signature, format: 2 };
  const manifestSha256 = createHash('sha256').update(body).digest('hex');
  const enrollmentApproval = { manifestSha256, inspect: async () => ({
    verifiedD1: true, exactAccessRoutes: Object.fromEntries(enrollmentUpgradeAccessPaths.map(path => [path, true])),
  }) };
  const lost = fixture({ format2: true, failDeploy: true, feed: legacyPreviewFeed });
  await assert.rejects(lost.run({ artifact: v2, enrollmentApproval }), { code: 'deployment_unconfirmed' });
  const upload = lost.log.find(([name]) => name === 'upload')[1];
  const binding = name => upload.bindings.find(entry => entry.name === name);
  assert.deepEqual(binding('NODRELAY_UPGRADE_FEED'), {
    name: 'NODRELAY_UPGRADE_FEED', type: 'plain_text', text: publicPreviewFeed,
  });
  for (const name of ['TICKETS', 'PROVISIONER_OAUTH', 'ACCESS_AUD', 'RELEASE_CATALOG', 'NODRELAY_UPGRADE_PUBLIC_KEY']) {
    assert.deepEqual(binding(name), { name, type: 'inherit' });
  }
  assert.equal(lost.state().migratesFeed, true);
  const wrongRead = { ...lost.api, async readVersion(target, id) {
    const read = await lost.api.readVersion(target, id);
    if (id === candidateVersion) read.bindings.find(b => b.name === 'NODRELAY_UPGRADE_FEED').text = legacyPreviewFeed;
    return read;
  } };
  await assert.rejects(confirmRecordedDeployment({ expected, operationId, api: wrongRead, journal: lost.journal }),
    /bindings do not match/);
  await confirmRecordedDeployment({ expected, operationId, api: lost.api, journal: lost.journal });
  assert.equal(lost.state().phase, 'confirmed');
  assert.equal(lost.log.filter(([name]) => name === 'deploy').length, 1);

  const foreign = fixture({ format2: true, feed: 'https://foreign.example.test/updates/' });
  await assert.rejects(foreign.run({ artifact: v2, enrollmentApproval }), { code: 'target_drift' });
  assert.equal(foreign.log.some(([name]) => name === 'upload' || name === 'deploy'), false);
});

test('an upload Cloudflare refused is settled at once and a new upgrade can start', async () => {
  const { CloudflareError } = await import('../cloud/cloudflare.mjs');
  const f = fixture();
  const refused = { ...f.api, async uploadVersion() { throw new CloudflareError('POST', 400, [10021]); },
    async taggedVersions() { return []; } };
  await assert.rejects(f.run({ api: refused }), error => error.code === 'upload_unconfirmed' &&
    /HTTP 400, codes 10021/.test(error.message) && error.failure.kind === 'refused');
  assert.deepEqual(f.state().uploadFailure, { kind: 'refused', status: 400, codes: [10021] });
  assert.deepEqual(await confirmRecordedDeployment({ expected, operationId, api: refused, journal: f.journal, now: () => now }),
    { status: 'upload_abandoned', version: release.version, operationId });
  assert.equal(f.state().phase, 'abandoned');
  assert.deepEqual(await confirmRecordedDeployment({ expected, operationId, api: refused, journal: f.journal }),
    { status: 'upload_abandoned', version: release.version, operationId }, 'checking again stays settled');
  const next = '22222222-3333-4444-8555-666666666666';
  assert.deepEqual(await f.run({ operationId: next }), { status: 'deployment_confirmed', version: '0.1.6', versionId: candidateVersion });
  assert.equal(f.state().operationId, next);
});

test('a timed-out upload is settled only after the settle time and only while no tagged version exists', async () => {
  const { CloudflareRequestTimeoutError } = await import('../cloud/cloudflare.mjs');
  const { uploadSettleMs } = await import('../cloud/upgrade-operation.mjs');
  const f = fixture();
  let tagged = [];
  const timedOut = { ...f.api, async uploadVersion() { throw new CloudflareRequestTimeoutError('POST', 30000); },
    async taggedVersions(_target, tag) { assert.equal(tag, operationId); return tagged; } };
  await assert.rejects(f.run({ api: timedOut }), /request timed out/);
  const check = at => confirmRecordedDeployment({ expected, operationId, api: timedOut, journal: f.journal, now: () => at });
  assert.deepEqual(await check(now + 60_000),
    { status: 'baseline_active_upload_unconfirmed', version: release.version, operationId, retryAfter: now + uploadSettleMs });
  assert.equal(f.state().phase, 'uploading');
  tagged = [];
  const foreign = { ...timedOut, readDeployment: async () => ({ deployments: [{ version_id: activeVersion, percentage: 100 }], latestVersion: foreignVersion }) };
  assert.equal((await confirmRecordedDeployment({ expected, operationId, api: foreign, journal: f.journal, now: () => now + uploadSettleMs })).status,
    'baseline_active_upload_unconfirmed', 'a newer unrelated upload is never treated as proof');
  assert.equal(f.state().phase, 'uploading');
  assert.equal((await check(now + uploadSettleMs)).status, 'upload_abandoned');
  assert.equal(f.log.filter(([action]) => action === 'deploy').length, 0);
});

test('an upload that did land is recorded as the staged candidate, never as abandoned', async () => {
  const f = fixture({ failUpload: true });
  await assert.rejects(f.run(), { code: 'upload_unconfirmed' });
  const api = { ...f.api, async taggedVersions() { return [candidateVersion]; } };
  assert.deepEqual(await confirmRecordedDeployment({ expected, operationId, api, journal: f.journal, now: () => now + 3_600_000 }),
    { status: 'baseline_active_candidate_staged', version: release.version, operationId });
  assert.equal(f.state().phase, 'staged');
  assert.equal(f.state().candidateVersion, candidateVersion);
  assert.equal(f.state().candidateEtag, candidate.etag);
  const twice = { ...f.api, async taggedVersions() { return [candidateVersion, foreignVersion]; } };
  const g = fixture({ failUpload: true });
  await assert.rejects(g.run(), { code: 'upload_unconfirmed' });
  await assert.rejects(confirmRecordedDeployment({ expected, operationId, api: twice, journal: g.journal }), { code: 'candidate_unproven' });
});

test('a record from before upload timestamps starts its settle wait at the first check', async () => {
  const { uploadSettleMs } = await import('../cloud/upgrade-operation.mjs');
  const legacy = { operationId, baseVersion: activeVersion, releaseVersion: release.version, releaseSha256: release.workerSha256, phase: 'uploading' };
  const f = fixture({ initialJournal: legacy });
  const api = { ...f.api, async taggedVersions() { return []; } };
  const check = at => confirmRecordedDeployment({ expected, operationId, api, journal: f.journal, now: () => at });
  assert.equal((await check(now)).retryAfter, now + uploadSettleMs);
  assert.equal(f.state().uploadCheckedAt, now);
  assert.equal((await check(now + uploadSettleMs - 1)).status, 'baseline_active_upload_unconfirmed');
  assert.equal((await check(now + uploadSettleMs)).status, 'upload_abandoned');
});

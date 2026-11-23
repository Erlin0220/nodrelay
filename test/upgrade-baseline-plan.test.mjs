import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { adoptManagementUpgradeBaseline } from '../src/management-upgrade-baseline.mjs';
import { bridgeCatalogDigest, planUpgradeBaseline, validateUpgradeBaselineCandidate } from '../cloud/upgrade-baseline-plan.mjs';

const activeVersion = '11111111-2222-3333-4444-555555555555';
const candidateVersion = '22222222-3333-4444-5555-666666666666';
const expected = {
  accountId: 'a'.repeat(32), zoneId: 'b'.repeat(32), worker: 'fleet-fixture-111111111111',
  origin: 'https://fixture-fleet.example.test', ownerEmail: 'owner@example.test', accessAudience: 'fixture-access-audience',
  activeVersion, databaseId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', namespaceId: 'c'.repeat(32),
};
const { publicKey } = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
const spki = Buffer.from(await crypto.subtle.exportKey('spki', publicKey)).toString('base64url');
const release = {
  automaticAdministrator: true, clientId: 'fixture-public-client',
  releases: { 'macos-arm64': { version: '0.1.5', browser: false,
    url: 'https://fixture.example.test/v0.1.5/agent.tgz', sha256: 'd'.repeat(64) } },
  webUpgrade: { version: '0.1.8-preview.2', channel: 'preview', feed: 'https://fixture.example.test/preview/', publicKey: spki },
};
const { accountId, zoneId, worker, origin, ownerEmail } = expected;
const plain = {
  APP_ORIGIN: origin, OWNER_EMAIL: ownerEmail, ACCESS_ISSUER: 'https://fixture.cloudflareaccess.com',
  ACCESS_AUD: expected.accessAudience,
  FLEET_SPEC: JSON.stringify({ accountId, zoneId, worker, label: worker, origin, ownerEmail, accountScopedAccess: true }),
  RELEASE_CATALOG: JSON.stringify({ 'macos-arm64': { sha256: 'd'.repeat(64), url: 'https://fixture.example.test/v0.1.5/agent.tgz',
    browser: false, version: '0.1.5' } }),
  FLEET_OAUTH_CLIENT_ID: release.clientId, FLEET_OAUTH_MODE: 'managed', FLEET_OAUTH_RECOVERY: '1',
};
const active = { id: activeVersion, etag: 'provider_active_etag', bindings: [
  ...Object.entries(plain).map(([name, text]) => ({ type: 'plain_text', name, text })),
  { name: 'TICKETS', type: 'd1', id: expected.databaseId },
  { name: 'PROVISIONER_OAUTH', type: 'durable_object_namespace', namespace_id: expected.namespaceId, class_name: 'OAuthProvisioner' },
  { name: 'TICKET_KEY', type: 'secret_text' }, { name: 'FLEET_OAUTH_KEY', type: 'secret_text' },
], runtime: { compatibilityDate: '2026-07-30', compatibilityFlags: ['flag_b', 'flag_a'], migrationTag: 'nodrelay-oauth-v1', usageModel: 'standard' } };
const deployment = { deployments: [{ version_id: activeVersion, percentage: 100 }], latestVersion: activeVersion };
const input = { release, expected, deployment, active };
const patched = (name, properties) => active.bindings.map(b => b.name === name ? { ...b, ...properties } : b);

test('adds only four signed baseline settings and explicitly inherits the existing bindings', () => {
  const proposed = planUpgradeBaseline(input);
  assert.equal(proposed.activeVersion, activeVersion);
  assert.equal(proposed.upload.bindingsInherit, 'strict');
  assert.deepEqual(proposed.upload.bindings, [
    ...active.bindings.map(({ name }) => ({ type: 'inherit', name })),
    { name: 'NODRELAY_RELEASE_VERSION', type: 'plain_text', text: release.webUpgrade.version },
    { name: 'NODRELAY_UPGRADE_CHANNEL', type: 'plain_text', text: release.webUpgrade.channel },
    { name: 'NODRELAY_UPGRADE_PUBLIC_KEY', type: 'plain_text', text: spki },
    { name: 'NODRELAY_UPGRADE_FEED', type: 'plain_text', text: release.webUpgrade.feed },
  ]);
  assert.equal(proposed.upload.compatibilityDate, active.runtime.compatibilityDate);
  assert.deepEqual(proposed.upload.compatibilityFlags, ['flag_a', 'flag_b']);
  assert.equal(proposed.expectedRuntime.migrationTag, active.runtime.migrationTag);
  assert.ok(!('migrations' in proposed.upload) && !('migrationTag' in proposed.upload));
  assert.ok(!JSON.stringify(proposed.upload).includes(expected.ownerEmail));
  assert.ok(Object.isFrozen(proposed.upload.bindings));
  assert.ok(proposed.upload.bindings.every(Object.isFrozen));
});

test('blocks changed ownership/resources, split or staged deployment, and a different live catalog', () => {
  for (const expectedChange of [
    { accountId: 'f'.repeat(32) }, { zoneId: 'e'.repeat(32) }, { worker: 'fleet-other-111111111111' },
    { origin: 'https://other.example.test' }, { ownerEmail: 'other@example.test' }, { accessAudience: 'other-access-audience' },
    { databaseId: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff' }, { namespaceId: 'a'.repeat(32) },
  ]) assert.throws(() => planUpgradeBaseline({ ...input, expected: { ...expected, ...expectedChange } }), /identity or persistent/);
  assert.throws(() => planUpgradeBaseline({ ...input, deployment: { ...deployment, latestVersion: candidateVersion } }), /authorized baseline target/);
  assert.throws(() => planUpgradeBaseline({ ...input, deployment: { ...deployment,
    deployments: [{ version_id: activeVersion, percentage: 90 }, { version_id: candidateVersion, percentage: 10 }] } }), /100% active/);
  assert.throws(() => planUpgradeBaseline({ ...input, active: { ...active, bindings: patched('RELEASE_CATALOG', { text: '{}' }) } }), /live catalog/);
  assert.throws(() => planUpgradeBaseline({ ...input, active: { ...active, bindings: patched('FLEET_OAUTH_CLIENT_ID', { text: 'other-client' }) } }), /identity or persistent/);
  assert.throws(() => planUpgradeBaseline({ ...input, active: { ...active, runtime: { ...active.runtime, migrationTag: 'different' } } }), /migration metadata/);
});

test('blocks every partial baseline, legacy or unsettled authorization and invalid signed metadata', () => {
  for (const name of ['NODRELAY_RELEASE_VERSION', 'NODRELAY_UPGRADE_CHANNEL', 'NODRELAY_UPGRADE_PUBLIC_KEY', 'NODRELAY_UPGRADE_FEED']) {
    assert.throws(() => planUpgradeBaseline({ ...input,
      active: { ...active, bindings: [...active.bindings, { name, type: 'plain_text', text: '' }] } }), /partial web-upgrade/);
  }
  for (const name of ['PROVISIONER_TOKEN', 'FLEET_OAUTH_SEED', 'FLEET_OAUTH_RECONNECT']) {
    assert.throws(() => planUpgradeBaseline({ ...input,
      active: { ...active, bindings: [...active.bindings, { name, type: 'secret_text' }] } }), /unsettled/);
  }
  assert.throws(() => planUpgradeBaseline({ ...input, active: { ...active, bindings: patched('TICKET_KEY', { text: 'must-not-echo' }) } }),
    error => /binding metadata/.test(error.message) && !error.message.includes('must-not-echo'));
  for (const fields of [{ version: '0.1.08' }, { channel: 'stable' }, { feed: 'https://fixture.example.test/?x=1' },
    { feed: 'http://fixture.example.test/preview/' }, { publicKey: 'a'.repeat(59) }]) {
    assert.throws(() => planUpgradeBaseline({ ...input,
      release: { ...release, webUpgrade: { ...release.webUpgrade, ...fields } } }), /signed owner-managed/);
  }
  assert.throws(() => planUpgradeBaseline({ ...input, release: { ...release, automaticAdministrator: false } }), /signed owner-managed/);
});

test('candidate readback must have the staged identity, exact bindings and unchanged runtime', () => {
  const plan = planUpgradeBaseline(input);
  const staged = { id: candidateVersion, etag: 'provider_candidate_etag' };
  const candidate = { ...staged, runtime: structuredClone(active.runtime), bindings: [...plan.expectedBindings].reverse() };
  assert.deepEqual(validateUpgradeBaselineCandidate(plan, { staged, candidate }), { versionId: candidateVersion });
  assert.throws(() => validateUpgradeBaselineCandidate(plan, { staged, candidate: { ...candidate, etag: 'changed_candidate_etag' } }), /readback/);
  assert.throws(() => validateUpgradeBaselineCandidate(plan, { staged, candidate: { ...candidate, bindings: candidate.bindings.slice(1) } }), /changed a binding/);
  const drift = candidate.bindings.map(b => b.name === 'TICKETS' ? { ...b, id: 'ffffffff-eeee-dddd-cccc-bbbbbbbbbbbb' } : b);
  assert.throws(() => validateUpgradeBaselineCandidate(plan, { staged, candidate: { ...candidate, bindings: drift } }), /changed a binding/);
  assert.throws(() => validateUpgradeBaselineCandidate(plan, { staged, candidate: { ...candidate,
    runtime: { ...candidate.runtime, compatibilityFlags: [] } } }), /runtime setting/);
});

const migrationFile = file => readFile(new URL('../cloud/' + file, import.meta.url), 'utf8');

async function bridgeFixture(t, behavior = {}) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  for (const file of ['0001_tickets.sql', '0002_devices.sql', '0003_portal_callback_labels.sql']) db.exec(await migrationFile(file));
  db.exec('CREATE TABLE fixture_preserved(value TEXT); INSERT INTO fixture_preserved VALUES (\'keep\');');
  if (behavior.historicalSchema) db.exec("CREATE TABLE enrollment_intents (id TEXT PRIMARY KEY NOT NULL, device_id TEXT NOT NULL, state TEXT NOT NULL);");
  let row, live = activeVersion, latest = activeVersion, writes = [], failedBeforeDispatch = false;
  const installed = { ...release, bundle: Buffer.from('export default {fetch(){return new Response("Nodrelay")}};') };
  const journal = { read: async () => row, write: async record => { row = structuredClone(record); } };
  const providerVersion = (id, bindings, etag) => ({ id, resources: { script: { etag }, bindings,
    script_runtime: { compatibility_date: active.runtime.compatibilityDate, compatibility_flags: active.runtime.compatibilityFlags,
      migration_tag: active.runtime.migrationTag, usage_model: active.runtime.usageModel } } });
  const activeWire = providerVersion(activeVersion, active.bindings, active.etag);
  let candidateWire;
  const workerBase = '/accounts/' + accountId + '/workers/scripts/' + worker;
  const api = {
    async get(path) {
      if (path === workerBase + '/deployments' && behavior.failFencePhase && row?.phase === behavior.failFencePhase && !failedBeforeDispatch) {
        failedBeforeDispatch = true;
        throw new Error('failed before dispatch');
      }
      if (path === workerBase + '/deployments') return { deployments: [{ id: activeVersion, strategy: 'percentage',
        versions: [{ version_id: live, percentage: 100 }] }] };
      if (path === workerBase + '/versions') return { items: [{ id: latest }] };
      if (path === workerBase + '/versions/' + activeVersion) return activeWire;
      if (path === workerBase + '/versions/' + candidateVersion && candidateWire) return candidateWire;
      throw new Error('unexpected GET');
    },
    async post(path, body) {
      if (path === '/accounts/' + accountId + '/d1/database/' + expected.databaseId + '/query') {
        // Real SQLite for idempotent DDL, D1 owner lease and parameter binding.
        if (body.sql.trim().startsWith('CREATE TABLE')) { db.exec(body.sql); return [{ success: true, results: [] }]; }
        const query = db.prepare(body.sql);
        if (body.sql.startsWith('DELETE')) { query.run(...body.params); return [{ success: true, results: [] }]; }
        return [{ success: true, results: query.all(...body.params) }];
      }
      writes.push(path);
      if (path === workerBase + '/versions?bindings_inherit=strict') {
        const meta = JSON.parse(await body.get('metadata').text());
        assert.ok(!Object.hasOwn(meta, 'migrations'));
        assert.deepEqual(meta.bindings.filter(item => item.type !== 'inherit').map(item => item.name).sort(), [
          'NODRELAY_RELEASE_VERSION', 'NODRELAY_UPGRADE_CHANNEL', 'NODRELAY_UPGRADE_FEED', 'NODRELAY_UPGRADE_PUBLIC_KEY',
        ]);
        assert.deepEqual(Buffer.from(await body.get('worker.js').arrayBuffer()), installed.bundle);
        candidateWire = providerVersion(candidateVersion, meta.bindings.map(item => item.type === 'inherit' ?
          active.bindings.find(before => before.name === item.name) : item), 'provider_candidate_etag');
        if (behavior.candidateDrift) candidateWire.resources.bindings = candidateWire.resources.bindings.slice(1);
        latest = candidateVersion;
        return candidateWire;
      }
      if (path === workerBase + '/deployments') {
        assert.deepEqual(body.versions, [{ version_id: candidateVersion, percentage: 100 }]);
        live = candidateVersion;
        if (behavior.lostAck) throw new Error('response lost after deployment');
        return { id: candidateVersion };
      }
      throw new Error('unexpected POST');
    }
  };
  return { db, writes, state: () => row, live: () => live, run: () =>
    adoptManagementUpgradeBaseline({ api, expected, release: installed, journal, readMigration: migrationFile }) };
}

test('old installation adopts the signed web baseline; rerun only reads back, keeping existing data', async t => {
  const fixture = await bridgeFixture(t);
  assert.deepEqual(await fixture.run(), { versionId: candidateVersion, releaseVersion: release.webUpgrade.version, recovered: false });
  assert.equal(fixture.writes.length, 2);
  assert.equal(fixture.state().phase, 'confirmed');
  assert.equal(fixture.live(), candidateVersion);
  assert.equal(fixture.db.prepare('SELECT value FROM fixture_preserved').get().value, 'keep');
  assert.ok(fixture.db.prepare("SELECT name FROM sqlite_schema WHERE name='management_upgrade_journal'").get());
  assert.equal(fixture.db.prepare('SELECT COUNT(*) AS count FROM fleet_leases').get().count, 0);
  assert.equal((await fixture.run()).recovered, true);
  assert.equal(fixture.writes.length, 2);
});

test('misconfigured candidate never cuts traffic, and a lost deployment receipt is reconciled without a second POST', async t => {
  const drift = await bridgeFixture(t, { candidateDrift: true });
  await assert.rejects(drift.run(), /changed a binding/);
  assert.equal(drift.live(), activeVersion);
  assert.equal(drift.writes.length, 1);
  assert.equal(drift.state().phase, 'staged');
  const lostAck = await bridgeFixture(t, { lostAck: true });
  await assert.rejects(lostAck.run(), /response lost/);
  assert.equal(lostAck.state().phase, 'deploying');
  assert.equal((await lostAck.run()).recovered, true);
  assert.equal(lostAck.state().phase, 'confirmed');
  assert.equal(lostAck.writes.length, 2);
});

test('an existing D1 lease prevents the bridge from publishing anything', async t => {
  const fixture = await bridgeFixture(t);
  fixture.db.prepare('INSERT INTO fleet_leases VALUES (1, ?, ?)').run('someone-else', Math.floor(Date.now()/1000) + 90);
  await assert.rejects(fixture.run(), /已有管理操作/);
  assert.deepEqual(fixture.writes, []);
  assert.equal(fixture.state(), undefined);
});

test('rerunning the same command resumes after a pre-dispatch Cloudflare read failure', async t => {
  for (const [failFencePhase, expectedPhase, writes] of [['uploading', 'prepared', 0], ['deploying', 'staged', 1]]) {
    const fixture = await bridgeFixture(t, { failFencePhase });
    await assert.rejects(fixture.run(), /failed before dispatch/);
    assert.equal(fixture.state().phase, expectedPhase);
    assert.equal(fixture.live(), activeVersion);
    assert.equal(fixture.writes.length, writes);
    assert.equal((await fixture.run()).versionId, candidateVersion);
    assert.equal(fixture.writes.length, 2);
  }
});

test('historical enrollment schema does not pass a create-if-not-exists migration', async t => {
  const fixture = await bridgeFixture(t, { historicalSchema: true });
  await assert.rejects(fixture.run(), /数据表结构/);
  assert.deepEqual(fixture.writes, []);
  assert.equal(fixture.live(), activeVersion);
});

test('one signed kit may package new devices for fresh installs and carry a verified legacy catalog for adoption', () => {
  const next = { ...release, releases: { 'macos-arm64': { ...release.releases['macos-arm64'], version: '0.1.6' } } };
  assert.throws(() => planUpgradeBaseline({ ...input, release: next }), /live catalog/);
  const bridge = planUpgradeBaseline({ ...input, release: { ...next, bridgeCatalogSha256: bridgeCatalogDigest(release.releases) } });
  assert.deepEqual(bridge.upload.bindings.find(x => x.name === 'RELEASE_CATALOG'), { name: 'RELEASE_CATALOG', type: 'inherit' });
  assert.equal(bridge.expectedBindings.find(x => x.name === 'RELEASE_CATALOG').text, plain.RELEASE_CATALOG);
  assert.throws(() => planUpgradeBaseline({ ...input, release: { ...next, bridgeCatalogSha256: 'c'.repeat(64) } }), /live catalog/);
});

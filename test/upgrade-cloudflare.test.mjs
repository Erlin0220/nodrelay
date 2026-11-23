import assert from 'node:assert/strict';
import test from 'node:test';
import { cloudflareApi } from '../cloud/cloudflare.mjs';
import { createCloudflareUpgradeAdapter } from '../cloud/upgrade-cloudflare.mjs';

const target = { accountId: 'a'.repeat(32), worker: 'fleet-my-nodrelay-0123456789ab' };
const path = `/accounts/${target.accountId}/workers/scripts/${target.worker}`;
const previous = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const next = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
const deploymentId = 'cccccccc-dddd-eeee-ffff-aaaaaaaaaaaa';
const d1Id = 'dddddddd-eeee-ffff-aaaa-bbbbbbbbbbbb';
const namespaceId = 'b'.repeat(32);
const etag = 'provider_version_etag';
const weights = (version = previous) => [{ version_id: version, percentage: 100 }];
const deployment = (versions = weights()) => ({ id: deploymentId, strategy: 'percentage', versions });
const base = {
  id: next, resources: {
    bindings: [{ name: 'OWNER_EMAIL', type: 'plain_text', text: 'fixture@example.test' },
      { name: 'TICKET_KEY', type: 'secret_text' }, { name: 'FLEET_OAUTH_KEY', type: 'secret_text' },
      { name: 'TICKETS', type: 'd1', database_id: d1Id },
      { name: 'PROVISIONER_OAUTH', type: 'durable_object_namespace', class_name: 'OAuthProvisioner', namespace_id: namespaceId }],
    script: { etag },
    script_runtime: { compatibility_date: '2026-07-30', migration_tag: 'nodrelay-oauth-v1', usage_model: 'standard',
      exports: { OAuthProvisioner: { type: 'durable-object', storage: 'sqlite' } } },
  },
};
const upload = { bundle: new TextEncoder().encode('export default {};'), module: 'worker.js', bindingsInherit: 'strict',
  bindings: [...['TICKETS', 'TICKET_KEY', 'FLEET_OAUTH_KEY', 'PROVISIONER_OAUTH'].map(name => ({ name, type: 'inherit' })),
    { name: 'NODRELAY_RELEASE_VERSION', type: 'plain_text', text: '0.1.6-preview.3' }],
  compatibilityDate: '2026-07-30', compatibilityFlags: [], usageModel: 'standard',
  operationId: '11111111-2222-4333-8444-555555555555',
};

test('reads the active deployment and most recent unfiltered upload separately', async () => {
  const seen = [];
  const adapter = createCloudflareUpgradeAdapter({
    async get(route, query) {
      seen.push(route);
      assert.deepEqual(query, { page: 1, per_page: 1 });
      if (route === path + '/deployments') return { deployments: [deployment(), deployment(weights(next))] };
      assert.equal(route, path + '/versions');
      return { items: [{ id: next }, { id: previous }] };
    }, post() { assert.fail('read only'); },
  }, target);
  assert.deepEqual(await adapter.readDeployment(target), { deployments: weights(), latestVersion: next });
  assert.deepEqual(seen.sort(), [path + '/deployments', path + '/versions']);
  await assert.rejects(adapter.readDeployment({ ...target, worker: 'fleet-other-0123456789ab' }), /target changed/);
  assert.equal(seen.length, 2);
});

test('normalizes official version response without reading any secret values', async () => {
  const version = structuredClone(base);
  const api = { get(route) { assert.equal(route, path + '/versions/' + next); return version; },
    post() { assert.fail('read only'); } };
  const adapter = createCloudflareUpgradeAdapter(api, target);
  const expected = {
    id: next, etag,
    bindings: [{ name: 'OWNER_EMAIL', type: 'plain_text', text: 'fixture@example.test' },
      { name: 'TICKET_KEY', type: 'secret_text' }, { name: 'FLEET_OAUTH_KEY', type: 'secret_text' },
      { name: 'TICKETS', type: 'd1', id: d1Id },
      { name: 'PROVISIONER_OAUTH', type: 'durable_object_namespace', class_name: 'OAuthProvisioner', namespace_id: namespaceId }],
    runtime: { compatibilityDate: '2026-07-30', compatibilityFlags: [], migrationTag: 'nodrelay-oauth-v1', usageModel: 'standard' },
  };
  assert.deepEqual(await adapter.readVersion(target, next), expected);
  version.resources.bindings[3] = { name: 'TICKETS', type: 'd1', id: d1Id };
  version.resources.bindings[4].script_name = target.worker;
  assert.deepEqual(await adapter.readVersion(target, next), expected);
  await assert.rejects(adapter.readVersion(target, '../settings'), /Invalid Cloudflare Worker version ID/);
});

test('incomplete or unexpected provider data fails closed without diagnostics containing binding values', async () => {
  for (const [mutate, expectedError] of [
    [data => { data.id = previous; }, /requested Worker version/],
    [data => { delete data.resources.script.etag; }, /requested Worker version/],
    [data => { data.resources.bindings = {}; }, /binding list/],
    [data => { data.resources.bindings[1].text = 'fixture-must-not-echo'; }, /Worker version binding/],
    [data => { data.resources.bindings[3].id = previous; }, /Worker version binding/],
    [data => { delete data.resources.bindings[4].namespace_id; }, /Worker version binding/],
    [data => { data.resources.bindings[4].script_name = 'other-worker'; }, /Worker version binding/],
    [data => { data.resources.bindings.pop(); }, /binding identities/],
    [data => { delete data.resources.script_runtime.migration_tag; }, /migration metadata/],
    [data => { delete data.resources.script_runtime.usage_model; }, /migration metadata/],
    [data => { data.resources.script_runtime.exports.OAuthProvisioner.storage = 'legacy-kv'; }, /SQLite/],
  ]) {
    const data = structuredClone(base);
    mutate(data);
    const adapter = createCloudflareUpgradeAdapter({ get: () => data, post() { assert.fail('read only'); } }, target);
    await assert.rejects(adapter.readVersion(target, next), error =>
      expectedError.test(error.message) && !error.message.includes('fixture-must-not-echo'));
  }
});

test('sends only code and allowlisted metadata via multipart and then deploys one version at 100 percent', async () => {
  const seen = [];
  // Test the actual Cloudflare envelope helper with a synthetic request only.
  const api = cloudflareApi('fixture-unused', { async request(url, options) {
    assert.equal(options.method, 'POST');
    seen.push(url.pathname + url.search);
    if (url.pathname.endsWith('/versions')) {
      assert.equal(url.search, '?bindings_inherit=strict');
      assert.ok(options.body instanceof FormData);
      assert.deepEqual([...options.body.keys()].sort(), ['metadata', 'worker.js']);
      const metadata = options.body.get('metadata');
      const worker = options.body.get('worker.js');
      assert.equal(metadata.type, 'application/json');
      assert.equal(worker.type, 'application/javascript+module');
      assert.deepEqual(new Uint8Array(await worker.arrayBuffer()), upload.bundle);
      assert.deepEqual(JSON.parse(await metadata.text()), { main_module: 'worker.js',
        compatibility_date: upload.compatibilityDate, compatibility_flags: [], usage_model: 'standard', bindings: upload.bindings,
        annotations: { 'workers/tag': upload.operationId } });
      return Response.json({ success: true, result: { id: next, resources: { script: { etag } } } });
    }
    assert.equal(url.pathname, '/client/v4' + path + '/deployments');
    assert.deepEqual(JSON.parse(options.body), { strategy: 'percentage', versions: weights(next) });
    return Response.json({ success: true, result: { id: deploymentId } });
  } });
  const adapter = createCloudflareUpgradeAdapter(api, target);
  assert.deepEqual(await adapter.uploadVersion(target, upload), { id: next, etag });
  assert.deepEqual(await adapter.deployVersion(target, { strategy: 'percentage', versions: weights(next) }), { id: deploymentId });
  assert.deepEqual(seen, ['/client/v4' + path + '/versions?bindings_inherit=strict', '/client/v4' + path + '/deployments']);
});

test('rejects capability expansion and unverified mutation acknowledgments with no implicit retries', async () => {
  let calls = 0;
  const adapter = createCloudflareUpgradeAdapter({
    get() { assert.fail('no implicit requests'); },
    post(route) {
      calls += 1;
      if (route.endsWith('/deployments')) return deployment(weights(previous));
      return { id: next, resources: { script: { etag } }, exports_reconciliation: { created: ['unexpected'] } };
    },
  }, target);
  await assert.rejects(adapter.uploadVersion(target, { ...upload, migrations: [] }), /upload input/);
  await assert.rejects(adapter.uploadVersion(target, { ...upload, bindingsInherit: 'permissive' }), /upload input/);
  await assert.rejects(adapter.uploadVersion(target, { ...upload,
    bindings: [...upload.bindings, { name: 'NEW_TOKEN', type: 'secret_text', text: 'fixture' }] }), /only inherit/);
  await assert.rejects(adapter.uploadVersion(target, { ...upload,
    bindings: upload.bindings.map(binding => binding.name === 'TICKET_KEY' ? { ...binding, version_id: previous } : binding) }), /only inherit/);
  await assert.rejects(adapter.deployVersion(target, { strategy: 'percentage', versions: [{ version_id: next, percentage: 80 }] }), /one verified version/);
  assert.equal(calls, 0);
  await assert.rejects(adapter.uploadVersion(target, upload), /code-only staged/);
  await assert.rejects(adapter.deployVersion(target, { strategy: 'percentage', versions: weights(next) }), /requested full rollout/);
  assert.equal(calls, 2);
});

test('an upload rejected before sending is marked unsent, and tagged versions are found by operation', async () => {
  const target = { accountId: 'a'.repeat(32), worker: 'fleet-demo-111111111111' };
  const tag = '11111111-2222-4333-8444-555555555555';
  const seen = [];
  const api = { async get(path, query) { seen.push([path, query]); return { items: [
    { id: '11111111-2222-3333-4444-555555555555', annotations: { 'workers/tag': tag } },
    { id: '22222222-3333-4444-5555-666666666666', annotations: { 'workers/triggered_by': 'upload' } },
  ] }; }, async post() { throw new Error('must not be sent'); } };
  const adapter = createCloudflareUpgradeAdapter(api, target);
  await assert.rejects(adapter.uploadVersion(target, { bundle: new Uint8Array(), module: 'worker.js' }),
    error => error.notSent === true && /Invalid staged Cloudflare Worker upload input/.test(error.message));
  assert.deepEqual(await adapter.taggedVersions(target, tag), ['11111111-2222-3333-4444-555555555555']);
  assert.deepEqual(seen[0], ['/accounts/' + target.accountId + '/workers/scripts/' + target.worker + '/versions', { page: 1, per_page: 20 }]);
  await assert.rejects(adapter.taggedVersions(target, 'not-a-uuid'), /Invalid Cloudflare upgrade operation tag/);
});

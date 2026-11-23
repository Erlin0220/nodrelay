import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { validateUpgradePreconditions, verifyUpgradeRelease } from '../cloud/upgrade-plan.mjs';

const now = Date.parse('2026-11-20T12:00:00.000Z');
const bundle = Buffer.from('export default { fetch: () => new Response("ok") };');
const signed = {
  schema: 1, product: 'nodrelay-management', channel: 'stable', version: '0.1.6', minimumVersion: '0.1.4',
  issuedAt: '2026-11-19T12:00:00.000Z', expiresAt: '2026-12-19T12:00:00.000Z', workerBundle: 'worker.js',
  workerSha256: createHash('sha256').update(bundle).digest('hex'),
};
const signer = await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify']);
async function releaseInput(changes = {}, input = {}) {
  const manifest = Buffer.from(JSON.stringify({ ...signed, ...changes }) + '\n');
  return {
    manifest, signature: new Uint8Array(await crypto.subtle.sign('Ed25519', signer.privateKey, manifest)),
    bundle, publicKey: signer.publicKey, channel: 'stable', currentVersion: '0.1.5', now, ...input,
  };
}

test('checks exact Ed25519 manifest bytes and pins exact Worker bytes', async () => {
  const input = await releaseInput();
  const result = await verifyUpgradeRelease(input);
  assert.deepEqual(result.release, signed);
  assert.ok(Object.isFrozen(result.release));
  assert.deepEqual(Buffer.from(result.bundle), bundle);
  assert.notEqual(result.bundle.buffer, bundle.buffer);

  const wrong = await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify']);
  await assert.rejects(verifyUpgradeRelease({ ...input, publicKey: wrong.publicKey }), /signature/);
  await assert.rejects(verifyUpgradeRelease({ ...input, publicKey: signer.privateKey }), /pinned/);
  await assert.rejects(verifyUpgradeRelease({ ...input, manifest: Buffer.concat([input.manifest, Buffer.from('\n')]) }), /signature/);
  await assert.rejects(verifyUpgradeRelease({ ...input, signature: new Uint8Array(65) }), /artifact size/);
  await assert.rejects(verifyUpgradeRelease({ ...input, bundle: Buffer.from('different Worker') }), /SHA-256/);
  await assert.rejects(verifyUpgradeRelease({ ...input, bundle: new Uint8Array(8 * 1024 * 1024 + 1) }), /artifact size/);
});

test('schema-2 enrollments explicitly select format and digest exact signed bytes, not parsed JSON', async () => {
  const enrollment = { protocol: 'intent-v1', releases: Object.fromEntries([
    'windows-x64', 'macos-arm64', 'macos-x64', 'linux-x64', 'linux-arm64',
  ].map(target => [target, { url: `https://download.example.test/0.1.6/${target}`, sha256: 'a'.repeat(64),
    version: '0.1.6', browser: false }])) };
  const raw = { ...signed, schema: 2, enrollment };
  const inputs = await Promise.all([JSON.stringify(raw) + '\n', JSON.stringify(raw, null, 2).replace('intent-v1', 'intent-\\u00761')]
    .map(async text => {
      const manifest = Buffer.from(text);
      return { ...await releaseInput(), manifest, format: 2,
        signature: new Uint8Array(await crypto.subtle.sign('Ed25519', signer.privateKey, manifest)) };
    }));
  const results = await Promise.all(inputs.map(verifyUpgradeRelease));
  for (const [index, result] of results.entries()) {
    assert.equal(result.manifestSha256, createHash('sha256').update(inputs[index].manifest).digest('hex'));
    assert.deepEqual(result.release.enrollment, enrollment);
    assert.ok(Object.isFrozen(result.release.enrollment.releases['linux-x64']));
  }
  assert.notEqual(results[0].manifestSha256, results[1].manifestSha256);
  await assert.rejects(verifyUpgradeRelease({ ...inputs[0], format: undefined }), /metadata/);
  await assert.rejects(verifyUpgradeRelease({ ...inputs[1], signature: inputs[0].signature }), /signature/);
  await assert.rejects(verifyUpgradeRelease(await releaseInput({}, { format: 2 })), /metadata/);
  await assert.rejects(verifyUpgradeRelease(await releaseInput({ schema: 2, enrollment: { ...enrollment, releases: {} } }, { format: 2 })), /currently supported installer targets/);
  assert.equal(Object.hasOwn(await verifyUpgradeRelease(await releaseInput()), 'manifestSha256'), false);
});

test('channel, minimum version, monotonic version, signed lifetime and fixed artifact path fail closed', async () => {
  for (const [changes, supplied, error] of [
    [{ channel: 'preview', version: '0.1.6-preview.1' }, {}, /channel/],
    [{ version: '0.1.6-preview.1' }, {}, /channel/],
    [{ channel: 'preview' }, { channel: 'preview' }, /channel/],
    [{ version: '0.1.5' }, {}, /not newer/],
    [{ version: '0.1.4' }, {}, /not newer/],
    [{ version: '0.01.6' }, {}, /Invalid Nodrelay upgrade version/],
    [{ minimumVersion: '0.1.6' }, {}, /cannot upgrade/],
    [{ issuedAt: '2026-11-20T12:00:00.001Z' }, {}, /not current/],
    [{ expiresAt: '2026-11-20T12:00:00.000Z' }, {}, /not current/],
    [{ expiresAt: '2027-11-20T12:00:00.000Z' }, {}, /not current/],
    [{ issuedAt: '2026-11-19' }, {}, /not current/],
    [{ workerBundle: '../worker.js' }, {}, /metadata/],
    [{ alternateUrl: 'https://example.test/worker.js' }, {}, /metadata/],
  ]) await assert.rejects(verifyUpgradeRelease(await releaseInput(changes, supplied)), error);

  const preview = { channel: 'preview', version: '0.1.6-preview.10' };
  const current = { channel: 'preview', currentVersion: '0.1.6-preview.9' };
  assert.equal((await verifyUpgradeRelease(await releaseInput(preview, current))).release.version, preview.version);
  await assert.rejects(verifyUpgradeRelease(await releaseInput({ ...preview, version: '0.1.6-preview.8' }, current)), /not newer/);
});

const activeVersion = '11111111-2222-3333-4444-555555555555';
const otherVersion = '22222222-3333-4444-5555-666666666666';
const activeBindings = [
  ...Object.entries({
    APP_ORIGIN: 'https://manager.example.test', ACCESS_ISSUER: 'https://fixture.cloudflareaccess.com', ACCESS_AUD: 'fixture-aud',
    OWNER_EMAIL: 'owner@example.test', FLEET_SPEC: '{}', RELEASE_CATALOG: '{"current":true}', FLEET_OAUTH_CLIENT_ID: 'fixture-client',
    FLEET_OAUTH_MODE: 'managed', FLEET_OAUTH_RECOVERY: '1',
  }).map(([name, text]) => ({ name, type: 'plain_text', text })),
  { name: 'TICKETS', id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', type: 'd1' },
  { name: 'PROVISIONER_OAUTH', type: 'durable_object_namespace', class_name: 'OAuthProvisioner', namespace_id: 'a'.repeat(32) },
  { name: 'TICKET_KEY', type: 'secret_text' },
  { name: 'FLEET_OAUTH_KEY', type: 'secret_text' },
];
const plan = { deployments: [{ version_id: activeVersion, percentage: 100 }], latestVersion: activeVersion,
  activeBindings, candidateBindings: activeBindings.toReversed() };
function edit(bindings, name, replacement) {
  return bindings.map(binding => binding.name === name ? { ...binding, ...replacement } : binding);
}

test('requires precisely one 100 percent active version matching the latest upload', () => {
  assert.deepEqual(validateUpgradePreconditions(plan), { activeVersion });
  for (const modified of [
    { deployments: [] },
    { deployments: [{ version_id: activeVersion, percentage: 99 }, { version_id: otherVersion, percentage: 1 }] },
    { deployments: [{ version_id: activeVersion, percentage: 90 }] },
    { deployments: [{ version_id: activeVersion, percentage: '100' }] },
    { latestVersion: otherVersion },
    { latestVersion: 'not-a-cloudflare-version-id' },
  ]) assert.throws(() => validateUpgradePreconditions({ ...plan, ...modified }), /100% active/);
});

test('preserves account, owner, Access, D1, DO namespace and secret binding identities', () => {
  for (const [name, replacement] of [
    ['APP_ORIGIN', { text: 'https://other.example.test' }],
    ['OWNER_EMAIL', { text: 'other@example.test' }],
    ['ACCESS_AUD', { text: 'different-audience' }],
    ['FLEET_SPEC', { text: '{"accountId":"changed"}' }],
    ['TICKETS', { id: '11111111-bbbb-cccc-dddd-eeeeeeeeeeee' }],
    ['PROVISIONER_OAUTH', { namespace_id: 'b'.repeat(32) }],
  ]) assert.throws(() => validateUpgradePreconditions({ ...plan,
    candidateBindings: edit(activeBindings, name, replacement) }), /approved upgrade plan/);

  const withoutTicketKey = activeBindings.filter(binding => binding.name !== 'TICKET_KEY');
  assert.throws(() => validateUpgradePreconditions({ ...plan, candidateBindings: withoutTicketKey }), /required Nodrelay Worker secret/);
  for (const name of ['PROVISIONER_TOKEN', 'FLEET_OAUTH_SEED', 'FLEET_OAUTH_RECONNECT']) {
    assert.throws(() => validateUpgradePreconditions({ ...plan,
      activeBindings: [...activeBindings, { name, type: 'secret_text' }] }), /unsettled/);
  }
  const withSecret = edit(activeBindings, 'TICKET_KEY', { text: 'fixture-not-a-secret' });
  assert.throws(() => validateUpgradePreconditions({ ...plan, candidateBindings: withSecret }),
    error => /unsettled/.test(error.message) && !/fixture-not-a-secret/.test(error.message));
  assert.throws(() => validateUpgradePreconditions({ ...plan, activeBindings: [...activeBindings, activeBindings[0]] }), /unsettled/);
});

test('only explicit verified rollout metadata may change while all other bindings remain fixed', () => {
  const plannedChanges = { NODRELAY_RELEASE_VERSION: '0.1.6' };
  const candidateBindings = [...activeBindings,
    { name: 'NODRELAY_RELEASE_VERSION', type: 'plain_text', text: plannedChanges.NODRELAY_RELEASE_VERSION }];
  assert.throws(() => validateUpgradePreconditions({ ...plan, candidateBindings }), /approved upgrade plan/);
  assert.deepEqual(validateUpgradePreconditions({ ...plan, candidateBindings, plannedChanges }), { activeVersion });
  assert.throws(() => validateUpgradePreconditions({ ...plan, candidateBindings,
    plannedChanges: { ...plannedChanges, ACCESS_AUD: 'different' } }), /Unapproved/);
  assert.throws(() => validateUpgradePreconditions({ ...plan, candidateBindings,
    plannedChanges: { ...plannedChanges, RELEASE_CATALOG: '{"different":true}' } }), /Unapproved/);
  assert.throws(() => validateUpgradePreconditions({ ...plan,
    candidateBindings: [...candidateBindings, { name: 'EXTRA', type: 'plain_text', text: 'unexpected' }],
    plannedChanges }), /approved upgrade plan/);
});

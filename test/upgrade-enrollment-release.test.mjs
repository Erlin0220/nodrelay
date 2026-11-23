import assert from 'node:assert/strict';
import test from 'node:test';
import { enrollmentBootstrapUrl, resolveEnrollmentBootstrap } from '../cloud/enrollment-bootstrap.mjs';
import { enrollmentUpgradeAccessPaths, planEnrollmentUpgrade, validateSignedEnrollmentRelease } from '../cloud/upgrade-enrollment-release.mjs';

const origin = 'https://manager.example.test';
const digest = 'e'.repeat(64);
const targets = ['windows-x64', 'macos-arm64', 'macos-x64', 'linux-x64', 'linux-arm64'];
const catalog = (version, sha = 'a', prefix = '') => Object.fromEntries(targets.map(target => [target, {
  sha256: sha.repeat(64), version, browser: false, url: `https://downloads.example.test/${prefix}${version}/${target}.${target.startsWith('windows') ? 'zip' : 'tgz'}`,
}]));
const release = releases => ({ schema: 2, product: 'nodrelay-management', enrollment: { protocol: 'intent-v1', releases } });
const plain = (name, text) => ({ name, type: 'plain_text', text });
const legacy = plain('RELEASE_CATALOG', JSON.stringify(catalog('0.8.0'), null, 2));
const readiness = { verifiedD1: true, exactAccessRoutes: Object.fromEntries(enrollmentUpgradeAccessPaths.map(path => [path, true])) };
const input = (releases, overrides = {}) => ({ release: release(releases), manifestSha256: digest, expectedManifestSha256: digest,
  activeBindings: [legacy], readiness, ...overrides });
const asBindings = changes => Object.entries(changes).map(([name, text]) => plain(name, text));

test('first plan requires full signed catalog and does not touch the legacy binding', () => {
  const first = catalog('1.0.0');
  const plan = planEnrollmentUpgrade(input(first));
  assert.deepEqual(Object.keys(plan.changes).sort(), ['FLEET_ENROLLMENT_CATALOG', 'FLEET_ENROLLMENT_HISTORY', 'FLEET_ENROLLMENT_PROTOCOL']);
  assert.equal(plan.manifestSha256, digest);
  assert.deepEqual(JSON.parse(plan.changes.FLEET_ENROLLMENT_CATALOG), first);
  assert.equal(JSON.parse(plan.changes.FLEET_ENROLLMENT_HISTORY).linux['0.8.0'], undefined);
  assert.equal(legacy.text, JSON.stringify(catalog('0.8.0'), null, 2));
  assert.throws(() => planEnrollmentUpgrade(input(first, { expectedManifestSha256: 'f'.repeat(64) })), /changed after approval/);
  assert.throws(() => planEnrollmentUpgrade(input(first, { readiness: { ...readiness, verifiedD1: 1 } })), /D1 schema/);
  assert.throws(() => planEnrollmentUpgrade(input(first, { readiness: { ...readiness, exactAccessRoutes: { ...readiness.exactAccessRoutes,
    '/device/install/windows': false, '/device/*': true } } })), /exact Access/);
});

test('catalog rejects missing, extra, local, unsafe and inconsistent scoped assets', () => {
  const verify = releases => validateSignedEnrollmentRelease({ release: release(releases), manifestSha256: digest });
  for (const mutation of [
    c => delete c['macos-arm64'], c => { c['windows-arm64'] = c['windows-x64']; },
    c => { c['linux-x64'] = { ...c['linux-x64'], localFile: 'archive.tgz' }; },
    c => { c['linux-x64'].url = 'https://downloads.example.test/a.tgz?token=x'; },
    c => { c['macos-x64'].browser = true; }, c => { c['macos-x64'].version = '1.0.1'; },
  ]) {
    const mutated = catalog('1.0.0'); mutation(mutated);
    assert.throws(() => verify(mutated));
  }
});

test('preexisting fresh-install history migrates without rewriting old URLs or admitting version rebinds', async () => {
  const old = catalog('1.0.0');
  const oldPlan = planEnrollmentUpgrade(input(old));
  const { FLEET_ENROLLMENT_CATALOG: _newOnly, ...oldInstalledFlags } = oldPlan.changes;
  const activeBindings = [plain('RELEASE_CATALOG', JSON.stringify(old)), ...asBindings(oldInstalledFlags)];
  const next = planEnrollmentUpgrade(input(catalog('1.0.1', 'b'), { activeBindings }));
  const history = JSON.parse(next.changes.FLEET_ENROLLMENT_HISTORY);
  assert.deepEqual(Object.keys(history.linux), ['1.0.0', '1.0.1']);
  const oldGroup = JSON.parse(oldPlan.changes.FLEET_ENROLLMENT_HISTORY).linux['1.0.0'];
  const url = await enrollmentBootstrapUrl(origin, { platform: 'linux', ...oldGroup });
  const response = await resolveEnrollmentBootstrap(new Request(url), { origin, lookupApproved: (os, version) => history[os]?.[version],
    render: (_origin, _os, group) => group.assets.x64.sha256 });
  assert.equal(await response.text(), 'a'.repeat(64));
  assert.throws(() => planEnrollmentUpgrade(input(catalog('1.0.0', 'b'), { activeBindings })), /cannot be reassigned/);
  const aliased = catalog('1.0.1', 'b');
  aliased['linux-x64'].url = old['linux-x64'].url;
  assert.throws(() => planEnrollmentUpgrade(input(aliased, { activeBindings })), /URL cannot be reassigned/);
  assert.throws(() => planEnrollmentUpgrade(input(catalog('1.0.1'), { activeBindings: [legacy,
    plain('FLEET_ENROLLMENT_PROTOCOL', 'intent-v1')] })), /Incomplete existing/);
  assert.throws(() => planEnrollmentUpgrade(input(catalog('1.0.1'), { activeBindings: [legacy,
    plain('FLEET_ENROLLMENT_PROTOCOL', 'intent-v1'), plain('FLEET_ENROLLMENT_HISTORY', '{}')] })), /missing active installer pins/);
});

test('a planned upgrade fails rather than truncate retained history at the budget', () => {
  const first = planEnrollmentUpgrade(input(catalog('1.0.0')));
  const activeBindings = [legacy, ...asBindings(first.changes)];
  const oversized = catalog('1.0.1', 'b', 'a'.repeat(1000));
  assert.throws(() => planEnrollmentUpgrade(input(oversized, { activeBindings })), /binding budget/);
  assert.ok(JSON.parse(first.changes.FLEET_ENROLLMENT_HISTORY).linux['1.0.0']);
});

test('the published baseline supports one accepted architecture on each OS without promising optional targets', () => {
  const core = catalog('1.0.0');
  delete core['macos-x64'];
  delete core['linux-arm64'];
  const proof = validateSignedEnrollmentRelease({ release: release(core), manifestSha256: digest });
  assert.deepEqual(Object.keys(proof.releases).sort(), ['linux-x64', 'macos-arm64', 'windows-x64']);
  assert.equal(Object.hasOwn(proof.history.macos['1.0.0'].assets, 'x64'), false);
});

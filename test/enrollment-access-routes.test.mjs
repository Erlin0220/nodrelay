import assert from 'node:assert/strict';
import test from 'node:test';
import { ensureEnrollmentAccessRoutes } from '../cloud/upgrade-enrollment-readiness.mjs';
import { enrollmentUpgradeAccessPaths } from '../cloud/upgrade-enrollment-release.mjs';

const spec = { origin: 'https://console.example.test', accountId: 'a'.repeat(32), label: 'fleet-demo-0123456789ab',
  worker: 'fleet-demo-0123456789ab', accountScopedAccess: true, zoneId: 'z'.repeat(32) };
const appsPath = `/accounts/${spec.accountId}/access/apps`;

function accessFixture(existing) {
  const apps = [], policies = new Map(), posts = [];
  let next = 0;
  const add = (body, rules) => {
    const id = String(++next).padStart(32, '0');
    const { policies: inline, ...app } = body;
    apps.push({ ...app, id });
    policies.set(id, rules ?? inline ?? []);
    return { ...app, id };
  };
  for (const pathname of existing) {
    add({ name: spec.label + pathname.replaceAll('/', '-'), type: 'self_hosted', domain: 'console.example.test' + pathname,
      destinations: [{ type: 'public', uri: 'console.example.test' + pathname }] },
    [{ name: spec.label + '-device-bootstrap', decision: 'bypass', include: [{ everyone: {} }], exclude: [], require: [] }]);
  }
  const api = {
    async list(path) {
      if (path === appsPath) return structuredClone(apps);
      const id = /\/apps\/([0-9]+)\/policies$/.exec(path)?.[1];
      return structuredClone(policies.get(id) ?? []);
    },
    async get(path) { return structuredClone(apps.find(app => path === `${appsPath}/${app.id}`)); },
    async post(path, body) {
      posts.push(path);
      if (path === appsPath) return add(body);
      throw new Error('unexpected write ' + path);
    },
  };
  return { api, apps, posts };
}

test('a re-run command adds only the missing exact public device routes and leaves existing ones alone', async () => {
  const present = enrollmentUpgradeAccessPaths.filter(path => !path.endsWith('/linux'));
  const { api, apps, posts } = accessFixture(present);
  assert.deepEqual(await ensureEnrollmentAccessRoutes({ api, spec }), ['/device/install/linux']);
  assert.deepEqual(posts, [appsPath]);
  const linux = apps.find(app => app.name.endsWith('-device-install-linux'));
  assert.deepEqual(linux.destinations, [{ type: 'public', uri: 'console.example.test/device/install/linux' }]);
  assert.deepEqual(await ensureEnrollmentAccessRoutes({ api, spec }), []);
  assert.equal(posts.length, 1);
});

test('an existing route with a wider destination is refused, never repaired', async () => {
  const { api, apps, posts } = accessFixture(enrollmentUpgradeAccessPaths);
  apps[0].destinations.push({ type: 'public', uri: 'console.example.test/' });
  await assert.rejects(ensureEnrollmentAccessRoutes({ api, spec }), /different or wider route/);
  assert.deepEqual(posts, []);
});

test('a command upgrade checks enrollment routes with the deployed Access scope, not the bare setup receipt', async () => {
  const { deployedSpec } = await import('../src/management-command-upgrade.mjs');
  const { accountScopedAccess, ...receipt } = spec;
  void accountScopedAccess;
  const { api, posts } = accessFixture(enrollmentUpgradeAccessPaths.filter(path => !path.endsWith('/linux')));
  // The setup receipt never records the Access scope, which once stopped every command upgrade here.
  await assert.rejects(ensureEnrollmentAccessRoutes({ api, spec: receipt }), /Cannot verify the existing managed deployment/);
  const deployed = deployedSpec(receipt, JSON.stringify({ ...receipt, accountScopedAccess: true, portalId: 'fleet-x' }));
  assert.deepEqual(deployed, spec);
  assert.deepEqual(await ensureEnrollmentAccessRoutes({ api, spec: deployed }), ['/device/install/linux']);
  assert.deepEqual(posts, [appsPath]);
  for (const hosted of [JSON.stringify(receipt), JSON.stringify({ ...receipt, accountScopedAccess: true, origin: 'https://other.example.test' }),
    JSON.stringify({ ...receipt, accountScopedAccess: true, zoneScopedAccess: true }), 'not json', undefined]) {
    assert.throws(() => deployedSpec(receipt, hosted), /指向不同目标/);
  }
});

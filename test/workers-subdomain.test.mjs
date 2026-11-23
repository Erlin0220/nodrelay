import test from 'node:test';
import assert from 'node:assert/strict';
import { applySetup, uploadManagementWorker } from '../src/setup-core.mjs';
import { cloudflareApi } from '../cloud/cloudflare.mjs';
import { catalog, cloudFixture, spec, ticketKey } from './cloudflare-fixture.mjs';

const route = '/accounts/' + spec.accountId + '/workers/subdomain';
const script = '/accounts/' + spec.accountId + '/workers/scripts/' + spec.worker;
const refused = () => Object.assign(new Error('first upload refused'), { status: 403, codes: [10063] });
const missing = () => Object.assign(new Error('no account subdomain'), { status: 404, codes: [10007] });

function fixture(options = {}) {
  const state = {};
  const calls = [];
  let reads = 0;
  let registered = options.existingAccountSubdomain;
  const result = uploadManagementWorker.bind(null, {
    async put(path, body) {
      calls.push(['PUT', path, body]);
      if (path === route) {
        assert.equal(state.workersSubdomainAttempt, body.subdomain);
        assert.notEqual(calls.findIndex(([action]) => action === 'save'), -1);
        if (options.uncertain) throw new Error('response lost');
        registered = body.subdomain;
        return { subdomain: registered };
      }
      if (calls.filter(([action, path]) => action === 'PUT' && path === script).length === 1) throw (options.uploadError ?? refused());
      return { id: spec.worker };
    },
    async get(path) {
      calls.push(['GET', path]);
      assert.equal(path, route);
      if (++reads === 2 && options.concurrent) registered = options.concurrent;
      if (options.lookupError) throw options.lookupError;
      if (!registered) throw missing();
      return { subdomain: registered };
    },
  }, {
    accountId: spec.accountId, scriptPath: script, form: new FormData(), state, existing: options.existingWorker,
    save: async () => { calls.push(['save']); },
    confirmWorkersSubdomain: options.optedOut ? undefined : async name => {
      calls.push(['confirm', name]);
      assert.match(name, /^nodrelay-[0-9a-f]{20}$/);
      assert(!name.includes(spec.accountId));
      if (options.cancel) throw new Error('cancelled');
    },
  });
  return { result, state, calls };
}

test('exact upload refusal and confirmed absence permit one stable confirmed registration and one upload retry', async () => {
  const f = fixture();
  assert.equal((await f.result()).id, spec.worker);
  const name = f.state.workersSubdomainAttempt;
  assert.deepEqual(f.calls.map(([action, path]) => [action, action === 'confirm' ? '<name>' : path]), [
    ['PUT', script], ['GET', route], ['confirm', '<name>'], ['save', undefined], ['GET', route],
    ['PUT', route], ['GET', route], ['PUT', script],
  ]);
  const independent = fixture();
  await independent.result();
  assert.equal(independent.state.workersSubdomainAttempt, name);
});

test('existing account subdomain (including one added during consent) is never overwritten', async () => {
  for (const input of [{ existingAccountSubdomain: 'existing' }, { concurrent: 'created-elsewhere' }]) {
    const f = fixture(input);
    await f.result();
    assert.ok(!f.calls.some(([action, path]) => action === 'PUT' && path === route));
  }
});

test('no unapproved, unknown, or existing-Worker error can trigger account registration', async () => {
  for (const input of [{ existingWorker: true }, { optedOut: true }, { cancel: true },
    { uploadError: Object.assign(new Error(), { status: 403, codes: [10063, 10000] }) },
    { lookupError: Object.assign(new Error(), { status: 403, codes: [10000] }) },
    { lookupError: Object.assign(new Error(), { status: 404, codes: [7003] }) }]) {
    const f = fixture(input);
    await assert.rejects(f.result());
    assert.ok(!f.calls.some(([action, path]) => action === 'PUT' && path === route));
  }
});

test('uncertain registration persists its intent and an identical receipt cannot replay it', async () => {
  const f = fixture({ uncertain: true });
  await assert.rejects(f.result(), /response lost/);
  assert.ok(f.state.workersSubdomainAttempt);
  const previous = fixture();
  Object.assign(previous.state, f.state);
  await assert.rejects(previous.result(), /不会重复写入/);
  assert.ok(!previous.calls.some(([action, path]) => action === 'PUT' && path === route));
});

test('resume a matching partial receipt and disable Worker subdomain and previews before binding its custom domain', async () => {
  const cf = cloudFixture({ directPolicies: true });
  const grant = { access: 'a'.repeat(48), refresh: 'r'.repeat(48), expiresAt: Math.floor(Date.now() / 1000) + 600 };
  const state = { ticketKey, spec };
  const calls = [];
  let registered;
  const unavailable = (code, status) => Response.json({ success: false, result: null, errors: [{ code }] }, { status });
  const api = cloudflareApi(grant.access, { request: async (url, init) => {
    const path = new URL(url).pathname.replace('/client/v4', '');
    calls.push([init.method, path, init.body]);
    if (path === script && !registered) return unavailable(10063, 403);
    if (path === route) {
      if (init.method === 'PUT') registered = JSON.parse(init.body).subdomain;
      if (!registered) return unavailable(10007, 404);
      return Response.json({ success: true, result: { subdomain: registered } });
    }
    return cf.request(url, { ...init, headers: { ...init.headers, Authorization: 'Bearer administrator-test-auth' } });
  } });
  const setup = {
    state, save: async () => {}, bundle: 'export default {}', migrations: [], releases: catalog,
    managedOAuth: { grant, clientId: 'fixture-oauth-client', userDetails: true },
  };
  await assert.rejects(applySetup(api, spec, setup), /10063/);
  assert.equal(state.bound, undefined);
  const portal = cf.db.portal.id;
  const d1 = state.databaseId;
  const apps = cf.db.apps.length;
  const result = await applySetup(api, spec, { ...setup, confirmWorkersSubdomain: async () => {} });
  assert.equal(result.management, spec.origin);
  assert.equal(state.bound, true);
  assert.equal(cf.db.portal.id, portal);
  assert.equal(state.databaseId, d1);
  assert.equal(cf.db.apps.length, apps);
  const disable = calls.findIndex(([method, path]) => method === 'POST' && path === script + '/subdomain');
  assert.equal(calls[disable][2], JSON.stringify({ enabled: false, previews_enabled: false }));
  const domain = calls.findIndex(([method, path]) => method === 'PUT' && path.endsWith('/workers/domains'));
  assert.ok(disable >= 0 && domain > disable);
});

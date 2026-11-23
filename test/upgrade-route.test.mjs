import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorker } from '../cloud/worker.mjs';

test('upgrade routes require the admin and same-origin POST, and track successful work to completion', async () => {
  const base = 'https://fleet.example.test';
  const env = { APP_ORIGIN: base, FLEET_SPEC: '{}', PROVISIONER_OAUTH: {}, RELEASE_CATALOG: '{}' };
  let writes = 0;
  let checks = 0;
  let background;
  const checked = { currentVersion: '1.0.0', nextVersion: '1.0.1', releaseSha256: 'a'.repeat(64) };
  const input = { version: checked.nextVersion, releaseSha256: checked.releaseSha256, operationId: crypto.randomUUID() };
  const worker = createWorker({
    verifyAdmin: req => req.headers.has('x-test-owner'), deviceProvider: () => ({}),
    upgradeProvider: () => ({
      async check() { return checked; },
      async reconcile(actual) { checks++; assert.deepEqual(actual, { operationId: input.operationId }); return { status: 'deployment_confirmed' }; },
      async status() { return { phase: 'idle' }; },
      async start(actual) { writes++; assert.deepEqual(actual, input); return { status: 'deployment_confirmed' }; },
    }),
  });
  const visit = (leaf, init) => worker.fetch(new Request(base + '/admin/upgrade/' + leaf, init), env,
    { waitUntil(promise) { background = promise; } });
  const headers = { 'x-test-owner': '1', Accept: 'application/json' };
  assert.equal((await visit('check')).status, 403);
  assert.deepEqual(await (await visit('check', { headers })).json(), checked);
  assert.deepEqual(await (await visit('status', { headers })).json(), { phase: 'idle' });
  const post = (origin, extra = headers) => visit('start', { method: 'POST', body: new URLSearchParams(input),
    headers: { ...extra, Origin: origin } });
  assert.equal((await post(base, {})).status, 403);
  assert.equal((await post('https://other.example.test')).status, 403);
  assert.equal(writes, 0);
  assert.equal((await post(base)).status, 200);
  assert.ok(background instanceof Promise);
  await background;
  assert.equal(writes, 1);
  const reconcile = (origin, extra = headers) => visit('reconcile', { method: 'POST',
    body: new URLSearchParams({ operationId: input.operationId }), headers: { ...extra, Origin: origin } });
  assert.equal((await reconcile(base, {})).status, 403);
  assert.equal((await reconcile('https://other.example.test')).status, 403);
  assert.equal((await reconcile(base)).status, 200);
  assert.equal(checks, 1);
  assert.equal(writes, 1);
});

test('deployed legacy setup cannot trigger a web upgrade without the signed baseline configuration', async () => {
  const worker = createWorker({ verifyAdmin: () => true, deviceProvider: () => ({}) });
  const base = 'https://fleet.example.test';
  const env = { APP_ORIGIN: base, FLEET_SPEC: '{}', PROVISIONER_OAUTH: {}, RELEASE_CATALOG: '{}' };
  assert.deepEqual(await (await worker.fetch(new Request(base + '/admin/upgrade/check'), env)).json(), { available: false });
  const reply = await worker.fetch(new Request(base + '/admin/upgrade/start', {
    method: 'POST', headers: { Origin: base }, body: new URLSearchParams({ version: '1.0.0' }),
  }), env);
  assert.equal(reply.status, 503);
  assert.equal((await reply.json()).code, 'unavailable');
});

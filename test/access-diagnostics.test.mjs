import test from 'node:test';
import assert from 'node:assert/strict';
import { managementAccessConfiguration } from '../src/setup-core.mjs';
import { accessNotEnabled, cloudflareApi, safeCloudflareRoute } from '../cloud/cloudflare.mjs';

test('reports the failing Zero Trust organization read without exposing account IDs or secrets', async () => {
  const cause = Object.assign(new Error('secret-token'), { status: 403, codes: [9999], rayId: '8abc1234-SJC' });
  await assert.rejects(managementAccessConfiguration({ getOptional: async () => { throw cause; } }, 'a'.repeat(32)), error => {
    assert.match(error.message, /Zero Trust 组织/);
    assert.match(error.message, /GET \/accounts\/\{account_id\}\/access\/organizations/);
    assert.match(error.message, /HTTP 403.*9999/);
    assert.match(error.message, /Ray ID 8abc1234-SJC/);
    assert.doesNotMatch(error.message, /secret-token|aaaaaaaa/);
    assert.equal(error.cause, cause);
    return true;
  });
});

test('does not relabel unrelated network errors as authorization failures', async () => {
  const cause = new Error('timeout');
  await assert.rejects(managementAccessConfiguration({ getOptional: async () => { throw cause; } }, 'a'.repeat(32)), error => error === cause);
});

test('API errors show a redacted route and safe Ray ID without response secrets', async () => {
  const account = 'a'.repeat(32);
  const api = cloudflareApi('secret-token', { request: async () => Response.json({
    success: false, errors: [{ code: 9999, message: 'private-response-secret' }],
  }, { status: 403, headers: { 'cf-ray': '8abc1234-SJC' } }) });
  await assert.rejects(api.get(`/accounts/${account}/access/organizations?secret=private`), error => {
    assert.match(error.message, /\/accounts\/\{id\}\/access\/organizations/);
    assert.match(error.message, /403.*9999.*8abc1234-SJC/);
    assert.doesNotMatch(error.message, /secret|aaaaaaaa/);
    return true;
  });
  assert.equal(safeCloudflareRoute('/accounts/private-name/workers/scripts/my-secret?token=x'),
    '/accounts/{id}/workers/scripts/{id}');
});

test('only the exact account Access GET envelope recognizes the disabled marker', async () => {
  const id = 'a'.repeat(32);
  const path = `/accounts/${id}/access/organizations`;
  const marker = { code: 9999, message: 'access.api.error.not_enabled: do not retain this detail' };
  const envelope = { success: false, result: null, errors: [marker], messages: [] };
  const cases = [
    { marked: true },
    { method: 'post' },
    { target: `/zones/${id}/access/organizations` },
    { target: `${path}?x=org` },
    { target: path + '/trust_settings' },
    { target: path.replace(id, 'invalid-id') },
    { status: 404 },
    { payload: { ...envelope, success: true } },
    { payload: { ...envelope, result: {} } },
    { payload: { ...envelope, errors: [{ ...marker, code: 10000 }] } },
    { payload: { ...envelope, errors: [{ ...marker, message: 'prefix ' + marker.message }] } },
    { payload: { ...envelope, errors: [{ ...marker, message: 'access.api.error.not_enabled_other: detail' }] } },
    { payload: { ...envelope, errors: [{ ...marker, message: 'Access is not enabled' }] } },
    { payload: { ...envelope, errors: [marker, { code: 10000, message: 'contradictory error' }] } },
    { payload: { ...envelope, errors: [null] } },
  ];
  for (const { method = 'get', target = path, status = 403, payload = envelope, marked = false } of cases) {
    const api = cloudflareApi('private-bearer-value', { request: async () => Response.json(payload, { status }) });
    await assert.rejects(api[method](target), error => {
      assert.equal(error.reason, marked ? accessNotEnabled : undefined);
      const details = error.stack + JSON.stringify(error);
      assert.doesNotMatch(details, /private-bearer-value|do not retain|contradictory/);
      return true;
    });
  }
});

test('reconciliation reads all declared pages even if the first page is short', async () => {
  const pages = [];
  const api = cloudflareApi('fixture-token', { request: async url => {
    const page = Number(url.searchParams.get('page'));
    pages.push(page);
    const result = page === 1 ? [{ id:'first' }] : [{ id:'target' }];
    return Response.json({ success:true, result, result_info:{ total_pages:2, per_page:1 } });
  } });
  assert.deepEqual(await api.list('/fixture', { per_page:100 }), [{ id:'first' }, { id:'target' }]);
  assert.deepEqual(pages, [1, 2]);
});

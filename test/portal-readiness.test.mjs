import assert from 'node:assert/strict';
import test from 'node:test';
import { portalAccessReady } from '../src/portal-readiness.mjs';
import { waitForManagementAccess, chooseManagementZone } from '../src/management-setup.mjs';
const portal = 'https://nodrelay-portal.example.test/mcp';
const issuer = 'https://team.cloudflareaccess.com';
const login = issuer + '/cdn-cgi/access/login/nodrelay-portal.example.test';

test('Portal requires a trusted login redirect or same-origin MCP authentication challenge', async () => {
  for (const response of [Response.redirect(login), new Response(null, { status: 401,
    headers: { 'WWW-Authenticate': `Bearer resource_metadata="${new URL(portal).origin}/.well-known/oauth-protected-resource/mcp"` } })]) {
    assert.equal(await portalAccessReady(portal, issuer, async (_url, options) => {
      assert.equal(options.redirect, 'manual');
      assert.equal(options.headers.Authorization, undefined);
      return response;
    }), true);
  }
  for (const response of [Response.redirect('https://other.cloudflareaccess.com/cdn-cgi/access/login/nodrelay-portal.example.test'),
    Response.redirect(issuer + '/cdn-cgi/access/login/other.example.test'), new Response('public'),
    new Response(null, { status: 503 }), new Response(null, { status: 401 }),
    new Response(null, { status: 401, headers: { 'WWW-Authenticate': 'Bearer resource_metadata="https://other.example.test/.well-known/oauth-protected-resource"' } })]) {
    assert.equal(await portalAccessReady(portal, issuer, async () => response), false);
  }
  assert.equal(await portalAccessReady(portal, issuer, async () => { throw new Error('TLS failure'); }), false);
});

test('a ready management login cannot hide a pending Portal', async () => {
  const management = 'https://nodrelay-fleet.example.test';
  for (const status of [503, 200, 401]) {
    assert.equal(await waitForManagementAccess(management, issuer, {}, { portal, timeoutMs: 0,
      request: async url => url === portal ? new Response(null, { status }) :
        Response.redirect(issuer + '/cdn-cgi/access/login/nodrelay-fleet.example.test'),
    }), false);
  }
  assert.equal(await waitForManagementAccess(management, issuer, {}, { portal, timeoutMs: 0,
    request: async url => Response.redirect(url === portal ? login : issuer + '/cdn-cgi/access/login/nodrelay-fleet.example.test'),
  }), true);
  await assert.rejects(waitForManagementAccess(management, issuer, {}, { portal: 'http://portal.example.test/mcp',
    request() { assert.fail('Invalid portal must not be requested'); } }), /exact HTTPS/);
});

test('empty-account discovery can return to another account without reauthorization', async () => {
  const empty = { id: 'empty', name: 'Empty' }, good = { id: 'good', name: 'Good' };
  const zone = { name: 'example.test', status: 'active', account: good };
  let accountsRead = 0, selections = 0;
  const api = { async list(path, query) {
    if (path === '/accounts') { accountsRead++; return [empty, good]; }
    assert.equal(path, '/zones'); return query['account.id'] === good.id ? [zone] : [];
  } };
  const ui = { success() {}, info() {}, select(_prompt, options) {
    return [empty, 'back', good][selections++];
  } };
  assert.equal(await chooseManagementZone(api, ui), zone);
  assert.equal(accountsRead, 1);
});

test('a sole empty account can be rechecked without typing or repeating authorization', async () => {
  const account = { id: 'only', name: 'Only' };
  const zone = { name: 'example.test', status: 'active', account };
  let zonesRead = 0;
  const api = { async list(path) { return path === '/accounts' ? [account] : ++zonesRead === 1 ? [] : [zone]; } };
  const ui = { success() {}, info() {}, select(_prompt, options) {
    assert.deepEqual(options.map(option => option.value), ['retry', 'cancel']); return 'retry';
  } };
  assert.equal(await chooseManagementZone(api, ui), zone);
  assert.equal(zonesRead, 2);
});

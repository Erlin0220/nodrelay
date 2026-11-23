import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import test from 'node:test';
import { OAuthProvisioner, workerOAuthAccess } from '../cloud/oauth-provisioning.mjs';
import { managementBootstrapOAuthScopes, managementIdentityOAuthScopes, managementIdentityScope, managementOAuthScopes, runtimeGrant, runtimeOAuthScopes } from '../cloud/oauth-grant.mjs';
import { registrationSpec, registerOAuthClient, verifyPublicManagementClient } from '../src/oauth-registration.mjs';
import { authorize } from '../src/cloudflare-oauth.mjs';

const tokenEndpoint = 'https://dash.cloudflare.com/oauth2/token';
const access1 = 'fixture-access-' + 'a'.repeat(40);
const access2 = 'fixture-access-' + 'b'.repeat(40);
const refresh1 = 'fixture-refresh-' + 'a'.repeat(40);
const refresh2 = 'fixture-refresh-' + 'b'.repeat(40);
const env = {
  FLEET_OAUTH_KEY: 'a'.repeat(43),
  FLEET_OAUTH_CLIENT_ID: 'fixture-runtime-client',
  FLEET_OAUTH_SEED: JSON.stringify({ access: access1, refresh: refresh1, expiresAt: 0 }),
};

function brokerFixture() {
  const data = new Map();
  return { data, state: { storage: { get: key => data.get(key), put: (key, value) => data.set(key, value) } } };
}

function access(broker) {
  const namespace = { idFromName: key => key, get: () => ({
    fetch: (url, init) => broker.fetch(new Request(url, init)),
  }) };
  return workerOAuthAccess(namespace);
}

function refreshed(properties = {}) {
  return { access_token: access2, refresh_token: refresh2, token_type: 'Bearer', expires_in: 900, ...properties };
}

test('a private runtime client registers only the four background API permissions', async () => {
  const spec = registrationSpec({ accountId: 'a'.repeat(32), namespace: 'testfleet',
    oauthRedirect: 'http://127.0.0.1:7117/oauth/callback' }, ['workers-scripts.write', 'account-api-tokens.write'], { runtime: true });
  assert.deepEqual(spec.body.grant_types, ['authorization_code', 'refresh_token']);
  assert.deepEqual(spec.body.scopes, ['mcp-portals.write', 'zone-access.write', 'teams-connector-cloudflared.write', 'dns.write']);
  assert.deepEqual(spec.body.optional_scopes, []);
  const registered = { ...spec.body, scopes: [...runtimeOAuthScopes, 'offline_access'],
    client_id: 'fixture-runtime-client', visibility: 'private' };
  const api = { list: async () => [registered] };
  assert.equal((await registerOAuthClient(api, spec)).oauthClientId, 'fixture-runtime-client');
  await assert.rejects(registerOAuthClient({ list: async () => [{ ...registered, visibility: 'public' }] }, spec), /settings/);
});

test('the public management client keeps the original required scopes and makes only profile read optional', async () => {
  const config = { accountId: 'a'.repeat(32), namespace: 'fixture',
    oauthRedirect: 'http://127.0.0.1:7117/oauth/callback',
    oauthPublisher: { url: 'https://nodrelay.example.test/', logo: 'https://nodrelay.example.test/logo.png' } };
  const { body } = registrationSpec(config, ['account-api-tokens.write'], { management: true });
  const oauthClientId = 'fixture-public-management';
  assert.deepEqual(body.grant_types, ['authorization_code', 'refresh_token']);
  assert.deepEqual(body.scopes, managementIdentityOAuthScopes.filter(scope => scope !== 'offline_access'));
  assert.deepEqual(body.optional_scopes, [managementIdentityScope]);
  assert.equal(body.token_endpoint_auth_method, 'none');
  const approved = { ...body, client_id: oauthClientId, visibility: 'public',
    scopes: managementIdentityOAuthScopes, client_uri_verification: { status: 'verified' } };
  const api = client => ({ async get(path) {
    assert.equal(path, '/accounts/' + config.accountId + '/oauth_clients/' + oauthClientId);
    return client;
  } });
  assert.deepEqual(await verifyPublicManagementClient(api(approved), config, oauthClientId),
    { oauthClientId, oauthRedirect: config.oauthRedirect, visibility: 'public' });
  for (const change of [
    { visibility: 'private' }, { client_uri_verification: { status: 'pending' } },
    { optional_scopes: undefined }, { optional_scopes: [] }, { optional_scopes: ['d1.write'] },
    { optional_scopes: [managementIdentityScope, 'd1.write'] },
    { scopes: managementOAuthScopes }, { scopes: [...approved.scopes, 'account-api-tokens.write'] },
    { redirect_uris: ['http://127.0.0.1:7118/oauth/callback'] }, { grant_types: ['authorization_code'] },
  ]) await assert.rejects(verifyPublicManagementClient(api({ ...approved, ...change }), config, oauthClientId), /not verified/);
});

test('accepts only a usable and narrowly scoped runtime grant, rejecting a bootstrap grant', () => {
  const scope = [...runtimeOAuthScopes, 'offline_access'].join(' ');
  assert.equal(runtimeGrant(refreshed({ scope })).refresh, refresh2);
  for (const value of [undefined, 'dns.write', scope + ' workers-scripts.write', scope + ' account-api-tokens.write']) {
    assert.throws(() => runtimeGrant(refreshed({ scope: value })), /different grant/);
  }
  assert.throws(() => runtimeGrant(refreshed({ refresh_token: refresh1 }), { refresh: refresh1 }), /rotating/);
});

test('the runtime PKCE consent requests only the four runtime scopes and offline access', async () => {
  const portProbe = createServer();
  await new Promise(resolve => portProbe.listen(0, '127.0.0.1', resolve));
  const redirectUri = `http://127.0.0.1:${portProbe.address().port}/oauth/callback`;
  await new Promise(resolve => portProbe.close(resolve));
  let callback, challenge, requested;
  const grant = await authorize({
    clientId: env.FLEET_OAUTH_CLIENT_ID, redirectUri, runtime: true,
    scopes: ['account-api-tokens.write', 'workers-scripts.write'],
    browse(url) {
      const params = new URL(url).searchParams;
      requested = params.get('scope').split(' ');
      challenge = params.get('code_challenge');
      const target = new URL(redirectUri);
      target.search = new URLSearchParams({ code: 'fixture-code', state: params.get('state') });
      callback = fetch(target);
    },
    async request(url, init) {
      assert.equal(url, tokenEndpoint);
      assert.equal(init.body.get('code'), 'fixture-code');
      assert.equal(createHash('sha256').update(init.body.get('code_verifier')).digest('base64url'), challenge);
      return Response.json(refreshed({ scope: requested.join(' ') }));
    },
  });
  assert.equal((await callback).status, 200);
  assert.deepEqual(requested, [...runtimeOAuthScopes, 'offline_access']);
  assert.equal(grant.refresh, refresh2);
});

test('management authorization requires profile and allows declining the optional Zero Trust write', async () => {
  for (const grantedScopes of [managementBootstrapOAuthScopes, managementIdentityOAuthScopes, managementOAuthScopes,
    [...managementBootstrapOAuthScopes, 'account-api-tokens.write'], undefined]) {
    const portProbe = createServer();
    await new Promise(resolve => portProbe.listen(0, '127.0.0.1', resolve));
    const redirectUri = `http://127.0.0.1:${portProbe.address().port}/oauth/callback`;
    await new Promise(resolve => portProbe.close(resolve));
    let requested, callback;
    const grant = authorize({
      clientId: 'fixture-public-management', redirectUri, scopes: managementBootstrapOAuthScopes, refreshable: true,
      browse(url) {
        const params = new URL(url).searchParams;
        requested = params.get('scope').split(' ');
        const target = new URL(redirectUri);
        target.search = new URLSearchParams({ code: 'fixture-code', state: params.get('state') });
        callback = fetch(target);
      },
      async request() {
        return Response.json(refreshed({ scope: grantedScopes?.join(' ') }));
      },
    });
    if ([managementIdentityOAuthScopes, managementBootstrapOAuthScopes].includes(grantedScopes)) {
      const actual = await grant;
      assert.equal(actual.refresh, refresh2);
      assert.equal(Boolean(actual.zeroTrustBootstrap), grantedScopes === managementBootstrapOAuthScopes);
    } else {
      await assert.rejects(grant, /请重新运行安装命令.*User Details Read|different grant/);
    }
    assert.deepEqual(requested, managementBootstrapOAuthScopes);
    assert.equal((await callback).status, 200);
  }
});

test('concurrent calls share one refresh and restart uses encrypted, rotated credentials', async () => {
  const { data, state } = brokerFixture();
  let refreshes = 0;
  const broker = new OAuthProvisioner(state, env, async (url, init) => {
    refreshes++;
    assert.equal(url, tokenEndpoint);
    assert.equal(init.redirect, 'manual');
    assert.equal(init.body.get('grant_type'), 'refresh_token');
    assert.equal(init.body.get('refresh_token'), refresh1);
    assert.deepEqual(data.get('credential'), { state: 'refresh_started' });
    return Response.json(refreshed());
  });
  assert.deepEqual(await Promise.all(Array.from({ length: 12 }, () => access(broker))), Array(12).fill(access2));
  assert.equal(refreshes, 1);
  const ciphertext = data.get('credential');
  assert.equal(typeof ciphertext, 'string');
  for (const secret of [access1, access2, refresh1, refresh2]) assert.equal(ciphertext.includes(secret), false);
  const restarted = new OAuthProvisioner(state, { ...env, FLEET_OAUTH_SEED: undefined },
    async () => assert.fail('A fresh credential does not need OAuth'));
  assert.equal(await access(restarted), access2);
  assert.equal((await restarted.fetch(new Request('https://fleet-oauth.internal/access-token'))).status, 404);
});

test('the broker fails closed after an uncertain refresh without reusing the seed or old token', async () => {
  const { state } = brokerFixture();
  let refreshes = 0;
  const request = async () => { refreshes++; throw new Error(refresh1); };
  const first = new OAuthProvisioner(state, env, request);
  const response = await first.fetch(new Request('https://fleet-oauth.internal/access-token', { method: 'POST' }));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'runtime_authorization_unavailable' });
  const restarted = new OAuthProvisioner(state, env, request);
  assert.equal(await access(restarted), undefined);
  assert.equal(refreshes, 1);
});

test('the combined broker refreshes an expired seed and deletes only the management bootstrap secret', async () => {
  const accountId = 'a'.repeat(32);
  const worker = 'fleet-fixture-123456789abc';
  const configuration = { ...env, FLEET_OAUTH_MODE: 'managed', FLEET_SPEC: JSON.stringify({ accountId, worker, label: worker }) };
  const { state, data } = brokerFixture();
  const writes = [];
  const broker = new OAuthProvisioner(state, configuration, async (url, init) => {
    writes.push([String(url), init.method]);
    if (init.method === 'POST') return Response.json(refreshed({ scope: managementOAuthScopes.join(' ') }));
    assert.equal(init.headers.Authorization, 'Bearer ' + access2);
    assert.equal(typeof data.get('credential'), 'string');
    assert.ok(!data.get('credential').includes(refresh2));
    return new Response(null, { status: 204 });
  });
  assert.equal(await access(broker), access2);
  assert.equal(await access(broker), access2);
  assert.deepEqual(writes, [[tokenEndpoint, 'POST'],
    [`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${worker}/secrets/FLEET_OAUTH_SEED`, 'DELETE']]);
});

test('the identity-enabled management broker refreshes only the identity-enabled grant', async () => {
  for (const scopes of [managementIdentityOAuthScopes, managementOAuthScopes,
    [...managementIdentityOAuthScopes, 'account-api-tokens.write']]) {
    const { state } = brokerFixture();
    const broker = new OAuthProvisioner(state, { ...env, FLEET_OAUTH_MODE: 'managed', FLEET_OAUTH_USER_DETAILS: '1',
      FLEET_SPEC: JSON.stringify({ accountId: 'a'.repeat(32), worker: 'fleet-demo-123456789abc', label: 'fleet-demo-123456789abc' }),
    }, async (url, init) => {
      if (init.method === 'GET') throw new Error('Profile reads belong only to the installer');
      if (init.method === 'POST') {
        assert.equal(url, tokenEndpoint);
        return Response.json(refreshed({ scope: scopes.join(' ') }));
      }
      return new Response(null, { status: 204 });
    });
    const response = await broker.fetch(new Request('https://fleet-oauth.internal/access-token', { method: 'POST' }));
    assert.equal(response.status, scopes === managementIdentityOAuthScopes ? 200 : 503);
  }
});

test('management refresh preserves actual optional scope and rejects scope drift', async () => {
  for (const granted of [false, true]) {
    const expected = granted ? managementBootstrapOAuthScopes : managementIdentityOAuthScopes;
    for (const scopes of [managementBootstrapOAuthScopes, managementIdentityOAuthScopes,
    [...managementIdentityOAuthScopes, 'account-api-tokens.write'], undefined]) {
      const { state } = brokerFixture();
      const broker = new OAuthProvisioner(state, { ...env, FLEET_OAUTH_MODE: 'managed', FLEET_OAUTH_USER_DETAILS: '1',
        ...(granted && { FLEET_OAUTH_ZERO_TRUST_BOOTSTRAP: '1' }),
        FLEET_SPEC: JSON.stringify({ accountId: 'a'.repeat(32), worker: 'fleet-demo-123456789abc', label: 'fleet-demo-123456789abc' }),
      }, async (url, init) => {
        if (init.method === 'GET') throw new Error('Profile reads belong only to the installer');
        if (init.method === 'POST') {
          assert.equal(url, tokenEndpoint);
          return Response.json(refreshed({ scope: scopes?.join(' ') }));
        }
        return new Response(null, { status: 204 });
      });
      const response = await broker.fetch(new Request('https://fleet-oauth.internal/access-token', { method: 'POST' }));
      assert.equal(response.status, !scopes || scopes === expected ? 200 : 503);
    }
  }
});

test('a new managed grant recovers a failed refresh and the same staged generation cannot be replayed', async () => {
  const accountId = 'a'.repeat(32);
  const worker = 'fleet-fixture-123456789abc';
  const configuration = { ...env, FLEET_OAUTH_MODE: 'managed', FLEET_SPEC: JSON.stringify({ accountId, worker, label: worker }) };
  const { state, data } = brokerFixture();
  const failing = new OAuthProvisioner(state, configuration, async () => { throw new Error('provider unavailable'); });
  assert.equal(await access(failing), undefined);
  const generation = 'e'.repeat(32);
  const reconnect = { ...configuration, FLEET_OAUTH_SEED: undefined, FLEET_OAUTH_RECONNECT: JSON.stringify({
    generation, clientId: env.FLEET_OAUTH_CLIENT_ID,
    grant: { access: access2, refresh: refresh2, expiresAt: Math.floor(Date.now() / 1000) + 900 },
  }) };
  let deletes = 0;
  const broker = new OAuthProvisioner(state, reconnect, async (url, init) => {
    deletes++;
    assert.ok(String(url).endsWith('/secrets/FLEET_OAUTH_RECONNECT'));
    assert.equal(init.method, 'DELETE');
    assert.equal(init.headers.Authorization, 'Bearer ' + access2);
    assert.equal(data.get('credential').generation, generation);
    assert.equal(data.get('credential').sealed.includes(refresh2), false);
    return new Response(null, { status: 204 });
  });
  assert.equal(await access(broker), access2);
  assert.equal(await access(broker), access2);
  assert.equal(deletes, 1);
  const nextGeneration = 'f'.repeat(32);
  const second = { ...reconnect, FLEET_OAUTH_RECONNECT: JSON.stringify({ generation: nextGeneration,
    clientId: env.FLEET_OAUTH_CLIENT_ID,
    grant: { access: access1, refresh: refresh1, expiresAt: Math.floor(Date.now() / 1000) + 900 } }) };
  assert.equal(await access(new OAuthProvisioner(state, second, async () => new Response(null, { status: 204 }))), access1);
  assert.equal(await access(new OAuthProvisioner(state, reconnect, async () => assert.fail('A stale binding must not modify the current deployment'))), access1);
  data.set('credential', { state: 'refresh_started', generation, applied: [generation] });
  const restarted = new OAuthProvisioner(state, reconnect, async () => assert.fail('The staged generation must not be reused'));
  assert.equal(await access(restarted), undefined);
  assert.deepEqual(data.get('credential'), { state: 'refresh_started', generation, applied: [generation] });
});

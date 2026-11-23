import assert from 'node:assert/strict';
import test from 'node:test';
import { cloudflareApi } from '../cloud/cloudflare.mjs';
import { runtimeOAuthScopes } from '../cloud/oauth-grant.mjs';
import { deploySingleConsentTrial } from '../src/single-consent-trial.mjs';
import { account, catalog, cloudFixture, spec, ticketKey } from './cloudflare-fixture.mjs';

const access = 'trial-only-access-' + 'a'.repeat(30);
const refresh = 'local-deployment-refresh-' + 'r'.repeat(30);
const nextRefresh = refresh + '-rotated';
const runtimeScope = runtimeOAuthScopes.join(' ');
function oauthResponse(scope) {
  return Response.json({ access_token: access, refresh_token: nextRefresh,
    token_type: 'bearer', expires_in: 3599, ...(scope !== undefined && { scope }) });
}

test('one approved grant sends only the narrowed access token to the pilot Worker', async () => {
  const cf = cloudFixture();
  const state = { ticketKey };
  const snapshots = [];
  let bindings;
  let localRefresh;
  let refreshes = 0;
  const api = cloudflareApi('administrator-test-auth', { async request(url, options) {
    if (url.pathname.endsWith('/workers/scripts/' + spec.worker)) {
      bindings = JSON.parse(await options.body.get('metadata').text()).bindings;
    }
    return cf.request(url, options);
  } });
  const result = await deploySingleConsentTrial(api, spec, {
    state, save: async value => snapshots.push(JSON.stringify(value)),
    bundle: 'export default {}', migrations: ['CREATE TABLE IF NOT EXISTS x (id TEXT)'], releases: catalog,
  }, {
    clientId: 'fixture-private-client', refreshToken: refresh, existingAccessIssuer: 'https://fixture.cloudflareaccess.com',
    keepLatestRefreshToken(value) { localRefresh = value; },
    async request(url, options) {
      refreshes++;
      assert.equal(url, 'https://dash.cloudflare.com/oauth2/token');
      assert.equal(options.body.get('scope'), runtimeScope);
      assert.equal(options.body.get('refresh_token'), refresh);
      return oauthResponse(runtimeScope);
    },
  });
  assert.equal(refreshes, 1);
  assert.equal(result.management, spec.origin);
  assert.equal(localRefresh, nextRefresh);
  assert.ok(bindings.some(x => x.name === 'PROVISIONER_TOKEN' && x.text === access));
  assert.ok(bindings.every(x => x.text !== refresh && x.text !== nextRefresh));
  assert.ok(snapshots.every(value => !value.includes(access) && !value.includes(refresh)));
  assert.equal(cf.writes.filter(([, path]) => path.startsWith(account + '/tokens')).length, 0);
  assert.ok(state.trial && state.bound);
});

test('a broader, missing, or incomplete OAuth scope aborts before any Cloudflare resource call', async () => {
  for (const scope of [runtimeScope + ' workers-scripts.write d1.write', undefined, 'dns.write']) {
    let latest;
    const mustNotGetCalled = new Proxy({}, { get() { assert.fail('No resource API call is allowed'); } });
    await assert.rejects(deploySingleConsentTrial(mustNotGetCalled, spec, {}, {
      clientId: 'fixture-private-client', refreshToken: refresh, existingAccessIssuer: 'https://fixture.cloudflareaccess.com',
      keepLatestRefreshToken(value) { latest = value; },
      request: async () => oauthResponse(scope),
    }), /did not confirm exactly/);
    assert.equal(latest, nextRefresh);
  }
});


test('scope omission is accepted for a short trial only after actual permissions are verified', async () => {
  for (const allowed of [true, false]) {
    const cf = cloudFixture();
    const state = { ticketKey };
    let verifierCalls = 0;
    const result = deploySingleConsentTrial(cloudflareApi('administrator-test-auth', { request: cf.request }), spec, {
      state, save: async () => {},
      bundle: 'export default {}', migrations: ['CREATE TABLE IF NOT EXISTS x (id TEXT)'], releases: catalog,
    }, {
      clientId: 'fixture-private-client', refreshToken: refresh, existingAccessIssuer: 'https://fixture.cloudflareaccess.com',
      keepLatestRefreshToken() {},
      request: async () => oauthResponse(undefined),
      async verifyRuntimeAccess(value) {
        verifierCalls++;
        assert.equal(value, access);
        assert.equal(cf.writes.length, 0);
        return allowed;
      },
    });
    if (allowed) {
      assert.equal((await result).management, spec.origin);
      assert.ok(state.trial);
    } else {
      await assert.rejects(result, /did not confirm the credential boundary/);
      assert.equal(cf.writes.length, 0);
    }
    assert.equal(verifierCalls, 1);
  }
});

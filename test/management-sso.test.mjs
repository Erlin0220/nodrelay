import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import test from 'node:test';
import { generateKeyPair, SignJWT } from 'jose';
import { authorize } from '../src/cloudflare-oauth.mjs';
import { proveManagementSso, removeSsoProof, verifySsoIdentity } from '../src/management-sso.mjs';

const accountId = 'a'.repeat(32);
const providerId = 'b'.repeat(32);
const appId = 'c'.repeat(32);
const clientId = 'fixture-oidc-client';
const issuer = 'https://fixture.cloudflareaccess.com';
const oidcIssuer = `${issuer}/cdn-cgi/access/sso/oidc/${clientId}`;
const email = 'verified-sso@example.test';
const path = `/accounts/${accountId}/access/apps`;
const fixedCallback = 'http://127.0.0.1:8125/oauth/callback';
const { publicKey, privateKey } = await generateKeyPair('RS256');

function idToken(nonce, changes = {}, key = privateKey) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ iss: oidcIssuer, aud: clientId, sub: 'fixture-sso-subject', iat: now, exp: now + 300,
    nonce, email, ...changes }).setProtectedHeader({ alg: 'RS256' }).sign(key);
}

function fixture() {
  const existing = { name: 'Existing corporate app', type: 'self_hosted', id: 'd'.repeat(32) };
  let app;
  let policies = [];
  const writes = [];
  const receipts = [];
  const api = {
    async post(resource, body) {
      writes.push([resource, body]);
      if (resource === path) {
        assert.equal(app, undefined);
        assert.equal(body.type, 'saas');
        assert.equal(body.app_launcher_visible, false);
        assert.equal(body.domain, undefined);
        assert.deepEqual(body.allowed_idps, [providerId]);
        assert.deepEqual(body.saas_app.grant_types, ['authorization_code_with_pkce']);
        assert.deepEqual(body.saas_app.scopes, ['openid', 'email']);
        app = { ...body, id: appId, saas_app: { ...body.saas_app, client_id: clientId } };
        return { ...app, saas_app: { ...app.saas_app, client_secret: 'fixture-secret-not-persisted' } };
      }
      assert.equal(resource, `${path}/${appId}/policies`);
      assert.deepEqual(body.include, [{ login_method: { id: providerId } }]);
      assert.equal(body.decision, 'allow');
      policies.push(body);
    },
    async list(resource) {
      if (resource === path) return app ? [existing, app] : [existing];
      assert.equal(resource, `${path}/${appId}/policies`);
      return policies;
    },
    async get(resource) { assert.equal(resource, `${path}/${appId}`); return app; },
    async getOptional(resource) { return api.get(resource); },
    async del(resource) {
      assert.equal(resource, `${path}/${appId}`);
      writes.push([resource, 'delete']);
      app = undefined;
      policies = [];
    },
  };
  const save = async proof => { receipts.push(structuredClone(proof)); };
  return { api, save, writes, receipts, existing };
}

function oidcMetadata() {
  return Response.json({ issuer: oidcIssuer, authorization_endpoint: oidcIssuer + '/authorization',
    token_endpoint: oidcIssuer + '/token', jwks_uri: oidcIssuer + '/jwks' });
}

test('temporary Access OIDC proves the exact SSO email over a local PKCE callback and cleans up', async () => {
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const redirectUri = `http://127.0.0.1:${probe.address().port}/oauth/callback`;
  await new Promise(resolve => probe.close(resolve));
  const { api, save, receipts, existing, writes } = fixture();
  let authorization, browser;
  const identity = await proveManagementSso(api, { accountId, issuer, providerId, redirectUri, save,
    getKey(url) { assert.equal(url.href, oidcIssuer + '/jwks'); return publicKey; },
    async request(url, options) {
      if (url.endsWith('/.well-known/openid-configuration')) return oidcMetadata();
      assert.equal(url, oidcIssuer + '/token');
      assert.equal(options.redirect, 'error');
      assert.equal(options.body.get('code'), 'fixture-code');
      assert.equal(options.body.get('redirect_uri'), redirectUri);
      assert.equal(options.body.has('client_secret'), false);
      assert.equal(createHash('sha256').update(options.body.get('code_verifier')).digest('base64url'),
        authorization.searchParams.get('code_challenge'));
      return Response.json({ id_token: await idToken(authorization.searchParams.get('nonce')) });
    },
    browserLogin(options) {
      return authorize({ ...options, timeoutMs: 2000, browse(url) {
        browser = (async () => {
          const start = await fetch(url, { redirect: 'manual' });
          authorization = new URL(start.headers.get('location'));
          assert.equal(authorization.origin + authorization.pathname, oidcIssuer + '/authorization');
          assert.equal(authorization.searchParams.get('scope'), 'openid email');
          const callback = new URL(redirectUri);
          callback.search = new URLSearchParams({ state: 'wrong-state', code: 'untrusted-code' });
          assert.equal((await fetch(callback)).status, 404);
          callback.search = new URLSearchParams({ state: authorization.searchParams.get('state'), code: 'fixture-code' });
          assert.equal((await fetch(callback)).status, 200);
        })();
      } });
    },
  });
  await browser;
  assert.deepEqual(identity, { email, issuer, providerId });
  assert.deepEqual(await api.list(path), [existing]);
  assert.equal(writes.length, 3);
  assert.equal(receipts[0].id, undefined);
  assert.equal(receipts[1].id, appId);
  assert.equal(receipts.at(-1), undefined);
  assert.doesNotMatch(JSON.stringify(receipts), /fixture-secret|fixture-code|verified-sso/);
});

test('SSO rejects a forged, expired or wrong-application ID token and an unusable email', async () => {
  const nonce = 'fixture-nonce';
  const expected = { issuer: oidcIssuer, clientId, nonce };
  const foreign = (await generateKeyPair('RS256')).privateKey;
  const now = Math.floor(Date.now() / 1000);
  const invalid = [await idToken(nonce, {}, foreign)];
  for (const claims of [
    { iss: 'https://other.cloudflareaccess.com' }, { aud: 'other-app' }, { aud: [clientId, 'other-app'] },
    { azp: 'other-app' }, { exp: now - 1 }, { exp: undefined }, { iat: now - 900 }, { nonce: 'other' },
    { email: undefined }, { email: 'not-an-email' }, { email_verified: false },
  ]) invalid.push(await idToken(nonce, claims));
  for (const token of invalid) await assert.rejects(verifySsoIdentity(token, publicKey, expected), /无法验证/);
});

test('a cancelled login cleans up and an unresolved creation preserves the recovery receipt', async () => {
  const cancelled = fixture();
  const options = { accountId, issuer, providerId, redirectUri: fixedCallback, request: async () => oidcMetadata(),
    browserLogin: async () => { throw new Error('cancelled'); },
  };
  await assert.rejects(proveManagementSso(cancelled.api, { ...options, save: cancelled.save }), /cancelled/);
  assert.deepEqual(await cancelled.api.list(path), [cancelled.existing]);
  assert.equal(cancelled.receipts.at(-1), undefined);

  const uncertain = fixture();
  uncertain.api.post = async () => { throw new Error('timed out'); };
  await assert.rejects(proveManagementSso(uncertain.api, { ...options, save: uncertain.save }), /--resume/);
  assert.equal(uncertain.receipts.length, 1);
  assert.equal(await removeSsoProof(uncertain.api, accountId, uncertain.receipts[0]), false);
  assert.deepEqual(uncertain.writes, []);

  const receipt = { ...uncertain.receipts[0], id: appId };
  assert.equal(await removeSsoProof(uncertain.api, accountId, receipt), false);
  uncertain.api.getOptional = async () => ({ ...uncertain.existing, id: appId });
  await assert.rejects(removeSsoProof(uncertain.api, accountId, receipt), /归属有变/);
  assert.deepEqual(uncertain.writes, []);
});

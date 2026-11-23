import assert from 'node:assert/strict';
import test from 'node:test';
import { ensureScopedAccessApp as ensureZoneAccessApp } from '../cloud/zone-access.mjs';
import { CloudflareError } from '../cloud/cloudflare.mjs';

const spec = { accountId: 'account', zoneId: 'zone', label: 'fleet', ownerEmail: 'owner@example.com' };
const scope = '/zones/zone/access/apps';
const account = '/accounts/account/access/apps';
const id = 'a'.repeat(32);
const appPath = `${scope}/${id}`;
const policyPath = `${appPath}/policies`;
const portal = { name: 'fleet', type: 'mcp_portal', domain: 'portal.example.com', oauth_configuration: { enabled: true } };
const management = { name: 'fleet-management', type: 'self_hosted', domain: 'management.example.com' };
const rule = { name: 'fleet-owner', decision: 'allow', include: [{ email: { email: spec.ownerEmail } }], exclude: [], require: [], precedence: 1 };

test('zone application creation requires an exact Access restriction after readback', async () => {
  const app = { ...management, id, aud: 'management-audience' };
  const calls = [];
  const api = {
    async list(path) { return path === policyPath ? [rule] : []; },
    async get(path) { assert.equal(path, appPath); return app; },
    async post(path, body) { calls.push({ path, body }); return app; },
  };
  assert.equal(await ensureZoneAccessApp(api, spec, management), app);
  assert.deepEqual(calls, [{ path: scope, body: { ...management, policies: [rule] } }]);
  api.list = async path => path === policyPath ? [rule, { ...rule, decision: 'bypass' }] : [];
  await assert.rejects(() => ensureZoneAccessApp(api, spec, management), /policy does not match/);
});

test('a managed Portal needs verified zone ownership and OAuth before configuring its policy', async () => {
  const app = { ...portal, id };
  let rules = [];
  let zone = [];
  let getResult = app;
  const api = {
    async list(path) {
      if (path === account) return [app];
      if (path === scope) return zone;
      assert.equal(path, policyPath);
      return rules;
    },
    async get(path) { assert.equal(path, appPath); return getResult; },
    async post(path, body) { assert.equal(path, policyPath); rules = [body]; },
  };
  await assert.rejects(() => ensureZoneAccessApp(api, spec, portal, { managed: true }), /account Access write is required/);
  zone = [app];
  getResult = { ...app, oauth_configuration: { enabled: false } };
  await assert.rejects(() => ensureZoneAccessApp(api, spec, portal, { managed: true }), /OAuth verification/);
  assert.deepEqual(rules, []);
  getResult = app;
  assert.equal(await ensureZoneAccessApp(api, spec, portal, { managed: true }), app);
  assert.deepEqual(rules, [rule]);
});

test('the Portal Access application is explicitly created when it is absent in both scopes', async () => {
  const app = { ...portal, id };
  const writes = [];
  let rules = [];
  const api = {
    async list(path) { return path === policyPath ? rules : []; },
    async get(path) { assert.equal(path, appPath); return app; },
    async post(path, body) {
      writes.push({ path, body });
      if (path === policyPath) rules = [body];
      return app;
    },
  };
  assert.equal(await ensureZoneAccessApp(api, spec, portal, { managed: true }), app);
  assert.deepEqual(writes, [{ path: scope, body: portal }, { path: policyPath, body: rule }]);
});

test('zone rejection of a Portal server app preserves the vendor code and performs no fallback write', async () => {
  const app = { name: 'test-device-d', type: 'mcp', destinations: [{ type: 'via_mcp_server_portal', mcp_server_id: 'test-device-d' }] };
  const writes = [];
  const api = {
    list: async () => [],
    async post(path, body) {
      writes.push({ path, body });
      throw new CloudflareError('POST', 400, [12130]);
    },
  };
  await assert.rejects(() => ensureZoneAccessApp(api, spec, app, { managed: true }), error => {
    assert.deepEqual(error.cause.codes, [12130]);
    return /Configure it at account scope/.test(error.message);
  });
  assert.deepEqual(writes, [{ path: scope, body: app }]);
});

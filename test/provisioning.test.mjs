import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import test from 'node:test';
import { confirmedRevocation } from '../cloud/device-revocation.mjs';
import { cloudflareApi } from '../cloud/cloudflare.mjs';
import { createDevices, deviceLease } from '../cloud/devices.mjs';
import { claimEnrollmentIntent, issueEnrollmentIntent, revealEnrollmentIntent } from '../cloud/enrollment-intents.mjs';
import { hostedInstallers } from '../cloud/device-paths.mjs';
import { installCommand } from '../cloud/install-command.mjs';
import { profiles } from '../cloud/profiles.mjs';
import { issueTicket, redeemTicket } from '../cloud/tickets.mjs';
import { createWorker } from '../cloud/worker.mjs';
import { authorize } from '../src/cloudflare-oauth.mjs';
import { checkConnection } from '../src/device-connection.mjs';
import { claimDeviceEnrollment } from '../src/enrollment-claim-client.mjs';
import { registerOAuthClient, registrationSpec } from '../src/oauth-registration.mjs';
import { cancelTicket } from '../cloud/tickets.mjs';
import { makeSetupSpec, applySetup, validateReleaseCatalog } from '../src/setup-core.mjs';
import { launchAgent, systemdUnit } from '../src/os-service.mjs';

import { account, spec, catalog, ticketKey, cloudFixture } from './cloudflare-fixture.mjs';

test('the managed console renders and initializes without separate asset requests', async () => {
  const worker = createWorker({
    verifyAdmin: req => req.headers.get('x-fixture-admin') === '1',
    deviceProvider: () => ({ releases: {}, list: async () => [] }),
  });
  const env = { APP_ORIGIN: spec.origin, FLEET_SPEC: JSON.stringify(spec), PROVISIONER_TOKEN: 'fixture', RELEASE_CATALOG: '{}' };
  const visit = path => worker.fetch(new Request(spec.origin + path, { headers: { 'x-fixture-admin': '1' } }), env);
  const response = await visit('/');
  assert.equal(response.status, 200);
  const markup = await response.text();
  const inlineStyle = markup.match(/<style nonce="([^"]+)">/);
  assert.ok(inlineStyle, 'the console must carry its render-blocking styles in the initial response');
  const [, nonce] = inlineStyle;
  const csp = response.headers.get('Content-Security-Policy');
  assert.ok(csp.includes(`script-src 'self' 'nonce-${nonce}';`));
  assert.ok(csp.includes(`style-src 'self' 'nonce-${nonce}';`));
  assert.match(csp, /img-src 'self' data:/);
  assert.doesNotMatch(csp, /'unsafe-inline'/);
  assert.ok(markup.includes(`<script nonce="${nonce}">`));
  assert.match(markup, /<img src="data:image\/png;base64,/);
  assert.doesNotMatch(markup, /(?:src|href)="\/admin\/(?:console\.css|devices\.js|console-logo\.png)"/);
  assert.notEqual((await visit('/')).headers.get('Content-Security-Policy'), csp);
  assert.equal((await visit('/admin/console.css')).status, 200);
});

async function d1Fixture(t) {
  const sql = new DatabaseSync(':memory:');
  t.after(() => sql.close());
  for (const file of ['0001_tickets.sql', '0002_devices.sql', '0003_portal_callback_labels.sql', '0004_enrollment_intents.sql', '0005_upgrade_journal.sql']) {
    sql.exec(await readFile(new URL('../cloud/' + file, import.meta.url), 'utf8'));
  }
  return {
    prepare(statement) {
      const q = sql.prepare(statement);
      const methods = (...args) => ({
        async all() { return { results: q.all(...args) }; },
        async first() { return q.get(...args) ?? null; },
        async run() { return { meta: q.run(...args) }; },
      });
      return { ...methods(), bind: methods };
    },
    async batch(statements) { return Promise.all(statements.map(statement => statement.run())); },
  };
}

const migrations = ['CREATE TABLE IF NOT EXISTS fixture (id TEXT)'];
async function deploy(cf, state, options = {}) {
  return applySetup(cloudflareApi('administrator-test-auth', { request: cf.request }), spec, {
    state, save: async () => {}, migrations, releases: catalog, bundle: 'export default {}', ...options,
  });
}

async function hostedClaimFixture(t) {
  const cf = cloudFixture();
  await deploy(cf, { ticketKey });
  const db = await d1Fixture(t);
  const env = { TICKETS: db, TICKET_KEY: ticketKey,
    FLEET_SPEC: JSON.stringify({ ...spec, policyId: cf.db.policies[0].id }),
    PROVISIONER_TOKEN: 'generated-provisioner', RELEASE_CATALOG: JSON.stringify(catalog) };
  const issue = async (deviceId, platform = 'linux') => {
    const release = hostedInstallers(catalog)[platform];
    const intent = await issueEnrollmentIntent(db, ticketKey, { deviceId, platform, release, confirmBrowser: release.browser });
    const { code } = await revealEnrollmentIntent(db, ticketKey, intent.id);
    return { intent, input: { deviceId, platform, code, recoveryProof: 'R'.repeat(43), architecture: 'x64',
      version: release.version, sha256: release.assets.x64.sha256, browser: release.browser } };
  };
  return { cf, db, env, issue, devices: createDevices(env, cf.request) };
}

test('hosted claim pins the old release, provisions one device after a transient failure, and rejects other proofs', async t => {
  const { cf, env, issue, devices } = await hostedClaimFixture(t);
  const { intent, input } = await issue('hosted-one', 'windows');
  const writes = cf.writes.length;
  await assert.rejects(devices.launch(input.deviceId, 'windows-x64', { confirmBrowser: true }), /reserved/);
  await assert.rejects(devices.claimHostedEnrollment({ ...input, sha256: 'f'.repeat(64) }), error => error.status === 404);
  assert.equal(cf.writes.length, writes);
  assert.deepEqual(await devices.list(), []);

  const nextCatalog = { ...catalog, 'windows-x64': { ...catalog['windows-x64'], version: '9.0.0', browser: false } };
  const updated = createDevices({ ...env, RELEASE_CATALOG: JSON.stringify(nextCatalog) }, cf.request);
  cf.failNext(account + '/cfd_tunnel');
  await assert.rejects(updated.claimHostedEnrollment(input), /503/);
  assert.equal((await devices.list()).length, 1);
  await assert.rejects(updated.claimHostedEnrollment({ ...input, recoveryProof: 'X'.repeat(43) }), error => error.status === 404);
  const claimed = await updated.claimHostedEnrollment(input);
  assert.deepEqual(Object.keys(claimed).sort(), ['activationToken', 'browserToken', 'deviceId', 'portalToken', 'tunnelToken']);
  assert.notEqual(claimed.portalToken, claimed.activationToken);
  assert.notEqual(claimed.portalToken, claimed.browserToken);
  assert.deepEqual(await updated.claimHostedEnrollment(input), claimed);
  assert.equal(cf.db.tunnels.length, 1);
  assert.equal(cf.db.servers.length, 0);
  assert.equal((await updated.status(input.deviceId)).release, intent.release.version);
  await updated.disable(input.deviceId);
  await assert.rejects(updated.claimHostedEnrollment(input), error => error.status === 404);
});

test('a hosted claim routes the device Tunnel to the ports it negotiated and pins them for recovery', async t => {
  const { cf, issue, devices } = await hostedClaimFixture(t);
  const { input } = await issue('ported-host');
  const ports = input.browser ? { development: 41001, browser: 41003 } : { development: 41001 };
  await assert.rejects(devices.claimHostedEnrollment({ ...input, ports: { development: 80 } }), error => error.status === 400);
  const claimed = await devices.claimHostedEnrollment({ ...input, ports });
  assert.deepEqual(claimed.ports, ports);
  const ingress = cf.db.tunnels.at(-1).config.ingress;
  assert.deepEqual(ingress.filter(rule => rule.hostname).map(rule => rule.service),
    Object.values(ports).map(port => `http://127.0.0.1:${port}`));
  assert.deepEqual(await devices.claimHostedEnrollment({ ...input, ports }), claimed);
  await assert.rejects(devices.claimHostedEnrollment(input), error => error.status === 404);
  await assert.rejects(devices.claimHostedEnrollment({ ...input, ports: { ...ports, development: 41009 } }), error => error.status === 404);
});

test('disabling a pending or claimed intent before fleet provisioning creates an irreversible local tombstone', async t => {
  const { cf, db, issue, devices } = await hostedClaimFixture(t);
  for (const [id, consume] of [['pending-host', false], ['claimed-host', true]]) {
    const { intent, input } = await issue(id);
    if (consume) assert.equal((await claimEnrollmentIntent(db, input)).state, 'claimed');
    const writes = cf.writes.length;
    assert.deepEqual(await devices.disable(id), { status: 'disabled' });
    assert.equal(await revealEnrollmentIntent(db, ticketKey, intent.id), undefined);
    await assert.rejects(devices.claimHostedEnrollment(input), error => error.status === 404);
    await assert.rejects(devices.launch(id, 'linux'), error => error.status === 409);
    assert.equal(cf.writes.length, writes);
  }
  assert.equal(cf.db.tunnels.length, 0);
  assert.deepEqual((await devices.list()).map(x => x.status), ['disabled', 'disabled']);
});

test('an expired claim recovery cannot resume partial Cloudflare provisioning', async t => {
  const { cf, db, issue, devices } = await hostedClaimFixture(t);
  const { input, intent } = await issue('expired-partial');
  cf.failNext(account + '/cfd_tunnel');
  await assert.rejects(devices.claimHostedEnrollment(input), /503/);
  assert.equal((await devices.list()).length, 1);
  await db.prepare('UPDATE enrollment_intents SET resolved_at = ? WHERE id = ?')
    .bind(Math.floor(Date.now() / 1000) - 3600, intent.id).run();

  const writes = cf.writes.length;
  await assert.rejects(devices.claimHostedEnrollment(input), error => error.status === 404);
  assert.equal(cf.writes.length, writes);
  assert.equal(cf.db.tunnels.length, 0);
  assert.deepEqual(await devices.disable(input.deviceId), { status: 'disabled' });
  await assert.rejects(devices.claimHostedEnrollment(input), error => error.status === 404);
  await assert.rejects(devices.launch(input.deviceId, 'linux'), error => error.status === 409);
});

test('legacy provisioning still launches before the enrollment intent migration', async t => {
  const { db, devices } = await hostedClaimFixture(t);
  await db.prepare('DROP TABLE enrollment_intents').run();
  assert.ok((await devices.launch('legacy-one', 'linux')).ticket);
  await assert.rejects(devices.claimHostedEnrollment({ deviceId: 'missing-intent', platform: 'linux' }), error => error.status === 404);
});

test('legacy managed add reserves only the ID before choosing OS, leaving old tickets usable', async t => {
  const { cf, db, env } = await hostedClaimFixture(t);
  // A public legacy control plane need not have opted into the durable schema or catalog.
  await db.prepare('DROP TABLE enrollment_intents').run();
  let requests = 0;
  const devices = createDevices(env, (...args) => { requests++; return cf.request(...args); });
  const worker = createWorker({ verifyAdmin: request => request.headers.has('x-owner-fixture'), deviceProvider: () => devices });
  const bindings = { ...env, APP_ORIGIN: spec.origin };
  const headers = { Accept: 'application/json', Origin: spec.origin, 'x-owner-fixture': '1' };
  const request = (path, init) => worker.fetch(new Request(spec.origin + path, init), bindings);
  const post = (path, fields, custom = headers) => request(path, {
    method: 'POST', headers: custom, body: new URLSearchParams(fields),
  });
  const reserve = (fields, custom) => post('/admin/devices/reserve', fields, custom);
  const draft = 'pending-setup';
  assert.equal((await reserve({ deviceId: draft }, { Origin: spec.origin })).status, 403);
  assert.equal((await reserve({ deviceId: draft }, { ...headers, Origin: 'https://other.example.test' })).status, 403);
  assert.equal((await reserve({ deviceId: draft, platform: 'linux' })).status, 400);
  assert.equal((await reserve([['deviceId', draft], ['deviceId', 'duplicate']])).status, 400);
  assert.equal((await reserve({ deviceId: 'INVALID' })).status, 400);
  const old = await issueTicket(db, ticketKey, { deviceId: 'previous', portalToken: 'p'.repeat(43),
    tunnelToken: 't'.repeat(80) });
  assert.equal((await reserve({ deviceId: 'previous' })).status, 409);
  assert.deepEqual(await (await reserve({ deviceId: draft })).json(), { deviceId: draft, draftSaved: true });
  assert.equal((await reserve({ deviceId: draft })).status, 409);
  const original = await db.prepare('SELECT * FROM fleet_devices WHERE id = ?').bind(draft).first();
  assert.deepEqual([original.platform, original.credentials, original.tunnel_id], ['', null, null]);
  assert.deepEqual(await devices.enrollmentStatus(draft), { registration: 'draft' });
  const page = await (await request('/', { headers })).text();
  assert.match(page, /data-state="draft" data-device="pending-setup"/);
  assert.match(page, /未选择系统/);
  assert.match(page, /data-action="setup-command"/);
  assert.equal((await post('/admin/devices', { deviceId: draft, platform: 'bad' })).status, 400);
  assert.equal((await post('/admin/devices', { deviceId: draft, platform: 'windows' })).status, 400);
  assert.equal(requests, 0, 'reserving and rejecting invalid selections do not access Cloudflare');
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM enrollment_tickets').first()).n, 1);
  const legacyRedeem = await request('/device/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ticket: old.ticket }) });
  assert.equal(legacyRedeem.status, 200);
  assert.equal((await legacyRedeem.json()).deviceId, 'previous');
  const issued = await (await post('/admin/devices', { deviceId: draft, platform: 'linux' })).json();
  assert.match(issued.command, /\/device\/install\/linux\?version=1\.1\.0/);
  assert.equal(issued.durable, undefined);
  assert.ok(issued.expiresAt - issued.serverTime >= 599 && issued.expiresAt - issued.serverTime <= 600);
  const registered = await db.prepare('SELECT * FROM fleet_devices WHERE id = ?').bind(draft).first();
  assert.equal(registered.unique_name, original.unique_name);
  assert.equal(registered.platform, 'linux');
  assert.ok(registered.credentials && registered.tunnel_id);
  assert.equal(cf.db.tunnels.length, 1);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM fleet_devices').first()).n, 1);
  const pending = await (await request('/', { headers })).text();
  assert.match(pending, /data-state="pending" data-device="pending-setup" data-platform="linux"/);
  assert.match(pending, /data-action="setup-command"/);
  const priorCalls = requests;
  assert.equal((await post('/admin/devices', { deviceId: draft, platform: 'linux' })).status, 409);
  assert.equal((await post('/admin/devices', { deviceId: draft, platform: 'windows', browserConsent: '1' })).status, 409);
  assert.equal(requests, priorCalls, 'invalid retry must not access Cloudflare or disturb the old ticket');
  assert.equal((await post('/admin/device', { deviceId: draft, action: 'cancel' })).status, 200);
  assert.equal((await post('/admin/devices', { deviceId: draft, platform: 'linux' })).status, 200);
  assert.equal(cf.db.tunnels.length, 1);
  assert.equal((await db.prepare('SELECT unique_name FROM fleet_devices WHERE id = ?').bind(draft).first()).unique_name, original.unique_name);
});

test('managed add keeps display names readable without making names device identities', async t => {
  const { cf, db, env, devices } = await hostedClaimFixture(t);
  const worker = createWorker({ verifyAdmin: req => req.headers.has('x-owner-fixture'), deviceProvider: () => devices });
  const bindings = { ...env, APP_ORIGIN: spec.origin };
  const headers = { Accept: 'application/json', Origin: spec.origin, 'x-owner-fixture': '1' };
  const request = (path, init) => worker.fetch(new Request(spec.origin + path, init), bindings);
  const reserve = fields => request('/admin/devices/reserve', { method: 'POST', headers, body: new URLSearchParams(fields) });
  const particular = '办公室 Mac';
  const before = cf.writes.length;
  assert.equal((await reserve({ name: '办公室\u0007 Mac' })).status, 400);
  assert.equal((await reserve({ name: '办'.repeat(21) })).status, 400);
  assert.equal((await reserve({ name: ' ' })).status, 400);
  assert.equal((await reserve({ name: particular, deviceId: 'manual-id' })).status, 400);
  assert.equal((await reserve([['name', particular], ['name', 'duplicate']])).status, 400);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM fleet_devices').first()).n, 0);

  const identities = [];
  for (const name of [particular, particular, 'e\u0301'.repeat(20)]) {
    const saved = await reserve({ name });
    assert.equal(saved.status, 200);
    const result = await saved.json();
    assert.match(result.deviceId, /^dev-[0-9a-f]{16}$/);
    assert.deepEqual(result, { deviceId: result.deviceId, draftSaved: true });
    identities.push(result.deviceId);
  }
  assert.equal(new Set(identities).size, identities.length);
  const legacy = 'prior-device-id';
  assert.deepEqual(await (await reserve({ deviceId: legacy })).json(), { deviceId: legacy, draftSaved: true });
  const markup = await (await request('/', { headers })).text();
  for (const id of identities.slice(0, 2)) {
    const row = new RegExp(`<tr role="row"[^>]*data-device="${id}"[^>]*>[\\s\\S]*?<\\/tr>`).exec(markup)?.[0];
    assert.ok(row, 'the named device row still carries its internal ID');
    assert.match(row, /<span class="device-name">办公室 Mac<\/span>/);
  }
  assert.match(markup, /<span class="device-name">prior-device-id<\/span>/);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM enrollment_tickets').first()).n, 0);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM enrollment_intents').first()).n, 0);
  assert.equal(cf.writes.length, before);
});

test('durable draft returns the exact reusable pending command and claim promotes its sole identity', async t => {
  const { cf, db, env, issue, devices } = await hostedClaimFixture(t);
  const bindings = { ...env, APP_ORIGIN: spec.origin, FLEET_ENROLLMENT_PROTOCOL: 'intent-v1', FLEET_ENROLLMENT_HISTORY: '{}' };
  const worker = createWorker({ verifyAdmin: request => request.headers.has('x-owner-fixture'), deviceProvider: () => devices });
  const headers = { Accept: 'application/json', Origin: spec.origin, 'x-owner-fixture': '1' };
  const request = (path, init) => worker.fetch(new Request(spec.origin + path, init), bindings);
  const post = (path, fields) => request(path, { method: 'POST', headers, body: new URLSearchParams(fields) });
  const draft = 'deferred';
  const reserve = deviceId => post('/admin/devices/reserve', { deviceId });
  const { input: occupied } = await issue('occupied');
  assert.equal((await reserve('occupied')).status, 409);
  assert.equal((await claimEnrollmentIntent(db, occupied)).state, 'claimed');
  assert.equal((await reserve('occupied')).status, 409);
  assert.equal((await reserve(draft)).status, 200);
  const original = await db.prepare('SELECT * FROM fleet_devices WHERE id = ?').bind(draft).first();
  const initialWrites = cf.writes.length;
  const create = () => post('/admin/devices', { deviceId: draft, platform: 'linux' });
  const result = await create();
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  const command = await result.json();
  assert.equal(command.durable, true);
  assert.equal(command.expiresAt, undefined);
  assert.match(command.command, /^bash <\(curl -fsSL https:\/\/raw\.githubusercontent\.com\/Erlin0220\/nodrelay\/refs\/heads\/main\/install\.sh\) -e https:\/\/[a-z0-9.-]+ -t [A-Za-z0-9_-]{43}$/);
  const target = { deviceId: draft, intentId: command.intentId };
  const status = ({ intentId } = {}) => request('/admin/devices/enrollment?' + new URLSearchParams({ deviceId: draft, ...(intentId && { intentId }) }), { headers });
  assert.deepEqual(await (await status()).json(), { registration: 'pending' });
  const page = await (await request('/', { headers })).text();
  assert.equal(page.match(/data-device="deferred"/g)?.length, 1);
  assert.ok(page.includes(`data-device="deferred" data-intent="${command.intentId}"`));
  assert.ok(!page.includes(command.command));
  assert.deepEqual(await (await post('/admin/enrollment-intents', { ...target, action: 'reveal' })).json(), command);
  assert.equal((await create()).status, 409);
  assert.equal((await post('/admin/enrollment-intents', { ...target, action: 'revoke' })).status, 200);
  assert.deepEqual(await (await status(target)).json(), { registration: 'revoked' });
  assert.deepEqual(await (await status()).json(), { registration: 'draft' });
  const replacement = await (await create()).json();
  assert.notEqual(replacement.intentId, command.intentId);
  assert.equal((await post('/admin/enrollment-intents', { ...target, action: 'reveal' })).status, 404);
  assert.equal(cf.writes.length, initialWrites);
  const code = / -t ([A-Za-z0-9_-]{43})$/.exec(replacement.command)?.[1];
  assert.ok(code && !page.includes(code));
  const enrollment = { deviceId: draft, code, recoveryProof: 'r'.repeat(43), platform: 'linux', architecture: 'x64',
    browser: false, version: catalog['linux-x64'].version, sha256: catalog['linux-x64'].sha256 };
  // Simulate a stop after the original consumer's claim CAS but before the device row is promoted.
  assert.equal((await claimEnrollmentIntent(db, enrollment)).state, 'claimed');
  assert.equal((await db.prepare('SELECT platform FROM fleet_devices WHERE id = ?').bind(draft).first()).platform, '');
  await assert.rejects(devices.claimHostedEnrollment({ ...enrollment, recoveryProof: 'x'.repeat(43) }), { status: 404 });
  const enrolled = await devices.claimHostedEnrollment(enrollment);
  assert.deepEqual(await devices.claimHostedEnrollment(enrollment), enrolled);
  assert.equal(cf.db.tunnels.length, 1);
  assert.equal((await db.prepare('SELECT unique_name FROM fleet_devices WHERE id = ?').bind(draft).first()).unique_name, original.unique_name);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM fleet_devices').first()).n, 1);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM enrollment_tickets').first()).n, 0);
});

test('Cloudflare custom domain deletion succeeds without a JSON envelope', async () => {
  const api = cloudflareApi('fixture', { request: async (_url, request) => {
    assert.equal(request.method, 'DELETE');
    return new Response(null, { status: 204 });
  } });
  assert.equal(await api.del(account + '/workers/domains/test-domain'), undefined);
});

test('setup resumes after a partial error, retains owner protection and provisions exactly one service token', async () => {
  const cf = cloudFixture();
  const state = { ticketKey };
  cf.failNext(account + '/workers/domains');
  await assert.rejects(deploy(cf, state), /503/);
  const result = await deploy(cf, state);
  assert.equal(result.management, spec.origin);
  assert.equal(result.portal, 'https://' + spec.portalHostname + '/mcp');
  assert.equal(cf.db.d1.length, 1);
  assert.equal(cf.db.domains.length, 1);
  assert.equal(cf.db.apps.length, 6);
  assert.deepEqual(cf.db.apps.filter(x => x.domain.includes('/device/')).map(x => x.domain), [
    new URL(spec.origin).hostname + '/device/enroll', new URL(spec.origin).hostname + '/device/activate',
    new URL(spec.origin).hostname + '/device/install/windows', new URL(spec.origin).hostname + '/device/install/linux',
  ]);
  assert.equal(state.draft, undefined);
  assert.equal(state.ticketKey, undefined);
  await deploy(cf, state);
  assert.equal(cf.db.dns.find(x => x.name === spec.portalHostname).content, 'gateway.agents.cloudflare.com');
  assert.equal(cf.writes.filter(([method, path]) => method === 'POST' && path.endsWith('/tokens')).length, 1);
  assert.equal(cf.db.apps.find(x => x.type === 'mcp_portal').oauth_configuration.enabled, true);
  assert.throws(() => makeSetupSpec({ namespace: 'demo', ownerEmail: spec.ownerEmail }, {
    id: spec.zoneId, account: { id: spec.accountId }, status: 'active', name: 'account.workers.dev',
  }, '1'.repeat(12)), /active Cloudflare zone/);
});

test('a short-lived pilot token uses cloudflared-only and pins the account and DNS zone', async () => {
  const cf = cloudFixture();
  const before = Date.now();
  await assert.rejects(deploy(cf, { ticketKey }, { provisionerLifetimeDays: 0 }), /1 to 90/);
  const deployment = await deploy(cf, { ticketKey }, { provisionerLifetimeDays: 1 });
  assert.ok(Date.parse(deployment.provisionerExpiresOn) > before + 86400000 - 1000);
  const credential = cf.db.tokens[0];
  assert.equal(credential.expires_on, deployment.provisionerExpiresOn);
  assert.deepEqual(credential.policies[0].resources, { ['com.cloudflare.api.account.' + spec.accountId]: '*' });
  assert.deepEqual(credential.policies[1].resources, { ['com.cloudflare.api.account.zone.' + spec.zoneId]: '*' });
  assert.deepEqual(credential.policies.map(x => x.permission_groups.length), [3, 1]);
});

test('setup refuses to bind a pilot token whose expiry Cloudflare cannot confirm', async () => {
  const cf = cloudFixture({ omitTokenExpiry: true });
  await assert.rejects(deploy(cf, { ticketKey }, { provisionerLifetimeDays: 1 }), /new token was revoked/);
  assert.equal(cf.db.tokens.length, 0);
  assert.equal(cf.db.scripts.length, 0);
  assert.ok(cf.writes.some(([method, path]) => method === 'DELETE' && path.endsWith('/tokens/provisioner')));
});

test('a legacy device wildcard stops setup before any Cloudflare write', async () => {
  const cf = cloudFixture();
  cf.db.apps.push({ domain: new URL(spec.origin).hostname + '/device/*' });
  await assert.rejects(deploy(cf, { ticketKey }), /legacy wildcard device Access application/);
  assert.equal(cf.writes.length, 0);
});

test('two independent devices provision, retry an offline origin, and revoke one without changing the peer', async t => {
  const cf = cloudFixture();
  await deploy(cf, { ticketKey });
  const db = await d1Fixture(t);
  const env = {
    TICKETS: db, TICKET_KEY: ticketKey, FLEET_SPEC: JSON.stringify({ ...spec, policyId: cf.db.policies[0].id }),
    PROVISIONER_TOKEN: 'generated-provisioner', RELEASE_CATALOG: JSON.stringify(catalog), APP_ORIGIN: spec.origin,
  };
  const devices = createDevices(env, cf.request);
  const alice = await devices.launch('alpha', 'linux-x64');
  const beforeNoConsent = cf.writes.length;
  await assert.rejects(devices.launch('beta', 'windows-x64'), /确认.*启用浏览器/);
  await assert.rejects(devices.launch('unused-dev', 'linux-x64', { confirmBrowser: true }), /未提供浏览器工具/);
  assert.equal(cf.writes.length, beforeNoConsent);
  assert.deepEqual((await devices.list()).map(x => x.id), ['alpha']);
  const bob = await devices.launch('beta', 'windows-x64', { confirmBrowser: true });
  await cancelTicket(db, 'beta');
  const nextCatalog = { ...catalog, 'windows-x64': { ...catalog['windows-x64'], version: '9.0', browser: false } };
  const updated = createDevices({ ...env, RELEASE_CATALOG: JSON.stringify(nextCatalog) }, cf.request);
  const reissued = await updated.launch('beta', 'windows-x64', { confirmBrowser: true });
  assert.deepEqual(reissued.asset, bob.asset, 'Pending ticket remains pinned after catalog change');
  assert.equal(cf.db.tunnels.length, 2);
  assert.equal(cf.db.servers.length, 0);
  assert.equal(cf.db.tunnels[0].config.ingress[0].path, '^/devspace/mcp$');
  assert.equal(cf.db.tunnels[1].config.ingress[1].path, '^/browser/mcp$');
  await assert.rejects(devices.launch('alpha', 'linux-x64'), /unclaimed ticket/);
  const alpha = await redeemTicket(db, ticketKey, alice.ticket);
  const beta = await redeemTicket(db, ticketKey, reissued.ticket);
  assert.equal(await redeemTicket(db, ticketKey, alice.ticket), undefined);
  assert.notEqual(alpha.portalToken, beta.portalToken);
  assert.equal(alpha.browserToken, undefined);
  assert.ok(beta.browserToken);
  assert.notEqual(beta.browserToken, beta.portalToken);
  assert.notEqual(beta.browserToken, beta.activationToken);
  assert.deepEqual((await devices.status('beta')).mcpProfiles, { development: 'unverified', browser: 'unverified' });
  await assert.rejects(devices.activate('alpha', beta.activationToken), /rejected/);
  cf.offline.add('alpha' + spec.deviceSuffix);
  await assert.rejects(devices.activate('alpha', alpha.activationToken), /unavailable/);
  const betaBrowser = 'https://beta' + spec.deviceSuffix + '/browser/mcp';
  const expectedTools = profiles.browser.tools.map(name => ({ name }));
  const noBrowserWrites = cf.writes.length;
  for (const catalog of [
    { tools: [...expectedTools, { name: 'exec_command' }] },
    { tools: [...expectedTools, expectedTools[0]] },
    { tools: expectedTools, nextCursor: 'unexpected-page' },
  ]) {
    cf.mcpCatalogs.set(betaBrowser, catalog);
    await assert.rejects(devices.activate('beta', beta.activationToken), /browser-only tool catalog/);
    assert.equal(cf.writes.length, noBrowserWrites);
    assert.equal((await devices.status('beta')).registration, 'pending');
  }
  cf.mcpCatalogs.set(betaBrowser, { tools: [...expectedTools, { name: 'browser_type' }] });
  assert.equal((await devices.activate('beta', beta.activationToken)).status, 'active');
  cf.offline.clear();
  assert.equal((await devices.activate('alpha', alpha.activationToken)).status, 'active');
  assert.equal((await devices.activate('alpha', alpha.activationToken)).status, 'active');
  assert.equal((await devices.status('alpha')).mcp, 'catalog_verified');
  assert.deepEqual((await devices.status('alpha')).mcpProfiles, { development: 'catalog_verified', browser: 'not_enabled' });
  assert.equal(cf.db.portal.servers.length, 4);
  cf.failNext(account + '/cfd_tunnel/' + cf.db.tunnels[0].id + '/connections');
  await assert.rejects(devices.disable('alpha'), /503/);
  const earlyProof = await devices.activate('alpha', alpha.activationToken);
  assert.equal(await confirmedRevocation(earlyProof, spec.origin, 'alpha', alpha.activationToken), true);
  await assert.rejects(devices.activate('alpha', beta.activationToken), /rejected/);
  assert.equal((await devices.status('alpha')).revocation, 'pending');
  await devices.disable('alpha');
  assert.equal((await devices.status('alpha')).revocation, 'complete');
  assert.equal((await devices.status('alpha')).mcpProfiles.browser, 'disabled');
  const writes = cf.writes.length;
  await devices.disable('alpha');
  assert.equal(cf.writes.length, writes, 'A completed revocation is durable and idempotent');
  assert.equal(cf.db.portal.servers.length, 3);
  assert.ok(cf.db.portal.servers.some(x => x.server_id === 'existing-fixed-mapping'));
  assert.deepEqual(cf.db.tunnels[0].config.ingress, [{ service: 'http_status:404' }]);
  assert.equal(cf.db.tunnels[0].rotated, true);
  assert.equal(cf.db.tunnels[0].disconnected, true);
  assert.equal(cf.db.tunnels[1].rotated, undefined);
  const revocation = await devices.activate('alpha', alpha.activationToken);
  assert.equal(await confirmedRevocation(revocation, spec.origin, 'alpha', alpha.activationToken), true);
  assert.equal(await confirmedRevocation(revocation, spec.origin, 'beta', beta.activationToken), false);
  await assert.rejects(devices.activate('alpha', beta.activationToken), /rejected/);
  assert.equal((await devices.status('beta')).registration, 'active');

  const console = createWorker({
    verifyAdmin: req => req.headers.get('x-fixture-admin') === '1',
    deviceProvider: () => devices,
  });
  const visit = (path, init) => console.fetch(new Request(spec.origin + path, init), env);
  assert.equal((await visit('/')).status, 403);
  const page = await visit('/', { headers: { 'x-fixture-admin': '1' } });
  assert.match(page.headers.get('Content-Security-Policy'), /connect-src 'self'/);
  const markup = await page.text();
  assert.match(markup, /alpha.*linux/i);
  assert.match(markup, /<button[^>]+data-filter="disabled"[^>]*>[^<]*<span class="count">1<\/span>/);
  assert.match(markup, /portal\.example\.test|demo-portal\.example\.test/);
  assert.match(markup, /name="platform" value="windows" data-browser="true"/);
  assert.doesNotMatch(markup, /name="platform" value="linux" data-browser/);
  assert.doesNotMatch(markup, /demo\.nodrelay\.example|ubuntu-server|此预览/);
  assert.equal((await visit('/admin/console-logo.png')).status, 403);
  assert.match(markup, /id="device-command-expiration"/);
  assert.match(markup, /id="device-enrollment-progress"/);
  assert.equal((await visit('/admin/devices/enrollment?deviceId=beta')).status, 403);
  const enrollment = async id => visit('/admin/devices/enrollment?' + new URLSearchParams({ deviceId: id }), {
    headers: { 'x-fixture-admin': '1' },
  });
  const light = await enrollment('beta');
  assert.match(light.headers.get('Cache-Control'), /no-store/);
  assert.deepEqual(await light.json(), { registration: 'active' });
  assert.deepEqual(await (await enrollment('alpha')).json(), { registration: 'disabled' });
  assert.equal((await enrollment('absent')).status, 404);
  assert.equal((await enrollment('invalid!')).status, 400);
  const issued = await visit('/admin/devices', {
    method: 'POST', headers: { 'x-fixture-admin': '1', Origin: spec.origin },
    body: new URLSearchParams({ deviceId: 'gamma', platform: 'linux-x64' }),
  });
  assert.equal(issued.status, 200);
  const html = await issued.text();
  assert.match(html, /DEVSPACE_FLEET_DEVICE/);
  assert.ok(!html.includes('generated-provisioner'));
  assert.match(html, /id="copy"/);
  assert.deepEqual(await (await enrollment('gamma')).json(), { registration: 'pending' });
  assert.equal((await visit('/admin/copy.js')).status, 403);
  const ownerHeaders = { 'x-fixture-admin': '1', Origin: spec.origin };
  const command = await visit('/admin/devices', {
    method: 'POST', headers: ownerHeaders,
    body: new URLSearchParams({ deviceId: 'hosted-linux', platform: 'linux' }),
  });
  const commandPage = await command.text();
  assert.match(commandPage, /\/device\/install\/linux\?version=1\.1\.0/);
  assert.doesNotMatch(commandPage, /Installer hash mismatch|mktemp|downloads\.example\.test/);
  const publicScript = await visit('/device/install/linux?version=1.1.0');
  assert.equal(publicScript.status, 200);
  assert.match(publicScript.headers.get('Content-Type'), /^text\/plain/);
  const text = await publicScript.text();
  assert.match(text, /x86_64\|amd64/);
  assert.match(text, /Installer hash mismatch/);
  assert.match(text, /downloads\.example\.test/);
  assert.ok(!text.includes('hosted-linux'));
  assert.equal((await visit('/device/install/linux?version=1.1.0&manifest=' + 'a'.repeat(64))).status, 404);
  const windows = await visit('/device/install/windows?version=1.1.0');
  assert.equal(windows.status, 200);
  assert.match(await windows.text(), /^param\([\s\S]+Get-FileHash[\s\S]+fleet\/src\/install-device\.mjs/);
  assert.equal((await visit('/device/install/windows')).status, 404);
  assert.equal((await visit('/device/install/linux?version=0.0.1')).status, 404);
  assert.equal((await visit('/device/install/macos?version=1.1.0')).status, 404);
  assert.equal((await visit('/device/install/linux?version=1.1.0', { method: 'POST' })).status, 404);
  assert.equal((await visit('/device/install/linux/anything?version=1.1.0')).status, 403);
  assert.match(await (await visit('/admin/copy.js', { headers: ownerHeaders })).text(), /clipboard.writeText/);
  const writesBeforeConfirm = cf.writes.length;
  const confirm = await visit('/admin/device', {
    method: 'POST', headers: ownerHeaders,
    body: new URLSearchParams({ deviceId: 'beta', action: 'confirm-disable' }),
  });
  assert.match(await confirm.text(), /确认停用/);
  assert.equal(cf.writes.length, writesBeforeConfirm);
  cf.failNext(account + '/cfd_tunnel/' + cf.db.tunnels[1].id, 'GET');
  assert.deepEqual(await (await enrollment('beta')).json(), { registration: 'active' });
  const detail = await visit('/admin/device', {
    method: 'POST', headers: ownerHeaders,
    body: new URLSearchParams({ deviceId: 'beta', action: 'status' }),
  });
  // The preceding lightweight lookups must not consume the mocked Tunnel failure.
  const detailHtml = await detail.text();
  assert.match(detailHtml, /beta-[a-f0-9]{5}-b/);
  assert.match(detailHtml, /无法查询 · HTTP 503/);
  const jsonHeaders = { ...ownerHeaders, Accept: 'application/json' };
  const action = (deviceId, action, headers = jsonHeaders) => visit('/admin/device', {
    method: 'POST', headers, body: new URLSearchParams({ deviceId, action }),
  });
  const active = await (await action('beta', 'status')).json();
  assert.equal(active.registration, 'active');
  assert.equal(active.mcp, 'catalog_verified');
  assert.deepEqual(active.mcpProfiles, { development: 'catalog_verified', browser: 'catalog_verified' });
  cf.offline.add(betaBrowser);
  const paused = await (await action('beta', 'status')).json();
  assert.equal(paused.mcp, 'unavailable');
  assert.deepEqual(paused.mcpProfiles, { development: 'catalog_verified', browser: 'unavailable' });
  assert.deepEqual(paused.mcpDiagnostics, { browser: { reason: 'http_error', httpStatus: 503 } });
  assert.ok(Number.isSafeInteger(paused.checkedAt));
  cf.failNext(account + '/cfd_tunnel/' + cf.db.tunnels[1].id, 'GET');
  const partial = await (await action('beta', 'status')).json();
  assert.equal(partial.tunnel, 'check_failed');
  assert.equal(partial.tunnelDiagnostic.httpStatus, 503);
  assert.equal(partial.mcpProfiles.development, 'catalog_verified');
  cf.offline.delete(betaBrowser);
  assert.equal((await action('beta', 'disable', { ...jsonHeaders, Origin: 'https://other.example.test' })).status, 403);
  const browserForm = (fields, headers = jsonHeaders) => visit('/admin/devices', {
    method: 'POST', headers, body: new URLSearchParams({ deviceId: 'json-windows', platform: 'windows', ...fields }),
  });
  assert.equal((await browserForm({}, jsonHeaders)).status, 400);
  assert.equal((await browserForm({ browserConsent: '1' }, { ...jsonHeaders, Origin: 'https://other.example.test' })).status, 403);
  const issuedJson = await browserForm({ browserConsent: '1' });
  const jsonCommand = await issuedJson.json();
  assert.equal(issuedJson.status, 200);
  assert.equal(jsonCommand.deviceId, 'json-windows');
  assert.equal(jsonCommand.platform, 'Windows');
  assert.ok(jsonCommand.expiresAt - jsonCommand.serverTime <= 600);
  assert.ok(jsonCommand.expiresAt > jsonCommand.serverTime);
  assert.match(jsonCommand.command, /\/device\/install\/windows\?version=1\.1\.0/);
  assert.match(jsonCommand.instructions, /PowerShell/);
  assert.match(jsonCommand.instructions, /浏览器专用后端/);
  assert.doesNotMatch(JSON.stringify(jsonCommand), /browserToken|apiToken|generated-provisioner/);
  assert.deepEqual(await (await action('json-windows', 'cancel')).json(), { status: 'cancelled' });
  assert.deepEqual(await (await action('json-windows', 'disable')).json(), { status: 'disabled' });
  const callbackPath = '/admin/client-callbacks';
  assert.equal((await visit(callbackPath)).status, 403);
  const beforeCallbacks = await (await visit(callbackPath, { headers: jsonHeaders })).json();
  assert.equal(beforeCallbacks.enabled, true);
  const addCallback = (redirectUri, headers = jsonHeaders) => visit(callbackPath, {
    method: 'POST', headers, body: new URLSearchParams({ clientName: 'Client fixture', redirectUri }),
  });
  assert.equal((await addCallback('https://client.example.test/callback', { ...jsonHeaders, Origin: 'https://other.example.test' })).status, 403);
  assert.equal((await addCallback('https://*.example.test/callback')).status, 400);
  assert.equal((await addCallback('https:/client.example.test/callback')).status, 400);
  assert.equal((await addCallback('https://client.example.test/callback/{client}')).status, 400);
  assert.equal((await addCallback('https://client.example.test/callback?code=fixture')).status, 400);
  const portalApp = cf.db.apps.find(app => app.type === 'mcp_portal');
  const policyIds = structuredClone(portalApp.policies);
  const allowed = await (await addCallback('https://client.example.test/callback')).json();
  assert.deepEqual(allowed.allowedUris, [...beforeCallbacks.allowedUris, 'https://client.example.test/callback']);
  assert.deepEqual(allowed.clients, [{ clientName: 'Client fixture', redirectUri: 'https://client.example.test/callback' }]);
  assert.deepEqual((await (await visit(callbackPath, { headers: jsonHeaders })).json()).clients, allowed.clients);
  assert.deepEqual(portalApp.policies, policyIds);
  const beforeRepeat = cf.writes.length;
  assert.deepEqual((await (await addCallback('https://client.example.test/callback')).json()).allowedUris, allowed.allowedUris);
  assert.equal(cf.writes.length, beforeRepeat);
});

test('concurrent management changes cannot acquire the same lock', async t => {
  const db = await d1Fixture(t);
  let unblock;
  let acquired;
  const started = new Promise(resolve => { acquired = resolve; });
  const operation = deviceLease(db, async () => {
    await new Promise(resolve => { unblock = resolve; acquired(); });
  });
  await started;
  await assert.rejects(deviceLease(db, () => {}), /Another device operation/);
  unblock();
  await operation;
  assert.equal(await deviceLease(db, () => 'released'), 'released');
});

test('Cloudflare registration creates one private PKCE client and refuses changes to a matching name', async () => {
  const registration = registrationSpec({
    accountId: spec.accountId, namespace: 'fleet-test',
    oauthRedirect: 'http://127.0.0.1:7840/oauth/callback',
  }, ['zone.read', 'account-api-tokens.write']);
  let client;
  let listVisible = true;
  let createAttempted = false;
  let mutations = 0;
  const api = cloudflareApi('non-production-registration-fixture', { async request(url, request) {
    assert.equal(url.pathname, '/client/v4/accounts/' + spec.accountId + '/oauth_clients');
    if (request.method === 'GET') return Response.json({ success: true, result: client && listVisible ? [client] : [] });
    assert.equal(request.method, 'POST');
    const body = JSON.parse(request.body);
    assert.equal(body.token_endpoint_auth_method, 'none');
    assert.deepEqual(body.optional_scopes, ['account-api-tokens.write']);
    mutations++;
    client = { ...body, client_id: 'oauth-fixture-id', visibility: 'private' };
    if (mutations === 1) throw new Error('response lost');
    return Response.json({ success: true, result: client });
  } });
  const beforeCreate = () => {
    if (createAttempted) throw new Error('uncertain earlier create');
    createAttempted = true;
  };
  assert.equal(registration.body.client_name, 'Nodrelay (fleet-test)');
  await assert.rejects(registerOAuthClient(api, registration, { beforeCreate }), /response lost/);
  listVisible = false;
  await assert.rejects(registerOAuthClient(api, registration, { beforeCreate }), /uncertain earlier create/);
  listVisible = true;
  const recovered = await registerOAuthClient(api, registration, { beforeCreate });
  assert.equal(recovered.oauthClientId, 'oauth-fixture-id');
  assert.equal(recovered.visibility, 'private');
  client.client_name = 'DevSpace Fleet (fleet-test)';
  assert.equal((await registerOAuthClient(api, registration, { beforeCreate })).oauthClientId, 'oauth-fixture-id');
  await assert.rejects(registerOAuthClient(api, {
    ...registration, body: { ...registration.body, scopes: ['different.scope'] },
  }), /settings or publisher verification differ/);
  assert.equal(mutations, 1);
});

for (const startThroughLoopback of [false, true]) {
  test(`setup OAuth exchanges a state-bound PKCE proof (local launch: ${startThroughLoopback})`, async () => {
    const server = createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    const redirectUri = `http://127.0.0.1:${port}/oauth/callback`;
    let challenge;
    let browseWork;
    const promise = authorize({
      clientId: 'product-public-oauth-id', redirectUri, scopes: ['zone.read'], startThroughLoopback,
      browse(url) {
        browseWork = (async () => {
          if (startThroughLoopback) {
            const launcher = new URL(url);
            assert.equal(launcher.pathname, '/oauth/start');
            assert.equal((await fetch(launcher.origin + launcher.pathname + '?nonce=bad', { redirect: 'manual' })).status, 404);
            const launch = await fetch(launcher, { redirect: 'manual' });
            assert.equal(launch.status, 302);
            url = launch.headers.get('location');
            assert.equal(new URL(url).origin, 'https://dash.cloudflare.com');
          }
          const params = new URL(url).searchParams;
          assert.equal(params.get('code_challenge_method'), 'S256');
          challenge = params.get('code_challenge');
          assert.equal((await fetch(redirectUri + '?code=forged&state=wrong')).status, 404);
          const redirect = new URL(redirectUri);
          redirect.search = new URLSearchParams({ code: 'fixture-code', state: params.get('state') });
          const callback = await fetch(redirect);
          assert.equal(callback.status, 200);
          assert.match(await callback.text(), /Return to Nodrelay for setup progress/);
        })();
      },
      async request(url, init) {
        assert.equal(url, 'https://dash.cloudflare.com/oauth2/token');
        assert.equal(init.body.get('code'), 'fixture-code');
        assert.equal(createHash('sha256').update(init.body.get('code_verifier')).digest('base64url'), challenge);
        return Response.json({ access_token: 'fixture-token', scope: 'zone.read' });
      },
    });
    assert.equal(await promise, 'fixture-token');
    await browseWork;
  });
}

test('cancelling interactive Cloudflare authorization closes the callback without a token exchange', async () => {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  const controller = new AbortController();
  const reason = new Error('fixture cancellation');
  await assert.rejects(authorize({
    clientId: 'product-public-oauth-id',
    redirectUri: `http://127.0.0.1:${port}/oauth/callback`,
    scopes: ['zone.read'],
    startThroughLoopback: true,
    signal: controller.signal,
    browse() { controller.abort(reason); },
    request() { assert.fail('Cancelled authorization must not exchange a token'); },
  }), error => error === reason);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  await new Promise(resolve => server.close(resolve));
});

test('pre-staged pilot releases require exactly one pinned, safe archive name', () => {
  const file = { localFile: 'devspace-1.0.0-macos-arm64.tgz', sha256: 'a'.repeat(64), version: '1.0.0' };
  const entries = validateReleaseCatalog({ 'macos-arm64': file });
  const cmd = installCommand(spec.origin, 'macos-arm64', entries['macos-arm64'], ticketKey, 'mac-test');
  assert.match(cmd, /cp '\.\/devspace-1\.0\.0-macos-arm64\.tgz'/);
  assert.ok(cmd.includes(file.sha256));
  assert.doesNotMatch(cmd, /curl --disable/);
  const windows = validateReleaseCatalog({ 'windows-x64': { ...file, localFile: 'device.zip' } });
  assert.match(installCommand(spec.origin, 'windows-x64', windows['windows-x64'], ticketKey, 'win-test'), /Copy-Item -LiteralPath/);
  for (const changed of [
    { ...file, localFile: '../payload.tgz' }, { ...file, localFile: 'some_file.zip' },
    { ...file, url: 'https://build.example.com/file.tgz' },
  ]) assert.throws(() => validateReleaseCatalog({ 'macos-arm64': changed }), /single archive basename/);
});

test('platform connection commands pin the bundle, isolate tickets and use OS service owners', () => {
  const marker = 'fixture-ticket';
  const shell = installCommand(spec.origin, 'linux-x64', catalog['linux-x64'], marker, 'alpha');
  const windows = installCommand(spec.origin, 'windows-x64', catalog['windows-x64'], marker, 'beta');
  assert.match(shell, /sha256sum.+tar -xzf.+DEVSPACE_FLEET_DEVICE/);
  assert.match(windows, /Get-FileHash.+Expand-Archive.+bin\/node\.exe.+install-device\.mjs.+LASTEXITCODE/);
  assert.doesNotMatch(windows, /install\.ps1|ExecutionPolicy|Unblock-File/i);
  assert.match(windows, /finally.*Remove-Item Env:DEVSPACE_FLEET_TICKET/);
  const agent = launchAgent('test', '/tmp/& node', ['/tmp/config'], '/tmp/fleet');
  assert.ok(agent.includes('&#38; node') && !agent.includes(marker));
  const unit = systemdUnit('test', '/tmp/% node', ['/tmp/config'], '/tmp/fleet % data');
  assert.match(unit, /\nWorkingDirectory=\/tmp\/fleet %% data\n/);
  assert.ok(unit.includes('%% node') && unit.includes('Restart=on-failure') && !unit.includes(marker));
});

test('owner creates and reveals a pinned command, and the device recovers a lost claim reply, activates and honors revocation', async t => {
  const cf = cloudFixture();
  await deploy(cf, { ticketKey });
  const db = await d1Fixture(t);
  const env = {
    TICKETS: db, TICKET_KEY: ticketKey, FLEET_SPEC: JSON.stringify({ ...spec, policyId: cf.db.policies[0].id }),
    PROVISIONER_TOKEN: 'generated-provisioner', RELEASE_CATALOG: JSON.stringify(catalog), APP_ORIGIN: spec.origin,
    FLEET_ENROLLMENT_PROTOCOL: 'intent-v1', FLEET_ENROLLMENT_HISTORY: '{}',
  };
  const worker = createWorker({ verifyAdmin: req => req.headers.has('x-owner-fixture'),
    deviceProvider: () => createDevices(env, cf.request) });
  const headers = { Accept: 'application/json', Origin: spec.origin, 'x-owner-fixture': '1' };
  const request = (path, init) => worker.fetch(new Request(spec.origin + path, init), env);
  const post = (path, fields, auth = headers) => request(path, {
    method: 'POST', headers: auth, body: new URLSearchParams(fields),
  });
  const initialWrites = cf.writes.length;
  const duplicate = await post('/admin/devices', [['deviceId','first'], ['deviceId','durable'], ['platform','linux']]);
  assert.equal(duplicate.status, 400);
  assert.equal((await duplicate.json()).code, 'duplicate_fields');
  const missingInstaller = await post('/admin/devices', { deviceId: 'durable', platform: 'unsupported' });
  assert.equal(missingInstaller.status, 400);
  assert.equal((await missingInstaller.json()).code, 'installer_unavailable');
  // Durable commands are OS-scoped; the signed installer chooses the architecture.
  const archOnly = await post('/admin/devices', { deviceId: 'durable', platform: 'linux-x64' });
  assert.equal(archOnly.status, 400);
  assert.equal((await archOnly.json()).code, 'installer_unavailable');
  assert.deepEqual(await db.prepare('SELECT device_id FROM enrollment_intents').all(), { results: [] });
  const created = await post('/admin/devices', { deviceId: 'durable', platform: 'linux' });
  assert.deepEqual(await created.json(), { intentSaved: true, deviceId: 'durable' });
  const occupied = await post('/admin/devices', { deviceId: 'durable', platform: 'linux' }, { ...headers, Accept: 'text/html' });
  assert.equal(occupied.status, 409);
  assert.match(occupied.headers.get('content-type'), /^text\/html/);
  const errorPage = await occupied.text();
  assert.match(errorPage, /这个设备名称已有接入记录/);
  assert.match(errorPage, /href="\/">返回设备列表/);
  assert.equal(cf.writes.length, initialWrites);
  const page = await (await request('/', { headers })).text();
  assert.match(page, /等待设备接入/);
  assert.match(page, /data-action="intent-command"/);
  const intentId = /data-device="durable" data-intent="([a-f0-9-]+)"/.exec(page)?.[1];
  assert.ok(intentId);
  const target = { deviceId: 'durable', intentId, action: 'reveal' };
  assert.equal((await post('/admin/enrollment-intents', target, { ...headers, Origin: 'https://other.example.test' })).status, 403);
  const result = await post('/admin/enrollment-intents', target);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  const cmd = await result.json();
  assert.equal(cmd.durable, true);
  assert.equal(cmd.expiresAt, undefined);
  assert.equal((await (await post('/admin/enrollment-intents', target)).json()).command, cmd.command);
  // The copied command names the public entry, the console and the code only.
  const href = '/device/install/linux?v=' + catalog['linux-x64'].version;
  const url = new URL(href, spec.origin);
  const code = / -t ([A-Za-z0-9_-]{43})$/.exec(cmd.command)?.[1];
  assert.ok(code && !page.includes(code));
  assert.ok(cmd.command.includes(' -e ' + spec.origin + ' '));
  const launch = await request(url.pathname + url.search);
  assert.equal(launch.status, 200);
  assert.match(await launch.text(), /DEVSPACE_FLEET_ENROLLMENT_PROTOCOL=intent-v1/);
  const served = await (await request(url.pathname + url.search)).text();
  // The copied command runs the downloaded text: nothing may run unless the last line arrived.
  assert.match(served, /^#!\/bin\/sh\nnodrelay_install\(\) \{\n/);
  assert.match(served, /\n\}\nnodrelay_install "\$@"\n$/);
  assert.equal((await request(url.pathname + url.search + '&extra=1')).status, 404);
  // The public entry exchanges the code for an installer bound to this device.
  const launchWith = (body, type = 'application/json', os = 'linux') => request('/device/install/' + os, {
    method: 'POST', headers: { 'Content-Type': type }, body: JSON.stringify(body) });
  const bound = await launchWith({ code });
  assert.equal(bound.status, 200);
  assert.equal(bound.headers.get('cache-control'), 'no-store');
  const boundScript = await bound.text();
  assert.match(boundScript, /\n\}\nnodrelay_install 'durable' "\$1"\n$/);
  assert.ok(!boundScript.includes(code), 'the bound installer never echoes the code');
  assert.equal((await launchWith({ code: 'x'.repeat(43) })).status, 404);
  assert.equal((await launchWith({ code, extra: 1 })).status, 404);
  assert.equal((await launchWith({ code }, 'text/plain')).status, 415);
  assert.equal((await launchWith({ code }, 'application/json', 'windows')).status, 404, 'a Linux-only command has no Windows installer');
  const enrollmentPath = '/admin/devices/enrollment?';
  const boundStatus = (deviceId, id) => request(enrollmentPath + new URLSearchParams({ deviceId, intentId: id }), { headers });
  assert.equal(cmd.intentId, intentId);
  assert.equal((await request(enrollmentPath + new URLSearchParams({ deviceId: 'durable', intentId }))).status, 403);
  assert.deepEqual(await (await boundStatus('durable', intentId)).json(), { registration: 'pending' });
  assert.equal((await boundStatus('other', intentId)).status, 404);
  assert.equal((await request(enrollmentPath + new URLSearchParams([
    ['deviceId', 'other'], ['deviceId', 'durable'], ['intentId', intentId],
  ]), { headers })).status, 400);
  assert.equal((await post('/admin/enrollment-intents', { ...target, action: 'revoke' })).status, 200);
  const replacement = await post('/admin/devices', { deviceId: 'durable', platform: 'linux' });
  assert.equal(replacement.status, 200);
  const replacementPage = await (await request('/', { headers })).text();
  const replacementId = /data-device="durable" data-intent="([a-f0-9-]+)"/.exec(replacementPage)?.[1];
  assert.ok(replacementId && replacementId !== intentId);
  const retired = await boundStatus('durable', intentId);
  assert.equal(retired.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(await retired.json(), { registration: 'revoked' });
  assert.deepEqual(await (await boundStatus('durable', replacementId)).json(), { registration: 'pending' });
  assert.equal(cf.writes.length, initialWrites);
  const replacementCommand = await (await post('/admin/enrollment-intents', { ...target, intentId: replacementId })).json();
  const replacementCode = / -t ([A-Za-z0-9_-]{43})$/.exec(replacementCommand.command)?.[1];
  assert.ok(replacementCode && replacementCode !== code);
  const claim = { deviceId: 'durable', code: replacementCode, platform: 'linux', architecture: 'x64',
    browser: false, version: catalog['linux-x64'].version, sha256: catalog['linux-x64'].sha256 };
  const redeem = input => request('/device/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input) });
  assert.equal((await redeem({ ...claim, protocol: 'intent-v1', code, recoveryProof: 'r'.repeat(43) })).status, 404);
  assert.equal((await redeem({ ...claim, protocol: 'intent-v1', sha256: '0'.repeat(64), recoveryProof: 'r'.repeat(43) })).status, 404);
  assert.equal(cf.writes.length, initialWrites);

  const callWorker = (url, init) => {
    assert.equal(new URL(url).origin, spec.origin);
    return worker.fetch(new Request(url, init), env);
  };
  const files = new Map();
  const recoveryStore = {
    async prepare() {},
    async read(path) {
      if (!files.has(path)) throw Object.assign(new Error('Fixture file missing'), { code: 'ENOENT' });
      return files.get(path);
    },
    async publish(path, contents) { assert.equal(files.has(path), false); files.set(path, contents); },
    async sync() {},
  };
  const clientInput = { ...claim, manager: spec.origin, root: resolve('simulated-device-a') };
  let original;
  await assert.rejects(claimDeviceEnrollment(clientInput, { recoveryStore, request: async (url, init) => {
    const response = await callWorker(url, init);
    assert.equal(response.status, 200);
    original = await response.json();
    throw new Error('Fixture drops a successful response');
  } }), { code: 'claim_unconfirmed' });
  assert.ok(original, 'first request reached the real Worker handler and consumed the command');
  assert.equal(cf.db.tunnels.length, 1);
  assert.equal(cf.db.servers.length, 0);
  assert.equal((await post('/admin/enrollment-intents', { ...target, intentId: replacementId })).status, 404);
  assert.deepEqual(await (await boundStatus('durable', replacementId)).json(), { registration: 'installing' });
  const afterFirstClaim = cf.writes.length;
  const originalConfig = structuredClone(cf.db.tunnels[0].config);
  await assert.rejects(claimDeviceEnrollment({ ...clientInput, root: resolve('simulated-device-b') },
    { recoveryStore, request: callWorker }), { code: 'claim_rejected', httpStatus: 404 });
  assert.equal(cf.writes.length, afterFirstClaim, 'another device must not change cloud state');
  const credentials = await claimDeviceEnrollment(clientInput, { recoveryStore, request: callWorker });
  assert.deepEqual(credentials, original);
  assert.deepEqual(cf.writes.slice(afterFirstClaim), [
    ['PUT', account + '/cfd_tunnel/' + cf.db.tunnels[0].id + '/configurations'],
  ], 'same-device recovery may reconcile the existing Tunnel but must not create resources');
  assert.equal(cf.db.tunnels.length, 1);
  assert.deepEqual(cf.db.tunnels[0].config, originalConfig);

  const connect = token => checkConnection(clientInput, token, new AbortController().signal, { request: callWorker });
  assert.deepEqual(await connect(credentials.portalToken), { status: 'unconfirmed', reason: 'http', httpStatus: 401 });
  cf.offline.add('durable' + spec.deviceSuffix);
  assert.deepEqual(await connect(credentials.activationToken), { status: 'unconfirmed', reason: 'route_unavailable', httpStatus: 409 });
  assert.equal(cf.db.servers.length, 0);
  cf.offline.clear();
  assert.deepEqual(await connect(credentials.activationToken), { status: 'active' });
  const activeMappings = cf.db.portal.servers.map(x => x.server_id);
  assert.equal(cf.db.servers.length, 1);
  assert.equal(activeMappings.length, 2);
  assert.ok(activeMappings.includes(cf.db.servers[0].id));
  assert.ok(activeMappings.includes('existing-fixed-mapping'));
  assert.equal((await post('/admin/device', { action: 'disable', deviceId: claim.deviceId }, { Accept: 'application/json' })).status, 403);
  assert.deepEqual(await connect(credentials.activationToken), { status: 'active' });
  const disable = await post('/admin/device', { action: 'disable', deviceId: claim.deviceId });
  assert.equal(disable.status, 200);
  assert.deepEqual(cf.db.portal.servers.map(x => x.server_id), ['existing-fixed-mapping']);
  assert.deepEqual(await connect(credentials.activationToken), { status: 'revoked' });
  assert.deepEqual(await (await boundStatus('durable', replacementId)).json(), { registration: 'disabled' });
  assert.deepEqual(await (await boundStatus('durable', intentId)).json(), { registration: 'revoked' });
  assert.deepEqual(await connect(credentials.portalToken), { status: 'unconfirmed', reason: 'http', httpStatus: 401 });
  await assert.rejects(claimDeviceEnrollment(clientInput, { recoveryStore, request: callWorker }),
    { code: 'claim_rejected', httpStatus: 404 });
});

test('legacy public installers reject ambiguous queries and report unavailable catalog bindings safely', async () => {
  const worker = createWorker({ verifyAdmin: () => assert.fail('public route must not require administrator login') });
  const env = { APP_ORIGIN: spec.origin, FLEET_SPEC: '{}', PROVISIONER_TOKEN: 'not-public',
    RELEASE_CATALOG: JSON.stringify(catalog) };
  const visit = (query, releaseCatalog = env.RELEASE_CATALOG) =>
    worker.fetch(new Request(spec.origin + '/device/install/linux?' + query), { ...env, RELEASE_CATALOG: releaseCatalog });
  assert.equal((await visit('version=1.1.0')).status, 200);
  for (const query of ['version=1.1.0&version=0.0.0', 'version=1.1.0&extra=1']) {
    assert.equal((await visit(query)).status, 404);
  }
  for (const releaseCatalog of ['not-json-private-value', 'null', JSON.stringify({
    ...catalog, 'linux-arm64': { ...catalog['linux-x64'], version: '2.0.0' },
  })]) {
    const response = await visit('version=1.1.0', releaseCatalog);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.match(response.headers.get('Content-Type'), /^application\/json/);
    assert.deepEqual(await response.json(), {
      error: 'Installer catalog temporarily unavailable. Contact the management console administrator.',
    });
  }
});

test('one durable code serves every hosted system until the first claim narrows it to the installing system', async t => {
  const { cf, db, env, devices } = await hostedClaimFixture(t);
  const bindings = { ...env, APP_ORIGIN: spec.origin, FLEET_ENROLLMENT_PROTOCOL: 'intent-v1', FLEET_ENROLLMENT_HISTORY: '{}' };
  const worker = createWorker({ verifyAdmin: request => request.headers.has('x-owner-fixture'), deviceProvider: () => devices });
  const headers = { Accept: 'application/json', Origin: spec.origin, 'x-owner-fixture': '1' };
  const request = (path, init) => worker.fetch(new Request(spec.origin + path, init), bindings);
  const post = (path, fields) => request(path, { method: 'POST', headers, body: new URLSearchParams(fields) });
  assert.equal((await post('/admin/devices/reserve', { deviceId: 'anywhere' })).status, 200);
  const writes = cf.writes.length;
  // The hosted Windows bundle carries browser tools, so the any-system command needs that consent.
  assert.equal((await post('/admin/devices', { deviceId: 'anywhere' })).status, 400);
  const created = await post('/admin/devices', { deviceId: 'anywhere', browserConsent: '1' });
  assert.equal(created.status, 200);
  const result = await created.json();
  assert.deepEqual(result.systems.map(system => system.id), ['linux', 'windows']);
  assert.equal(result.system, 'linux');
  const code = / -t ([A-Za-z0-9_-]{43})$/.exec(result.systems[0].command)?.[1];
  assert.ok(code);
  const windows = result.systems[1].command;
  assert.equal(windows, `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "try { iwr 'https://raw.githubusercontent.com/Erlin0220/nodrelay/refs/heads/main/install.ps1' -UseBasicParsing -OutFile 'nodrelay-install.ps1' -ErrorAction Stop; & '.\\nodrelay-install.ps1' '-e' '${spec.origin}' '-t' '${code}' } catch { throw }"`);
  assert.ok(!windows.includes('$'), 'an outer PowerShell must not expand anything in the copied command');
  assert.match(result.systems[1].instructions, /PowerShell/);
  const revealed = await (await post('/admin/enrollment-intents', { deviceId: 'anywhere', intentId: result.intentId, action: 'reveal' })).json();
  assert.deepEqual(revealed.systems, result.systems);
  const served = await (await request('/device/install/windows?v=1.1.0')).text();
  assert.match(served, /^param\(/);
  assert.match(served, /DEVSPACE_FLEET_PORT_PROTOCOL = 'v1'/);
  const launchWindows = await request('/device/install/windows', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
  const bound = await launchWindows.text();
  assert.match(bound, /^param\(\[ValidatePattern\('\^\[a-z\]\[a-z0-9-\]\{0,23\}\$'\)\]\[string\]\$Device = 'anywhere', \[Parameter\(Mandatory\)\]/);
  assert.equal(cf.writes.length, writes, 'creating, revealing and fetching commands never touches Cloudflare');
  const page = await (await request('/', { headers })).text();
  assert.match(page, /data-device="anywhere" data-intent="[a-f0-9-]+"[^>]*>[\s\S]*?未选择系统/);

  const claim = { deviceId: 'anywhere', code, recoveryProof: 'r'.repeat(43), platform: 'windows', architecture: 'x64',
    browser: true, version: catalog['windows-x64'].version, sha256: catalog['windows-x64'].sha256 };
  const claimed = await devices.claimHostedEnrollment(claim);
  assert.ok(claimed.browserToken);
  assert.deepEqual(await devices.claimHostedEnrollment(claim), claimed);
  const stored = JSON.parse((await db.prepare('SELECT snapshot FROM enrollment_intents WHERE device_id = ?').bind('anywhere').first()).snapshot);
  assert.equal(stored.platform, 'windows');
  const linux = { ...claim, platform: 'linux', browser: false, sha256: catalog['linux-x64'].sha256 };
  await assert.rejects(devices.claimHostedEnrollment(linux), error => error.status === 404);
  const afterClaim = os => request('/device/install/' + os, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
  assert.equal((await afterClaim('linux')).status, 404, 'after a Windows claim the Linux entry no longer resolves');
  assert.equal((await afterClaim('windows')).status, 200, 'the claiming system can still recover within its window');
  assert.equal(cf.db.tunnels.length, 1);
});

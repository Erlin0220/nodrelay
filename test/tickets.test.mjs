import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createWorker } from '../cloud/worker.mjs';
import { issueTicket, redeemTicket } from '../cloud/tickets.mjs';

const origin = 'https://fleet-manager.example.invalid';
const key = Buffer.alloc(32, 7).toString('base64url');
const credentials = { deviceId: 'mac-fixture', portalToken: 'p'.repeat(43), tunnelToken: 't'.repeat(100) };

async function database(t) {
  const sqlite = new DatabaseSync(':memory:');
  t.after(() => sqlite.close());
  sqlite.exec(await readFile(new URL('../cloud/0001_tickets.sql', import.meta.url), 'utf8'));
  const db = {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() { return sqlite.prepare(sql).get(...args) ?? null; },
            async run() { return { meta: sqlite.prepare(sql).run(...args) }; },
          };
        },
      };
    },
    async batch(statements) {
      return Promise.all(statements.map(statement => statement.run()));
    },
  };
  return { sqlite, db };
}

test('only one ticket can be pending and one redemption succeeds', async t => {
  const { db, sqlite } = await database(t);
  const issued = await issueTicket(db, key, credentials);
  assert.match(issued.ticket, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(await issueTicket(db, key, credentials), undefined);
  const row = sqlite.prepare('SELECT * FROM enrollment_tickets').get();
  for (const raw of [issued.ticket, credentials.portalToken, credentials.tunnelToken]) {
    assert.ok(!JSON.stringify(row).includes(raw));
  }
  const outcomes = await Promise.all(Array.from({ length: 12 }, () => redeemTicket(db, key, issued.ticket)));
  assert.deepEqual(outcomes.filter(Boolean), [credentials]);
  assert.equal(await redeemTicket(db, key, issued.ticket), undefined);
});

test('expired tickets are rejected and can be replaced', async t => {
  const { db, sqlite } = await database(t);
  const old = await issueTicket(db, key, credentials);
  sqlite.exec('UPDATE enrollment_tickets SET expires_at = 0');
  assert.equal(await redeemTicket(db, key, old.ticket), undefined);
  assert.ok(await issueTicket(db, key, credentials));
});

test('management handler checks admin identity and same-origin forms; redemption uses a ticket', async t => {
  const { db } = await database(t);
  const env = { APP_ORIGIN: origin, TICKET_KEY: key, TICKETS: db };
  const worker = createWorker({ verifyAdmin: request => request.headers.get('x-test-admin') === 'yes' });
  const request = (path, init) => worker.fetch(new Request(origin + path, init), env);
  assert.equal((await request('/')).status, 403);
  assert.equal((await request('/', { headers: { 'x-test-admin': 'yes' } })).status, 200);
  const form = (path, fields, includeOrigin = true) => request(path, {
    method: 'POST', headers: { 'x-test-admin': 'yes', ...(includeOrigin && { Origin: origin }) },
    body: new URLSearchParams(fields),
  });
  assert.equal((await form('/admin/tickets', credentials, false)).status, 403);
  const created = await form('/admin/tickets', credentials);
  assert.equal(created.status, 200);
  assert.equal(created.headers.get('cache-control'), 'no-store');
  const html = await created.text();
  const ticket = /<pre>([A-Za-z0-9_-]{43})<\/pre>/.exec(html)[1];
  assert.ok(!html.includes(credentials.portalToken) && !html.includes(credentials.tunnelToken));
  const redeem = () => request('/enroll', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket }),
  });
  assert.deepEqual(await (await redeem()).json(), credentials);
  assert.equal((await redeem()).status, 404);

  const next = await issueTicket(db, key, credentials);
  assert.equal((await form('/admin/cancel', { deviceId: credentials.deviceId })).status, 200);
  assert.equal(await redeemTicket(db, key, next.ticket), undefined);
  assert.equal((await worker.fetch(new Request('https://other.example.invalid/'), env)).status, 404);
});

test('the default administrator verifier rejects forged identity and checks audience and email', async t => {
  const { SignJWT, exportJWK, generateKeyPair } = await import('jose');
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  const issuer = 'https://fleet-fixture.cloudflareaccess.com';
  const env = { APP_ORIGIN: origin, ACCESS_ISSUER: issuer, ACCESS_AUD: 'fleet-audience', OWNER_EMAIL: 'owner@example.invalid' };
  const jwk = { ...await exportJWK(publicKey), kid: 'fixture-key', alg: 'RS256', use: 'sig' };
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(String(new URL(url)), issuer + '/cdn-cgi/access/certs');
    return Response.json({ keys: [jwk] });
  });
  const worker = createWorker();
  const token = (audience, email, expiry = '5m') => new SignJWT({ email })
    .setProtectedHeader({ alg: 'RS256', kid: 'fixture-key' })
    .setIssuer(issuer).setAudience(audience).setSubject('test-owner').setExpirationTime(expiry).sign(privateKey);
  const visit = assertion => worker.fetch(new Request(origin, {
    headers: { 'Cf-Access-Jwt-Assertion': assertion },
  }), env);
  assert.equal((await visit('forged')).status, 403);
  assert.equal((await visit(await token('other-audience', env.OWNER_EMAIL))).status, 403);
  assert.equal((await visit(await token(env.ACCESS_AUD, 'other@example.invalid'))).status, 403);
  assert.equal((await visit(await token(env.ACCESS_AUD, env.OWNER_EMAIL, '1s ago'))).status, 403);
  assert.equal((await visit(await token(env.ACCESS_AUD, env.OWNER_EMAIL))).status, 200);
});

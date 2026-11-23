import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createEnrollmentAdmin } from '../cloud/enrollment-admin.mjs';
import { claimEnrollmentIntent } from '../cloud/enrollment-intents.mjs';
import { issueTicket } from '../cloud/tickets.mjs';

const secret = Buffer.alloc(32, 7).toString('base64url');
const version = '1.0.0';
const sha256 = 'd'.repeat(64);
const releases = { 'macos-arm64': { version, sha256, browser: true, url: 'https://test.invalid/v1.0.0/mac.tgz' } };
const create = { deviceId: 'target-mac', platform: 'macos', confirmBrowser: true };
const status = code => error => error.status === code;

async function fixture(t) {
  const sqlite = new DatabaseSync(':memory:');
  t.after(() => sqlite.close());
  for (const file of ['0001_tickets.sql', '0002_devices.sql', '0004_enrollment_intents.sql']) {
    sqlite.exec(await readFile(new URL('../cloud/' + file, import.meta.url), 'utf8'));
  }
  let fence = false;
  let previous = Promise.resolve();
  const withDeviceFence = action => {
    const next = previous.catch(() => {}).then(async () => {
      assert.equal(fence, false);
      fence = true;
      try { return await action(async () => assert.equal(fence, true)); }
      finally { fence = false; }
    });
    previous = next;
    return next;
  };
  const db = { prepare: sql => ({ bind: (...args) => ({
    first: async () => { if (/fleet_devices|enrollment_tickets|INSERT INTO enrollment_intents/.test(sql)) assert.ok(fence); return sqlite.prepare(sql).get(...args) ?? null; },
    run: async () => ({ meta: sqlite.prepare(sql).run(...args) }),
  }) }), batch: statements => Promise.all(statements.map(statement => statement.run())) };
  return { db, sqlite, admin: createEnrollmentAdmin({ db, secret, releases, withDeviceFence }) };
}

test('exact catalog inputs create only pinned metadata, with explicit bound reveal', async t => {
  const { admin, sqlite } = await fixture(t);
  for (const input of [{ ...create, release: releases }, { ...create, confirmBrowser: false },
    { ...create, platform: 'linux' }, { ...create, deviceId: 'WRONG' }]) await assert.rejects(admin.create(input), status(400));
  const intent = await admin.create(create);
  assert.equal(intent.state, 'pending');
  assert.equal(intent.release.assets.arm64.sha256, sha256);
  assert.equal(Object.hasOwn(intent, 'code'), false);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS total FROM fleet_devices').get().total, 0);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS total FROM enrollment_tickets').get().total, 0);
  const target = { deviceId: create.deviceId, intentId: intent.id };
  await assert.rejects(admin.reveal({ ...target, deviceId: 'other-mac' }), status(404));
  const revealed = await admin.reveal(target);
  assert.match(revealed.code, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(await admin.reveal(target), revealed);
});

test('no replacement while pending or claimed; explicit revoke enables a fresh reservation', async t => {
  const { admin, db } = await fixture(t);
  const results = await Promise.allSettled([admin.create(create), admin.create(create)]);
  const [first] = results.filter(result => result.status === 'fulfilled').map(result => result.value);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.status, 409);
  const target = { deviceId: create.deviceId, intentId: first.id };
  const oldCode = (await admin.reveal(target)).code;
  assert.equal((await admin.revoke(target)).state, 'revoked');
  await assert.rejects(admin.reveal(target), status(404));
  const next = await admin.create(create);
  const nextTarget = { ...target, intentId: next.id };
  const { code } = await admin.reveal(nextTarget);
  assert.notEqual(code, oldCode);
  assert.equal((await claimEnrollmentIntent(db, { ...create, recoveryProof: 'r'.repeat(43), code, version, sha256,
    architecture: 'arm64', browser: true })).state, 'claimed');
  await assert.rejects(admin.revoke(nextTarget), status(404));
  await assert.rejects(admin.create(create), status(409));
});

test('mixed legacy records block create and reveal without changing existing records', async t => {
  const { admin, db, sqlite } = await fixture(t);
  const ticket = await issueTicket(db, secret, { deviceId: create.deviceId,
    portalToken: 'p'.repeat(43), tunnelToken: 't'.repeat(80) });
  assert.ok(ticket);
  await assert.rejects(admin.create(create), status(409));
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS total FROM enrollment_tickets').get().total, 1);
  sqlite.exec('UPDATE enrollment_tickets SET expires_at = 0');
  const intent = await admin.create(create);
  sqlite.prepare(`INSERT INTO fleet_devices VALUES (?, ?, 'active', 'old-device', NULL, 'opaque', 1)`)
    .run(create.deviceId, create.platform);
  const target = { deviceId: create.deviceId, intentId: intent.id };
  await assert.rejects(admin.reveal(target), status(409));
  assert.equal((await admin.revoke(target)).state, 'revoked');
  await assert.rejects(admin.create(create), status(409));
  assert.equal(sqlite.prepare('SELECT status FROM fleet_devices').get().status, 'active');
});

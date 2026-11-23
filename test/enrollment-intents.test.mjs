import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { claimEnrollmentIntent, claimRecoveryWindowSeconds, getEnrollmentIntent, issueEnrollmentIntent,
  revealEnrollmentIntent, revokeEnrollmentIntent } from '../cloud/enrollment-intents.mjs';

const key = Buffer.alloc(32, 9).toString('base64url');
const sha256 = 'a'.repeat(64);
const platform = 'macos';
const deviceId = 'mac-fixture';
const version = '1.2.3';
const browser = true;
const recoveryProof = Buffer.alloc(32, 66).toString('base64url');
const release = { version, browser, assets: {
  arm64: { sha256, url: 'https://fixture.invalid/v1.2.3/mac-arm.tgz' },
  x64: { sha256: 'b'.repeat(64), url: 'https://fixture.invalid/v1.2.3/mac-intel.tgz' },
} };
const input = { deviceId, platform, release, confirmBrowser: browser };
const claim = (code, overrides = {}) => ({ code, recoveryProof, deviceId, platform, architecture: 'arm64', version, sha256, browser, ...overrides });

async function fixture(t) {
  const sqlite = new DatabaseSync(':memory:');
  t.after(() => sqlite.close());
  sqlite.exec(await readFile(new URL('../cloud/0004_enrollment_intents.sql', import.meta.url), 'utf8'));
  const db = { prepare: sql => ({ bind: (...args) => ({ first: async () => sqlite.prepare(sql).get(...args) ?? null }) }) };
  const issued = await issueEnrollmentIntent(db, key, input);
  return { db, sqlite, issued, code: (await revealEnrollmentIntent(db, key, issued.id)).code };
}

test('pending code is encrypted, revealable and not subject to a pre-claim deadline', async t => {
  const { db, sqlite, issued, code } = await fixture(t);
  assert.match(code, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(await getEnrollmentIntent(db, issued.id), issued);
  assert.equal(Object.hasOwn(issued, 'code'), false);
  assert.ok(!JSON.stringify(sqlite.prepare('SELECT * FROM enrollment_intents').get()).includes(code));
  assert.equal(await issueEnrollmentIntent(db, key, input), undefined);
  sqlite.exec('UPDATE enrollment_intents SET created_at = 1');
  assert.equal((await revealEnrollmentIntent(db, key, issued.id)).code, code);
  assert.equal((await claimEnrollmentIntent(db, claim(code))).state, 'claimed');
});

test('all mismatched metadata fails before consumption; only one concurrent claimant succeeds', async t => {
  const { db, sqlite, issued, code } = await fixture(t);
  for (const overrides of [{ deviceId: 'other-mac' }, { platform: 'linux' }, { architecture: 'x64' },
    { version: '1.2.4' }, { sha256: 'f'.repeat(64) }, { browser: false }, { browser: 'true' }, { code: 'bad' },
    { recoveryProof: 'bad' }, { recoveryProof: undefined }, { recoveryProof: code }]) {
    assert.equal(await claimEnrollmentIntent(db, claim(code, overrides)), undefined);
  }
  assert.equal((await getEnrollmentIntent(db, issued.id)).state, 'pending');
  const attempted = await Promise.all(Array.from({ length: 10 }, (_, index) => claimEnrollmentIntent(db,
    claim(code, { recoveryProof: Buffer.alloc(32, 80 + index).toString('base64url') }))));
  const [success] = attempted.filter(Boolean);
  assert.equal(attempted.filter(Boolean).length, 1);
  assert.equal(success.architecture, 'arm64');
  assert.equal(success.state, 'claimed');
  assert.equal(success.resumed, false);
  assert.equal(await revealEnrollmentIntent(db, key, issued.id), undefined);
  assert.equal(await revokeEnrollmentIntent(db, issued.id), undefined);
  assert.equal(sqlite.prepare('SELECT code_ciphertext FROM enrollment_intents').get().code_ciphertext, null);
});

test('matching receipt resumes boundedly without storing plain proof or reopening the claim', async t => {
  const { db, sqlite, code } = await fixture(t);
  const outcomes = await Promise.all([claimEnrollmentIntent(db, claim(code)), claimEnrollmentIntent(db, claim(code))]);
  const first = outcomes.find(outcome => outcome.resumed === false);
  assert.ok(first);
  assert.deepEqual(outcomes.find(outcome => outcome.resumed === true), { ...first, resumed: true });
  assert.deepEqual(await claimEnrollmentIntent(db, claim(code)), { ...first, resumed: true });
  assert.equal(await claimEnrollmentIntent(db, claim(code, { recoveryProof: 'B'.repeat(43) })), undefined);
  assert.equal(await claimEnrollmentIntent(db, claim(code, { architecture: 'x64', sha256: 'b'.repeat(64) })), undefined);
  assert.equal(await claimEnrollmentIntent(db, claim(code, { version: '1.2.4' })), undefined);
  const stored = sqlite.prepare('SELECT recovery_digest, claimed_architecture, resolved_at FROM enrollment_intents').get();
  assert.notEqual(stored.recovery_digest, recoveryProof);
  assert.equal(stored.claimed_architecture, 'arm64');
  assert.equal(stored.resolved_at, first.resolvedAt);
  sqlite.prepare('UPDATE enrollment_intents SET resolved_at = ?').run(Math.floor(Date.now() / 1000) - claimRecoveryWindowSeconds);
  assert.equal(await claimEnrollmentIntent(db, claim(code)), undefined);
  assert.equal(sqlite.prepare('SELECT state FROM enrollment_intents').get().state, 'claimed');
});

test('revocation prevents reveal and claim, and a newly issued code is independent', async t => {
  const { db, issued, code } = await fixture(t);
  assert.equal((await revokeEnrollmentIntent(db, issued.id)).state, 'revoked');
  assert.equal(await claimEnrollmentIntent(db, claim(code)), undefined);
  assert.equal(await revealEnrollmentIntent(db, key, issued.id), undefined);
  const next = await issueEnrollmentIntent(db, key, input);
  const newCode = (await revealEnrollmentIntent(db, key, next.id)).code;
  assert.notEqual(newCode, code);
  assert.equal(await claimEnrollmentIntent(db, claim(code)), undefined);
  assert.equal((await claimEnrollmentIntent(db, claim(newCode))).state, 'claimed');
});

test('snapshot only carries allowlisted installer metadata and requires explicit browser confirmation', async t => {
  const { db } = await fixture(t);
  const single = { deviceId: 'windows-test', platform: 'windows-x64', release: { version, sha256,
    localFile: 'bundle.zip', portalToken: 'not-public', tunnelToken: 'not-public' } };
  const intent = await issueEnrollmentIntent(db, key, single);
  assert.deepEqual(intent.release, { platform: 'windows-x64', version, browser: false,
    assets: { x64: { sha256, localFile: 'bundle.zip' } } });
  await assert.rejects(issueEnrollmentIntent(db, key, { ...input, confirmBrowser: false }), /Browser confirmation/);
  await assert.rejects(issueEnrollmentIntent(db, key, { ...single, release: { ...single.release, localFile: '../../private.zip' } }), /local installer/);
  await assert.rejects(issueEnrollmentIntent(db, key, { ...single, release: { version, sha256, url: 'https://fixture.invalid/?token=private' } }), /URL/);
});

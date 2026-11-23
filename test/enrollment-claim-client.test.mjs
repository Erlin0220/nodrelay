import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { claimDeviceEnrollment } from '../src/enrollment-claim-client.mjs';

const sample = {
  manager: 'https://manager.example.test', code: 'c'.repeat(43), deviceId: 'mac-mini',
  platform: 'macos', architecture: 'arm64', version: '0.1.6-preview.3', sha256: 'a'.repeat(64), browser: true,
  root: resolve('not-a-real-test-directory'),
};
const credentials = { deviceId: sample.deviceId, tunnelToken: 't'.repeat(43), portalToken: 'p'.repeat(43),
  activationToken: 'k'.repeat(43), browserToken: 'b'.repeat(43) };

function fixtureStore() {
  const log = [], files = new Map();
  const missing = () => Object.assign(new Error('fixture path must not be exposed'), { code: 'ENOENT' });
  return { files, log, io: {
    prepare(root) { assert.equal(root, sample.root); log.push('private root'); },
    read(path) {
      log.push('read');
      if (!files.has(path)) throw missing();
      return files.get(path);
    },
    publish(path, text) {
      log.push('publish');
      if (files.has(path)) throw Object.assign(new Error('fixture already exists'), { code: 'EEXIST' });
      files.set(path, text);
    },
    sync() { log.push('sync'); },
  } };
}

test('persists and syncs the same-host proof before POST, without storing the code or returned credentials', async () => {
  const f = fixtureStore();
  const sent = [];
  const request = async (url, init) => {
    assert.equal(url, `${sample.manager}/device/enroll`);
    assert.deepEqual([...new URL(url).searchParams], []);
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'error');
    assert.equal(init.cache, 'no-store');
    assert.equal(init.headers['Content-Type'], 'application/json');
    assert.ok(init.signal instanceof AbortSignal);
    assert.equal(f.log.at(-1), 'sync');
    const body = JSON.parse(init.body);
    const localText = [...f.files.values()][0];
    assert.ok(!localText.includes(sample.code) && !localText.includes(credentials.activationToken));
    assert.equal(JSON.parse(localText).recoveryProof, body.recoveryProof);
    sent.push(body);
    if (sent.length === 1) throw new Error(sample.code);
    return Response.json(credentials);
  };
  const options = { request, recoveryStore: f.io };
  await assert.rejects(claimDeviceEnrollment(sample, options), error =>
    error.code === 'claim_unconfirmed' && !error.message.includes(sample.code));
  assert.equal(sent.length, 1);
  assert.deepEqual(await claimDeviceEnrollment({ ...sample, manager: sample.manager + '/' }, options), credentials);
  const { root, manager, ...tuple } = sample;
  const proof = sent[0].recoveryProof;
  assert.match(proof, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(proof, sample.code);
  assert.deepEqual(sent, [1, 2].map(() => ({ protocol: 'intent-v1', ...tuple, recoveryProof: proof })));
  assert.equal(f.log.filter(entry => entry === 'publish').length, 1);
  assert.equal(f.files.size, 1);
});

test('refuses conflicting local proof records or unavailable private storage without dispatch', async () => {
  const f = fixtureStore();
  const noop = () => { throw new Error('No request should have been sent'); };
  await claimDeviceEnrollment(sample, { recoveryStore: f.io, request: () => Response.json(credentials) });
  const [file, original] = [...f.files.entries()][0];
  const failure = options => assert.rejects(claimDeviceEnrollment(options, { request: noop, recoveryStore: f.io }),
    { code: 'recovery_mismatch' });
  await failure({ ...sample, architecture: 'x64' });
  await failure({ ...sample, sha256: 'b'.repeat(64) });
  await failure({ ...sample, browser: false });
  assert.equal(f.files.get(file), original);
  f.files.set(file, '{"truncated":');
  await failure(sample);
  assert.equal(f.files.get(file), '{"truncated":');

  const unable = fixtureStore();
  unable.io.sync = () => { throw new Error('fixture unavailable path'); };
  await assert.rejects(claimDeviceEnrollment(sample, { request: noop, recoveryStore: unable.io }), error =>
    error.code === 'recovery_unavailable' && !error.message.includes('fixture unavailable'));
});

test('validates pinned identity, architecture, origin and timeout settings before storage or network', async () => {
  for (const changed of [
    { manager: 'http://manager.example.test' }, { manager: sample.manager + '/enroll' },
    { manager: sample.manager + '?code=' + sample.code }, { manager: 'https://owner:password@manager.example.test' },
    { code: 'bad' }, { deviceId: '..' }, { platform: 'windows', architecture: 'arm64' },
    { platform: 'macos-x64', architecture: 'arm64' }, { platform: 'macos-arm64-extra' },
    { version: 'a/b' }, { sha256: 'a'.repeat(63) }, { browser: 'true' }, { root: 'relative' },
  ]) {
    const f = fixtureStore();
    await assert.rejects(claimDeviceEnrollment({ ...sample, ...changed }, { recoveryStore: f.io,
      request() { assert.fail('invalid input must not be sent'); } }), { code: 'invalid_claim' });
    assert.deepEqual(f.log, []);
  }
  await assert.rejects(claimDeviceEnrollment(sample, { timeoutMs: 0, recoveryStore: fixtureStore().io }), { code: 'invalid_claim' });
});

test('rejects wrong identity, browser capability, malformed or excessive response and redirections without leaking body', async () => {
  const options = { recoveryStore: fixtureStore().io };
  for (const [response, expectedCode, expectedStatus] of [
    [Response.json({ ...credentials, deviceId: 'other-device' }), 'claim_response_invalid'],
    [Response.json({ ...credentials, browserToken: undefined }), 'claim_response_invalid'],
    [Response.json({ ...credentials, activationToken: undefined }), 'claim_response_invalid'],
    [Response.json({ ...credentials, unexpected: 'a'.repeat(20000) }), 'claim_response_invalid'],
    [new Response(`<html>${sample.code}</html>`, { headers: { 'content-type': 'text/html' } }), 'claim_response_invalid'],
    [new Response('{ invalid JSON ', { headers: { 'content-type': 'application/json' } }), 'claim_response_invalid'],
    [Response.redirect('https://wrong.example.test/device/enroll'), 'claim_unconfirmed', 302],
    [new Response(sample.code, { status: 404 }), 'claim_rejected', 404],
    [new Response(sample.code, { status: 503 }), 'claim_unconfirmed', 503],
  ]) {
    await assert.rejects(claimDeviceEnrollment(sample, { ...options, request: () => response }), error =>
      error.code === expectedCode && error.httpStatus === expectedStatus && !error.message.includes(sample.code));
  }
  const redirect = { url: 'https://wrong.example.test/device/enroll', status: 200, redirected: true };
  await assert.rejects(claimDeviceEnrollment(sample, { ...options, request: () => redirect }), { code: 'claim_response_invalid' });
});

test('request timeout remains bounded and recovery record survives an unanswered POST', async () => {
  const f = fixtureStore();
  // Keep this test alive until the mocked process observes AbortSignal.timeout.
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(claimDeviceEnrollment(sample, { timeoutMs: 5, recoveryStore: f.io, request(_url, init) {
      return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
    } }), { code: 'claim_unconfirmed' });
    assert.equal(f.files.size, 1);
  } finally { clearTimeout(keepAlive); }
});

test('concurrent POSIX installs atomically retain a single proof and do not touch existing credentials', {
  skip: process.platform === 'win32' && 'Windows ACL and link behavior need separate native acceptance',
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'nodrelay-claim-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const existing = join(root, 'credentials.private.json');
  await writeFile(existing, 'fixture existing credentials', { mode: 0o600 });
  const proofs = [];
  const request = (_url, options) => {
    proofs.push(JSON.parse(options.body).recoveryProof);
    return Response.json(credentials);
  };
  const result = await Promise.all(Array.from({ length: 6 }, () => claimDeviceEnrollment({ ...sample, root }, { request })));
  assert.ok(result.every(data => data.deviceId === credentials.deviceId));
  assert.equal(new Set(proofs).size, 1);
  const entries = (await readdir(root)).filter(name => name !== 'credentials.private.json');
  assert.equal(entries.length, 1);
  assert.match(entries[0], /^enrollment-claim-[a-f0-9]{64}\.private\.json$/);
  const state = join(root, entries[0]);
  assert.equal((await stat(state)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(state, 'utf8')).recoveryProof, proofs[0]);
  assert.equal(await readFile(existing, 'utf8'), 'fixture existing credentials');
});

test('sends negotiated ports and accepts credentials only when the console routed exactly those ports', async () => {
  const ports = { development: 41001, browser: 41003 };
  const replies = [{ ...credentials, ports }, credentials, { ...credentials, ports: { development: 41001, browser: 41009 } }];
  const sent = [];
  const request = async (_url, init) => { sent.push(JSON.parse(init.body)); return Response.json(replies[sent.length - 1]); };
  const options = { request, recoveryStore: fixtureStore().io };
  assert.deepEqual(await claimDeviceEnrollment({ ...sample, ports }, options), { ...credentials, ports });
  assert.deepEqual(sent[0].ports, ports);
  for (let i = 0; i < 2; i++) {
    await assert.rejects(claimDeviceEnrollment({ ...sample, ports }, options), { code: 'claim_response_invalid' });
  }
  await assert.rejects(claimDeviceEnrollment({ ...sample, ports: { development: 41001 } }, options), { code: 'invalid_claim' });
  assert.equal(sent.length, 3);
});

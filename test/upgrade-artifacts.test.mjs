import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { loadVerifiedUpgradeArtifacts } from '../cloud/upgrade-artifacts.mjs';

test('trusted feed fetches only fixed channel paths, strips auth, and fails closed on inconsistent publication', async () => {
  const now = Date.now();
  const bundle = new TextEncoder().encode('export default {}');
  const k = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const manifest = new TextEncoder().encode(JSON.stringify({
    schema: 1, product: 'nodrelay-management', channel: 'preview', version: '1.0.0-preview.2',
    minimumVersion: '1.0.0-preview.1', issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 1000).toISOString(), workerBundle: 'worker.js',
    workerSha256: createHash('sha256').update(bundle).digest('hex'),
  }));
  const signature = await crypto.subtle.sign('Ed25519', k.privateKey, manifest);
  const base = 'https://downloads.example.test/nodrelay/';
  const names = [];
  const args = { base, channel: 'preview', currentVersion: '1.0.0-preview.1', publicKey: k.publicKey, now,
    request(url, init) {
      assert.equal(init.redirect, 'manual');
      assert.equal(new Headers(init.headers).get('Authorization'), null);
      assert.ok(url.startsWith(base + 'preview/'));
      const name = url.split('/').at(-1);
      names.push(name);
      return new Response({ 'manifest.json': manifest, 'manifest.json.sig': signature, 'worker.js': bundle }[name]);
    } };
  assert.equal((await loadVerifiedUpgradeArtifacts(args)).release.version, '1.0.0-preview.2');
  await assert.rejects(loadVerifiedUpgradeArtifacts({ ...args, currentVersion: '1.0.0-preview.2' }), /not newer/);
  assert.equal((await loadVerifiedUpgradeArtifacts({ ...args, currentVersion: '1.0.0-preview.2', allowCurrent: true })).release.version, '1.0.0-preview.2');
  assert.deepEqual([...new Set(names)].sort(), ['manifest.json', 'manifest.json.sig', 'worker.js'].sort());
  await assert.rejects(loadVerifiedUpgradeArtifacts({ ...args, base: 'https://u:p@downloads.example.test/' }), /configuration/);
  await assert.rejects(loadVerifiedUpgradeArtifacts({ ...args, request(url, init) {
    return url.endsWith('/worker.js') ? new Response('older worker content') : args.request(url, init);
  } }), /SHA-256 mismatch/);
  await assert.rejects(loadVerifiedUpgradeArtifacts({ ...args, request(url, init) {
    return url.endsWith('/worker.js') ? Response.redirect('https://untrusted.example.test/') : args.request(url, init);
  } }), /unavailable/);
});

test('v2 reads only its separately pinned path, never falls back to the v1 feed', async () => {
  const now = Date.now();
  const bundle = new TextEncoder().encode('export default {}');
  const keys = await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify']);
  const fields = { product: 'nodrelay-management', channel: 'stable', version: '1.0.1', minimumVersion: '1.0.0',
    issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60000).toISOString(), workerBundle: 'worker.js',
    workerSha256: createHash('sha256').update(bundle).digest('hex') };
  const enrollment = { protocol: 'intent-v1', releases: Object.fromEntries([
    'windows-x64', 'macos-arm64', 'macos-x64', 'linux-x64', 'linux-arm64',
  ].map(target => [target, { url: `https://assets.example.test/1.0.1/${target}`, sha256: 'a'.repeat(64), version: '1.0.1', browser: false }])) };
  const current = version => new TextEncoder().encode(JSON.stringify({ ...fields, schema: version, ...(version === 2 && { enrollment }) }) + '\n');
  const base = 'https://downloads.example.test/nodrelay/';
  const prefix = base + 'stable/v2/';
  let requested = [];
  async function fixture(version) {
    const manifest = current(version);
    const signature = await crypto.subtle.sign('Ed25519', keys.privateKey, manifest);
    return { base, channel: 'stable', currentVersion: '1.0.0', publicKey: keys.publicKey, now, format: 2,
      request(url, init) {
        requested.push(url);
        assert.equal(init.redirect, 'manual');
        assert.equal(init.credentials, 'omit');
        const headers = new Headers(init.headers);
        for (const name of ['Authorization', 'Cookie', 'Cf-Access-Jwt-Assertion']) assert.equal(headers.get(name), null);
        assert.ok(url.startsWith(prefix));
        return new Response({ 'manifest.json': manifest, 'manifest.json.sig': signature, 'worker.js': bundle }[url.slice(prefix.length)]);
      } };
  }
  const args = await fixture(2);
  const result = await loadVerifiedUpgradeArtifacts(args);
  assert.equal(result.artifact.format, 2);
  assert.deepEqual(result.release.enrollment, enrollment);
  assert.equal(result.manifestSha256, createHash('sha256').update(current(2)).digest('hex'));
  const expected = ['manifest.json', 'manifest.json.sig', 'worker.js'].map(name => prefix + name);
  assert.deepEqual(requested.sort(), expected.sort());
  requested = [];
  await assert.rejects(loadVerifiedUpgradeArtifacts(await fixture(1)), /metadata/);
  assert.deepEqual(requested.sort(), expected.sort());
  requested = [];
  await assert.rejects(loadVerifiedUpgradeArtifacts({ ...args, format: '../v1/' }), /configuration/);
  assert.deepEqual(requested, []);
});

test('a failed upgrade artifact aborts the sibling transfers without masking the original error', async () => {
  const paths = [];
  const aborted = [];
  const failure = new Error('Simulated signature transfer failure');
  const load = loadVerifiedUpgradeArtifacts({
    base: 'https://downloads.example.test/nodrelay/', channel: 'preview', currentVersion: '1.0.0-preview.1',
    request(url, { signal }) {
      const name = url.split('/').at(-1);
      paths.push(name);
      if (name === 'manifest.json.sig') return Promise.reject(failure);
      return new Promise((_, reject) => {
        signal.addEventListener('abort', () => {
          aborted.push(name);
          reject(signal.reason);
        }, { once: true });
      });
    },
  });
  await assert.rejects(load, error => error === failure);
  assert.deepEqual(paths, ['manifest.json', 'manifest.json.sig', 'worker.js']);
  assert.deepEqual(aborted, ['manifest.json', 'worker.js']);
});

test('a redirected v2 manifest cannot escape the trusted feed or fall back to v1', async () => {
  const urls = [];
  const base = 'https://downloads.example.test/nodrelay/';
  await assert.rejects(loadVerifiedUpgradeArtifacts({
    base, channel: 'preview', currentVersion: '1.0.0-preview.1', format: 'auto',
    request(url, init) {
      urls.push(url);
      assert.equal(init.redirect, 'manual');
      return Response.redirect('https://untrusted.example.test/manifest.json', 302);
    },
  }), /v2 upgrade feed cannot be verified/);
  assert.deepEqual(urls, [base + 'preview/v2/manifest.json']);
});

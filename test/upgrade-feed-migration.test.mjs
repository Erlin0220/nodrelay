import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { confirmPreviewMigrationMirror, loadVerifiedUpgradeArtifacts } from '../cloud/upgrade-artifacts.mjs';
import {
  legacyPreviewFeed, legacyPreviewMigrationMirror, matchesInstallerFeed, publicPreviewFeed,
} from '../cloud/upgrade-feed-migration.mjs';

const old = '0.1.5-preview.15', next = '0.1.5-preview.16';
const now = Date.parse('2026-11-23T08:00:00.000Z');
const allowed = { from: legacyPreviewFeed, to: publicPreviewFeed };
const key = await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify']);
const bundle = Buffer.from('export default {};');
const releases = Object.fromEntries(['macos-arm64', 'linux-x64', 'windows-x64'].map(platform =>
  [platform, { version: next, url: 'https://artifacts.example.test/' + platform, sha256: 'a'.repeat(64), browser: false }]));
async function files(feedMigration, overrides) {
  const manifest = Buffer.from(JSON.stringify({ schema: 2, channel: 'preview', product: 'nodrelay-management',
    version: next, minimumVersion: old, issuedAt: '2026-11-23T00:00:00.000Z',
    expiresAt: '2026-12-23T00:00:00.000Z', workerBundle: 'worker.js',
    workerSha256: createHash('sha256').update(bundle).digest('hex'),
    enrollment: { protocol: 'intent-v1', releases }, feedMigration, ...overrides }));
  const signature = await crypto.subtle.sign('Ed25519', key.privateKey, manifest);
  return { 'manifest.json': manifest, 'manifest.json.sig': signature, 'worker.js': bundle };
}
const options = { channel: 'preview', currentVersion: old, publicKey: key.publicKey, now };

function serve(at, data, status = 200) {
  return (url, init) => {
    assert.ok(url.startsWith(at + 'preview/v2/'));
    assert.equal(init.redirect, 'manual');
    assert.equal(init.credentials, 'omit');
    assert.equal(new Headers(init.headers).has('authorization'), false);
    return new Response(status === 200 ? data[url.split('/').at(-1)] : null, { status });
  };
}

test('installer recognizes only the preapproved legacy preview host and exact signed replacement', () => {
  assert.equal(matchesInstallerFeed(legacyPreviewFeed, { channel: 'preview', feed: publicPreviewFeed }), true);
  assert.equal(matchesInstallerFeed(publicPreviewFeed, { channel: 'preview', feed: publicPreviewFeed }), true);
  assert.equal(matchesInstallerFeed(legacyPreviewFeed, { channel: 'stable', feed: publicPreviewFeed }), false);
  assert.equal(matchesInstallerFeed(legacyPreviewFeed, { channel: 'preview', feed: publicPreviewFeed + 'other/' }), false);
  assert.equal(matchesInstallerFeed(publicPreviewFeed, { channel: 'preview', feed: legacyPreviewFeed }), false);
});

test('verifies matching signed migration bytes at both repositories before cutover', async () => {
  const published = await files(allowed);
  const result = await loadVerifiedUpgradeArtifacts({ ...options, base: publicPreviewFeed,
    request: serve(publicPreviewFeed, published), format: 'auto' });
  assert.deepEqual(result.release.feedMigration, allowed);
  await confirmPreviewMigrationMirror(result.manifestSha256, { ...options, request: serve(legacyPreviewMigrationMirror, published) });
  await assert.rejects(confirmPreviewMigrationMirror(result.manifestSha256, {
    ...options, request: serve(legacyPreviewMigrationMirror, await files(allowed, { version: '0.1.5-preview.17' })),
  }), /does not match/);
  for (const unavailable of [302, 404, 503]) await assert.rejects(confirmPreviewMigrationMirror(result.manifestSha256, {
    ...options, request: serve(legacyPreviewMigrationMirror, published, unavailable),
  }), /unavailable/);
});

test('rejects third-party, reverse and non-object migration even with a valid signature', async () => {
  for (const invalid of [null, { from: publicPreviewFeed, to: legacyPreviewFeed }, { ...allowed, to: 'https://elsewhere.test/' }]) {
    await assert.rejects(loadVerifiedUpgradeArtifacts({ ...options, base: publicPreviewFeed, format: 2,
      request: serve(publicPreviewFeed, await files(invalid)) }), /Invalid signed Nodrelay preview feed migration/);
  }
});

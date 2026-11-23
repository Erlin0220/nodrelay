import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { tarOwnership, verifyPublishedArchive } from '../packaging/release-archive.mjs';
import { validateReleaseCatalog } from '../src/setup-core.mjs';

const exec = promisify(execFile);

async function packaged(t, { platform, browser, companions = [], next = {}, intent = false, stale = false, macPax = false }) {
  const temporary = await mkdtemp(join(tmpdir(), 'nodrelay-release-archive-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const bundle = join(temporary, 'bundle');
  const windows = platform.startsWith('windows-');
  const fields = { schema: 1, platform, version: '1.2.3', browser, ...next };
  const archive = join(temporary, windows ? 'test.zip' : 'test.tgz');
  const files = [windows ? 'install.ps1' : 'install.sh', windows ? 'bin/node.exe' : 'bin/node',
    windows ? 'bin/cloudflared.exe' : 'bin/cloudflared', 'fleet/src/install-device.mjs', 'personal/dist/server.js',
    ...(intent ? ['fleet/src/enrollment-claim-client.mjs'] : []), ...companions.map(name => 'browser/' + name)];
  for (const name of files) {
    const file = join(bundle, name);
    await mkdir(dirname(file), { recursive: true });
    const native = name === 'install.sh' || name === 'install.ps1';
    const runtime = name === 'fleet/src/install-device.mjs' || name === 'fleet/src/enrollment-claim-client.mjs';
    const source = native ? '../packaging/' + name : runtime ? '../src/' + name.split('/').at(-1) : undefined;
    await writeFile(file, intent && source && !(stale && name.includes('enrollment-claim-client'))
      ? await readFile(new URL(source, import.meta.url)) : 'publication check fixture\n');
  }
  if (macPax) {
    await mkdir(join(bundle, 'mac-metadata'));
    for (let i = 0; i < 450; i++) await writeFile(join(bundle, 'mac-metadata', 'file-' + i), '');
  }
  await writeFile(join(bundle, 'bundle.json'), JSON.stringify(fields));
  if (windows) {
    if (process.platform === 'win32') await exec('tar.exe', ['-caf', archive, ...tarOwnership, '.'], { cwd: bundle });
    else await exec('zip', ['-Xqr', archive, '.'], { cwd: bundle });
  } else await exec('tar', ['-czf', archive, ...tarOwnership,
    ...(macPax ? ['--format=pax', '--pax-option=LIBARCHIVE.xattr.com.apple.provenance:=fixture'] : []),
    '.'], { cwd: bundle });
  const bytes = await readFile(archive);
  const asset = { url: 'https://releases.example.test/test', version: '1.2.3', browser, sha256: createHash('sha256').update(bytes).digest('hex') };
  let initialSignal;
  const request = (url, options) => {
    assert.equal(options.redirect, 'manual');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.headers, undefined);
    if (url.hostname === 'releases.example.test') {
      initialSignal = options.signal;
      return Response.redirect('https://cdn.example.test/download');
    }
    assert.ok(initialSignal instanceof AbortSignal);
    assert.equal(options.signal, initialSignal);
    assert.equal(url.href, 'https://cdn.example.test/download');
    return new Response(bytes);
  };
  return { asset, request, bytes };
}

test('publication verifies both target archive formats and their signed capability metadata', async t => {
  for (const [platform, browser] of [['windows-x64', false], ['macos-arm64', true], ['linux-x64', false]]) {
    const fixture = await packaged(t, { platform, browser, companions: browser ? ['setup.mjs', 'preflight.mjs'] : [] });
    await verifyPublishedArchive(platform, fixture.asset, fixture.request);
    await assert.rejects(verifyPublishedArchive(platform, { ...fixture.asset, browser: !browser }, fixture.request), /capability differs/);
    await assert.rejects(verifyPublishedArchive(platform, { ...fixture.asset, version: '4.5.6' }, fixture.request), /version differs/);
    await assert.rejects(verifyPublishedArchive(platform, { ...fixture.asset, sha256: 'f'.repeat(64) }, fixture.request), /pinned SHA-256/);
  }
});

test('publication rejects stale architecture, missing browser preflight, and unsafe redirects', async t => {
  const wrong = await packaged(t, { platform: 'linux-x64', browser: false, next: { platform: 'linux-arm64' } });
  assert.throws(() => validateReleaseCatalog({ 'linux-x64': { ...wrong.asset, browser: 'false' } }), /must be a boolean/);
  await assert.rejects(verifyPublishedArchive('linux-x64', wrong.asset, wrong.request), /platform differs/);
  const legacy = await packaged(t, { platform: 'macos-arm64', browser: true, companions: ['setup.mjs'] });
  await assert.rejects(verifyPublishedArchive('macos-arm64', legacy.asset, legacy.request), /browser\/preflight\.mjs/);
  const absent = await packaged(t, { platform: 'linux-x64', browser: false, companions: ['setup.mjs'] });
  await assert.rejects(verifyPublishedArchive('linux-x64', absent.asset, absent.request), /development-only .* browser companion/);
  await assert.rejects(verifyPublishedArchive('linux-x64', absent.asset, () => Response.redirect('http://example.test/unsafe')), /must preserve HTTPS/);
  await assert.rejects(verifyPublishedArchive('linux-x64', absent.asset,
    () => new Response(absent.bytes, { status: 206 })), /unavailable to unauthenticated devices/);
});

test('intent signing verifies exact reviewed native launcher, enrollment client and installer bytes', async t => {
  for (const platform of ['windows-x64', 'macos-arm64', 'linux-arm64']) {
    const good = await packaged(t, { platform, browser: false, intent: true });
    await verifyPublishedArchive(platform, good.asset, good.request, { intent: true });
    const stale = await packaged(t, { platform, browser: false, intent: true, stale: true });
    await assert.rejects(verifyPublishedArchive(platform, stale.asset, stale.request, { intent: true }), /stale .*enrollment-claim-client/);
    const absent = await packaged(t, { platform, browser: false });
    await assert.rejects(verifyPublishedArchive(platform, absent.asset, absent.request, { intent: true }), /exactly one .*enrollment-claim-client/);
  }
});


test('publication rejects an oversized declaration without reading the archive body', async t => {
  const { asset } = await packaged(t, { platform: 'linux-x64', browser: false });
  let cancelled = false;
  const body = new ReadableStream({
    pull() { assert.fail('Oversized body should not be read'); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  await assert.rejects(verifyPublishedArchive('linux-x64', asset, () => new Response(body, {
    headers: { 'Content-Length': '9' },
  }), { maxBytes: 8 }), /compressed download size limit/);
  assert.equal(cancelled, true);
});

test('publication enforces the download limit on streamed bytes without a truthful length', async t => {
  const { asset } = await packaged(t, { platform: 'linux-x64', browser: false });
  for (const headers of [{}, { 'Content-Length': '8' }]) {
    let sent = 0;
    let cancelled = false;
    const body = new ReadableStream({
      pull(controller) { sent++; controller.enqueue(new Uint8Array(4)); },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    await assert.rejects(verifyPublishedArchive('linux-x64', asset, () => new Response(body, { headers }),
      { maxBytes: 8 }), /compressed download size limit/);
    assert.ok(sent >= 3 && sent < 10);
    assert.equal(cancelled, true);
  }
});


test('Linux publication inspection accepts macOS archives with many benign PAX warnings', {
  skip: process.platform !== 'linux',
}, async t => {
  const fixture = await packaged(t, { platform: 'macos-arm64', browser: false, intent: true, macPax: true });
  await verifyPublishedArchive('macos-arm64', fixture.asset, fixture.request, { intent: true });
});

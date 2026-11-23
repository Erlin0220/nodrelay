import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { verifyUpgradeRelease } from '../cloud/upgrade-plan.mjs';
import { signWebUpgrade } from '../packaging/sign-web-upgrade.mjs';

const script = fileURLToPath(new URL('../packaging/sign-web-upgrade.mjs', import.meta.url));
const exec = promisify(execFile);
const sha256 = value => createHash('sha256').update(value).digest('hex');

test('upgrade pack emits three detached verified artifacts with no credentials', {
  skip: process.platform === 'win32' && 'POSIX fixture uses owner-only key permissions',
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'nodrelay-web-signer-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { privateKey, publicKey: raw } = generateKeyPairSync('ed25519');
  const key = join(root, 'key.pem'), worker = join(root, 'source.js'), output = join(root, 'signed');
  await writeFile(key, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
  await writeFile(worker, 'export default {};\n');
  const run = args => exec(process.execPath, [script, worker, key, ...args]);
  await assert.rejects(run(['1.0.0-preview.2', '1.0.0-preview.1', 'stable', join(root, 'mismatch')]));
  await run(['1.0.0-preview.2', '1.0.0-preview.1', 'preview', output]);
  const [manifest, signature, bundle] = await Promise.all(['manifest.json', 'manifest.json.sig', 'worker.js']
    .map(name => readFile(join(output, name))));
  const publicKey = await crypto.subtle.importKey('spki', raw.export({ type: 'spki', format: 'der' }),
    { name: 'Ed25519' }, false, ['verify']);
  const release = await verifyUpgradeRelease({ manifest, signature, bundle, publicKey, channel: 'preview', currentVersion: '1.0.0-preview.1' });
  assert.equal(release.release.version, '1.0.0-preview.2');
  assert.equal(release.release.schema, 1);
  assert.equal(Object.hasOwn(release.release, 'enrollment'), false);
  assert.equal(bundle.toString(), 'export default {};\n');
});

test('explicit v2 publisher checks all projected archives anonymously before signing a three-file product', {
  skip: process.platform === 'win32' && 'POSIX fixture uses owner-only key permissions and native zip/tar',
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'nodrelay-enrollment-signer-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { privateKey, publicKey: raw } = generateKeyPairSync('ed25519');
  const keyFile = join(root, 'key.pem'), worker = join(root, 'source.js'), output = join(root, 'signed-v2');
  const enrollmentCatalog = join(root, 'release.json');
  const workerBytes = Buffer.from('export default {};\n');
  const workerSha256 = sha256(workerBytes);
  const version = '1.0.0-preview.2', minimumVersion = '1.0.0-preview.1', channel = 'preview';
  await writeFile(keyFile, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
  await writeFile(worker, workerBytes);
  const targets = ['windows-x64', 'macos-arm64', 'macos-x64', 'linux-x64', 'linux-arm64'];
  const releases = {}, packed = new Map();
  const packageAsset = async (platform, stale = false) => {
    const windows = platform === 'windows-x64';
    const installer = windows ? 'install.ps1' : 'install.sh';
    const directory = join(root, platform + (stale ? '-stale' : ''));
    const filename = `devspace-fleet-${version}-${platform}.${windows ? 'zip' : 'tgz'}`;
    const archive = join(root, (stale ? 'stale-' : '') + filename);
    for (const [entry, source] of [[installer, '../packaging/' + installer],
      ['fleet/src/install-device.mjs', '../src/install-device.mjs'],
      ['fleet/src/enrollment-claim-client.mjs', stale ? undefined : '../src/enrollment-claim-client.mjs'],
      [windows ? 'bin/node.exe' : 'bin/node'], [windows ? 'bin/cloudflared.exe' : 'bin/cloudflared'], ['personal/dist/server.js']]) {
      const file = join(directory, entry);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, source ? await readFile(new URL(source, import.meta.url)) : 'fixture only\n');
    }
    await writeFile(join(directory, 'bundle.json'), JSON.stringify({ schema: 1, platform, version, browser: false }));
    await exec(windows ? 'zip' : 'tar', [windows ? '-Xqr' : '-czf', archive, '.'], { cwd: directory });
    const bytes = await readFile(archive);
    const url = `https://releases.example.test/${version}/${filename}`;
    packed.set(url, bytes);
    releases[platform] = { url, sha256: sha256(bytes), version, browser: false };
  };
  for (const target of targets) await packageAsset(target);
  const saveCatalog = override => writeFile(enrollmentCatalog, JSON.stringify({ workerBundle: './worker.js', workerSha256, releases, ...override }));
  const requested = [];
  const inputs = { worker, keyFile, version, minimumVersion, channel, output, enrollmentCatalog,
    request(url, init) {
      assert.equal(init.credentials, 'omit');
      assert.equal(new Headers(init.headers).get('Authorization'), null);
      assert.equal(init.redirect, 'manual');
      requested.push(url.href);
      assert.ok(packed.has(url.href));
      return new Response(packed.get(url.href));
    } };

  await saveCatalog({ workerSha256: 'e'.repeat(64) });
  await assert.rejects(signWebUpgrade(inputs), /bind the exact Worker/);
  assert.deepEqual(requested, []);
  await saveCatalog({ releases: { 'linux-x64': releases['linux-x64'] } });
  await assert.rejects(signWebUpgrade(inputs), /currently supported installer targets/);
  assert.deepEqual(requested, []);
  await saveCatalog();
  await signWebUpgrade(inputs);
  assert.deepEqual(requested.sort(), Object.values(releases).map(asset => asset.url).sort());
  assert.deepEqual((await readdir(output)).sort(), ['manifest.json', 'manifest.json.sig', 'worker.js']);
  const [manifest, signature, bundle] = await Promise.all(['manifest.json', 'manifest.json.sig', 'worker.js'].map(name => readFile(join(output, name))));
  const publicKey = await crypto.subtle.importKey('spki', raw.export({ type: 'spki', format: 'der' }), 'Ed25519', false, ['verify']);
  const observed = await verifyUpgradeRelease({ manifest, signature, bundle, publicKey, channel, currentVersion: minimumVersion, format: 2 });
  assert.equal(observed.manifestSha256, sha256(manifest));
  assert.deepEqual(observed.release.enrollment, { protocol: 'intent-v1', releases });
  await assert.rejects(verifyUpgradeRelease({ manifest, signature, bundle, publicKey, channel, currentVersion: minimumVersion }), /metadata/);

  await packageAsset('linux-arm64', true);
  await saveCatalog();
  const staleOutput = join(root, 'no-signature');
  await assert.rejects(signWebUpgrade({ ...inputs, output: staleOutput, keyFile: join(root, 'not-used.pem') }), /stale .*enrollment-claim-client/);
  assert.ok(!(await readdir(root)).includes('no-signature'));
});

test('publisher cannot package a signed management baseline under a different version filename', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nodrelay-kit-version-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const worker = Buffer.from('export default {};');
  const manifest = join(root, 'management-release.json'), key = join(root, 'publisher.pem');
  const release = Buffer.from(JSON.stringify({ schema: 2, oauthClientId: 'fixture-management-client',
    oauthRedirect: 'http://127.0.0.1:18871/oauth/callback', workerBundle: './worker.js', workerSha256: sha256(worker),
    releases: Object.fromEntries(['macos-arm64', 'windows-x64', 'linux-x64'].map(platform => [platform, {
      url: 'https://release.example.test/asset', sha256: 'c'.repeat(64), version: '1.0.0', browser: false,
    }])),
    webUpgrade: { version: '1.0.0-preview.2', channel: 'preview', feed: 'https://release.example.test/updates/' },
  }));
  await Promise.all([
    writeFile(join(root, 'worker.js'), worker), writeFile(manifest, release),
    writeFile(manifest + '.sig', sign(null, release, privateKey)),
    writeFile(key, publicKey.export({ type: 'spki', format: 'pem' })),
  ]);
  const output = join(root, 'output');
  const pack = fileURLToPath(new URL('../packaging/pack-management.mjs', import.meta.url));
  await assert.rejects(exec(process.execPath, [pack, manifest, key,
    'https://release.example.test/nodrelay-management-1.0.0-preview.3-macos.tgz', output]),
  /filename does not match the signed management version/);
  await assert.rejects(lstat(output), { code: 'ENOENT' });
});

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, chmod, cp, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as wait } from 'node:timers/promises';
import { promisify } from 'node:util';
import test from 'node:test';
import { revokeResponse } from '../cloud/device-revocation.mjs';
import { bootstrapInstaller, installCommand, shortInstallCommand } from '../cloud/install-command.mjs';

const exec = promisify(execFile);
const hash = value => createHash('sha256').update(value).digest('hex');
const rootProject = fileURLToPath(new URL('../', import.meta.url));
const ticket = 'v'.repeat(43);
const localCredentials = { deviceId: 'fixture-mac', portalToken: 'p'.repeat(43), activationToken: 'a'.repeat(43), tunnelToken: 't'.repeat(90) };
const useLocalArchive = process.env.FLEET_TEST_LOCAL_ARCHIVE === '1';
const useIntent = process.env.FLEET_TEST_NATIVE_INTENT === '1' && !useLocalArchive;
const shell = value => "'" + value.replaceAll("'", "'\\''") + "'";

test('one generated command installs a dedicated macOS service and activates it with synthetic providers', {
  skip: process.platform !== 'darwin' || process.env.FLEET_TEST_NATIVE_INSTALL !== '1',
  timeout: 40000,
}, async t => {
  const fixture = await mkdtemp(join(tmpdir(), 'fleet-native-install-'));
  const cert = join(fixture, 'cert.pem'), key = join(fixture, 'key.pem'), config = join(fixture, 'tls.cnf');
  await writeFile(config, '[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\nCN=127.0.0.1\n[ext]\nsubjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\n');
  await exec('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-keyout', key, '-out', cert, '-config', config]);
  let bytes, bootstrapDownloads = 0, downloads = 0, redeemed = 0, activationAttempts = 0, activated = 0, revocationChecks = 0;
  let proof;
  const server = createServer({ cert: await readFile(cert), key: await readFile(key) }, async (req, res) => {
    try {
      if (!useLocalArchive && req.method === 'GET' && req.url === '/device/install/macos?version=0.0.0-test') {
        bootstrapDownloads++;
        const assets = { [process.arch]: { url: manager + '/release.tgz', sha256: hash(bytes) } };
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        return res.end(bootstrapInstaller(manager, 'macos', { assets }, { enrollmentIntent: useIntent }));
      }
      if (req.method === 'GET' && req.url === '/release.tgz') {
        downloads++;
        return res.end(bytes);
      }
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      const validIntent = useIntent && body.protocol === 'intent-v1' && body.code === ticket &&
        body.deviceId === localCredentials.deviceId && body.platform === 'macos' && body.architecture === process.arch &&
        body.version === '0.0.0-test' && body.sha256 === hash(bytes) && body.browser === false &&
        /^[A-Za-z0-9_-]{43}$/.test(body.recoveryProof ?? '') && body.recoveryProof !== ticket;
      if (req.url === '/device/enroll' && (validIntent || !useIntent && body.ticket === ticket) && !redeemed++) {
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify(localCredentials));
      }
      if (req.url === '/device/activate' && req.headers.authorization === `Bearer ${localCredentials.activationToken}` &&
          body.deviceId === localCredentials.deviceId) {
        if (proof) {
          revocationChecks++;
          res.writeHead(410, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify(proof));
        }
        if (activationAttempts++ === 0) {
          res.statusCode = 403;
          return res.end('Temporary edge policy response');
        }
        activated++;
        res.setHeader('Content-Type', 'application/json');
        return res.end('{"status":"active"}');
      }
    } catch {}
    res.statusCode = 400;
    res.end();
  });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const manager = `https://127.0.0.1:${server.address().port}`;
  const id = hash(manager).slice(0, 12);
  const label = 'devspace-fleet-' + id;
  const installed = join(homedir(), '.devspace-fleet', id);
  const plist = join(homedir(), 'Library', 'LaunchAgents', label + '.plist');
  const job = `gui/${process.getuid()}/${label}`;
  await assert.rejects(access(installed), { code: 'ENOENT' });
  await assert.rejects(access(plist), { code: 'ENOENT' });
  t.after(async () => {
    const owned = (await readFile(plist, 'utf8').catch(() => '')).includes(installed);
    if (owned) {
      await exec('/bin/launchctl', ['bootout', job], { timeout: 8000 });
      await rm(plist, { force: true });
      let loaded = true;
      for (let delay = 0; delay < 30 && loaded; delay++) {
        loaded = await exec('/bin/launchctl', ['print', job]).then(() => true, () => false);
        if (loaded) await wait(200);
      }
      assert.equal(loaded, false);

    }
    await rm(installed, { recursive: true, force: true });
    await rm(fixture, { recursive: true, force: true });
  });

  const bundle = join(fixture, 'bundle');
  for (const leaf of ['bin', 'fleet', 'personal/dist', 'personal/personal/desktop']) {
    await mkdir(join(bundle, leaf), { recursive: true });
  }
  for (const path of ['src', 'cloud', 'node_modules', 'package.json']) {
    await cp(join(rootProject, path), join(bundle, 'fleet', path), { recursive: true, verbatimSymlinks: true });
  }
  await cp(join(rootProject, 'packaging', 'install.sh'), join(bundle, 'install.sh'));
  await writeFile(join(bundle, 'bundle.json'), JSON.stringify({ schema: 1, platform: 'macos-' + process.arch, version: '0.0.0-test', browser: false }));
  await writeFile(join(bundle, 'bin', 'node'), `#!/bin/sh\nexport NODE_EXTRA_CA_CERTS=${shell(cert)}\nexec ${shell(process.execPath)} "$@"\n`, { mode: 0o700 });
  const disconnect = join(fixture, 'disconnect');
  const tunnelFixture = `const { existsSync } = require('node:fs');
setInterval(() => { if (existsSync(process.argv[1])) process.exit(1); }, 100);`;
  await writeFile(join(bundle, 'bin', 'cloudflared'),
    `#!/bin/sh\n[ "$4" = "--token-file" ] || exit 1\nexec ${shell(process.execPath)} -e ${shell(tunnelFixture)} ${shell(disconnect)}\n`,
    { mode: 0o700 });

  // The real adapter uses a fixed device port, which may belong to an existing setup on this Mac.
  // Its protocol is covered by the separate Worker and adapter integration tests.
  await writeFile(join(bundle, 'fleet/src/device.mjs'), 'setInterval(() => {}, 1000);\n');
  await writeFile(join(bundle, 'personal/dist/server.js'), '// The Runtime is isolated in a separate integration test.\n');
  await writeFile(join(bundle, 'personal/personal/state.mjs'), `import { writeFile, mkdir } from 'node:fs/promises';
export const secureStateDirectory = dir => mkdir(dir, { recursive: true, mode: 0o700 });
export const atomicJson = (file, value) => writeFile(file, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
`);
  await writeFile(join(bundle, 'personal/personal/desktop/platform.mjs'), `export const registerJobs = async () => {};
export const jobAction = async () => {};
export const registerDesktopEntries = async () => {};
`);
  const archive = join(fixture, 'release.tgz');
  await exec('tar', ['-czf', archive, '-C', bundle, '.']);
  bytes = await readFile(archive);
  const command = useLocalArchive ? installCommand(manager, 'macos-' + process.arch,
    { localFile: 'release.tgz', sha256: hash(bytes) }, ticket, localCredentials.deviceId) :
    shortInstallCommand(manager, 'macos', '0.0.0-test', ticket, localCredentials.deviceId);
  const run = () => exec('/bin/sh', ['-c', command], {
    cwd: fixture, env: { ...process.env, CURL_CA_BUNDLE: cert }, timeout: 20000,
  });
  await run();
  assert.equal(bootstrapDownloads, useLocalArchive ? 0 : 1);
  assert.equal(downloads, useLocalArchive ? 0 : 1);
  for (let i = 0; i < 70 && activated === 0; i++) await wait(200);
  assert.equal(activated, 1);
  assert.equal(activationAttempts, 2, 'The OS-managed service survived an unverified 403');
  const statusFile = join(installed, 'connection-status.json');
  let connectionStatus;
  for (let i = 0; i < 15; i++) {
    try { connectionStatus = JSON.parse(await readFile(statusFile, 'utf8')); } catch {}
    if (connectionStatus?.status === 'active') break;
    await wait(200);
  }
  assert.equal(connectionStatus?.status, 'active');
  assert.equal(redeemed, 1);
  assert.equal((await exec('/bin/launchctl', ['print', job])).stdout.includes(label), true);
  const tunnelToken = join(installed, 'tunnel.token');
  assert.equal((await readFile(tunnelToken, 'utf8')).trim(), localCredentials.tunnelToken);
  await chmod(tunnelToken, 0o644);
  await assert.rejects(run(), /private regular file/);
  assert.equal((await lstat(tunnelToken)).mode & 0o777, 0o644, 'Rejection did not modify the existing file');
  assert.equal(redeemed, 1);
  await chmod(tunnelToken, 0o600);
  await run();
  assert.equal(redeemed, 1, 'Idempotent rerun keeps its credential and does not redeem again');

  proof = await revokeResponse(manager, localCredentials.deviceId, localCredentials.activationToken);
  await writeFile(disconnect, '');
  for (let i = 0; i < 30; i++) {
    connectionStatus = JSON.parse(await readFile(statusFile, 'utf8'));
    if (connectionStatus?.status === 'revoked') break;
    await wait(200);
  }
  assert.equal(connectionStatus?.status, 'revoked', 'Connector exit did not interrupt confirmed revocation');
  assert.equal(revocationChecks, 1);

});

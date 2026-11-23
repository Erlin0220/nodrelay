import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const exec = promisify(execFile);

test('the macOS management command downloads and verifies the kit from an empty directory', {
  skip: process.platform !== 'darwin' || process.env.FLEET_TEST_MANAGEMENT_KIT !== '1', timeout: 120000,
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'nodrelay-kit-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = join(root, 'management-release.json');
  const publisher = join(root, 'publisher.pem');
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const worker = 'export default {}';
  const workerSha256 = createHash('sha256').update(worker).digest('hex');
  const metadata = JSON.stringify({ schema: 2, oauthClientId: 'fixture-management-client',
    oauthRedirect: 'http://127.0.0.1:18871/oauth/callback', workerBundle: './worker.js', workerSha256,
    releases: {
      'macos-arm64': { url: 'https://release.example.test/mac.tgz', sha256: 'a'.repeat(64), version: '1.0.0' },
      'windows-x64': { url: 'https://release.example.test/windows.zip', sha256: 'b'.repeat(64), version: '1.0.1', browser: true },
      'linux-x64': { url: 'https://release.example.test/linux.tgz', sha256: 'c'.repeat(64), version: '1.0.2' },
    },
  });
  await Promise.all([
    writeFile(join(root, 'worker.js'), worker), writeFile(manifest, metadata),
    writeFile(manifest + '.sig', sign(null, Buffer.from(metadata), privateKey)),
    writeFile(publisher, publicKey.export({ type: 'spki', format: 'pem' })),
  ]);
  const tls = join(root, 'tls.cnf');
  const cert = join(root, 'tls.pem');
  const key = join(root, 'tls.key');
  await writeFile(tls, '[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\nCN=127.0.0.1\n[ext]\nsubjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\n');
  await exec('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', key, '-out', cert, '-config', tls]);
  const name = 'nodrelay-management-1.0.0-macos.tgz';
  let archive;
  let downloads = 0;
  let launcher;
  let launcherDownloads = 0;
  const server = createServer({ key: await readFile(key), cert: await readFile(cert) }, (req, res) => {
    if (req.url === '/install-macos.sh') {
      launcherDownloads++;
      return res.end(launcher);
    }
    if (req.url === '/archives/' + name) {
      res.writeHead(302, { Location: '/asset' });
      return res.end();
    }
    if (req.url === '/asset') {
      downloads++;
      return res.end(archive);
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const output = join(root, 'output');
  const origin = `https://127.0.0.1:${server.address().port}`;
  await exec(process.execPath, ['packaging/pack-management.mjs', manifest, publisher,
    `${origin}/archives/${name}`, output, `${origin}/install-macos.sh`]);
  launcher = await readFile(join(output, 'install-macos.sh'));
  const archiveFile = join(output, name);
  archive = await readFile(archiveFile);
  const { stdout: notice } = await exec('tar', ['-xOzf', archiveFile, './licenses/jose.txt']);
  assert.equal(notice, await readFile(new URL('../node_modules/jose/LICENSE.md', import.meta.url), 'utf8'));
  const { stdout: clackNotice } = await exec('tar', ['-xOzf', archiveFile, './node_modules/@clack/prompts/LICENSE']);
  assert.equal(clackNotice, await readFile(new URL('../node_modules/@clack/prompts/LICENSE', import.meta.url), 'utf8'));
  const command = (await readFile(join(output, 'install-macos-command.txt'), 'utf8')).trim();
  const inline = (await readFile(join(output, 'install-command.txt'), 'utf8')).trim();
  const run = (command) => exec('/bin/sh', ['-c', command + ' --plan'], {
    cwd: tmpdir(), env: { ...process.env, CURL_CA_BUNDLE: cert }, timeout: 100000,
  });
  const result = await run(command);
  assert.deepEqual(JSON.parse((await run(inline)).stdout), JSON.parse(result.stdout));
  assert.match(result.stderr, /正在准备并校验 Node/);
  assert.match(result.stdout, /"automaticDomainDiscovery": true/);
  assert.match(result.stdout, /"automaticAdministratorDiscovery": true/);
  assert.match(result.stdout, /"oauthTokenProvisioning": false/);
  assert.ok(JSON.parse(result.stdout).permissionScopes.includes('user-details.read'));
  assert.deepEqual(JSON.parse(result.stdout).deviceTargets, [
    { platform: 'macos-arm64', version: '1.0.0', browser: false },
    { platform: 'windows-x64', version: '1.0.1', browser: true },
    { platform: 'linux-x64', version: '1.0.2', browser: false },
  ]);
  const trustedLauncher = launcher;
  launcher = Buffer.from('#!/bin/sh\necho untrusted-launcher-was-executed\n');
  await assert.rejects(run(command), error => {
    assert.doesNotMatch(error.stdout, /untrusted-launcher-was-executed/);
    return /Nodrelay launcher checksum mismatch/.test(error.stderr);
  });
  assert.equal(downloads, 2);
  launcher = trustedLauncher;
  archive = Buffer.from('corrupted archive');
  await assert.rejects(run(command), error => {
    assert.doesNotMatch(error.stderr, /正在准备并校验 Node/);
    return /Nodrelay download checksum mismatch/.test(error.stderr);
  });
  assert.equal(downloads, 3);
  assert.equal(launcherDownloads, 3);
});

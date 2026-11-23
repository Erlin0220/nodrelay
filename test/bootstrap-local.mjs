import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { enrollmentBootstrapUrl, resolveEnrollmentBootstrap } from '../cloud/enrollment-bootstrap.mjs';
import { bootstrapInstaller, installCommand, shortInstallCommand } from '../cloud/install-command.mjs';
import { inspectWindowsDirectory, inspectWindowsFile } from '../src/private-directory.mjs';

const exec = promisify(execFile);
async function serveArchive(t, root, payload, bootstrap) {
  const tls = join(root, 'tls.cnf');
  await writeFile(tls, `[req]
prompt=no
distinguished_name=dn
x509_extensions=ext
[dn]
CN=127.0.0.1
[ext]
subjectAltName=IP:127.0.0.1
basicConstraints=critical,CA:TRUE
`);
  const cert = join(root, 'certificate.pem');
  const key = join(root, 'key.pem');
  await exec('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-keyout', key, '-out', cert, '-config', tls]);
  const archiveSha256 = createHash('sha256').update(payload).digest('hex');
  let downloads = 0;
  const server = createServer({ cert: await readFile(cert), key: await readFile(key) }, (req, res) => {
    const url = new URL(req.url, `https://127.0.0.1:${server.address().port}`);
    if (bootstrap && url.searchParams.has('manifest')) {
      void resolveEnrollmentBootstrap(new Request(url), {
        origin: url.origin,
        lookupApproved(platform, version) {
          if (version !== '1.0.0' || !['macos', 'linux'].includes(platform)) return;
          return { version, browser: false, assets: {
            [process.arch]: { url: url.origin + '/release', sha256: archiveSha256 },
          } };
        },
        render: (origin, platform, manifest) => bootstrapInstaller(origin, platform, manifest, { enrollmentIntent: true }),
      }).then(async response => {
        res.statusCode = response?.status ?? 404;
        res.end(response ? await response.text() : '');
      }).catch(error => res.destroy(error));
      return;
    }
    const install = req.url.match(/^\/device\/install\/(windows|macos|linux)\?version=1\.0\.([0-4])$/);
    if (bootstrap && install) {
      const [, platform, scenario] = install;
      if (scenario === '3') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end('<html>Management login</html>');
      }
      res.setHeader('Content-Type', 'text/plain');
      if (scenario === '1') res.statusCode = 404;
      if (scenario === '2') res.writeHead(302, { Location: `/device/install/${platform}?version=1.0.0` });
      if (scenario === '4') res.statusCode = 302;
      return res.end(bootstrap(`https://127.0.0.1:${server.address().port}`, platform));
    }
    const target = {
      '/release': '/device.tgz',
      '/downgrade': `http://127.0.0.1:${server.address().port}/device.tgz`,
      '/loop': '/loop',
    }[req.url];
    if (target) {
      res.writeHead(302, { Location: target });
      return res.end();
    }
    downloads++;
    res.end(payload);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const origin = `https://127.0.0.1:${server.address().port}`;
  return { origin, cert, downloads: () => downloads };
}

test('the generated POSIX command executes only the exact approved archive', {
  skip: process.platform === 'win32' || process.env.FLEET_TEST_BOOTSTRAP !== '1',
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'fleet-install-command-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'install.sh'), '#!/bin/sh\nset -eu\nprintf "%s" "$DEVSPACE_FLEET_DEVICE" > "$FLEET_TEST_RESULT"\nprintf "%s" "${DEVSPACE_FLEET_ENROLLMENT_PROTOCOL:-}:${DEVSPACE_FLEET_ASSET_SHA256:-}" > "$FLEET_TEST_RESULT.protocol"\n');
  const archive = join(root, 'device.tgz');
  await exec('tar', ['-czf', archive, '-C', root, 'install.sh']);
  const payload = await readFile(archive);
  const hash = createHash('sha256').update(payload).digest('hex');
  const { origin, cert, downloads } = await serveArchive(t, root, payload, (url, platform) =>
    bootstrapInstaller(url, platform, { assets: { [process.arch]: { url: url + '/release', sha256: hash } } }));
  const result = join(root, 'result');
  const run = (sha256, path = '/release') => exec('/bin/sh', ['-c', installCommand('https://fleet.example.invalid',
    'macos-arm64', { url: origin + path, sha256 }, 'temporary-fixture-ticket', 'mac-test')], {
    env: { ...process.env, CURL_CA_BUNDLE: cert, FLEET_TEST_RESULT: result },
  });
  await assert.rejects(run('0'.repeat(64)), /Installer hash mismatch/);
  await assert.rejects(readFile(result, 'utf8'), { code: 'ENOENT' });
  await assert.rejects(run(hash, '/downgrade'), /Protocol "http" disabled/i);
  await assert.rejects(run(hash, '/loop'), /maximum .*redirect/i);
  assert.equal(downloads(), 1, 'Rejected redirects did not resolve to the archive');
  await run(hash);
  assert.equal(downloads(), 2, 'Both release requests followed the HTTPS redirect');
  assert.equal(await readFile(result, 'utf8'), 'mac-test');

  const shim = join(root, 'shims');
  await mkdir(shim);
  await writeFile(join(shim, 'uname'), '#!/bin/sh\nif [ "$1" = "-s" ]; then echo "$FIXTURE_SYSTEM"; else exec /usr/bin/uname "$@"; fi\n', { mode: 0o755 });
  for (const [platform, kernel] of [['macos', 'Darwin'], ['linux', 'Linux']]) {
    const reads = downloads();
    await rm(result);
    const runShort = version => exec('/bin/sh', ['-c', shortInstallCommand(origin, platform, version, 's'.repeat(43), platform + '-short')], {
      env: { ...process.env, CURL_CA_BUNDLE: cert, FLEET_TEST_RESULT: result, FIXTURE_SYSTEM: kernel, PATH: shim + ':' + process.env.PATH },
    });
    for (const version of ['1.0.1', '1.0.2', '1.0.3', '1.0.4']) {
      await assert.rejects(runShort(version));
      await assert.rejects(lstat(result), { code: 'ENOENT' });
    }
    assert.equal(downloads(), reads, 'An invalid bootstrap must not request the archive');
    await runShort('1.0.0');
    assert.equal(await readFile(result, 'utf8'), platform + '-short');
    const pinnedUrl = await enrollmentBootstrapUrl(origin, { platform, version: '1.0.0', browser: false,
      assets: { [process.arch]: { url: origin + '/release', sha256: hash } } });
    const runPinned = url => exec('/bin/sh', ['-c',
      shortInstallCommand(origin, platform, '1.0.0', 'p'.repeat(43), platform + '-pinned', { pinnedUrl: url })], {
      env: { ...process.env, CURL_CA_BUNDLE: cert, FLEET_TEST_RESULT: result, FIXTURE_SYSTEM: kernel, PATH: shim + ':' + process.env.PATH },
    });
    await rm(result);
    const modifiedPin = new URL(pinnedUrl);
    const digest = modifiedPin.searchParams.get('manifest');
    modifiedPin.searchParams.set('manifest', (digest.startsWith('0') ? '1' : '0') + digest.slice(1));
    const beforeInvalidPin = downloads();
    await assert.rejects(runPinned(modifiedPin.href));
    await assert.rejects(lstat(result), { code: 'ENOENT' });
    assert.equal(downloads(), beforeInvalidPin);
    await runPinned(pinnedUrl);
    assert.equal(await readFile(result, 'utf8'), platform + '-pinned');
    assert.equal(await readFile(result + '.protocol', 'utf8'), 'intent-v1:' + hash);
  }
});

test('the Windows command executes the verified native entry, reports nonzero exits and removes staging', {
  skip: process.platform === 'win32' || process.env.FLEET_TEST_BOOTSTRAP !== '1' || !process.env.FLEET_TEST_PWSH,
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'fleet-powershell-bootstrap-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundle = join(root, 'bundle');
  await mkdir(join(bundle, 'bin'), { recursive: true });
  await mkdir(join(bundle, 'fleet', 'src'), { recursive: true });
  await writeFile(join(bundle, 'bin', 'node.exe'), '#!/bin/sh\nexec "$FLEET_TEST_NATIVE_NODE" "$@"\n', { mode: 0o755 });
  await writeFile(join(bundle, 'fleet/src/install-device.mjs'), `
import { writeFileSync } from 'node:fs';
writeFileSync(process.env.FLEET_TEST_RESULT, JSON.stringify({
  device: process.env.DEVSPACE_FLEET_DEVICE,
  root: process.argv[2]
}));
process.exit(Number(process.env.FLEET_TEST_CHILD_EXIT));
`);
  const archive = join(root, 'device.zip');
  await exec('zip', ['-qr', archive, '.'], { cwd: bundle });
  const marker = join(root, 'temp-root'), result = join(root, 'result');
  const payload = await readFile(archive);
  const sha256 = createHash('sha256').update(payload).digest('hex');
  const { origin, cert, downloads } = await serveArchive(t, root, payload, url =>
    bootstrapInstaller(url, 'windows', { assets: { x64: { url: url + '/release', sha256 } } }));
  const testCurl = join(root, 'curl.exe');
  await writeFile(testCurl, `#!/bin/sh\n
previous=
for arg do
  if [ "$previous" = "--output" ]; then dirname "$arg" > "$FLEET_TEST_DOWNLOAD_MARKER"; fi
  previous=$arg
done
exec /usr/bin/curl "$@"
`, { mode: 0o755 });
  const env = {
    ...process.env,
    CURL_CA_BUNDLE: cert,
    FLEET_TEST_SYSTEM_CURL: testCurl,
    FLEET_TEST_DOWNLOAD_MARKER: marker,
    FLEET_TEST_NATIVE_NODE: process.execPath,
    FLEET_TEST_RESULT: result,
    FLEET_TEST_ACL_SOURCE: join(root, 'inspect-acl.txt'),
  };
  await writeFile(env.FLEET_TEST_ACL_SOURCE, inspectWindowsDirectory + '\n' + inspectWindowsFile);
  const powershell = command => exec(process.env.FLEET_TEST_PWSH, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command,
  ], { env, timeout: 15000 });
  await powershell(`
$tokens=$null; $errors=$null
[System.Management.Automation.Language.Parser]::ParseInput([IO.File]::ReadAllText($env:FLEET_TEST_ACL_SOURCE),[ref]$tokens,[ref]$errors) > $null
if ($errors.Count -ne 0) { throw 'Invalid ACL inspection script' }
`);
  const run = (hash, code, path = '/release') => powershell(`
function Join-Path {
  param([AllowEmptyString()][string]$Path, [string]$ChildPath)
  if ($ChildPath -eq 'System32/curl.exe') { return $env:FLEET_TEST_SYSTEM_CURL }
  Microsoft.PowerShell.Management\\Join-Path @PSBoundParameters
}
function Expand-Archive {
  param([string]$LiteralPath, [string]$DestinationPath)
  Microsoft.PowerShell.Archive\\Expand-Archive @PSBoundParameters
  & chmod +x (Join-Path $DestinationPath 'bin/node.exe')
  if ($LASTEXITCODE -ne 0) { throw 'Could not prepare the Unix native-process test fixture' }
}
$env:FLEET_TEST_CHILD_EXIT='${code}'
${installCommand('https://fleet.example.invalid', 'windows-x64',
    { url: origin + path, sha256: hash }, 'fixture-ticket', 'windows-test')}
`);
  const removed = async () => {
    const temporary = (await readFile(marker, 'utf8')).trim();
    await assert.rejects(lstat(temporary), { code: 'ENOENT' });
  };
  await assert.rejects(run('0'.repeat(64), 0), /Installer hash mismatch/);
  await assert.rejects(readFile(result), { code: 'ENOENT' });
  await removed();
  await assert.rejects(run(sha256, 0, '/downgrade'), /Protocol "http" disabled/i);
  await removed();
  assert.equal(downloads(), 1, 'The Windows command blocked an HTTP redirect before obtaining the bundle');
  await run(sha256, 0);
  const receipt = JSON.parse(await readFile(result, 'utf8'));
  assert.equal(receipt.device, 'windows-test');
  assert.equal(receipt.root, join((await readFile(marker, 'utf8')).trim(), 'bundle'));
  await removed();
  await assert.rejects(run(sha256, 7), /Device installation failed/);
  await removed();

  const runShort = (version, exitCode = 0) => powershell(`
$ErrorActionPreference = 'Stop'
$env:PROCESSOR_ARCHITECTURE='AMD64'
function Invoke-WebRequest {
  param([string]$Uri,[int]$MaximumRedirection,[int]$TimeoutSec,[switch]$UseBasicParsing)
  if ($MaximumRedirection -ne 0 -or $TimeoutSec -ne 30 -or -not $UseBasicParsing) { throw 'Unexpected bootstrap HTTP options' }
  $raw = [string]::Join([Environment]::NewLine, (& /usr/bin/curl --silent --show-error --proto '=https' --write-out '%{http_code}' --url $Uri))
  if ($LASTEXITCODE -ne 0 -or $raw.Length -lt 3) { throw 'Fixture bootstrap request failed' }
  $status = [int]$raw.Substring($raw.Length - 3)
  if ($status -ge 400) { throw "Fixture HTTP $status" }
  return [pscustomobject]@{StatusCode=$status;Content=$raw.Substring(0,$raw.Length-3)}
}
function Join-Path {
  param([AllowEmptyString()][string]$Path, [string]$ChildPath)
  if ($ChildPath -eq 'System32/curl.exe') { return $env:FLEET_TEST_SYSTEM_CURL }
  Microsoft.PowerShell.Management\\Join-Path @PSBoundParameters
}
function Expand-Archive {
  param([string]$LiteralPath, [string]$DestinationPath)
  Microsoft.PowerShell.Archive\\Expand-Archive @PSBoundParameters
  & chmod +x (Join-Path $DestinationPath 'bin/node.exe')
}
$env:FLEET_TEST_CHILD_EXIT='${exitCode}'
${shortInstallCommand(origin, 'windows', version, 'w'.repeat(43), 'windows-short')}
`);
  const beforeShort = downloads();
  await rm(result);
  for (const version of ['1.0.1', '1.0.2', '1.0.3', '1.0.4']) {
    await assert.rejects(runShort(version));
    await assert.rejects(lstat(result), { code: 'ENOENT' });
  }
  assert.equal(downloads(), beforeShort);
  await runShort('1.0.0');
  assert.equal(JSON.parse(await readFile(result, 'utf8')).device, 'windows-short');
  await removed();
  await assert.rejects(runShort('1.0.0', 7), /Device installation failed/);
  await removed();
});

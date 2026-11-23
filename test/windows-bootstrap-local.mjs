import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { enrollmentBootstrapUrl } from '../cloud/enrollment-bootstrap.mjs';
import { bootstrapInstaller, shortInstallCommand } from '../cloud/install-command.mjs';

const exec = promisify(execFile);
const shell = () => join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const options = ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'];

test('the pinned short command extracts and runs the verified archive on native Windows', {
  skip: process.platform !== 'win32' || process.env.FLEET_TEST_WINDOWS_BOOTSTRAP !== '1', timeout: 120000,
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'nodrelay native bootstrap '));
  t.after(() => rm(root, { recursive:true, force:true, maxRetries:5, retryDelay:100 }));
  const bundle = join(root, 'fixture'), stage = join(root, 'staging'), result = join(root, 'receipt.json');
  const archive = join(root, 'device.zip'), transfer = join(root, 'transfer.cmd');
  await Promise.all([mkdir(join(bundle, 'bin'), { recursive:true }),
    mkdir(join(bundle, 'fleet', 'src'), { recursive:true }), mkdir(stage)]);
  await Promise.all([
    copyFile(process.execPath, join(bundle, 'bin', 'node.exe')),
    writeFile(join(bundle, 'fleet', 'src', 'install-device.mjs'), `
import { writeFileSync } from 'node:fs';
writeFileSync(process.env.FLEET_TEST_RESULT, JSON.stringify({
  root: process.argv[2],
  device: process.env.DEVSPACE_FLEET_DEVICE,
  protocol: process.env.DEVSPACE_FLEET_ENROLLMENT_PROTOCOL,
  sha256: process.env.DEVSPACE_FLEET_ASSET_SHA256,
  hasTicket: process.env.DEVSPACE_FLEET_TICKET === 'f'.repeat(43),
}));
process.exit(Number(process.env.FLEET_TEST_EXIT));
`),
    writeFile(transfer, [
      '@echo off', 'setlocal', ':next', 'if "%~1"=="" exit /b 2',
      'if "%~1"=="--output" goto save', 'shift', 'goto next', ':save',
      'copy /Y "%FLEET_TEST_ARCHIVE%" "%~2" >NUL', 'exit /b %errorlevel%', '',
    ].join('\r\n')),
  ]);
  const env = { ...process.env, TEMP:stage, TMP:stage, FLEET_TEST_ARCHIVE:archive,
    FLEET_TEST_TRANSFER:transfer, FLEET_TEST_BUNDLE:bundle, FLEET_TEST_RESULT:result };
  // The runner normally starts this test from pwsh. Its inherited module
  // search path can load a PowerShell 7 module into the Windows 5.1 process.
  for (const name of Object.keys(env)) {
    if (name.toLowerCase() === 'psmodulepath') delete env[name];
  }
  await exec(shell(), [...options,
    'Compress-Archive -Path (Join-Path $env:FLEET_TEST_BUNDLE "*") -DestinationPath $env:FLEET_TEST_ARCHIVE -CompressionLevel Fastest -ErrorAction Stop'],
  { env, timeout:40000 });

  const sha256 = createHash('sha256').update(await readFile(archive)).digest('hex');
  const origin = 'https://manager.example.invalid';
  const release = { platform:'windows', version:'1.0.0', browser:false,
    assets:{ x64:{ url:'https://archive.example.invalid/device.zip', sha256 } } };
  const pinnedUrl = await enrollmentBootstrapUrl(origin, release);
  const command = shortInstallCommand(origin, 'windows', release.version, 'f'.repeat(43), 'windows-fixture', { pinnedUrl });
  const run = async (digest, exitCode, status = 200, locked = 0) => {
    const script = bootstrapInstaller(origin, 'windows', {
      assets:{ x64:{ ...release.assets.x64, sha256:digest } },
    }, { enrollmentIntent:true });
    return exec(shell(), [...options, `
$ErrorActionPreference = 'Stop'
# Load the real modules before the test shadows Join-Path: module discovery
# can call Join-Path with parameter sets that the fixture doesn't implement.
if ($PSVersionTable.PSEdition -ne 'Desktop' -or $PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1) {
  throw 'The fixture requires Windows PowerShell 5.1'
}
$env:PSModulePath = [IO.Path]::Combine($PSHOME, 'Modules')
foreach ($module in @('Microsoft.PowerShell.Management', 'Microsoft.PowerShell.Utility', 'Microsoft.PowerShell.Archive')) {
  $manifest = [IO.Path]::Combine($env:PSModulePath, $module, ($module + '.psd1'))
  Import-Module $manifest -ErrorAction Stop
}
Get-Command Get-FileHash, Expand-Archive -ErrorAction Stop | Out-Null
function Invoke-WebRequest {
  [CmdletBinding()]
  param([string]$Uri, [switch]$UseBasicParsing, [int]$MaximumRedirection, [int]$TimeoutSec)
  if ($Uri -cne $env:FLEET_TEST_PINNED -or !$UseBasicParsing -or $MaximumRedirection -ne 0 -or $TimeoutSec -ne 30) {
    throw 'Unexpected bootstrap request'
  }
  return [pscustomobject]@{ StatusCode = [int]$env:FLEET_TEST_STATUS; Content = $env:FLEET_TEST_BOOTSTRAP_SCRIPT }
}
function Join-Path {
  param([AllowEmptyString()][string]$Path, [string]$ChildPath)
  if ($Path -eq $env:SystemRoot -and $ChildPath -in @('System32/curl.exe','Sysnative/curl.exe')) {
    return $env:FLEET_TEST_TRANSFER
  }
  Microsoft.PowerShell.Management\\Join-Path @PSBoundParameters
}
$script:cleanupCalls = 0
function Remove-Item {
  [CmdletBinding(DefaultParameterSetName='Path')]
  param([Parameter(Position=0,ParameterSetName='Path')][string[]]$Path,
        [Parameter(Mandatory,ParameterSetName='LiteralPath')][string[]]$LiteralPath,
        [switch]$Recurse, [switch]$Force)
  if ($Recurse -and $LiteralPath.Count -eq 1 -and [IO.Path]::GetFileName($LiteralPath[0]) -like 'nodrelay-*') {
    $script:cleanupCalls++
    if ($script:cleanupCalls -le [int]$env:FLEET_TEST_LOCKED) {
      throw [IO.IOException]::new('Fixture temporarily locks extracted executable')
    }
  }
  Microsoft.PowerShell.Management\\Remove-Item @PSBoundParameters
}
${command}
`], { env:{ ...env, FLEET_TEST_PINNED:pinnedUrl, FLEET_TEST_BOOTSTRAP_SCRIPT:script,
      FLEET_TEST_EXIT:String(exitCode), FLEET_TEST_STATUS:String(status), FLEET_TEST_LOCKED:String(locked) }, timeout:25000 });
  };
  const cleaned = async () => assert.deepEqual(await readdir(stage), []);
  const throwsOnStderr = (promise, pattern) => assert.rejects(promise, error => {
    assert.match(error.stderr, pattern);
    return true;
  });
  await throwsOnStderr(run(sha256, 0, 302), /Installer unavailable/);
  await assert.rejects(readFile(result), { code:'ENOENT' });
  await cleaned();
  await throwsOnStderr(run('0'.repeat(64), 0), /Installer hash mismatch/);
  await assert.rejects(readFile(result), { code:'ENOENT' });
  await cleaned();

  await run(sha256, 0, 200, 2);
  const receipt = JSON.parse(await readFile(result, 'utf8'));
  assert.match(receipt.root, /nodrelay-[a-f0-9-]+[\\/]bundle$/i);
  // PowerShell may expand a DOS short profile path that Node received in
  // TEMP. Resolve the surviving staging root, not the now-removed bundle.
  const actualStage = await realpath(dirname(dirname(receipt.root)));
  const expectedStage = await realpath(stage);
  assert.equal(actualStage.toLowerCase(), expectedStage.toLowerCase());
  assert.deepEqual({ ...receipt, root:undefined }, { root:undefined, device:'windows-fixture',
    protocol:'intent-v1', sha256, hasTicket:true });
  await cleaned();
  await rm(result);
  await throwsOnStderr(run(sha256, 7, 200, 5), /Device installation failed/);
  assert.equal(JSON.parse(await readFile(result, 'utf8')).device, 'windows-fixture');
  assert.equal((await readdir(stage)).filter(name => name.startsWith('nodrelay-')).length, 1,
    'Fixture holds staging beyond the retry budget without masking installation failure');
});

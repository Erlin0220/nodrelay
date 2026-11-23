import { installPath, operatingSystems, publicInstallerBase } from './device-paths.mjs';
import { devicePattern, tokenPattern } from './tickets.mjs';

const sh = value => "'" + value.replaceAll("'", "'\\''") + "'";
const curlOptions = "--disable --fail --silent --show-error --location --max-redirs 5 --connect-timeout 15 --max-time 300 --retry 3 --retry-delay 2 --proto '=https' --proto-redir '=https'";
const ps = value => "'" + value.replaceAll("'", "''") + "'";

const shellHash = "if command -v sha256sum >/dev/null; then digest=$(sha256sum \"$d/fleet.tgz\"); else digest=$(shasum -a 256 \"$d/fleet.tgz\"); fi";
const requireShellHash = expected => `[ "\${digest%% *}" = ${expected} ] || { printf '%s\\n' 'Installer hash mismatch' >&2; exit 1; }`;
const unpackShell = 'mkdir "$d/bundle"; tar -xzf "$d/fleet.tgz" -C "$d/bundle"';
const temporaryDirectory = 'umask 077; d=$(mktemp -d); trap \'rm -rf "$d"\' EXIT';
const runWindows = "& (Join-Path $bundle 'bin/node.exe') (Join-Path $bundle 'fleet/src/install-device.mjs') $bundle";
const requireWindowsSuccess = "if ($LASTEXITCODE -ne 0) { throw 'Device installation failed' }";

// Windows can briefly hold the extracted executable open after it exits.
// Never overwrite the installer outcome with a staging cleanup error.
const windowsCleanup = "for ($attempt = 0; $attempt -lt 5; $attempt++) { try { if (-not (Test-Path -LiteralPath $d -ErrorAction Stop)) { break }; Remove-Item -LiteralPath $d -Recurse -Force -ErrorAction Stop; break } catch { if ($attempt -eq 4) { Write-Warning 'Nodrelay could not remove its temporary installer files.' -WarningAction Continue } else { Start-Sleep -Milliseconds (200 * ($attempt + 1)) } } }";

export function shortInstallCommand(origin, platform, version, ticket, deviceId, { pinnedUrl } = {}) {
  const url = new URL(installPath(platform), origin);
  if (url.protocol !== 'https:') throw new Error('Device bootstrap requires HTTPS');
  if (pinnedUrl) {
    const pinned = new URL(pinnedUrl);
    if (pinned.origin !== url.origin || pinned.pathname !== url.pathname || pinned.searchParams.get('version') !== version ||
        !/^[a-f0-9]{64}$/.test(pinned.searchParams.get('manifest') ?? '') || [...pinned.searchParams].length !== 2 ||
        pinned.hash || pinned.username || pinned.password) throw new Error('Unsafe pinned installer destination');
    url.search = pinned.search;
  } else url.searchParams.set('version', version);
  if (platform === 'windows') {
    return `& { $r=iwr ${ps(url.href)} -UseBasicParsing -MaximumRedirection 0 -TimeoutSec 30 -ErrorAction Stop; if($r.StatusCode -ne 200 -or $r.Content -cnotlike 'param(*'){ throw 'Installer unavailable' }; & ([scriptblock]::Create([string]$r.Content)) ${ps(deviceId)} ${ps(ticket)} }`;
  }
  return `(s=$(curl -qfsSL --max-redirs 0 -m30 -w '%{http_code}' ${sh(url.href)}) && case "$s" in '#!/bin/sh'*200) sh -c "\${s%???}" -- ${sh(deviceId)} ${sh(ticket)};; *) echo 'Installer unavailable' >&2; exit 1;; esac)`;
}

// The command a person copies, in Komari's shape: a fixed public script, the
// console address and the install code. The script asks the console for the
// pinned installer, which downloads, retries and verifies SHA-256 itself.
export function publicInstallCommand(origin, platform, code) {
  const url = new URL(origin);
  if (url.protocol !== 'https:' || url.origin !== origin || !/^https:\/\/[a-z0-9.-]+(?::\d{1,5})?$/.test(origin) ||
      typeof code !== 'string' || !tokenPattern.test(code)) throw new Error('Device install command requires a canonical HTTPS origin and code');
  // Komari's Windows shape: runs when pasted into cmd or PowerShell, so it has
  // no "$" an outer PowerShell would expand. Every argument is quoted, so a
  // code that begins with "-" is never read as a parameter. try/catch keeps a
  // failed download from running an older local copy: -ErrorAction Stop alone
  // does not stop the next statement of a -Command string.
  if (platform === 'windows') {
    return `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "try { iwr '${publicInstallerBase}install.ps1' -UseBasicParsing -OutFile 'nodrelay-install.ps1' -ErrorAction Stop; & '.\\nodrelay-install.ps1' '-e' '${origin}' '-t' '${code}' } catch { throw }"`;
  }
  const shell = platform === 'linux' ? 'bash' : 'zsh';
  return `${shell} <(curl -fsSL ${publicInstallerBase}install.sh) -e ${origin} -t ${code}`;
}

export function bootstrapInstaller(origin, platform, { assets }, { enrollmentIntent = false, deviceId } = {}) {
  if (deviceId !== undefined && (!enrollmentIntent || typeof deviceId !== 'string' || !devicePattern.test(deviceId))) {
    throw new Error('A bound installer needs an enrollment intent and a valid device ID');
  }
  if (platform === 'windows') {
    const asset = assets.x64;
    // Bound to a device by the console: the public entry passes only -Ticket.
    const device = deviceId === undefined ? "[Parameter(Mandatory)][ValidatePattern('^[a-z][a-z0-9-]{0,23}$')][string]$Device"
      : `[ValidatePattern('^[a-z][a-z0-9-]{0,23}$')][string]$Device = ${ps(deviceId)}`;
    return `param(${device}, [Parameter(Mandatory)][ValidatePattern('^[A-Za-z0-9_-]{43}$')][string]$Ticket)
$ErrorActionPreference = 'Stop'
if ($env:PROCESSOR_ARCHITEW6432 -eq 'ARM64' -or ($env:PROCESSOR_ARCHITEW6432 -ne 'AMD64' -and $env:PROCESSOR_ARCHITECTURE -ne 'AMD64')) { throw 'This release supports x64 Windows' }
$d = Join-Path ([IO.Path]::GetTempPath()) ('nodrelay-' + [Guid]::NewGuid())
New-Item -ItemType Directory $d | Out-Null
try {
  $f = Join-Path $d 'fleet.zip'
  $curlPath = if ($env:PROCESSOR_ARCHITEW6432 -eq 'AMD64') { 'Sysnative/curl.exe' } else { 'System32/curl.exe' }
  $curl = Join-Path $env:SystemRoot $curlPath
  if (-not (Test-Path -LiteralPath $curl -PathType Leaf)) { throw 'Windows system curl.exe is required' }
  & $curl ${curlOptions} --output $f --url ${ps(asset.url)}
  if ($LASTEXITCODE -ne 0) { throw 'Installer download failed' }
  if ((Get-FileHash -Algorithm SHA256 -LiteralPath $f).Hash.ToLowerInvariant() -ne ${ps(asset.sha256)}) { throw 'Installer hash mismatch' }
  $bundle = Join-Path $d 'bundle'
  Expand-Archive -LiteralPath $f -DestinationPath $bundle
  $env:DEVSPACE_FLEET_MANAGER = ${ps(origin)}
  $env:DEVSPACE_FLEET_TICKET = $Ticket
  $env:DEVSPACE_FLEET_DEVICE = $Device
${enrollmentIntent ? `  $env:DEVSPACE_FLEET_ENROLLMENT_PROTOCOL = 'intent-v1'
  $env:DEVSPACE_FLEET_ASSET_SHA256 = ${ps(asset.sha256)}
  $env:DEVSPACE_FLEET_PORT_PROTOCOL = 'v1'
` : ''}  ${runWindows}
  ${requireWindowsSuccess}
} finally {
  Remove-Item Env:DEVSPACE_FLEET_TICKET, Env:DEVSPACE_FLEET_MANAGER, Env:DEVSPACE_FLEET_DEVICE -ErrorAction SilentlyContinue${enrollmentIntent ? '\n  Remove-Item Env:DEVSPACE_FLEET_ENROLLMENT_PROTOCOL, Env:DEVSPACE_FLEET_ASSET_SHA256 -ErrorAction SilentlyContinue' : ''}
  ${enrollmentIntent ? 'Remove-Item Env:DEVSPACE_FLEET_PORT_PROTOCOL -ErrorAction SilentlyContinue' : ''}
  ${windowsCleanup}
}
`;
  }
  const architectures = { x64: 'x86_64|amd64', arm64: 'arm64|aarch64' };
  const cases = Object.entries(assets).map(([arch, asset]) =>
    `  ${architectures[arch]}) url=${sh(asset.url)}; expected=${sh(asset.sha256)} ;;`).join('\n');
  const body = `#!/bin/sh
set -eu
[ "$(uname -s)" = ${sh(platform === 'macos' ? 'Darwin' : 'Linux')} ] || { echo ${sh(`Use the ${operatingSystems[platform].label} command on its target OS`)} >&2; exit 1; }
case "$(uname -m)" in
${cases}
  *) echo 'No verified installer is available for this CPU' >&2; exit 1 ;;
esac
export DEVSPACE_FLEET_DEVICE="\${1:-\${DEVSPACE_FLEET_DEVICE:-}}"
export DEVSPACE_FLEET_TICKET="\${2:-\${DEVSPACE_FLEET_TICKET:-}}"
: "\${DEVSPACE_FLEET_DEVICE:?Missing device id}" "\${DEVSPACE_FLEET_TICKET:?Missing device ticket}"
${temporaryDirectory}
curl ${curlOptions} --url "$url" --output "$d/fleet.tgz"
${shellHash}
${requireShellHash('"$expected"')}
${unpackShell}
${enrollmentIntent ? 'export DEVSPACE_FLEET_ENROLLMENT_PROTOCOL=intent-v1 DEVSPACE_FLEET_ASSET_SHA256="$expected" DEVSPACE_FLEET_PORT_PROTOCOL=v1\n' : ''}DEVSPACE_FLEET_MANAGER=${sh(origin)} sh "$d/bundle/install.sh"
`;
  if (!enrollmentIntent) return body;
  // Copied commands run the downloaded text directly. Define everything first
  // and call it on the last line, so a truncated download runs nothing.
  const [shebang, ...rest] = body.trimEnd().split('\n');
  const call = deviceId === undefined ? 'nodrelay_install "$@"' : `nodrelay_install ${sh(deviceId)} "$1"`;
  return `${shebang}\nnodrelay_install() {\n${rest.join('\n')}\n}\n${call}\n`;
}

export function installCommand(origin, platform, asset, ticket, deviceId) {
  if (platform.startsWith('windows-')) {
    const acquire = asset.localFile
      ? [`Copy-Item -LiteralPath (Join-Path (Get-Location) ${ps(asset.localFile)}) -Destination $f`]
      : [
        "$curl=Join-Path $env:SystemRoot 'System32/curl.exe'",
        "if (-not (Test-Path -LiteralPath $curl -PathType Leaf)) { throw 'Windows system curl.exe is required' }",
        `& $curl ${curlOptions} --output $f --url ${ps(asset.url)}`,
        "if ($LASTEXITCODE -ne 0) { throw 'Installer download failed' }",
      ];
    const install = [
      "$f=Join-Path $d 'fleet.zip'",
      ...acquire,
      `if ((Get-FileHash -Algorithm SHA256 -LiteralPath $f).Hash.ToLowerInvariant() -ne ${ps(asset.sha256)}) { throw 'Installer hash mismatch' }`,
      "$bundle=Join-Path $d 'bundle'",
      "Expand-Archive -LiteralPath $f -DestinationPath $bundle",
      `$env:DEVSPACE_FLEET_MANAGER=${ps(origin)}; $env:DEVSPACE_FLEET_TICKET=${ps(ticket)}; $env:DEVSPACE_FLEET_DEVICE=${ps(deviceId)}`,
      runWindows,
      requireWindowsSuccess,
    ];
    return [
      "$ErrorActionPreference='Stop'",
      "$d=Join-Path ([IO.Path]::GetTempPath()) ('devspace-fleet-'+[Guid]::NewGuid())",
      'New-Item -ItemType Directory $d | Out-Null',
      `try { ${install.join('; ')} } finally { Remove-Item Env:DEVSPACE_FLEET_TICKET -ErrorAction SilentlyContinue; Remove-Item Env:DEVSPACE_FLEET_MANAGER -ErrorAction SilentlyContinue; Remove-Item Env:DEVSPACE_FLEET_DEVICE -ErrorAction SilentlyContinue; ${windowsCleanup} }`,
    ].join('; ');
  }
  return [
    "(set -eu; " + temporaryDirectory,
    asset.localFile
      ? `cp ${sh('./' + asset.localFile)} "$d/fleet.tgz"`
      : `curl ${curlOptions} --url ${sh(asset.url)} --output "$d/fleet.tgz"`,
    shellHash,
    requireShellHash(sh(asset.sha256)),
    unpackShell,
    `DEVSPACE_FLEET_MANAGER=${sh(origin)} DEVSPACE_FLEET_TICKET=${sh(ticket)} DEVSPACE_FLEET_DEVICE=${sh(deviceId)} sh "$d/bundle/install.sh")`,
  ].join('; ');
}

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
}

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, win32 } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const systemSid = 'S-1-5-18';
const fullControl = 0x1f01ff;
const unsafeFile = 'The Nodrelay state file must be a private regular file owned by this user and free of reparse points.';
const unsafeDirectory = 'The Nodrelay state directory must be owned by this user, with a private DACL and no reparse points.';

const verifyWindowsParents = `
$ErrorActionPreference = 'Stop'
$path = $env:DEVSPACE_FLEET_PRIVATE_PATH
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$parent = [System.IO.DirectoryInfo]::new([System.IO.Path]::GetDirectoryName($path))
while ($null -ne $parent) {
  if (-not $parent.Exists -or ($parent.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) { throw 'Unsafe state directory parent' }
  $parent = $parent.Parent
}
`;

// Windows PowerShell's .NET Framework applies owner and DACL at creation.
const createWindowsFile = verifyWindowsParents + `
$security = [System.Security.AccessControl.FileSecurity]::new()
$security.SetOwner($sid)
$security.SetAccessRuleProtection($true, $false)
$rights = [System.Security.AccessControl.FileSystemRights]::FullControl
$rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, $rights, [System.Security.AccessControl.AccessControlType]::Allow)
$security.AddAccessRule($rule)
$file = [System.IO.FileStream]::new($path, [System.IO.FileMode]::CreateNew, $rights, [System.IO.FileShare]::None, 4096, [System.IO.FileOptions]::None, $security)
$file.Dispose()
'true'
`;

const inspectWindowsPath = directory => verifyWindowsParents + `
$wantDirectory = ${directory ? '$true' : '$false'}
$entry = $null
try { $entry = Get-Item -LiteralPath $path -Force }
catch [System.Management.Automation.ItemNotFoundException] {}
if ($null -eq $entry -and $wantDirectory) {
  $security = [System.Security.AccessControl.DirectorySecurity]::new()
  $security.SetOwner($sid)
  $security.SetAccessRuleProtection($true, $false)
  $inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, [System.Security.AccessControl.FileSystemRights]::FullControl, $inheritance, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)
  $security.AddAccessRule($rule)
  [void][System.IO.Directory]::CreateDirectory($path, $security)
  $entry = Get-Item -LiteralPath $path -Force
}
if ($null -eq $entry -or $entry.PSIsContainer -ne $wantDirectory -or ($entry.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) { throw 'Unsafe Fleet state object' }
$acl = $entry.GetAccessControl()
$descriptor = [System.Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(), 0)
$entries = @()
if ($null -ne $descriptor.DiscretionaryAcl) {
  $entries = @($descriptor.DiscretionaryAcl | ForEach-Object {
    @{ sid = $_.SecurityIdentifier.Value; type = [int]$_.AceType; flags = [int]$_.AceFlags; mask = [int]$_.AccessMask }
  })
}
@{
  directory = $entry.PSIsContainer
  reparse = [bool]($entry.Attributes -band [System.IO.FileAttributes]::ReparsePoint)
  currentUser = $sid.Value
  owner = $descriptor.Owner.Value
  protected = [bool]($descriptor.ControlFlags -band [System.Security.AccessControl.ControlFlags]::DiscretionaryAclProtected)
  daclPresent = ($null -ne $descriptor.DiscretionaryAcl) -and [bool]($descriptor.ControlFlags -band [System.Security.AccessControl.ControlFlags]::DiscretionaryAclPresent)
  entries = $entries
} | ConvertTo-Json -Compress -Depth 5
`;

export const inspectWindowsDirectory = inspectWindowsPath(true);
export const inspectWindowsFile = inspectWindowsPath(false);

function windowsRules(result, directory, error) {
  const user = result?.currentUser;
  if (result?.directory !== directory || result.reparse !== false ||
      typeof user !== 'string' || !/^S-1-[0-9-]+$/.test(user) || result.owner !== user ||
      result.daclPresent !== true || !Array.isArray(result.entries) ||
      !result.entries.some(rule => rule?.sid === user)) throw new Error(error);
  return { user, rules: result.entries };
}

export function verifyWindowsDirectory(result, { allowSystem = false } = {}) {
  const { user, rules } = windowsRules(result, true, unsafeDirectory);
  if (result.protected !== true || rules.some(rule => !rule ||
      (rule.sid !== user && !(allowSystem && rule.sid === systemSid)) ||
      rule.type !== 0 || rule.flags !== 3 || rule.mask !== fullControl)) throw new Error(unsafeDirectory);
}

export function verifyWindowsFile(result) {
  const { user, rules } = windowsRules(result, false, unsafeFile);
  // A newly created file may inherit the owner's rule. Upstream Personal also
  // uses explicit owner and SYSTEM rules. Neither grants another user access.
  if (rules.some(rule => !rule || (rule.sid !== user && rule.sid !== systemSid) ||
      rule.type !== 0 || (rule.flags !== 0 && rule.flags !== 16) || !Number.isInteger(rule.mask)) ||
      !rules.some(rule => rule.sid === user && (rule.mask & 1))) throw new Error(unsafeFile);
}

async function windowsSecurity(path, script, error, verify) {
  if (!/^[A-Za-z]:[\\/]/.test(path)) throw new Error(error);
  const powershell = win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32',
    'WindowsPowerShell', 'v1.0', 'powershell.exe');
  try {
    const { stdout } = await exec(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: { ...process.env, DEVSPACE_FLEET_PRIVATE_PATH: path },
      windowsHide: true, timeout: 15000, maxBuffer: 16384,
    });
    verify(JSON.parse(stdout));
  } catch {
    throw new Error(error);
  }
}

export async function ensurePrivateDirectory(path, options) {
  if (process.platform === 'win32') {
    return windowsSecurity(path, inspectWindowsDirectory, unsafeDirectory, result => verifyWindowsDirectory(result, options));
  }

  try { await mkdir(path, { mode: 0o700 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const info = await lstat(path);
  if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o077)) {
    throw new Error('The Nodrelay state directory must be private and owned by this user.');
  }
}

function privateFileInfo(info) {
  return info.isFile() && (!process.getuid || (info.uid === process.getuid() && !(info.mode & 0o077)));
}

export async function assertPrivateFile(path) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error(unsafeFile);
  const info = await lstat(path);
  if (!privateFileInfo(info)) throw new Error(unsafeFile);
  if (process.platform === 'win32') await windowsSecurity(path, inspectWindowsFile, unsafeFile, verifyWindowsFile);
  return info;
}

export async function readPrivateFile(path) {
  const inspected = await assertPrivateFile(path);
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!privateFileInfo(info) || info.size > 16384 ||
        info.dev !== inspected.dev || info.ino !== inspected.ino) throw new Error(unsafeFile);
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

export async function writePrivateFile(path, value) {
  if (process.platform !== 'win32') return writeFile(path, value, { mode: 0o600, flag: 'wx' });
  const temporary = path + '.write-' + randomUUID();
  await windowsSecurity(temporary, createWindowsFile, unsafeFile, result => {
    if (result !== true) throw new Error(unsafeFile);
  });
  try {
    const expected = await assertPrivateFile(temporary);
    const handle = await open(temporary, 'r+');
    try {
      const actual = await handle.stat();
      if (!actual.isFile() || actual.dev !== expected.dev || actual.ino !== expected.ino) throw new Error(unsafeFile);
      await handle.writeFile(value);
    } finally {
      await handle.close();
    }
    await link(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

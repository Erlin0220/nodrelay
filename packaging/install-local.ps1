param([switch]$Repair)
$ErrorActionPreference = 'Stop'
$archive = Join-Path $PSScriptRoot '@ARCHIVE@'
$work = Join-Path ([IO.Path]::GetTempPath()) ('nodrelay-' + [Guid]::NewGuid())
New-Item -ItemType Directory -Path $work | Out-Null
try {
  $copy = Join-Path $work 'bundle.zip'
  Copy-Item -LiteralPath $archive -Destination $copy
  if ((Get-FileHash -Algorithm SHA256 -LiteralPath $copy).Hash.ToLowerInvariant() -ne '@SHA256@') {
    throw 'Installer hash mismatch'
  }
  $bundle = Join-Path $work 'bundle'
  Expand-Archive -LiteralPath $copy -DestinationPath $bundle
  $env:DEVSPACE_FLEET_MANAGER = Read-Host 'Management HTTPS origin'
  $env:DEVSPACE_FLEET_DEVICE = Read-Host 'Device ID'
  $options = @()
  if ($Repair) {
    $options += '--repair'
  } else {
    $secureTicket = Read-Host 'One-time device ticket' -AsSecureString
    $ticketPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureTicket)
    try { $env:DEVSPACE_FLEET_TICKET = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ticketPointer) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ticketPointer) }
  }
  & (Join-Path $bundle 'bin/node.exe') (Join-Path $bundle 'fleet/src/install-device.mjs') $bundle @options
  if ($LASTEXITCODE -ne 0) { throw 'Nodrelay installation did not complete' }
} finally {
  Remove-Item Env:DEVSPACE_FLEET_TICKET, Env:DEVSPACE_FLEET_MANAGER, Env:DEVSPACE_FLEET_DEVICE -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $work -Recurse -Force
}

$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'bin\node.exe') (Join-Path $PSScriptRoot 'fleet\src\install-device.mjs') $PSScriptRoot
if ($LASTEXITCODE -ne 0) { throw 'Nodrelay did not start' }

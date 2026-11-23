# Nodrelay device installer entry for Windows.
#
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "try { iwr 'https://raw.githubusercontent.com/Erlin0220/nodrelay/refs/heads/main/install.ps1' -UseBasicParsing -OutFile 'nodrelay-install.ps1' -ErrorAction Stop; & '.\nodrelay-install.ps1' '-e' 'https://CONSOLE' '-t' 'CODE' } catch { throw }"
#
# This script holds no credentials. It sends the install code to the
# management console given with -e, which returns the installer pinned for
# that device. That installer downloads the release, verifies its SHA-256 and
# starts it. Everything runs from the last line, so a truncated download runs
# nothing. Arguments are read from $args, so quoted '-e' and '-t' work, and an
# install code that begins with "-" is still just a value.

function Invoke-NodrelayInstall([object[]]$Arguments) {
  $ErrorActionPreference = 'Stop'
  $endpoint = ''
  $token = ''
  for ($i = 0; $i -lt $Arguments.Count; $i++) {
    $name = [string]$Arguments[$i]
    if ($name -ceq '-e' -or $name -ceq '-t') {
      if ($i + 1 -ge $Arguments.Count) { throw "Missing value for $name" }
      $i++
      if ($name -ceq '-e') { $endpoint = [string]$Arguments[$i] } else { $token = [string]$Arguments[$i] }
    } else { throw "Unknown argument: $name. Usage: install.ps1 -e https://<management console> -t <install code>" }
  }
  if ($endpoint -cnotmatch '^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?/?$') {
    throw 'Use -e with the management console address, for example https://console.example.com'
  }
  if ($token -cnotmatch '^[A-Za-z0-9_-]{43}$') { throw 'Use -t with the install code shown in the management console' }
  $endpoint = $endpoint.TrimEnd('/')
  Write-Host '诺联 Nodrelay · 正在向管理台读取此设备的安装程序…'
  $body = '{"code":"' + $token + '"}'
  $response = $null
  for ($attempt = 1; $attempt -le 4; $attempt++) {
    try {
      $response = Invoke-WebRequest -Uri ($endpoint + '/device/install/windows') -Method Post -Body $body `
        -ContentType 'application/json' -UseBasicParsing -MaximumRedirection 0 -TimeoutSec 60
      break
    } catch {
      $status = $null
      if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
      # Only connection errors and 5xx responses are retried; the request claims nothing.
      if (($status -and $status -lt 500) -or $attempt -eq 4) {
        throw '无法从管理台读取安装程序。请检查 -e 地址和网络；如果提示 404，请回到管理台复制当前的安装命令。'
      }
      Start-Sleep -Seconds 2
    }
  }
  $script = [string]$response.Content
  if ($response.StatusCode -ne 200 -or $script -cnotlike 'param(*') { throw '管理台返回的内容不是诺联安装程序，已停止。' }
  & ([scriptblock]::Create($script)) -Ticket $token
}

Invoke-NodrelayInstall $args

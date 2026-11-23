#!/bin/sh
# Nodrelay device installer entry for macOS and Linux.
#
#   zsh <(curl -fsSL https://raw.githubusercontent.com/Erlin0220/nodrelay/refs/heads/main/install.sh) -e https://CONSOLE -t CODE
#
# This script holds no credentials. It sends the install code to the
# management console given with -e, which returns the installer pinned for
# that device. That installer downloads the release, retries, verifies its
# SHA-256 and starts it. Everything runs from the last line, so a truncated
# download runs nothing.

nodrelay_entry() {
  endpoint=''
  token=''
  while [ "$#" -gt 0 ]; do
    case "$1" in
      -e|-t)
        [ "$#" -ge 2 ] || { printf 'Missing value for %s\n' "$1" >&2; return 2; }
        if [ "$1" = -e ]; then endpoint=$2; else token=$2; fi
        shift 2 ;;
      -h|--help)
        echo 'Usage: install.sh -e https://<management console> -t <install code>'
        return 0 ;;
      *) printf 'Unknown option: %s\n' "$1" >&2; return 2 ;;
    esac
  done
  endpoint=${endpoint%/}
  case "$endpoint" in
    https://*[!A-Za-z0-9.:-]*|https://) echo 'Use -e with the management console address, for example https://console.example.com' >&2; return 2 ;;
    https://?*) ;;
    *) echo 'Use -e with the management console address, for example https://console.example.com' >&2; return 2 ;;
  esac
  case "$token" in
    *[!A-Za-z0-9_-]*|'') echo 'Use -t with the install code shown in the management console' >&2; return 2 ;;
  esac
  [ "${#token}" -eq 43 ] || { echo 'Use -t with the install code shown in the management console' >&2; return 2; }
  case "$(uname -s)" in
    Darwin) os=macos ;;
    Linux) os=linux ;;
    *) echo 'Nodrelay supports macOS and Linux here. On Windows, use the PowerShell command.' >&2; return 1 ;;
  esac
  command -v curl >/dev/null 2>&1 || { echo 'curl is required' >&2; return 1; }
  echo '诺联 Nodrelay · 正在向管理台读取此设备的安装程序…' >&2
  # The code goes in the request body, never the URL. Only connection errors
  # and 5xx responses are retried; the request claims nothing by itself.
  if ! script=$(curl -fsS --proto '=https' --max-redirs 0 --connect-timeout 15 -m 60 --retry 3 --retry-delay 2 \
      -H 'Content-Type: application/json' -H 'Accept: text/plain' \
      --data "{\"code\":\"$token\"}" "$endpoint/device/install/$os"); then
    echo '无法从管理台读取安装程序。请检查 -e 地址和网络；如果提示 404，请回到管理台复制当前的安装命令。' >&2
    return 1
  fi
  case "$script" in
    '#!/bin/sh'*'nodrelay_install '*) ;;
    *) echo '管理台返回的内容不是诺联安装程序，已停止。' >&2; return 1 ;;
  esac
  sh -c "$script" -- "$token"
}

nodrelay_entry "$@"

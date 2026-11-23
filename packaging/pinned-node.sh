# Shared Node download for the Cloudflare management installers.

fleet_node_platform() {
  # Updating these pins requires the verified Node.js release signature and platform checksums.
  node_version=24.22.3
  case "$(uname -s):$(uname -m)" in
    Darwin:arm64) platform=darwin-arm64; node_hash=ff6e17d4874b76d272212b908cc020d6e815fba5a6c7eaaa06add725840307fd ;;
    Darwin:x86_64) platform=darwin-x64; node_hash=977614af0504c81045e7fd85596dbca0e5f951b96681516dadafedcca8c447f7 ;;
    Linux:aarch64|Linux:arm64) platform=linux-arm64; node_hash=261af2af250dfd7e9f25cf151d1b2713a0adf8f10a9ad116c4947f68627affe8 ;;
    Linux:x86_64) platform=linux-x64; node_hash=061ec3e3062115705b56b51fa9cc330ab50d34b6969387d4e4b1a50c6809acc2 ;;
    *) echo 'Node setup supports macOS and Linux on arm64 or x64.' >&2; return 2 ;;
  esac
}

fleet_download() {
  curl --disable --fail --show-error --silent --location --max-redirs 5 --connect-timeout 15 --max-time 300 \
    --proto '=https' --proto-redir '=https' --output "$2" "$1"
}

fleet_prepare_node() {
  node_archive="node-v$node_version-$platform"
  fleet_download "https://nodejs.org/dist/v$node_version/$node_archive.tar.gz" "$1/node.tgz" || return
  if command -v sha256sum >/dev/null 2>&1; then
    node_digest=$(sha256sum "$1/node.tgz")
  else
    node_digest=$(shasum -a 256 "$1/node.tgz")
  fi
  [ "$node_hash" = "${node_digest%% *}" ] || { echo 'Node archive checksum mismatch.' >&2; return 1; }
  tar -xzf "$1/node.tgz" -C "$1" "$node_archive/bin/node" || return
  node="$1/$node_archive/bin/node"
}

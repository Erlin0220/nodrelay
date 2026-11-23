#!/bin/sh
set -eu
if [ "$#" -gt 1 ] || { [ "$#" -eq 1 ] && [ "$1" != --repair ]; }; then
  echo 'Usage: sh install-….sh [--repair]' >&2
  exit 2
fi
here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
archive="$here/@ARCHIVE@"
umask 077
work=$(mktemp -d)
terminal=''
trap 'if [ -n "$terminal" ]; then stty "$terminal" </dev/tty || :; fi; rm -rf -- "$work"' EXIT
trap 'exit 1' HUP INT TERM
cp "$archive" "$work/bundle.tgz"
if command -v sha256sum >/dev/null 2>&1; then
  digest=$(sha256sum "$work/bundle.tgz")
else
  digest=$(shasum -a 256 "$work/bundle.tgz")
fi
[ "${digest%% *}" = '@SHA256@' ] || { echo 'Installer hash mismatch' >&2; exit 1; }
mkdir "$work/bundle"
tar -xzf "$work/bundle.tgz" -C "$work/bundle"

printf 'Management HTTPS origin: ' >&2
IFS= read -r manager
printf 'Device ID: ' >&2
IFS= read -r device
ticket=''
if [ "$#" -eq 0 ]; then
  terminal=$(stty -g </dev/tty)
  printf 'One-time device ticket: ' >&2
  stty -echo </dev/tty
  IFS= read -r ticket </dev/tty
  stty "$terminal" </dev/tty
  terminal=''
  printf '\n' >&2
fi
DEVSPACE_FLEET_MANAGER="$manager" DEVSPACE_FLEET_DEVICE="$device" DEVSPACE_FLEET_TICKET="$ticket" \
  "$work/bundle/bin/node" "$work/bundle/fleet/src/install-device.mjs" "$work/bundle" "$@"

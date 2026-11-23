#!/bin/sh
set -eu

if [ "$(uname -s)" != Darwin ] || [ "$#" -lt 2 ] || [ "$#" -gt 7 ]; then
  echo 'Usage on macOS: sh setup-macos.sh SIGNED_MANIFEST TRUSTED_PUBLISHER_KEY [--plan | --check MANAGEMENT_ORIGIN ACCESS_ISSUER [--portal PORTAL_URL] | [--reconnect | --resume] [--namespace NAME]]' >&2
  exit 2
fi
if [ ! -r "$1" ] || [ ! -r "$1.sig" ] || [ ! -r "$2" ]; then
  echo 'The signed Nodrelay management release or trusted publisher key is missing.' >&2
  exit 2
fi
project=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd -P)
. "$project/packaging/pinned-node.sh"
fleet_node_platform

umask 077
scratch=$(mktemp -d "${TMPDIR:-/tmp}/nodrelay-management.XXXXXXXX")
trap 'rm -rf -- "$scratch"' EXIT
trap 'exit 1' HUP INT TERM
printf '诺联 Nodrelay · 正在准备并校验 Node %s…\n' "$node_version" >&2
fleet_prepare_node "$scratch"
"$node" "$project/src/management-setup.mjs" "$@"

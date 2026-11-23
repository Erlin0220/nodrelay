#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "Usage: sh packaging/check-cloudflare-setup.sh /path/to/setup.private.json" >&2
  exit 2
fi
config=$(CDPATH='' cd -- "$(dirname -- "$1")" && pwd -P)/$(basename -- "$1")
[ -f "$config" ] || { echo 'Nodrelay setup configuration is missing.' >&2; exit 2; }
project=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd -P)
cf_version=1.0.0-rc.1
. "$project/packaging/pinned-node.sh"
fleet_node_platform

umask 077
scratch=$(mktemp -d /tmp/devspace-fleet-cloudflare-check.XXXXXXXX)
trap 'rm -rf -- "$scratch"' EXIT
trap 'exit 1' HUP INT TERM
cd "$scratch"

fleet_prepare_node "$scratch"

fleet_download "https://registry.npmjs.org/cf/-/cf-$cf_version.tgz" cf.tgz
cf_hash='mQ9X/FVE1QP2ebXVF/9tlbqoO0TB3tKxUJocaWsic6IuNvThmJc/Ou/4ABJNB/Sj8HxEzvrjT1PRqjySVO5YoA=='
mkdir home cache config work
clean_node() {
  env -i PATH=/usr/bin:/bin HOME="$scratch/home" XDG_CONFIG_HOME="$scratch/config" \
    XDG_CACHE_HOME="$scratch/cache" CF_SEND_TELEMETRY=false \
    CLOUDFLARE_AUTH_USE_KEYRING=false "$node" "$@"
}
cf_digest=$(clean_node -e "
  const { createHash } = require('node:crypto');
  const { readFileSync } = require('node:fs');
  process.stdout.write(createHash('sha512').update(readFileSync('cf.tgz')).digest('base64'));
")
[ "$cf_hash" = "$cf_digest" ] || { echo 'Cloudflare CLI archive checksum mismatch.' >&2; exit 1; }
tar -xzf cf.tgz
printf 'Verified official downloads for %s: Node %s and cf %s.\n' "$platform" "$node_version" "$cf_version"

cd work
clean_node --input-type=module - "$project/src/setup.mjs" "$config" "$scratch/package/bin/cf" "$cf_version" <<'NODE'
import { execFileSync } from 'node:child_process';

const [setup, config, cf, version] = process.argv.slice(2);
const run = (...args) => execFileSync(process.execPath, args, { encoding: 'utf8' });

if (run(cf, '--version').trim() !== version) throw new Error('Unexpected Cloudflare CLI version');
const plan = JSON.parse(run(setup, config, '--plan'));
// The official CLI uses a different scope identifier for issuing account tokens.
const scopes = plan.scopes.map(scope => scope === 'account-api-tokens.write' ? 'account_api_tokens:create' : scope);
console.log('Official CLI OAuth scopes:', scopes.join(', '));
console.log('Device bundle sources:', JSON.stringify(plan.enrollment));

const preview = JSON.parse(run(cf, 'auth', 'login', '--dry-run', '--no-browser', '--no-device',
  '--no-use-keyring', '--scopes', ...scopes));
if (preview.dryRun !== true || preview.executed !== false) throw new Error('Cloudflare CLI did not return a login preview');
console.log('Cloudflare CLI parsed the login arguments. The granted scopes and server permissions require a live trial.');

if (plan.issueProvisioner) {
  const createToken = JSON.parse(run(cf, 'schema', 'accounts', 'tokens', 'create'));
  if (createToken.httpMethod !== 'POST' || createToken.path !== '/accounts/{account_id}/tokens') {
    throw new Error('The Cloudflare CLI account token command points to an unexpected API');
  }
  console.log('Account token command: cf accounts tokens create -> POST /accounts/{account_id}/tokens');
}
console.log('No browser login, API token creation or Cloudflare deployment was performed.');
NODE

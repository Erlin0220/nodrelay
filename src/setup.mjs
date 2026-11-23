import { createHash, randomBytes } from 'node:crypto';
import { open, readFile, rm, writeFile, rename } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { cloudflareApi, connectorScope, deploymentScopes, runtimePermissions } from '../cloud/cloudflare.mjs';
import { authorize } from './cloudflare-oauth.mjs';
import { openManagementWhenReady } from './management-setup.mjs';
import { registerOAuthClient, registrationSpec, verifyPublicManagementClient } from './oauth-registration.mjs';
import { readPrivateFile, writePrivateFile } from './private-directory.mjs';
import { applySetup, makeSetupSpec, validateProvisionerLifetime, validateReleaseCatalog } from './setup-core.mjs';

async function privateState(path) {
  try {
    return JSON.parse(await readPrivateFile(path));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return {
      installationId: randomBytes(6).toString('hex'),
      ticketKey: randomBytes(32).toString('base64url'),
    };
  }
}

async function saveState(path, value) {
  const tmp = path + '.' + randomBytes(6).toString('hex');
  await writePrivateFile(tmp, JSON.stringify(value));
  await rename(tmp, path);
}

async function chooseZone(api, config, input) {
  const zones = (await api.list('/zones', { status: 'active' }))
    .filter(zone => zone.status === 'active' && (!config.accountId || config.accountId === zone.account?.id));
  if (!zones.length) throw new Error('No active zone was found in the selected Cloudflare account. The production Portal requires an active domain.');
  if (config.zoneId) {
    const zone = zones.find(candidate => candidate.id === config.zoneId);
    if (!zone) throw new Error('The configured zone is not an active, authorized zone');
    return zone;
  }
  if (zones.length === 1) return zones[0];
  const selection = await input.question(zones.map((zone, index) => `${index + 1}. ${zone.name}`).join('\n') + '\nSelect the production domain number: ');
  const zone = /^[1-9]\d*$/.test(selection) && zones[Number(selection) - 1];
  if (!zone) throw new Error('No valid zone selected');
  return zone;
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      plan: { type: 'boolean' }, yes: { type: 'boolean' }, 'rotate-provisioner': { type: 'boolean' },
      'register-oauth': { type: 'boolean' }, 'oauth-token-file': { type: 'string' }, 'runtime-oauth': { type: 'boolean' },
      'management-oauth': { type: 'boolean' }, 'check-public-client': { type: 'string' },
    },
  });
  if (positionals.length !== 1) throw new Error('Usage: npm run setup -- /absolute/path/setup.private.json [--plan]');
  const configFile = resolve(positionals[0]);
  const config = JSON.parse(await readFile(configFile, 'utf8'));
  const requestedScopes = [...deploymentScopes, ...(config.zeroTrustTeam ? ['access-acct.write'] : [])];
  if (values['runtime-oauth'] && !values['register-oauth']) throw new Error('The runtime experiment currently supports the OAuth registration plan and local Worker verification only');
  if (values['management-oauth'] && !values['register-oauth']) {
    throw new Error('Use --management-oauth with --register-oauth.');
  }
  if (values['check-public-client'] && (values['register-oauth'] || values.plan || values.yes || values['rotate-provisioner'])) {
    throw new Error('Use --check-public-client by itself with --oauth-token-file.');
  }
  if (values['register-oauth'] || values['check-public-client']) {
    const spec = registrationSpec(config, requestedScopes, { runtime: values['runtime-oauth'], management: values['management-oauth'] });
    if (values.plan) {
      console.log(JSON.stringify(spec, null, 2));
      return;
    }
    if (!values['oauth-token-file']) throw new Error('Supply an owner-only file holding OAuth Client Read for verification or OAuth Client Read and Write for registration.');
    const token = (await readPrivateFile(resolve(values['oauth-token-file']))).trim();
    if (!/^[A-Za-z0-9_-]{20,256}$/.test(token)) throw new Error('Invalid OAuth client registration token in the private file');
    const receipt = configFile + '.oauth-registration-attempt';
    const api = cloudflareApi(token);
    if (values['check-public-client']) {
      console.log(JSON.stringify(await verifyPublicManagementClient(api, config, values['check-public-client']), null, 2));
      return;
    }
    if (values['runtime-oauth'] || values['management-oauth']) {
      const available = await api.get('/oauth/scopes');
      if (!Array.isArray(available)) throw new Error('Cloudflare returned an invalid OAuth scope catalog');
      const missing = spec.body.scopes.filter(scope => !available.some(candidate => candidate.id === scope));
      if (missing.length) throw new Error(`Cloudflare's registration catalog did not offer: ${missing.join(', ')}`);
    }
    const registered = await registerOAuthClient(api, spec, {
      async beforeCreate() {
        try {
          await writeFile(receipt, JSON.stringify({ accountId: spec.accountId, clientName: spec.body.client_name }), {
            flag: 'wx', mode: 0o600,
          });
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
          throw new Error('A previous OAuth registration might have reached Cloudflare. Check the named client in that account before clearing the attempt receipt.');
        }
      },
    });
    console.log(JSON.stringify(registered, null, 2));
    return;
  }
  if (values['oauth-token-file']) throw new Error('The OAuth client token can only be used with --register-oauth or --check-public-client');
  const provisionerLifetimeDays = validateProvisionerLifetime(config.provisionerLifetimeDays);
  const releaseFile = config.releaseManifest && resolve(dirname(configFile), config.releaseManifest);
  const release = releaseFile ? JSON.parse(await readFile(releaseFile, 'utf8')) : config;
  const releases = validateReleaseCatalog(release.releases);
  const stateFile = configFile + '.state';
  const rotateToken = values['rotate-provisioner'];
  const scopesFor = state => requestedScopes.filter(scope => !state.bound || rotateToken ||
    !['account-api-tokens.write', connectorScope].includes(scope));
  if (values.plan) {
    const state = await privateState(stateFile);
    console.log(JSON.stringify({
      account: config.accountId ?? 'discover during authorization', namespace: config.namespace, zone: config.zoneId ?? 'discover active zones after authorization',
      scopes: scopesFor(state), issueProvisioner: !state.bound || Boolean(rotateToken),
      provisionerLifetimeDays: provisionerLifetimeDays ?? null, runtimePermissions: [...runtimePermissions, 'zone-scoped DNS Write'],
      resources: [
        'Owner-only Access policy and apps for management and the Portal',
        'Exact Access exceptions for enrollment, activation and each hosted installer configured in the release catalog',
        'Portal OAuth and proxied Portal DNS CNAME',
        'D1, management Worker custom domain and account-owned provisioning token',
        'Per-device named Tunnel, DNS, bearer MCP mapping and owner Access on enrollment',
      ],
      enrollment: Object.fromEntries(Object.entries(releases).map(([platform, asset]) =>
        [platform, asset.localFile ? 'pre-staged archive' : 'HTTPS download'])),
    }, null, 2));
    return;
  }

  for (const asset of Object.values(releases)) {
    if (asset.url && /(^|\.)invalid$/.test(new URL(asset.url).hostname)) {
      throw new Error('Replace the release placeholder with a verified HTTPS URL or an explicit local pilot archive');
    }
  }
  const bundle = await readFile(resolve(dirname(releaseFile ?? configFile), release.workerBundle));
  if (!/^[a-f0-9]{64}$/.test(release.workerSha256 ?? '') ||
      createHash('sha256').update(bundle).digest('hex') !== release.workerSha256) throw new Error('The Worker bundle does not match the approved SHA-256');
  const input = createInterface({ input: process.stdin, output: process.stdout });
  const lockPath = stateFile + '.lock';
  let lock;
  try {
    lock = await open(lockPath, 'wx', 0o600);
    await lock.writeFile(String(process.pid));
  } catch (error) {
    input.close();
    await lock?.close().catch(() => {});
    if (lock) await rm(lockPath, { force: true }).catch(() => {});
    if (error.code === 'EEXIST') throw new Error('Another setup is active, or a previous setup left its lock. Review the recorded PID before removing the lock.');
    throw error;
  }
  try {
    const state = await privateState(stateFile);
    const token = await authorize({ clientId: config.oauthClientId, redirectUri: config.oauthRedirect, scopes: scopesFor(state) });
    const api = cloudflareApi(token);
    const zone = await chooseZone(api, config, input);
    const spec = makeSetupSpec(config, zone, state.installationId);
    if (state.spec && JSON.stringify(state.spec) !== JSON.stringify(spec)) throw new Error('Setup state belongs to a different account, zone, namespace or owner');
    console.log(`Account: ${spec.accountId}\nZone: ${spec.zone} (${spec.zoneId})\nManagement: ${spec.origin}\nPortal: https://${spec.portalHostname}\nWorker service token: ${[...runtimePermissions, 'zone-scoped DNS Write'].join(', ')}`);
    console.log(`New service token lifetime: ${provisionerLifetimeDays ? provisionerLifetimeDays + ' day(s)' : 'no fixed expiry'}`);
    if (!values.yes && (await input.question('Create or reconcile the resources and authorize unattended enrollment? Type YES: ')) !== 'YES') {
      throw new Error('Setup was declined; no resources changed');
    }
    state.spec = spec;
    await saveState(stateFile, state);
    const migrations = (await Promise.all(['0001_tickets.sql', '0002_devices.sql', '0003_portal_callback_labels.sql', '0004_enrollment_intents.sql', '0005_upgrade_journal.sql']
      .map(file => readFile(new URL('../cloud/' + file, import.meta.url), 'utf8'))))
      .flatMap(sql => sql.split(';').map(statement => statement.trim()).filter(Boolean));
    const result = await applySetup(api, spec, { state, save: s => saveState(stateFile, s), bundle, migrations, releases,
      rotateToken, zeroTrustTeam: config.zeroTrustTeam, provisionerLifetimeDays });
    console.log(`Management console: ${result.management}\nPortal: ${result.portal}`);
    if (result.provisionerExpiresOn) console.log(`Provisioning token expires: ${result.provisionerExpiresOn}`);
    if (result.retiredProvisioner) console.log('The previous service token is still active. Revoke it after verifying the new deployment.');
    await openManagementWhenReady(result, releases);
  } finally {
    input.close();
    await lock.close();
    await rm(lockPath, { force: true });
  }
}
try { await main(); }
catch (error) {
  console.error(error.name === 'SyntaxError' ? 'Invalid setup JSON or API response' : error.message);
  process.exitCode = 1;
}

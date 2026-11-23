import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { cloudflareApi } from '../cloud/cloudflare.mjs';
import { loopbackCallback } from '../src/cloudflare-oauth.mjs';
import { verifyPublicManagementClient } from '../src/oauth-registration.mjs';
import { approvedEnrollment, normalizeWebUpgrade } from '../src/management-release.mjs';
import { bridgeCatalogDigest } from '../cloud/upgrade-baseline-plan.mjs';
import { readPrivateFile } from '../src/private-directory.mjs';
import { validateReleaseCatalog } from '../src/setup-core.mjs';
import { verifyPublishedArchive } from './release-archive.mjs';

const { positionals, values } = parseArgs({ allowPositionals: true, options: {
  'public-client-config': { type: 'string' }, 'oauth-token-file': { type: 'string' },
  'bridge-from-signed-manifest': { type: 'string' },
  'device-intent-v1': { type: 'boolean' },
  'web-upgrade-version': { type: 'string' }, 'web-upgrade-channel': { type: 'string' }, 'web-upgrade-feed': { type: 'string' },
} });
const [input, oauthClientId, callback, privateKey, target] = positionals;
const publicConfig = values['public-client-config'];
const tokenFile = values['oauth-token-file'];
const upgradeRequested = ['web-upgrade-version', 'web-upgrade-channel', 'web-upgrade-feed'].some(key => values[key] !== undefined);
if (upgradeRequested && !publicConfig) throw new Error('Verified public management registration is required for web upgrades.');
const webUpgrade = upgradeRequested && normalizeWebUpgrade({ version: values['web-upgrade-version'],
  channel: values['web-upgrade-channel'], feed: values['web-upgrade-feed'] });
if (positionals.length !== 5 || !/^[A-Za-z0-9_-]{8,128}$/.test(oauthClientId) || Boolean(publicConfig) !== Boolean(tokenFile)) {
  throw new Error('Usage: node packaging/sign-management-release.mjs RELEASE_JSON OAUTH_CLIENT_ID LOOPBACK_CALLBACK PUBLISHER_PRIVATE_KEY NEW_DIRECTORY [--public-client-config CONFIG --oauth-token-file OAUTH_CLIENT_READ_TOKEN]');
}
const redirectUri = loopbackCallback(callback).href;
let zeroTrustBootstrap = false;
if (publicConfig) {
  const config = JSON.parse(await readFile(resolve(publicConfig), 'utf8'));
  zeroTrustBootstrap = config.zeroTrustBootstrap === true;
  const token = (await readPrivateFile(resolve(tokenFile))).trim();
  if (!/^[A-Za-z0-9_-]{20,256}$/.test(token)) throw new Error('Invalid OAuth Client Read token in the private file.');
  const checked = await verifyPublicManagementClient(cloudflareApi(token), config, oauthClientId);
  if (checked.oauthRedirect !== redirectUri) throw new Error('The signature must name the verified publisher callback.');
}
const enrollmentProtocol = values['device-intent-v1'] ? 'intent-v1' : undefined;
if (enrollmentProtocol && !webUpgrade) throw new Error('Intent enrollment requires a verified management upgrade baseline.');
const release = JSON.parse(await readFile(input));
const releases = validateReleaseCatalog(release.releases);
if (Object.values(releases).some(asset => !asset.url || /(^|\.)invalid$/.test(new URL(asset.url).hostname))) {
  throw new Error('Publish versioned, accessible HTTPS device archives before signing the management release.');
}
if (release.workerBundle !== './worker.js') throw new Error('The unsigned release must contain worker.js next to release.json.');
const worker = await readFile(join(dirname(resolve(input)), 'worker.js'));
const workerSha256 = createHash('sha256').update(worker).digest('hex');
if (workerSha256 !== release.workerSha256) throw new Error('The Worker bundle hash differs from the unsigned manifest.');
if (enrollmentProtocol) approvedEnrollment(enrollmentProtocol, releases);
for (const [platform, asset] of Object.entries(releases)) {
  await verifyPublishedArchive(platform, asset, fetch, { intent: Boolean(enrollmentProtocol) });
}
const publisher = createPrivateKey(await readPrivateFile(resolve(privateKey)));
if (publisher.asymmetricKeyType !== 'ed25519') throw new Error('Use a separately managed Ed25519 publisher key.');
let bridgeCatalogSha256;
const predecessor = values['bridge-from-signed-manifest'];
if (predecessor !== undefined) {
  if (!webUpgrade) throw new Error('A predecessor catalog requires a verified management upgrade baseline.');
  const [previousBytes, previousSignature] = await Promise.all([readFile(predecessor), readFile(predecessor + '.sig')]);
  if (!verify(null, previousBytes, createPublicKey(publisher), previousSignature)) {
    throw new Error('Previous management release was not signed by the existing publisher.');
  }
  const previous = JSON.parse(previousBytes);
  if (previous.schema !== 2 || previous.oauthClientId !== oauthClientId ||
      loopbackCallback(previous.oauthRedirect).href !== redirectUri) {
    throw new Error('Previous management release belongs to a different OAuth installation.');
  }
  bridgeCatalogSha256 = bridgeCatalogDigest(validateReleaseCatalog(previous.releases));
}
// A new-installation kit must attest that its public client was checked for
// the required identity scope. Unverified signing keeps the legacy schema.
const manifest = Buffer.from(JSON.stringify({ schema: publicConfig ? 2 : 1, oauthClientId, oauthRedirect: redirectUri,
  workerBundle: './worker.js', workerSha256, releases, ...(zeroTrustBootstrap && { zeroTrustBootstrap: true }), ...(webUpgrade && { webUpgrade }),
  ...(enrollmentProtocol && { enrollmentProtocol }), ...(bridgeCatalogSha256 && { bridgeCatalogSha256 }) }, null, 2) + '\n');
const signature = sign(null, manifest, publisher);
await mkdir(target, { mode: 0o700 });
await writeFile(join(target, 'worker.js'), worker, { flag: 'wx' });
await writeFile(join(target, 'management-release.json.sig'), signature, { flag: 'wx' });
await writeFile(join(target, 'management-release.json'), manifest, { flag: 'wx' });
console.log(resolve(target, 'management-release.json'));

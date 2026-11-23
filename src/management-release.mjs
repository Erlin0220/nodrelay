import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { loopbackCallback } from './cloudflare-oauth.mjs';
import { validateReleaseCatalog } from './setup-core.mjs';
import { supportedEnrollmentTargets } from '../cloud/device-paths.mjs';
import { mergeEnrollmentBootstrapHistory } from '../cloud/enrollment-bootstrap.mjs';

export function normalizeWebUpgrade(input) {
  if (input === undefined) return;
  const { version, channel, feed } = input ?? {};
  const url = typeof feed === 'string' && URL.parse(feed);
  if (!input || Object.keys(input).length !== 3 || !['stable', 'preview'].includes(channel) ||
      typeof version !== 'string' ||
      !/^(0|[1-9][0-9]{0,8})[.](0|[1-9][0-9]{0,8})[.](0|[1-9][0-9]{0,8})(?:-preview[.](0|[1-9][0-9]{0,8}))?$/.test(version) ||
      (channel === 'preview') !== version.includes('-preview.') ||
      !url || url.href !== feed || url.protocol !== 'https:' || url.port ||
      url.username || url.password || url.search || url.hash || !url.pathname.endsWith('/')) {
    throw new Error('The signed Nodrelay web upgrade baseline is invalid');
  }
  return { version, channel, feed };
}

export function approvedEnrollment(protocol, releases) {
  if (protocol === undefined) return;
  if (protocol !== 'intent-v1' || !supportedEnrollmentTargets.every(platform => Object.hasOwn(releases, platform))) {
    throw new Error('Signed device enrollment requires all currently supported native targets');
  }
  const history = mergeEnrollmentBootstrapHistory({}, releases);
  // Workers limits apply to a single environment variable. Keep headroom.
  if (Buffer.byteLength(JSON.stringify(history)) > 4096 ||
      !['windows', 'macos', 'linux'].every(os => history[os] && Object.keys(history[os]).length === 1)) {
    throw new Error('The signed device enrollment catalog is incomplete or oversized');
  }
  return { protocol, history };
}

export async function managementRelease(manifestFile, publisherKey) {
  const manifest = await readFile(manifestFile);
  const signature = await readFile(manifestFile + '.sig');
  const key = createPublicKey(await readFile(publisherKey));
  if (key.asymmetricKeyType !== 'ed25519' || !verify(null, manifest, key, signature)) {
    throw new Error('Nodrelay installation manifest signature is invalid. Use the original release and trusted publisher key.');
  }
  const data = JSON.parse(manifest);
  if ((data.zeroTrustBootstrap !== undefined && (data.schema !== 2 || data.zeroTrustBootstrap !== true)) || ![1, 2].includes(data.schema) || !/^[A-Za-z0-9_-]{8,128}$/.test(data.oauthClientId ?? '') ||
      data.workerBundle !== './worker.js' || !/^[a-f0-9]{64}$/.test(data.workerSha256 ?? '')) {
    throw new Error('The signed release does not describe a valid Nodrelay management installer.');
  }
  const redirectUri = loopbackCallback(data.oauthRedirect).href;
  if (data.webUpgrade !== undefined && data.schema !== 2) throw new Error('Web upgrades require the verified owner installer');
  const upgrade = normalizeWebUpgrade(data.webUpgrade);
  const webUpgrade = upgrade && { ...upgrade, publicKey: key.export({ format: 'der', type: 'spki' }).toString('base64url') };
  const releases = validateReleaseCatalog(data.releases);
  if (Object.values(releases).some(asset => !asset.url || /(^|\.)invalid$/.test(new URL(asset.url).hostname))) {
    throw new Error('The management installer requires hosted HTTPS device releases.');
  }
  if (data.enrollmentProtocol !== undefined && (data.schema !== 2 || !webUpgrade)) {
    throw new Error('Device enrollment capability requires a verified management upgrade baseline');
  }
  const enrollment = approvedEnrollment(data.enrollmentProtocol, releases);
  const bridgeCatalogSha256 = data.bridgeCatalogSha256;
  if (bridgeCatalogSha256 !== undefined && (data.schema !== 2 || !webUpgrade ||
      typeof bridgeCatalogSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(bridgeCatalogSha256))) {
    throw new Error('The signed previous device catalog digest is invalid');
  }
  const bundle = await readFile(join(dirname(resolve(manifestFile)), 'worker.js'));
  if (createHash('sha256').update(bundle).digest('hex') !== data.workerSha256) {
    throw new Error('The Worker bundle does not match the signed release.');
  }
  return { clientId: data.oauthClientId, redirectUri, releases, bundle, automaticAdministrator: data.schema === 2, zeroTrustBootstrap: data.zeroTrustBootstrap === true, ...(webUpgrade && { webUpgrade }), ...(enrollment && { enrollment }), ...(bridgeCatalogSha256 && { bridgeCatalogSha256 }) };
}

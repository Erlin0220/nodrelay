import { activatePath, enrollPath, installPath, operatingSystems, supportedEnrollmentTargets } from './device-paths.mjs';
import { mergeEnrollmentBootstrapHistory } from './enrollment-bootstrap.mjs';

const protocol = 'intent-v1';
const hash = /^[a-f0-9]{64}$/;
const assetVersion = /^[0-9][A-Za-z0-9._-]{0,39}$/;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const matches = (pattern, value) => typeof value === 'string' && pattern.test(value);
const exact = (value, keys) => record(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const targets = Object.entries(operatingSystems).flatMap(([os, value]) => value.architectures.map(arch => `${os}-${arch}`));
export const enrollmentUpgradeAccessPaths = Object.freeze([enrollPath, activatePath, ...Object.keys(operatingSystems).map(installPath)]);
export const enrollmentUpgradeBindingBudget = 4096;

const protocolName = 'FLEET_ENROLLMENT_PROTOCOL';
const historyName = 'FLEET_ENROLLMENT_HISTORY';
const catalogName = 'FLEET_ENROLLMENT_CATALOG';

function hostedCatalog(input) {
  if (!record(input) || !supportedEnrollmentTargets.every(target => Object.hasOwn(input, target)) ||
      Object.keys(input).some(target => !targets.includes(target))) {
    throw new Error('Signed enrollment needs all currently supported installer targets');
  }
  return Object.freeze(Object.fromEntries(targets.filter(target => Object.hasOwn(input, target)).map(target => {
    const asset = input[target];
    const url = typeof asset?.url === 'string' && URL.parse(asset.url);
    if (!exact(asset, ['url', 'sha256', 'version', 'browser']) || !matches(hash, asset.sha256) ||
        !matches(assetVersion, asset.version) || typeof asset.browser !== 'boolean' || !url ||
        url.href !== asset.url || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
      throw new Error('Invalid signed hosted enrollment installer');
    }
    return [target, Object.freeze({ url: url.href, sha256: asset.sha256, version: asset.version, browser: asset.browser })];
  })));
}

// Signature verification and replay/channel/expiry checks belong to the feed verifier.
// manifestSha256 is the digest of the exact verified manifest bytes, not workerSha256.
export function validateSignedEnrollmentRelease({ release, manifestSha256 }) {
  if (!matches(hash, manifestSha256) || release?.schema !== 2 || release.product !== 'nodrelay-management' ||
      !exact(release.enrollment, ['protocol', 'releases']) || release.enrollment.protocol !== protocol) {
    throw new Error('Verified schema-2 enrollment release and manifest digest are required');
  }
  const releases = hostedCatalog(release.enrollment.releases);
  const history = mergeEnrollmentBootstrapHistory({}, releases);
  return Object.freeze({ manifestSha256, protocol, releases, history });
}

function loadPlain(bindings, name) {
  const fields = bindings.filter(binding => binding?.name === name);
  if (!fields.length) return;
  if (fields.length !== 1 || fields[0].type !== 'plain_text' || typeof fields[0].text !== 'string' || !fields[0].text) {
    throw new Error('Unverified existing enrollment binding');
  }
  return fields[0].text;
}

function parse(text) {
  try { return JSON.parse(text); }
  catch { throw new Error('Unverified existing enrollment binding'); }
}

function assertDistinctAssetPins(history, legacy) {
  const pins = new Map();
  const observe = asset => {
    if (asset?.url === undefined) return;
    const url = typeof asset.url === 'string' && URL.parse(asset.url);
    if (!url || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !matches(hash, asset.sha256)) {
      throw new Error('Unverified hosted asset pin');
    }
    if (pins.has(url.href) && pins.get(url.href) !== asset.sha256) throw new Error('A published installer URL cannot be reassigned to different bytes');
    pins.set(url.href, asset.sha256);
  };
  for (const asset of Object.values(legacy)) observe(asset);
  for (const versions of Object.values(history)) {
    for (const group of Object.values(versions)) for (const asset of Object.values(group.assets)) observe(asset);
  }
}

// Readiness is trusted attestation from exact live readbacks, not request form data.
// Legacy RELEASE_CATALOG is examined only for URL collisions; its bytes are inherited.
export function planEnrollmentUpgrade({ release, manifestSha256, expectedManifestSha256, activeBindings, readiness }) {
  const approved = validateSignedEnrollmentRelease({ release, manifestSha256 });
  if (manifestSha256 !== expectedManifestSha256) throw new Error('Signed enrollment manifest changed after approval');
  if (readiness?.verifiedD1 !== true || !record(readiness.exactAccessRoutes) ||
      enrollmentUpgradeAccessPaths.some(path => !Object.hasOwn(readiness.exactAccessRoutes, path) || readiness.exactAccessRoutes[path] !== true)) {
    throw new Error('Verified enrollment D1 schema and exact Access routes are required');
  }
  if (!Array.isArray(activeBindings)) throw new Error('Missing active binding readback');
  const legacy = parse(loadPlain(activeBindings, 'RELEASE_CATALOG'));
  if (!record(legacy) || !Object.keys(legacy).length) throw new Error('Unverified existing legacy catalog');
  const existingProtocol = loadPlain(activeBindings, protocolName);
  const existingHistory = loadPlain(activeBindings, historyName);
  const existingCatalog = loadPlain(activeBindings, catalogName);
  const anyIntentBinding = existingProtocol !== undefined || existingHistory !== undefined || existingCatalog !== undefined;
  let previous = {};
  if (anyIntentBinding) {
    if (existingProtocol !== protocol || existingHistory === undefined) throw new Error('Incomplete existing enrollment configuration');
    previous = mergeEnrollmentBootstrapHistory(parse(existingHistory), {});
    // Fresh installations from the first signed intent kit have no separate intent catalog.
    const current = hostedCatalog(existingCatalog === undefined ? legacy : parse(existingCatalog));
    if (JSON.stringify(mergeEnrollmentBootstrapHistory(previous, current)) !== JSON.stringify(previous)) {
      throw new Error('Existing enrollment history is missing active installer pins');
    }
  }
  const history = mergeEnrollmentBootstrapHistory(previous, approved.releases);
  assertDistinctAssetPins(history, legacy);
  const changes = Object.freeze({ [protocolName]: protocol,
    [historyName]: JSON.stringify(history), [catalogName]: JSON.stringify(approved.releases) });
  if (Object.values(changes).some(value => new TextEncoder().encode(value).byteLength > enrollmentUpgradeBindingBudget)) {
    throw new Error('Enrollment history exceeds the binding budget; no historical pin may be removed');
  }
  return Object.freeze({ manifestSha256, changes });
}

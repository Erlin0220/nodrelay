import { legacyPreviewFeed, normalizeFeedMigration, publicPreviewFeed } from './upgrade-feed-migration.mjs';
import { validateSignedEnrollmentRelease } from './upgrade-enrollment-release.mjs';

const MAX_MANIFEST = 64 * 1024;
const MAX_WORKER = 8 * 1024 * 1024;
const MAX_VALIDITY = 90 * 86400_000;
const versionPattern = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(?:-preview\.(0|[1-9]\d{0,8}))?$/;
const uuidPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const requiredPlain = ['APP_ORIGIN', 'ACCESS_ISSUER', 'ACCESS_AUD', 'OWNER_EMAIL', 'FLEET_SPEC', 'RELEASE_CATALOG',
  'FLEET_OAUTH_CLIENT_ID', 'FLEET_OAUTH_MODE', 'FLEET_OAUTH_RECOVERY'];
const requiredSecrets = ['TICKET_KEY', 'FLEET_OAUTH_KEY'];
const blockedBindings = ['PROVISIONER_TOKEN', 'FLEET_OAUTH_SEED', 'FLEET_OAUTH_RECONNECT'];
const permittedChanges = new Set(['NODRELAY_RELEASE_VERSION', 'NODRELAY_UPGRADE_FEED',
  'FLEET_ENROLLMENT_PROTOCOL', 'FLEET_ENROLLMENT_HISTORY', 'FLEET_ENROLLMENT_CATALOG']);

function version(value) {
  const parts = typeof value === 'string' && versionPattern.exec(value);
  if (!parts) throw new Error('Invalid Nodrelay upgrade version');
  return [Number(parts[1]), Number(parts[2]), Number(parts[3]), parts[4] === undefined ? Infinity : Number(parts[4])];
}

function compare(left, right) {
  const position = left.findIndex((part, index) => part !== right[index]);
  return position < 0 ? 0 : (left[position] > right[position] ? 1 : -1);
}

function timestamp(value) {
  if (typeof value !== 'string') return NaN;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value ? time : NaN;
}

async function sha256(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function verifyUpgradeRelease({ manifest, signature, bundle, publicKey, channel, currentVersion, now = Date.now(), allowCurrent = false, format = 1 }) {
  if (format !== 1 && format !== 2) throw new Error('Invalid Nodrelay upgrade format');
  if (!(manifest instanceof Uint8Array) || manifest.length === 0 || manifest.length > MAX_MANIFEST ||
      !(signature instanceof Uint8Array) || signature.length !== 64 ||
      !(bundle instanceof Uint8Array) || bundle.length === 0 || bundle.length > MAX_WORKER) {
    throw new Error('Invalid Nodrelay upgrade artifact size or type');
  }
  if (!(publicKey instanceof CryptoKey) || publicKey.type !== 'public' || publicKey.algorithm.name !== 'Ed25519' ||
      !publicKey.usages.includes('verify')) throw new Error('The pinned Nodrelay upgrade verification key is unavailable');
  if (!['stable', 'preview'].includes(channel) || !Number.isFinite(now)) throw new Error('Invalid upgrade channel or clock');

  // Own the exact bytes across awaits; a caller cannot mutate data after either check.
  const verifiedManifest = new Uint8Array(manifest);
  const verifiedBundle = new Uint8Array(bundle);
  if (!await crypto.subtle.verify('Ed25519', publicKey, new Uint8Array(signature), verifiedManifest)) {
    throw new Error('Invalid Nodrelay upgrade signature');
  }
  let release;
  try { release = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(verifiedManifest)); }
  catch { throw new Error('Invalid Nodrelay upgrade metadata'); }
  const fields = ['schema', 'product', 'channel', 'version', 'minimumVersion', 'issuedAt', 'expiresAt', 'workerBundle', 'workerSha256'];
  if (format === 2) {
    fields.push('enrollment');
    if (Object.hasOwn(release ?? {}, 'feedMigration')) fields.push('feedMigration');
  }
  if (!release || !fields.every(name => Object.hasOwn(release, name)) || Object.keys(release).length !== fields.length ||
      release.schema !== format || release.product !== 'nodrelay-management' || release.workerBundle !== 'worker.js' ||
      typeof release.workerSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(release.workerSha256)) {
    throw new Error('Invalid Nodrelay upgrade metadata');
  }
  const next = version(release.version), current = version(currentVersion), minimum = version(release.minimumVersion);
  if (release.channel !== channel || (next[3] === Infinity) !== (channel === 'stable') ||
      (channel === 'stable' && current[3] !== Infinity)) throw new Error('Nodrelay upgrade channel does not match');
  const advance = compare(next, current);
  if (advance < 0 || (advance === 0 && !allowCurrent)) throw new Error('Nodrelay upgrade is not newer than the active version');
  if (compare(current, minimum) < 0) throw new Error('The current Nodrelay version cannot upgrade to this release');
  const start = timestamp(release.issuedAt), end = timestamp(release.expiresAt);
  if (!(start <= now && now < end && end - start <= MAX_VALIDITY)) throw new Error('Nodrelay upgrade metadata is not current');
  const actual = await sha256(verifiedBundle);
  if (actual !== release.workerSha256) throw new Error('Nodrelay upgrade Worker SHA-256 mismatch');
  if (format === 2) {
    const manifestSha256 = await sha256(verifiedManifest);
    if (Object.hasOwn(release, 'feedMigration')) release.feedMigration = normalizeFeedMigration(release.feedMigration, channel);
    const enrollment = validateSignedEnrollmentRelease({ release, manifestSha256 });
    release.enrollment = Object.freeze({ protocol: enrollment.protocol, releases: enrollment.releases });
    return { release: Object.freeze(release), bundle: verifiedBundle, manifestSha256 };
  }
  return { release: Object.freeze(release), bundle: verifiedBundle };
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}

function bindingMap(input) {
  if (!Array.isArray(input)) throw new Error('Missing Cloudflare Worker binding metadata');
  const result = new Map();
  for (const binding of input) {
    if (!binding || typeof binding.name !== 'string' || typeof binding.type !== 'string' || result.has(binding.name) ||
        blockedBindings.includes(binding.name) ||
        (binding.type === 'secret_text' && Object.keys(binding).some(name => !['name', 'type'].includes(name)))) {
      throw new Error('Unexpected or unsettled Cloudflare Worker binding metadata');
    }
    result.set(binding.name, binding);
  }
  for (const name of requiredPlain) {
    const binding = result.get(name);
    if (binding?.type !== 'plain_text' || typeof binding.text !== 'string' || !binding.text) {
      throw new Error('Missing required Nodrelay Worker binding');
    }
  }
  for (const name of requiredSecrets) {
    if (result.get(name)?.type !== 'secret_text') throw new Error('Missing required Nodrelay Worker secret binding');
  }
  const db = result.get('TICKETS'), broker = result.get('PROVISIONER_OAUTH');
  if (db?.type !== 'd1' || typeof db.id !== 'string' || !uuidPattern.test(db.id) ||
      broker?.type !== 'durable_object_namespace' || broker.class_name !== 'OAuthProvisioner' ||
      typeof broker.namespace_id !== 'string' || !/^[a-f0-9]{32}$/.test(broker.namespace_id) ||
      result.get('FLEET_OAUTH_MODE').text !== 'managed' || result.get('FLEET_OAUTH_RECOVERY').text !== '1') {
    throw new Error('The existing deployment is not a verified managed OAuth Worker');
  }
  return result;
}

// deployments is the CURRENT deployment's versions list, not the history.
// plannedChanges is trusted caller input derived from already-verified release metadata.
export function validateUpgradePreconditions({ deployments, latestVersion, activeBindings, candidateBindings, plannedChanges = {} }) {
  const current = Array.isArray(deployments) && deployments.length === 1 ? deployments[0] : undefined;
  if (typeof latestVersion !== 'string' || !uuidPattern.test(latestVersion) ||
      current?.version_id !== latestVersion || current.percentage !== 100) {
    throw new Error('Cloudflare does not have exactly one 100% active version matching its latest upload');
  }
  validateUpgradeBindings(activeBindings, candidateBindings, plannedChanges);
  return { activeVersion: latestVersion };
}

export function validateUpgradeBindings(activeBindings, candidateBindings, plannedChanges = {}) {
  const active = bindingMap(activeBindings);
  const candidate = bindingMap(candidateBindings);
  const expected = new Map(active);
  for (const [name, text] of Object.entries(plannedChanges)) {
    if (!permittedChanges.has(name) || typeof text !== 'string' || !text ||
        (active.has(name) && active.get(name).type !== 'plain_text')) throw new Error('Unapproved Nodrelay binding change');
    if (name === 'NODRELAY_UPGRADE_FEED' && (active.get(name)?.text !== legacyPreviewFeed ||
        active.get('NODRELAY_UPGRADE_CHANNEL')?.text !== 'preview' || text !== publicPreviewFeed)) {
      throw new Error('Unapproved Nodrelay feed migration');
    }
    expected.set(name, { ...active.get(name), name, type: 'plain_text', text });
  }
  if (candidate.size !== expected.size || [...expected].some(([name, binding]) =>
    JSON.stringify(canonical(binding)) !== JSON.stringify(canonical(candidate.get(name))))) {
    throw new Error('Cloudflare Worker bindings do not match the approved upgrade plan');
  }
}

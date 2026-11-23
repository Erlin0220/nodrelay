import { createHash } from 'node:crypto';
import { validateUpgradePreconditions } from './upgrade-plan.mjs';

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const id = /^[a-f0-9]{32}$/;
const worker = /^fleet-[a-z][a-z0-9-]{2,15}-[a-f0-9]{12}$/;
const idp = /^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/;
const version = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(?:-preview\.(0|[1-9]\d{0,8}))?$/;
const etag = /^[A-Za-z0-9_-]{16,128}$/;
const name = /^[A-Za-z_][A-Za-z0-9_]{0,126}$/;
const keywords = Object.freeze({
  NODRELAY_RELEASE_VERSION: 'version',
  NODRELAY_UPGRADE_CHANNEL: 'channel',
  NODRELAY_UPGRADE_PUBLIC_KEY: 'publicKey',
  NODRELAY_UPGRADE_FEED: 'feed',
});
const matches = (pattern, value) => typeof value === 'string' && pattern.test(value);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}
export function bridgeCatalogDigest(catalog) {
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog) || !Object.keys(catalog).length) {
    throw new Error('The existing device catalog cannot be authenticated');
  }
  return createHash('sha256').update(JSON.stringify(canonical(catalog))).digest('hex');
}
const same = (left, right) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
const object = value => value && typeof value === 'object' && !Array.isArray(value);

function readJson(text) {
  try { return JSON.parse(text); } catch { return undefined; }
}

function validPublicKey(key) {
  if (!matches(/^[A-Za-z0-9_-]{59}$/, key)) return false;
  const base64 = key.replaceAll('-', '+').replaceAll('_', '/') + '=';
  const bytes = atob(base64);
  // Ed25519's 12-byte SubjectPublicKeyInfo DER prefix followed by 32 bytes.
  return bytes.length === 44 && btoa(bytes) === base64 && bytes.startsWith('\x30\x2a\x30\x05\x06\x03\x2b\x65\x70\x03\x21\x00');
}

function newBaselineBindings(release) {
  const signed = release?.webUpgrade;
  const feed = typeof signed?.feed === 'string' && URL.parse(signed.feed);
  if (release?.automaticAdministrator !== true || !matches(/^[A-Za-z0-9_-]{8,128}$/, release.clientId) ||
      !object(release.releases) || !Object.keys(release.releases).length || !object(signed) ||
      Object.keys(signed).length !== 4 || !matches(version, signed.version) || !['stable', 'preview'].includes(signed.channel) ||
      (signed.channel === 'preview') !== signed.version.includes('-preview.') || !validPublicKey(signed.publicKey) ||
      !feed || feed.href !== signed.feed || feed.protocol !== 'https:' || feed.port || feed.username || feed.password ||
      feed.search || feed.hash || !feed.pathname.endsWith('/')) {
    throw new Error('The signed owner-managed Nodrelay baseline is invalid');
  }
  return Object.entries(keywords).map(([name, field]) => Object.freeze({ name, type: 'plain_text', text: signed[field] }));
}

function runtimeSnapshot(runtime) {
  const { compatibilityDate, compatibilityFlags, migrationTag, usageModel } = runtime ?? {};
  if (!matches(/^\d{4}-\d{2}-\d{2}$/, compatibilityDate) || !Array.isArray(compatibilityFlags) ||
      compatibilityFlags.some(flag => !matches(/^[a-z0-9_]{1,100}$/, flag)) || new Set(compatibilityFlags).size !== compatibilityFlags.length ||
      migrationTag !== 'nodrelay-oauth-v1' || !['bundled', 'unbound', 'standard'].includes(usageModel)) {
    throw new Error('The existing runtime or Durable Object migration metadata is not verified');
  }
  return Object.freeze({ compatibilityDate, compatibilityFlags: Object.freeze([...compatibilityFlags].sort()), migrationTag, usageModel });
}

function verifiedTarget(expected) {
  const site = typeof expected?.origin === 'string' && URL.parse(expected.origin);
  if (!matches(id, expected?.accountId) || !matches(id, expected.zoneId) || !matches(worker, expected.worker) ||
      !matches(uuid, expected.activeVersion) || !matches(uuid, expected.databaseId) || !matches(id, expected.namespaceId) ||
      !site || site.origin !== expected.origin || site.protocol !== 'https:' || site.port ||
      /\.(?:workers|pages)\.dev$/.test(site.hostname) ||
      !matches(/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/u, expected.ownerEmail) ||
      !matches(/^[a-zA-Z0-9._:-]{3,200}$/, expected.accessAudience)) {
    throw new Error('The verified target for baseline adoption is invalid');
  }
}

// Pure code-only upgrade plan. `release` must come from an already-verified
// managementRelease() and `active` is a normalized Cloudflare version GET.
// Neither the trust configuration nor the expected deployment can be UI input.
export function planUpgradeBaseline({ release, expected, deployment, active }) {
  const additions = newBaselineBindings(release);
  verifiedTarget(expected);
  if (active?.id !== expected.activeVersion || deployment?.latestVersion !== expected.activeVersion || !matches(etag, active.etag)) {
    throw new Error('Existing Worker version does not match the authorized baseline target');
  }
  const bindings = active.bindings;
  validateUpgradePreconditions({ ...deployment, activeBindings: bindings, candidateBindings: bindings });
  if (bindings.some(binding => !matches(name, binding.name) ||
      !['plain_text', 'secret_text', 'd1', 'durable_object_namespace'].includes(binding.type) ||
      binding.type === 'd1' && binding.name !== 'TICKETS' ||
      binding.type === 'durable_object_namespace' && binding.name !== 'PROVISIONER_OAUTH')) {
    throw new Error('Existing Worker includes an unsupported binding');
  }
  const byName = new Map(bindings.map(binding => [binding.name, binding]));
  if (Object.keys(keywords).some(key => byName.has(key))) throw new Error('This Worker already has complete or partial web-upgrade bindings');
  const plain = key => byName.get(key)?.text;
  const spec = readJson(plain('FLEET_SPEC'));
  if (plain('APP_ORIGIN') !== expected.origin || plain('OWNER_EMAIL') !== expected.ownerEmail ||
      plain('ACCESS_AUD') !== expected.accessAudience || !matches(idp, plain('ACCESS_ISSUER')) ||
      plain('FLEET_OAUTH_CLIENT_ID') !== release.clientId || spec?.accountScopedAccess !== true || spec.zoneScopedAccess ||
      spec.accountId !== expected.accountId || spec.zoneId !== expected.zoneId || spec.worker !== expected.worker ||
      spec.label !== expected.worker || spec.origin !== expected.origin || spec.ownerEmail !== expected.ownerEmail ||
      byName.get('TICKETS')?.id !== expected.databaseId || byName.get('PROVISIONER_OAUTH')?.namespace_id !== expected.namespaceId) {
    throw new Error('Existing Worker identity or persistent bindings do not match the authorized target');
  }
  const oldCatalog = readJson(plain('RELEASE_CATALOG'));
  if (!same(oldCatalog, release.releases) &&
      (!matches(/^[a-f0-9]{64}$/, release.bridgeCatalogSha256) || bridgeCatalogDigest(oldCatalog) !== release.bridgeCatalogSha256)) {
    throw new Error('Neither the signed baseline legacy catalog digest nor the current catalog matches the live catalog');
  }
  const { compatibilityDate, compatibilityFlags, usageModel, ...rest } = runtimeSnapshot(active.runtime);
  const expectedBindings = Object.freeze([...bindings.map(binding => Object.freeze(structuredClone(binding))), ...additions]);
  return Object.freeze({ activeVersion: active.id, activeEtag: active.etag, expectedBindings,
    expectedRuntime: Object.freeze({ compatibilityDate, compatibilityFlags, usageModel, ...rest }),
    upload: Object.freeze({ bindingsInherit: 'strict', compatibilityDate, compatibilityFlags, usageModel,
      bindings: Object.freeze([...bindings.map(({ name }) => Object.freeze({ name, type: 'inherit' })), ...additions]) }),
  });
}

export function validateUpgradeBaselineCandidate(plan, { staged, candidate }) {
  if (!matches(uuid, staged?.id) || staged.id === plan.activeVersion || !matches(etag, staged.etag) ||
      candidate?.id !== staged.id || candidate.etag !== staged.etag) throw new Error('The prepared baseline version did not match Cloudflare readback');
  const sort = list => [...list].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  if (!Array.isArray(candidate.bindings) || !same(sort(plan.expectedBindings), sort(candidate.bindings)) ||
      !same(plan.expectedRuntime, runtimeSnapshot(candidate.runtime))) {
    throw new Error('Baseline readback changed a binding or runtime setting outside the signed plan');
  }
  return { versionId: staged.id };
}

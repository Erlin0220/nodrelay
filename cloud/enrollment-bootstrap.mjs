import { hostedInstallers, installPath, operatingSystems } from './device-paths.mjs';

const versionPattern = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,95}$/;
const hashPattern = /^[a-f0-9]{64}$/;
const matches = (pattern, value) => typeof value === 'string' && pattern.test(value);
const validOS = os => typeof os === 'string' && Object.hasOwn(operatingSystems, os);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const encoder = new TextEncoder();

export const enrollmentBootstrapPath = installPath;

function canonicalOrigin(input) {
  const url = typeof input === 'string' && URL.parse(input);
  if (!url || url.origin !== input || url.protocol !== 'https:') throw new Error('Expected canonical HTTPS management origin');
  return url.origin;
}

function trustedGroup(os, group) {
  if (!validOS(os) || !record(group) || !matches(versionPattern, group.version) ||
      (group.browser !== undefined && typeof group.browser !== 'boolean') || !record(group.assets) ||
      Object.keys(group.assets).length === 0) throw new Error('Invalid approved installer group');
  const { version } = group;
  const browser = group.browser === true;
  const assets = Object.create(null);
  for (const arch of Object.keys(group.assets).sort()) {
    const entry = group.assets[arch];
    const url = typeof entry?.url === 'string' && URL.parse(entry.url);
    if (!operatingSystems[os].architectures.includes(arch) || !matches(hashPattern, entry?.sha256) ||
        !url || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
        (entry.version !== undefined && entry.version !== version) || (entry.browser !== undefined && entry.browser !== browser)) {
      throw new Error('Invalid approved installer asset');
    }
    assets[arch] = Object.freeze({ sha256: entry.sha256, url: url.href });
  }
  return Object.freeze({ version, browser, assets: Object.freeze(assets) });
}

const canonical = (os, group) => JSON.stringify(['enrollment-bootstrap-v1', os, trustedGroup(os, group)]);

export async function enrollmentBootstrapManifestId(os, group) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(canonical(os, group))));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

// Call with verified deployment history and release catalogs only. Persist the returned union
// before removing an old release from current catalog. The history is not an intent lookup.
export function mergeEnrollmentBootstrapHistory(previousHistory, releases) {
  if (!record(previousHistory) || !record(releases)) throw new Error('Invalid approved release history');
  const history = Object.create(null);
  for (const [os, versions] of Object.entries(previousHistory)) {
    if (!validOS(os) || !record(versions)) throw new Error('Invalid approved release history');
    history[os] = Object.create(null);
    for (const [version, group] of Object.entries(versions)) {
      const accepted = trustedGroup(os, group);
      if (accepted.version !== version) throw new Error('Invalid approved installer version key');
      history[os][version] = accepted;
    }
  }
  for (const [os, group] of Object.entries(hostedInstallers(releases))) {
    const next = trustedGroup(os, group);
    history[os] ??= Object.create(null);
    const existing = history[os][next.version];
    if (existing && canonical(os, existing) !== canonical(os, next)) throw new Error('Approved installer identity cannot be reassigned');
    history[os][next.version] ??= next;
  }
  for (const versions of Object.values(history)) Object.freeze(versions);
  return Object.freeze(history);
}

// This public URL is not an enrollment command. It intentionally takes no credential.
export async function enrollmentBootstrapUrl(origin, release) {
  origin = canonicalOrigin(origin);
  const os = release?.platform;
  const group = trustedGroup(os, release);
  const pinned = new URL(enrollmentBootstrapPath(os), origin);
  pinned.searchParams.set('version', group.version);
  pinned.searchParams.set('manifest', await enrollmentBootstrapManifestId(os, group));
  return pinned.href;
}

function response(status, body) {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}

// lookupApproved receives exact validated OS and version, never a credential or user-supplied URL.
// Inject a deployment-approved lookup; do not fall back to mutable current release by name.
export async function resolveEnrollmentBootstrap(request, { origin, lookupApproved, render }) {
  const url = new URL(request.url);
  const match = /^\/device\/install\/([^/]+)$/.exec(url.pathname);
  // `v` is the short public entry. Approved history never reassigns a version,
  // so the version alone selects the same installer the manifest form pins.
  const short = url.searchParams.has('v');
  if (!match || !(short || url.searchParams.has('manifest'))) return;
  const os = match[1];
  const version = url.searchParams.get(short ? 'v' : 'version');
  const manifest = short ? undefined : url.searchParams.get('manifest');
  const unavailable = () => response(404, 'Installer version unavailable.');
  if (request.method !== 'GET' || url.origin !== canonicalOrigin(origin) || !validOS(os) || typeof render !== 'function' ||
      [...url.searchParams].length !== (short ? 1 : 2) || !matches(versionPattern, version) ||
      (!short && !matches(hashPattern, manifest))) return unavailable();
  try {
    const selected = await lookupApproved(os, version);
    if (!selected) return unavailable();
    const group = trustedGroup(os, selected);
    if (group.version !== version || (!short && await enrollmentBootstrapManifestId(os, group) !== manifest)) return unavailable();
    // Intentionally no legacy renderer fallback. Caller must supply an intent-capable renderer.
    const body = await render(origin, os, group);
    return typeof body === 'string' && body.length ? response(200, body) : unavailable();
  } catch {
    return unavailable();
  }
}

import { base64url } from 'jose';
import { operatingSystems } from './device-paths.mjs';
import { devicePattern, protect, tokenPattern, unprotect } from './tickets.mjs';

const now = () => Math.floor(Date.now() / 1000);
export const claimRecoveryWindowSeconds = 15 * 60;
const hashPattern = /^[a-f0-9]{64}$/;
const versionPattern = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,95}$/;
const uuidPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const matches = (pattern, value) => typeof value === 'string' && pattern.test(value);
const encoder = new TextEncoder();
const digest = async code => base64url.encode(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(code))));
const label = (id, deviceId, codeDigest, snapshot) => JSON.stringify(['enrollment-intent-v1', id, deviceId, codeDigest, snapshot]);

function platformParts(platform) {
  if (typeof platform !== 'string') return [];
  const parts = platform.split('-');
  const [os, architecture] = parts;
  if (parts.length > 2 || !Object.hasOwn(operatingSystems, os) ||
      (architecture !== undefined && !operatingSystems[os].architectures.includes(architecture))) return [];
  return parts;
}

function snapshotRelease(platform, release) {
  const [os, fixed] = platformParts(platform);
  if (!os || !record(release) || !matches(versionPattern, release.version) ||
      (release.browser !== undefined && typeof release.browser !== 'boolean')) throw new Error('Invalid pinned release');
  const { version } = release;
  const browser = release.browser === true;
  const source = fixed ? { [fixed]: release } : release.assets;
  if (!record(source) || !Object.keys(source).length) throw new Error('Missing pinned installer assets');
  const assets = {};
  for (const architecture of Object.keys(source).sort()) {
    const asset = source[architecture];
    if (!operatingSystems[os].architectures.includes(architecture) || !record(asset) ||
        !matches(hashPattern, asset.sha256) || (asset.version !== undefined && asset.version !== version) ||
        (asset.browser !== undefined && asset.browser !== browser)) throw new Error('Invalid pinned installer asset');
    const { sha256, url, localFile } = asset;
    if ((url === undefined) === (localFile === undefined)) throw new Error('Invalid pinned installer location');
    if (url !== undefined) {
      const parsed = typeof url === 'string' && URL.parse(url);
      if (!parsed || parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
        throw new Error('Invalid pinned installer URL');
      }
      assets[architecture] = { sha256, url: parsed.href };
    } else {
      if (!fixed || !matches(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/, localFile)) throw new Error('Invalid local installer');
      assets[architecture] = { sha256, localFile };
    }
  }
  return { platform, version, browser, assets };
}

function publicIntent(row) {
  if (!row) return;
  const parsed = JSON.parse(row.snapshot);
  if (!matches(devicePattern, row.device_id)) throw new Error('Invalid stored enrollment intent');
  const base = { id: row.id, deviceId: row.device_id, state: row.state, createdAt: row.created_at, resolvedAt: row.resolved_at ?? null };
  if (record(parsed?.platforms)) {
    // One unclaimed command may serve every hosted system. The first claim
    // narrows the stored snapshot to the system that actually installed.
    const releases = snapshotChoices(parsed.platforms);
    if (JSON.stringify({ platforms: releases }) !== row.snapshot) throw new Error('Invalid stored enrollment intent');
    return { ...base, releases };
  }
  const [, fixed] = platformParts(parsed.platform);
  const release = snapshotRelease(parsed.platform, fixed
    ? { ...parsed.assets?.[fixed], version: parsed.version, browser: parsed.browser } : parsed);
  if (JSON.stringify(release) !== row.snapshot) throw new Error('Invalid stored enrollment intent');
  return { ...base, release, releases: { [platformParts(release.platform)[0]]: release } };
}

function snapshotChoices(groups) {
  const systems = Object.keys(groups).sort();
  if (!systems.length || systems.some(os => !Object.hasOwn(operatingSystems, os))) throw new Error('Invalid pinned release');
  return Object.fromEntries(systems.map(os => {
    const release = snapshotRelease(os, groups[os]);
    if (Object.values(release.assets).some(asset => asset.url === undefined)) throw new Error('A multi-system command requires hosted installers');
    return [os, release];
  }));
}

// Call only from the authorized administration path. Never create remote resources here.
export async function issueEnrollmentIntent(db, secret, { deviceId, platform, release, releases, confirmBrowser = false }) {
  if (!matches(devicePattern, deviceId)) throw new Error('Invalid device ID');
  let snapshot;
  if (releases !== undefined) {
    if (platform !== undefined || release !== undefined) throw new Error('Choose one pinned release form');
    const choices = snapshotChoices(releases);
    if (confirmBrowser !== Object.values(choices).some(choice => choice.browser)) throw new Error('Browser confirmation does not match pinned release');
    snapshot = JSON.stringify({ platforms: choices });
  } else {
    const pinned = snapshotRelease(platform, release);
    if (confirmBrowser !== pinned.browser) throw new Error('Browser confirmation does not match pinned release');
    snapshot = JSON.stringify(pinned);
  }
  const id = crypto.randomUUID();
  const code = base64url.encode(crypto.getRandomValues(new Uint8Array(32)));
  const codeDigest = await digest(code);
  const encrypted = await protect(secret, label(id, deviceId, codeDigest, snapshot), code);
  const row = await db.prepare(`INSERT INTO enrollment_intents
    (id, device_id, code_digest, code_ciphertext, snapshot, state, created_at)
    VALUES (?, ?, ?, ?, ?, 'pending', ?) ON CONFLICT DO NOTHING
    RETURNING id, device_id, snapshot, state, created_at, resolved_at`)
    .bind(id, deviceId, codeDigest, encrypted, snapshot, now()).first();
  return publicIntent(row);
}

export async function getEnrollmentIntent(db, id) {
  if (!matches(uuidPattern, id)) return;
  return publicIntent(await db.prepare(`SELECT id, device_id, snapshot, state, created_at, resolved_at
    FROM enrollment_intents WHERE id = ?`).bind(id).first());
}

// For the public install entry: whoever holds the install code may read which
// device and approved installers it is bound to. Nothing is claimed here, the
// code itself is never returned, and a claimed code stops resolving once its
// same-device recovery window ends.
export async function findEnrollmentIntentByCode(db, code) {
  if (!matches(tokenPattern, code)) return;
  const at = now();
  return publicIntent(await db.prepare(`SELECT id, device_id, snapshot, state, created_at, resolved_at
    FROM enrollment_intents WHERE code_digest = ? AND (state = 'pending' OR (state = 'claimed' AND resolved_at > ?))`)
    .bind(await digest(code), at - claimRecoveryWindowSeconds).first());
}

export async function readBoundEnrollmentState(db, deviceId, id) {
  if (!matches(uuidPattern, id) || !matches(devicePattern, deviceId)) return;
  const row = await db.prepare('SELECT state FROM enrollment_intents WHERE id = ? AND device_id = ?')
    .bind(id, deviceId).first();
  return row?.state;
}

// Keep reveal routes admin-only and no-store. A concurrent revoke invalidates any displayed code.
export async function revealEnrollmentIntent(db, secret, id) {
  if (!matches(uuidPattern, id)) return;
  const row = await db.prepare(`SELECT * FROM enrollment_intents
    WHERE id = ? AND state = 'pending'`).bind(id).first();
  if (!row) return;
  const intent = publicIntent(row);
  const code = await unprotect(secret, label(row.id, row.device_id, row.code_digest, row.snapshot), row.code_ciphertext);
  if (!matches(tokenPattern, code) || await digest(code) !== row.code_digest) throw new Error('Invalid stored enrollment code');
  return { ...intent, code };
}

export async function claimEnrollmentIntent(db, { code, recoveryProof, deviceId, platform, architecture, version, sha256, browser } = {}) {
  const [, fixed] = platformParts(platform);
  if (!matches(tokenPattern, code) || !matches(tokenPattern, recoveryProof) || recoveryProof === code || !matches(devicePattern, deviceId) ||
      typeof architecture !== 'string' || (fixed && fixed !== architecture) ||
      !matches(versionPattern, version) || !matches(hashPattern, sha256) || typeof browser !== 'boolean') return;
  const [codeDigest, recoveryDigest] = await Promise.all([digest(code), digest('enrollment-claim-recovery-v1:' + recoveryProof)]);
  const row = await db.prepare(`SELECT id, device_id, snapshot, state, created_at, resolved_at FROM enrollment_intents
    WHERE code_digest = ? AND device_id = ? AND state IN ('pending', 'claimed')`).bind(codeDigest, deviceId).first();
  if (!row) return;
  const [os] = platformParts(platform);
  const release = publicIntent(row).releases[os];
  if (!release || release.platform !== platform || release.version !== version || release.browser !== browser ||
      !Object.hasOwn(release.assets, architecture) || release.assets[architecture].sha256 !== sha256) return;
  const claimedSnapshot = JSON.stringify(release);
  if (row.state === 'pending') {
    const claimed = await db.prepare(`UPDATE enrollment_intents
      SET state = 'claimed', code_ciphertext = NULL, resolved_at = ?, recovery_digest = ?, claimed_architecture = ?, snapshot = ?
      WHERE id = ? AND device_id = ? AND code_digest = ? AND snapshot = ? AND state = 'pending'
      RETURNING id, device_id, snapshot, state, created_at, resolved_at`)
      .bind(now(), recoveryDigest, architecture, claimedSnapshot, row.id, deviceId, codeDigest, row.snapshot).first();
    if (claimed) return { ...publicIntent(claimed), architecture, resumed: false };
  }
  // This is an idempotent receipt read, not another redemption. A consumer must
  // resume the same operation by intent ID rather than provision a second device.
  const at = now();
  const receipt = await db.prepare(`SELECT id, device_id, snapshot, state, created_at, resolved_at
    FROM enrollment_intents WHERE id = ? AND device_id = ? AND code_digest = ? AND snapshot = ?
    AND state = 'claimed' AND recovery_digest = ? AND claimed_architecture = ?
    AND resolved_at > ? AND resolved_at <= ?`)
    .bind(row.id, deviceId, codeDigest, claimedSnapshot, recoveryDigest, architecture, at - claimRecoveryWindowSeconds, at).first();
  if (receipt) return { ...publicIntent(receipt), architecture, resumed: true };
}

export async function revokeEnrollmentIntent(db, id) {
  if (!matches(uuidPattern, id)) return;
  const row = await db.prepare(`UPDATE enrollment_intents
    SET state = 'revoked', code_ciphertext = NULL, resolved_at = ? WHERE id = ? AND state = 'pending'
    RETURNING id, device_id, snapshot, state, created_at, resolved_at`).bind(now(), id).first();
  return publicIntent(row);
}

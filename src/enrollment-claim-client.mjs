import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, open, unlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { enrollPath, operatingSystems } from '../cloud/device-paths.mjs';
import { devicePattern, tokenPattern, validateCredentials, validateDevicePorts } from '../cloud/tickets.mjs';
import { assertPrivateFile, ensurePrivateDirectory, readPrivateFile, writePrivateFile } from './private-directory.mjs';

const versionPattern = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,95}$/;
const shaPattern = /^[a-f0-9]{64}$/;
const valid = (pattern, value) => typeof value === 'string' && pattern.test(value);
const maxBodyBytes = 16384;

export class EnrollmentClaimError extends Error {
  constructor(code, message, httpStatus) {
    super(message);
    this.name = 'EnrollmentClaimError';
    this.code = code;
    if (httpStatus !== undefined) this.httpStatus = httpStatus;
  }
}

async function syncFile(path) {
  const expected = await assertPrivateFile(path);
  const handle = await open(path, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
  try {
    const actual = await handle.stat();
    if (!actual.isFile() || actual.ino !== expected.ino || actual.dev !== expected.dev) {
      throw new Error('The private recovery file changed before publication');
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function publishExclusive(path, value) {
  const temporary = path + '.' + randomUUID() + '.tmp';
  await writePrivateFile(temporary, value);
  try {
    await syncFile(temporary);
    // Publish the complete file under the final name in one step, and never
    // overwrite a proof written by a concurrent installer on the same host.
    await link(temporary, path);
  } finally {
    await unlink(temporary);
  }
}

async function syncDirectory(root) {
  // Node does not provide an equivalent directory-handle fsync on Windows.
  // Windows still uses the flushed private file and exclusive atomic link.
  if (process.platform === 'win32') return;
  const handle = await open(root, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
  try { await handle.sync(); }
  finally { await handle.close(); }
}

const defaultRecoveryStore = {
  prepare: ensurePrivateDirectory, read: readPrivateFile, publish: publishExclusive, sync: syncDirectory,
};

function claimInput(input) {
  const { manager, code, deviceId, platform, architecture, version, sha256, browser, root, ports } = input ?? {};
  const parsed = typeof manager === 'string' ? URL.parse(manager) : null;
  const parts = typeof platform === 'string' ? platform.split('-') : [];
  const [os, fixed] = parts;
  if (!parsed || parsed.protocol !== 'https:' || (manager !== parsed.origin && manager !== parsed.origin + '/') ||
      !valid(tokenPattern, code) || !valid(devicePattern, deviceId) || !Object.hasOwn(operatingSystems, os) || parts.length > 2 ||
      !operatingSystems[os].architectures.includes(architecture) || (fixed !== undefined && fixed !== architecture) ||
      !valid(versionPattern, version) || !valid(shaPattern, sha256) || typeof browser !== 'boolean' ||
      typeof root !== 'string' || !isAbsolute(root)) {
    throw new EnrollmentClaimError('invalid_claim', 'The device enrollment inputs do not match a pinned installer');
  }
  let localPorts;
  if (ports !== undefined) {
    try { localPorts = validateDevicePorts(ports, browser); }
    catch { throw new EnrollmentClaimError('invalid_claim', 'The device enrollment ports are invalid'); }
  }
  return { manager: parsed.origin, code, deviceId, platform, architecture, version, sha256, browser, root, ports: localPorts };
}

function proofFromRecord(text, record, code) {
  let value;
  try { value = JSON.parse(text); } catch { /* Invalid local state cannot be replaced silently. */ }
  const keys = Object.keys(record);
  if (!value || Array.isArray(value) || Object.keys(value).length !== keys.length + 1 ||
      !keys.every(key => Object.hasOwn(value, key) && value[key] === record[key]) ||
      !Object.hasOwn(value, 'recoveryProof') || !valid(tokenPattern, value.recoveryProof) || value.recoveryProof === code) {
    throw new EnrollmentClaimError('recovery_mismatch', 'The local enrollment recovery file does not match this command. It was not replaced');
  }
  return value.recoveryProof;
}

async function recoverProof({ root, manager, code, ...tuple }, store, newProof) {
  const digest = createHash('sha256').update(code).digest('hex');
  const path = join(root, 'enrollment-claim-' + digest + '.private.json');
  const record = { schema: 1, manager, ...tuple, codeDigest: digest };
  const load = async () => proofFromRecord(await store.read(path), record, code);
  try {
    await store.prepare(root);
    let proof;
    try { proof = await load(); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (proof === undefined) {
      const proposed = newProof();
      if (!valid(tokenPattern, proposed) || proposed === code) throw new Error('Invalid enrollment recovery material');
      try { await store.publish(path, JSON.stringify({ ...record, recoveryProof: proposed }) + '\n'); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      proof = await load();
    }
    await store.sync(root);
    return proof;
  } catch (error) {
    if (error instanceof EnrollmentClaimError) throw error;
    throw new EnrollmentClaimError('recovery_unavailable', 'Could not verify and persist private enrollment recovery state. No request was sent');
  }
}

async function readCredentials(response, deviceId, browser, ports) {
  const type = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  if (type !== 'application/json' || !response.body) throw new Error('Expected credentials JSON');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const reader = response.body.getReader();
  let text = '', size = 0;
  let complete = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) { complete = true; break; }
      size += value.length;
      if (size > maxBodyBytes) throw new Error('Enrollment response was too large');
      text += decoder.decode(value, { stream: true });
    }
    const credentials = validateCredentials(JSON.parse(text + decoder.decode()));
    if (credentials.deviceId !== deviceId || !credentials.activationToken || !!credentials.browserToken !== browser ||
        JSON.stringify(credentials.ports) !== JSON.stringify(ports)) {
      throw new Error('Enrollment credentials did not match the pinned device');
    }
    return credentials;
  } finally {
    if (!complete) void reader.cancel().catch(() => {});
    else reader.releaseLock();
  }
}

// Called only after the launcher has verified the exact archive. This helper
// writes no device credentials, modifies no services, and never retries POST.
// The caller owns installing the returned credentials with a private write.
export async function claimDeviceEnrollment(input, { request = fetch, recoveryStore = defaultRecoveryStore,
  newProof = () => randomBytes(32).toString('base64url'), timeoutMs = 45000 } = {}) {
  const { manager, root, code, deviceId, platform, architecture, version, sha256, browser, ports } = claimInput(input);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) {
    throw new EnrollmentClaimError('invalid_claim', 'Invalid enrollment request timeout');
  }
  const recoveryProof = await recoverProof({ manager, root, code, deviceId, platform, architecture, version, sha256, browser },
    recoveryStore, newProof);
  const url = manager + enrollPath;
  let response;
  try {
    response = await request(url, { method: 'POST', redirect: 'error', cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs), headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ protocol: 'intent-v1', code, deviceId, platform, architecture, version, sha256, browser, recoveryProof,
        ...(ports && { ports }) }),
    });
  } catch {
    throw new EnrollmentClaimError('claim_unconfirmed', 'Enrollment was not confirmed. Use the same command on this device to recover');
  }
  if (response?.redirected || (response?.url && response.url !== url) || !Number.isInteger(response?.status)) {
    void response?.body?.cancel().catch(() => {});
    throw new EnrollmentClaimError('claim_response_invalid', 'Enrollment returned an unexpected response. No local credentials were changed');
  }
  if (response.status !== 200) {
    void response.body?.cancel().catch(() => {});
    if ([400, 401, 403, 404, 409, 410].includes(response.status)) {
      throw new EnrollmentClaimError('claim_rejected', 'The enrollment command was rejected. Verify this device and command in the management console', response.status);
    }
    throw new EnrollmentClaimError('claim_unconfirmed', 'Enrollment was not confirmed. Use the same command on this device to recover', response.status);
  }
  try { return await readCredentials(response, deviceId, browser, ports); }
  catch {
    void response.body?.cancel().catch(() => {});
    throw new EnrollmentClaimError('claim_response_invalid', 'Enrollment did not return verified credentials. No local credentials were changed');
  }
}

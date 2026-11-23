import { validateUpgradeBindings, validateUpgradePreconditions, verifyUpgradeRelease } from './upgrade-plan.mjs';
import { planEnrollmentUpgrade } from './upgrade-enrollment-release.mjs';

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const operationUuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

export class UpgradeOperationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'UpgradeOperationError';
    this.code = code;
  }
}

function pinnedTarget(expected, operationId) {
  const { accountId, worker, zoneId, origin, ownerEmail, accessAudience, activeVersion, currentVersion } = expected ?? {};
  if (typeof origin !== 'string' || typeof accountId !== 'string' || typeof zoneId !== 'string' ||
      typeof worker !== 'string' || typeof ownerEmail !== 'string' || typeof accessAudience !== 'string' ||
      typeof activeVersion !== 'string' || typeof currentVersion !== 'string' || typeof operationId !== 'string') {
    throw new UpgradeOperationError('invalid_target', 'The trusted Nodrelay upgrade target is incomplete');
  }
  const host = URL.parse(origin);
  if (!/^[a-f0-9]{32}$/.test(accountId) || !/^[a-f0-9]{32}$/.test(zoneId) ||
      !/^fleet-[a-z][a-z0-9-]{2,15}-[a-f0-9]{12}$/.test(worker) ||
      !host || host.origin !== origin || host.protocol !== 'https:' || host.port ||
      /\.(?:workers|pages)\.dev$/.test(host.hostname) ||
      !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/u.test(ownerEmail) ||
      !/^[a-zA-Z0-9._:-]{3,200}$/.test(accessAudience) || !uuid.test(activeVersion) || !operationUuid.test(operationId)) {
    throw new UpgradeOperationError('invalid_target', 'The trusted Nodrelay upgrade target or operation ID is invalid');
  }
  return Object.freeze({ accountId, worker, zoneId, origin, ownerEmail, accessAudience, activeVersion, currentVersion });
}

function checkTarget(bindings, target) {
  const lookup = (name) => bindings.find(binding => binding.name === name)?.text;
  let spec;
  try { spec = JSON.parse(lookup('FLEET_SPEC')); }
  catch { /* An unexpected live binding must not cross the write boundary. */ }
  if (lookup('APP_ORIGIN') !== target.origin || lookup('OWNER_EMAIL') !== target.ownerEmail ||
      lookup('ACCESS_AUD') !== target.accessAudience || lookup('NODRELAY_RELEASE_VERSION') !== target.currentVersion ||
      !spec?.accountScopedAccess || spec.accountId !== target.accountId || spec.zoneId !== target.zoneId ||
      spec.origin !== target.origin || spec.ownerEmail !== target.ownerEmail || spec.worker !== target.worker || spec.label !== target.worker) {
    throw new UpgradeOperationError('target_drift', 'The live Cloudflare bindings do not match this authorized Nodrelay target and release');
  }
}

function snapshot(runtime) {
  const { compatibilityDate, compatibilityFlags, migrationTag, usageModel } = runtime ?? {};
  if (typeof compatibilityDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(compatibilityDate) ||
      !Array.isArray(compatibilityFlags) || compatibilityFlags.some(flag => typeof flag !== 'string') ||
      typeof migrationTag !== 'string' || !migrationTag || !['standard', 'bundled', 'unbound'].includes(usageModel)) {
    throw new UpgradeOperationError('runtime_unproven', 'Cloudflare Worker runtime or Durable Object migration metadata is unavailable');
  }
  return { compatibilityDate, compatibilityFlags: [...compatibilityFlags].sort(), migrationTag, usageModel };
}

function compatibleRuntime(candidate, active) {
  if (JSON.stringify(snapshot(candidate)) !== JSON.stringify(active)) {
    throw new UpgradeOperationError('runtime_drift', 'The proposed Worker changes runtime compatibility or Durable Object migration metadata');
  }
}

function requireDeployment(state, activeVersion, latestVersion) {
  const versions = state?.deployments;
  if (state?.latestVersion !== latestVersion || !Array.isArray(versions) || versions.length !== 1 ||
      versions[0]?.version_id !== activeVersion || versions[0].percentage !== 100) {
    throw new UpgradeOperationError('deployment_drift', 'The active or most recently uploaded Cloudflare version changed');
  }
}

const validEtag = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{16,128}$/.test(value);

// These are trusted, same-account interfaces. No API URLs, Cloudflare token, or
// replacement catalog come from the request. `readVersion` normalizes actual
// provider metadata and reads secret binding *names only*. Etag is a provider
// correlation value, not the publisher's SHA-256 (which is verified separately).
// A durable target lock must survive Worker version cutover. `write` cannot
// resolve before the phase is durable; `assertHeld` fences each mutation as
// close to dispatch as possible. Cloudflare does not supply a deployment CAS;
// concurrent writers outside this lock are not authorized by this flow.
const enrollmentBindings = ['FLEET_ENROLLMENT_PROTOCOL', 'FLEET_ENROLLMENT_HISTORY', 'FLEET_ENROLLMENT_CATALOG'];
const validHash = x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
async function enrollmentPlanDigest(changes) {
  const value = JSON.stringify(enrollmentBindings.map(name => [name, changes[name]]));
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), b =>
    b.toString(16).padStart(2, '0')).join('');
}
export async function runUpgradeOperation({ expected, artifact, operationId, api, journal, enrollmentApproval, now = Date.now() }) {
  const target = pinnedTarget(expected, operationId);
  const { release, bundle, manifestSha256 } = await verifyUpgradeRelease({ ...artifact, currentVersion: target.currentVersion, now });
  const enrollmentChange = release.schema === 2;
  // Required only for format 2; its exact signed manifest (not merely Worker
  // bytes) was accepted by the owner. Readiness comes from live provider reads.
  if (enrollmentChange && (enrollmentApproval?.manifestSha256 !== manifestSha256 ||
      typeof enrollmentApproval.inspect !== 'function')) {
    throw new UpgradeOperationError('format_not_enabled', 'This enrollment release was not confirmed.');
  }
  return journal.withLock(target, async (txn) => {
    const previous = await txn.read();
    if (previous?.phase === 'confirmed' && previous.operationId === operationId) {
      if (previous.releaseVersion !== release.version || previous.releaseSha256 !== release.workerSha256 ||
          previous.manifestSha256 !== manifestSha256 ||
          previous.baseVersion !== target.activeVersion || !uuid.test(previous.candidateVersion ?? '')) {
        throw new UpgradeOperationError('operation_conflict', 'This operation ID already refers to a different upgrade');
      }
      return { status: 'previously_confirmed', version: release.version, versionId: previous.candidateVersion };
    }
    if (previous && previous.phase !== 'confirmed') {
      throw new UpgradeOperationError('reconciliation_required', 'An earlier upgrade is unsettled. Check Cloudflare before submitting another upgrade');
    }

    const baseline = await api.readDeployment(target);
    const live = baseline?.deployments;
    if (Array.isArray(live) && live.length === 1 && live[0]?.version_id === target.activeVersion &&
        live[0].percentage === 100 && uuid.test(baseline.latestVersion ?? '') && baseline.latestVersion !== target.activeVersion) {
      throw new UpgradeOperationError('baseline_version_mismatch', 'Cloudflare is serving a different version from its latest upload. No upload or rollout was attempted');
    }
    requireDeployment(baseline, target.activeVersion, target.activeVersion);
    const read = await api.readVersion(target, target.activeVersion);
    if (read?.id !== target.activeVersion || !validEtag(read.etag)) {
      throw new UpgradeOperationError('baseline_unproven', 'Cloudflare did not identify the active Worker version');
    }
    const active = structuredClone(read);
    const activeBindings = active.bindings;
    const state = { ...baseline, activeBindings };
    validateUpgradePreconditions({ ...state, candidateBindings: activeBindings });
    checkTarget(activeBindings, target);
    const runtime = snapshot(active.runtime);
    let enrollmentChanges;
    if (enrollmentChange) {
      try {
        const readiness = await enrollmentApproval.inspect();
        enrollmentChanges = planEnrollmentUpgrade({ release, manifestSha256,
          expectedManifestSha256: enrollmentApproval.manifestSha256, activeBindings, readiness }).changes;
      } catch {
        throw new UpgradeOperationError('enrollment_not_ready', 'Existing D1, Access or enrollment settings do not support this signed release.');
      }
    }
    const changes = { NODRELAY_RELEASE_VERSION: release.version, ...enrollmentChanges };
    const names = new Set(activeBindings.map(({ name }) => name));
    const bindings = activeBindings.map(({ name }) => Object.hasOwn(changes, name)
      ? { name, type: 'plain_text', text: changes[name] } : { name, type: 'inherit' });
    for (const [name, text] of Object.entries(changes)) if (!names.has(name)) bindings.push({ name, type: 'plain_text', text });
    const record = { operationId, baseVersion: target.activeVersion, releaseVersion: release.version, releaseSha256: release.workerSha256,
      ...(enrollmentChanges && { manifestSha256, enrollmentChangesSha256: await enrollmentPlanDigest(enrollmentChanges) }) };
    const assertStable = async latest => {
      requireDeployment(await api.readDeployment(target), target.activeVersion, latest);
      await txn.assertHeld();
    };
    // A failed or ambiguous POST is never retried, including when an HTTP
    // request is resubmitted or the Worker has been restarted.
    await assertStable(target.activeVersion);
    await txn.write({ ...record, phase: 'uploading' });
    let uploaded;
    try {
      uploaded = await api.uploadVersion(target, { bundle, module: 'worker.js', bindingsInherit: 'strict',
        bindings, compatibilityDate: runtime.compatibilityDate, compatibilityFlags: runtime.compatibilityFlags,
        usageModel: runtime.usageModel, operationId });
    } catch {
      throw new UpgradeOperationError('upload_unconfirmed', 'Cloudflare staging was not confirmed. No rollout was attempted; check Cloudflare before retrying');
    }
    if (!uploaded || typeof uploaded.id !== 'string' || !uuid.test(uploaded.id) ||
        uploaded.id === target.activeVersion || !validEtag(uploaded.etag)) {
      throw new UpgradeOperationError('upload_unconfirmed', 'Cloudflare did not identify the staged version. No rollout was attempted');
    }

    const candidateVersion = uploaded.id;
    const staged = { ...record, candidateVersion, candidateEtag: uploaded.etag };
    await txn.write({ ...staged, phase: 'staged' });
    const candidate = await api.readVersion(target, candidateVersion);
    if (candidate?.id !== candidateVersion || candidate.etag !== uploaded.etag) {
      throw new UpgradeOperationError('candidate_unproven', 'The staged Worker does not match Cloudflare readback. No rollout was attempted');
    }
    validateUpgradePreconditions({ ...state, candidateBindings: candidate.bindings, plannedChanges: changes });
    compatibleRuntime(candidate.runtime, runtime);
    await assertStable(candidateVersion);

    await txn.write({ ...staged, phase: 'deploying' });
    try { await assertStable(candidateVersion); }
    catch (error) {
      // The final preflight failed before the deployment request was invoked.
      await txn.write({ ...staged, phase: 'staged' });
      throw error;
    }
    try {
      await api.deployVersion(target, { strategy: 'percentage', versions: [{ version_id: candidateVersion, percentage: 100 }] });
    } catch {
      throw new UpgradeOperationError('deployment_unconfirmed', 'Cloudflare rollout was not confirmed. Check the current deployment; no automatic retry or rollback was attempted');
    }

    try {
      requireDeployment(await api.readDeployment(target), candidateVersion, candidateVersion);
      await txn.assertHeld();
      await txn.write({ ...staged, phase: 'confirmed' });
    } catch {
      throw new UpgradeOperationError('deployment_unconfirmed', 'Cloudflare rollout was not confirmed by readback. Check the current deployment before retrying');
    }
    // This is provider-level confirmation, not application health; the caller
    // must still smoke-test the custom domain and authenticated application.
    return { status: 'deployment_confirmed', version: release.version, versionId: candidateVersion };
  });
}

// Read provider truth for interrupted uploads or cutovers. Pre-cutover checks
// never clear the journal; a GET cannot prove an ambiguous upload won't arrive.
// Never uploads, switches traffic, or rolls back.
export async function confirmRecordedDeployment({ expected, operationId, api, journal }) {
  const target = pinnedTarget(expected, operationId);
  return journal.withLock(target, async txn => {
    const record = await txn.read();
    const phase = record?.phase;
    if (record?.operationId !== operationId || !['uploading', 'staged', 'deploying', 'confirmed'].includes(phase) ||
        !uuid.test(record.baseVersion ?? '') || record.baseVersion !== target.activeVersion ||
        (phase === 'uploading' ? record.candidateVersion !== undefined || record.candidateEtag !== undefined :
          !uuid.test(record.candidateVersion ?? '') || record.candidateVersion === record.baseVersion || !validEtag(record.candidateEtag))) {
      throw new UpgradeOperationError('reconciliation_required', 'There is no exact recorded version to reconcile');
    }
    if (record.phase === 'confirmed') {
      return { status: 'previously_confirmed', version: record.releaseVersion, operationId };
    }
    if (phase === 'uploading') {
      const [deployment, original] = await Promise.all([api.readDeployment(target), api.readVersion(target, record.baseVersion)]);
      if (!uuid.test(deployment?.latestVersion ?? '') || original?.id !== record.baseVersion || !validEtag(original.etag)) {
        throw new UpgradeOperationError('candidate_unproven', 'Cloudflare did not identify the original version');
      }
      checkTarget(original.bindings, target);
      requireDeployment(deployment, record.baseVersion, deployment.latestVersion);
      requireDeployment(await api.readDeployment(target), record.baseVersion, deployment.latestVersion);
      await txn.assertHeld();
      return { status: 'baseline_active_upload_unconfirmed', version: record.releaseVersion, operationId };
    }
    const [deployment, original, candidate] = await Promise.all([
      api.readDeployment(target), api.readVersion(target, record.baseVersion), api.readVersion(target, record.candidateVersion),
    ]);
    // A timed-out rollout can leave the old version serving 100% while
    // the exact candidate is uploaded. This is an observation, not proof
    // that the request failed or permission to retry it.
    const rolloutStillUnconfirmed = phase === 'deploying' && deployment?.deployments?.[0]?.version_id === record.baseVersion;
    const active = phase === 'staged' || rolloutStillUnconfirmed ? record.baseVersion : record.candidateVersion;
    requireDeployment(deployment, active, record.candidateVersion);
    if (original?.id !== record.baseVersion || !validEtag(original.etag) ||
        candidate?.id !== record.candidateVersion || candidate.etag !== record.candidateEtag) {
      throw new UpgradeOperationError('candidate_unproven', 'Cloudflare version identity cannot confirm the recorded deployment');
    }
    const currentVersion = original.bindings.find(({ name }) => name === 'NODRELAY_RELEASE_VERSION')?.text;
    if (!currentVersion || !(phase === 'staged' ? target.currentVersion === currentVersion :
        [currentVersion, record.releaseVersion].includes(target.currentVersion))) {
      throw new UpgradeOperationError('target_drift', 'Nodrelay runtime version does not match the recorded deployment');
    }
    checkTarget(original.bindings, { ...target, currentVersion });
    const changes = { NODRELAY_RELEASE_VERSION: record.releaseVersion };
    if (record.manifestSha256 !== undefined || record.enrollmentChangesSha256 !== undefined) {
      if (!validHash(record.manifestSha256) || !validHash(record.enrollmentChangesSha256)) {
        throw new UpgradeOperationError('candidate_unproven', 'The enrollment release record is incomplete');
      }
      for (const name of enrollmentBindings) {
        changes[name] = candidate.bindings.find(binding => binding.name === name && binding.type === 'plain_text')?.text;
      }
      if (await enrollmentPlanDigest(changes) !== record.enrollmentChangesSha256) {
        throw new UpgradeOperationError('candidate_unproven', 'The enrollment settings do not match the original verified plan');
      }
    }
    validateUpgradeBindings(original.bindings, candidate.bindings, changes);
    compatibleRuntime(candidate.runtime, snapshot(original.runtime));
    requireDeployment(await api.readDeployment(target), active, record.candidateVersion);
    await txn.assertHeld();
    if (phase === 'staged') return { status: 'baseline_active_candidate_staged', version: record.releaseVersion, operationId };
    if (rolloutStillUnconfirmed) return { status: 'baseline_active_rollout_unconfirmed', version: record.releaseVersion, operationId };
    await txn.write({ ...record, phase: 'confirmed' });
    return { status: 'deployment_confirmed', version: record.releaseVersion, operationId };
  });
}

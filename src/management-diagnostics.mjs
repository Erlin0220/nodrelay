import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CloudflareError, CloudflareRequestTimeoutError } from '../cloud/cloudflare.mjs';
import { ManagementLockError } from './management-lock.mjs';
import { ensurePrivateDirectory, writePrivateFile } from './private-directory.mjs';

const stages = new Set(['arguments', 'release_verification', 'readiness', 'terminal', 'authorization',
  'target_selection', 'administrator', 'deployment', 'deployment_confirmation']);
const modes = new Set(['install', 'plan', 'check', 'reconnect', 'resume']);
const operationCodes = new Set([
  'management_lock_busy', 'management_lock_unconfirmed', 'management_lock_lost', 'management_journal_unconfirmed',
  'baseline_unproven', 'baseline_version_mismatch', 'candidate_unproven', 'deployment_drift', 'deployment_unconfirmed',
  'enrollment_not_ready', 'format_not_enabled', 'invalid_target', 'operation_conflict', 'reconciliation_required',
  'runtime_drift', 'runtime_unproven', 'target_drift', 'upload_unconfirmed',
]);
const lockStages = new Set(['acquire', 'renew', 'journal_write', 'release']);
const ownership = new Set(['current', 'other', 'missing', 'expired', 'unknown']);
const localLockKinds = new Set(['active', 'interrupted', 'unknown']);
const uploadKinds = new Set(['not_sent', 'refused', 'timeout', 'unknown']);
const count = value => Number.isSafeInteger(value) && value >= 0 && value <= 100;
const status = value => Number.isInteger(value) && value >= 100 && value <= 599;
const safeCodes = values => Array.isArray(values)
  ? values.filter(value => Number.isInteger(value) && value >= 0 && value <= 999999999).slice(0, 5) : [];

export function managementFailureRecord(error, context = {}) {
  const result = { schema: 1, timestamp: new Date().toISOString(),
    mode: modes.has(context.mode) ? context.mode : 'unknown',
    stage: stages.has(context.stage) ? context.stage : 'unknown', code: 'unexpected_error' };
  if (typeof context.version === 'string' && /^\d{1,9}\.\d{1,9}\.\d{1,9}(?:-preview\.\d{1,9})?$/.test(context.version)) {
    result.version = context.version;
  }
  if (operationCodes.has(error?.code)) result.code = error.code;
  else if (error instanceof CloudflareError) result.code = 'cloudflare_api_error';
  else if (error instanceof CloudflareRequestTimeoutError) result.code = 'cloudflare_timeout';
  else if (error instanceof ManagementLockError) {
    result.code = 'local_management_lock';
    if (localLockKinds.has(error.kind)) result.localLockState = error.kind;
  } else if (error instanceof SyntaxError) result.code = 'invalid_format';

  // Copy strictly typed, non-identifying fields only. In particular, provider
  // paths, raw messages, payloads, scopes and lock owner values never enter the log.
  const cloudflare = error instanceof CloudflareError ? error
    : error?.cause instanceof CloudflareError ? error.cause : undefined;
  if (cloudflare) {
    result.cloudflare = { codes: safeCodes(cloudflare.codes) };
    if (status(cloudflare.status)) result.cloudflare.status = cloudflare.status;
    if (typeof cloudflare.rayId === 'string' && /^[a-f0-9]{16,32}(?:-[A-Z]{3,5})?$/.test(cloudflare.rayId)) {
      result.cloudflare.rayId = cloudflare.rayId;
    }
  }
  if (result.code === 'upload_unconfirmed' && uploadKinds.has(error.failure?.kind)) {
    result.upload = { kind: error.failure.kind, codes: safeCodes(error.failure.codes) };
    if (status(error.failure.status)) result.upload.status = error.failure.status;
  }
  if (result.code.startsWith('management_lock_') || result.code === 'management_journal_unconfirmed') {
    const value = error.diagnostic;
    const lock = {};
    if (lockStages.has(value?.stage)) lock.stage = value.stage;
    if (ownership.has(value?.ownership)) lock.ownership = value.ownership;
    if (count(value?.changes)) lock.changes = value.changes;
    if (count(value?.rows)) lock.rows = value.rows;
    if (Number.isSafeInteger(value?.secondsLeft)) lock.secondsLeft = value.secondsLeft;
    if (Object.keys(lock).length) result.lock = lock;
  }
  return result;
}

export async function writeManagementFailure(error, context, { home = homedir() } = {}) {
  const root = join(home, '.nodrelay');
  const directory = join(root, 'management-logs');
  await ensurePrivateDirectory(root);
  await ensurePrivateDirectory(directory);
  const path = join(directory, 'failure-' + randomUUID() + '.json');
  await writePrivateFile(path, JSON.stringify(managementFailureRecord(error, context), null, 2) + '\n');
  return path;
}

import { cloudflareApi } from './cloudflare.mjs';
import { oauthTokenValue } from './oauth-grant.mjs';
import { workerOAuthAccess } from './oauth-provisioning.mjs';
import { loadVerifiedUpgradeArtifacts } from './upgrade-artifacts.mjs';
import { createCloudflareUpgradeAdapter } from './upgrade-cloudflare.mjs';
import { createUpgradeJournal, readUpgradeJournal } from './upgrade-journal.mjs';
import { inspectEnrollmentUpgradeReadiness } from './upgrade-enrollment-readiness.mjs';
import { confirmRecordedDeployment, runUpgradeOperation, UpgradeOperationError } from './upgrade-operation.mjs';

const versionPattern = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(?:-preview\.(0|[1-9]\d{0,8}))?$/;
const operationUuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const id = /^[a-f0-9]{32}$/;
const sha256 = /^[a-f0-9]{64}$/;
const worker = /^fleet-[a-z][a-z0-9-]{2,15}-[a-f0-9]{12}$/;
const phases = new Set(['uploading', 'staged', 'deploying', 'confirmed']);
const matches = (pattern, value) => typeof value === 'string' && pattern.test(value);

const errors = {
  unavailable: [503, '此管理台未启用可信升级配置。'],
  invalid_request: [400, '升级操作编号或目标版本无效。'],
  format_not_enabled: [409, '签名清单不是本次确认的升级，请重新检查版本。'],
  enrollment_not_ready: [409, '设备下载配置或数据库不满足新版本要求，未切换版本。'],
  feed_unavailable: [503, '未能验证官方升级包，未执行升级。'],
  release_changed: [409, '官方升级包已变化，请重新检查版本后提交。'],
  authorization_unavailable: [503, 'Cloudflare 管理授权不可用，未执行升级。'],
  status_unavailable: [503, '无法读取升级记录，请稍后查看状态，不要重复提交。'],
  operation_conflict: [409, '此操作编号已用于另一升级版本。'],
  reconciliation_required: [409, '有未完成的升级。请先核对 Cloudflare 部署状态，不要重复提交。'],
  target_drift: [409, 'Cloudflare 当前部署与此管理台不一致，未执行升级。'],
  baseline_version_mismatch: [409, 'Cloudflare 当前接收流量的版本与最近上传的版本不同（回滚或单独上传后可能出现）。为避免继承错误配置，本次未上传或切换版本。请先在 Cloudflare 核对生效版本和版本历史，不要重复提交。'],
  deployment_drift: [409, 'Cloudflare 部署状态已变化，请查看升级状态。'],
  upload_unconfirmed: [502, '未能确认 Cloudflare 已暂存新版本，未切换流量。请先核对升级状态。'],
  deployment_unconfirmed: [502, '未能确认 Cloudflare 的版本切换。请先核对升级状态，不要重复提交。'],
  candidate_unproven: [502, '未能确认 Cloudflare 暂存版本与升级包一致，未切换流量。'],
  operation_unavailable: [503, '无法确认升级操作结果。请查看升级状态，不要重复提交。'],
};

export class UpgradeAdminError extends Error {
  constructor(code) {
    const [status, message] = errors[code];
    super(message);
    this.name = 'UpgradeAdminError';
    this.code = code;
    this.status = status;
  }
}

function readConfig(env) {
  const { NODRELAY_RELEASE_VERSION: currentVersion, NODRELAY_UPGRADE_CHANNEL: channel,
    NODRELAY_UPGRADE_PUBLIC_KEY: key, NODRELAY_UPGRADE_FEED: base, FLEET_SPEC: fleet,
    APP_ORIGIN: origin, OWNER_EMAIL: ownerEmail, ACCESS_AUD: accessAudience } = env;
  const directory = typeof base === 'string' && URL.parse(base);
  const site = typeof origin === 'string' && URL.parse(origin);
  let spec;
  try { spec = JSON.parse(fleet); } catch { return; }
  if (!matches(versionPattern, currentVersion) || !['stable', 'preview'].includes(channel) ||
      (channel === 'stable' && currentVersion.includes('-preview.')) || !matches(/^[A-Za-z0-9_-]{59}$/, key) ||
      !directory || directory.href !== base || directory.protocol !== 'https:' || directory.port ||
      directory.username || directory.password || directory.search || directory.hash || !directory.pathname.endsWith('/') ||
      !site || site.origin !== origin || site.protocol !== 'https:' || site.port ||
      /\.(?:workers|pages)\.dev$/.test(site.hostname) ||
      !matches(/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/u, ownerEmail) ||
      !matches(/^[a-zA-Z0-9._:-]{3,200}$/, accessAudience) || !matches(id, spec?.accountId) ||
      !matches(id, spec?.zoneId) || !matches(worker, spec?.worker) || spec.worker !== spec.label ||
      spec.origin !== origin || spec.ownerEmail !== ownerEmail || spec.accountScopedAccess !== true ||
      env.FLEET_OAUTH_MODE !== 'managed' || env.FLEET_OAUTH_RECOVERY !== '1' ||
      !env.PROVISIONER_OAUTH || !env.TICKETS || env.PROVISIONER_TOKEN) return;
  return Object.freeze({ base, channel, currentVersion, key, spec: Object.freeze(spec), target: Object.freeze({
    accountId: spec.accountId, worker: spec.worker, zoneId: spec.zoneId, origin, ownerEmail, accessAudience,
  }) });
}

function safeRecord(row) {
  if (row === undefined) return { phase: 'idle' };
  if (!phases.has(row?.phase) || !matches(operationUuid, row.operationId) ||
      !matches(versionPattern, row.releaseVersion) || !matches(sha256, row.releaseSha256) ||
      !matches(uuid, row.baseVersion) || (row.phase !== 'uploading' && !matches(uuid, row.candidateVersion))) {
    throw new UpgradeAdminError('status_unavailable');
  }
  if (row.manifestSha256 !== undefined && !matches(sha256, row.manifestSha256)) throw new UpgradeAdminError('status_unavailable');
  return { phase: row.phase, operationId: row.operationId, version: row.releaseVersion, releaseSha256: row.releaseSha256,
    ...(row.manifestSha256 && { manifestSha256: row.manifestSha256 }) };
}

async function verificationKey(value) {
  const b64 = value.replaceAll('-', '+').replaceAll('_', '/') + '=';
  const decoded = atob(b64);
  if (btoa(decoded) !== b64) throw new Error('Invalid SPKI encoding');
  return crypto.subtle.importKey('spki', Uint8Array.from(decoded, c => c.charCodeAt(0)), 'Ed25519', false, ['verify']);
}

// Internal owner-only adapter. Route caller must have verified the Access JWT
// against this owner's audience and must separately enforce same-origin POST.
export function createUpgradeAdmin(env, {
  loadArtifacts = loadVerifiedUpgradeArtifacts,
  createAdapter = createCloudflareUpgradeAdapter,
  runOperation = runUpgradeOperation,
  confirmOperation = confirmRecordedDeployment,
  createJournal = createUpgradeJournal,
  readJournal = readUpgradeJournal,
  oauthAccess = workerOAuthAccess,
  request = fetch,
  clock = Date.now,
  inspectEnrollment = inspectEnrollmentUpgradeReadiness,
} = {}) {
  const config = readConfig(env);
  async function artifacts(allowCurrent = false) {
    try {
      const { base, channel, currentVersion, key } = config;
      return await loadArtifacts({ base, channel, currentVersion, publicKey: await verificationKey(key), request, now: clock(), allowCurrent, format: 'auto' });
    } catch { throw new UpgradeAdminError('feed_unavailable'); }
  }
  async function persisted() {
    try { return safeRecord(await readJournal(env.TICKETS, config.target)); }
    catch { throw new UpgradeAdminError('status_unavailable'); }
  }
  async function ownerAdapter(enrollment = false) {
    // Do not activate the broker's bootstrap cleanup path during an upgrade.
    if (env.FLEET_OAUTH_SEED || env.FLEET_OAUTH_RECONNECT) throw new UpgradeAdminError('authorization_unavailable');
    let token;
    try { token = await oauthAccess(env.PROVISIONER_OAUTH); }
    catch { throw new UpgradeAdminError('authorization_unavailable'); }
    if (!matches(oauthTokenValue, token)) throw new UpgradeAdminError('authorization_unavailable');
    const provider = cloudflareApi(token, { request });
    return { provider, api: createAdapter(provider, config.target, { enrollment }) };
  }
  function mapError(error) {
    if (error instanceof UpgradeAdminError) return error;
    if (error instanceof UpgradeOperationError && Object.hasOwn(errors, error.code)) return new UpgradeAdminError(error.code);
    return new UpgradeAdminError('operation_unavailable');
  }
  return {
    async check() {
      if (!config) return { available: false };
      // Do not call the OAuth broker on a read path: it may refresh credentials
      // or delete a bootstrap secret. This is feed verification, not live readiness.
      const { release, manifestSha256 } = await artifacts(true);
      return release.version === config.currentVersion ? { currentVersion: config.currentVersion }
        : { currentVersion: config.currentVersion, nextVersion: release.version,
          ...(manifestSha256 ? { manifestSha256, includesEnrollment: true } : { releaseSha256: release.workerSha256 }) };
    },
    async status() {
      if (!config) return { phase: 'idle' };
      const { releaseSha256, manifestSha256, ...status } = await persisted();
      // Version of this responding Worker alongside the historical journal;
      // this is not a live Cloudflare deployment or application health check.
      return { ...status, currentVersion: config.currentVersion };
    },
    async reconcile(input) {
      if (!config) throw new UpgradeAdminError('unavailable');
      if (!input || Object.keys(input).length !== 1 || !matches(operationUuid, input.operationId)) {
        throw new UpgradeAdminError('invalid_request');
      }
      try {
        const record = await readJournal(env.TICKETS, config.target);
        const stored = safeRecord(record);
        if (stored.operationId !== input.operationId || !phases.has(stored.phase)) {
          throw new UpgradeAdminError('reconciliation_required');
        }
        if (stored.phase === 'confirmed') return { status: 'previously_confirmed', version: stored.version, operationId: stored.operationId };
        return await confirmOperation({ expected: { ...config.target, currentVersion: config.currentVersion, activeVersion: record.baseVersion },
          operationId: stored.operationId, api: (await ownerAdapter()).api, journal: createJournal(env.TICKETS) });
      } catch (error) { throw mapError(error); }
    },
    async start(input) {
      if (!config) throw new UpgradeAdminError('unavailable');
      if (!input || Array.isArray(input) || typeof input !== 'object' ||
          Object.keys(input).length !== 3 || !Object.hasOwn(input, 'operationId') || !Object.hasOwn(input, 'version') ||
          !matches(operationUuid, input.operationId) || !matches(versionPattern, input.version) ||
          Number(Object.hasOwn(input, 'releaseSha256')) + Number(Object.hasOwn(input, 'manifestSha256')) !== 1 ||
          !matches(sha256, input.manifestSha256 ?? input.releaseSha256)) {
        throw new UpgradeAdminError('invalid_request');
      }
      const { operationId, version, releaseSha256, manifestSha256 } = input;
      const previous = await persisted();
      if (previous.operationId === operationId && (previous.version !== version ||
          (previous.manifestSha256 ? previous.manifestSha256 !== manifestSha256 : previous.releaseSha256 !== releaseSha256))) {
        throw new UpgradeAdminError('operation_conflict');
      }
      // Completed replay is available even when the feed or OAuth is offline
      // and after the new Worker serves the updated version binding.
      if (previous.phase === 'confirmed' && previous.operationId === operationId) {
        return { status: 'previously_confirmed', version, operationId };
      }
      if (previous.phase !== 'idle' && previous.phase !== 'confirmed') throw new UpgradeAdminError('reconciliation_required');
      const { release, artifact, manifestSha256: verifiedDigest } = await artifacts();
      if (release.version !== version || (verifiedDigest ? verifiedDigest !== manifestSha256 :
          manifestSha256 !== undefined || release.workerSha256 !== releaseSha256)) throw new UpgradeAdminError('release_changed');
      try {
        const { api, provider } = await ownerAdapter(Boolean(verifiedDigest));
        const enrollmentApproval = verifiedDigest && { manifestSha256,
          inspect: () => inspectEnrollment({ api: provider, db: env.TICKETS, spec: config.spec }) };
        const baseline = await api.readDeployment(config.target);
        const active = baseline?.deployments;
        if (!Array.isArray(active) || active.length !== 1 || active[0]?.percentage !== 100 ||
            !matches(uuid, active[0]?.version_id) || !matches(uuid, baseline.latestVersion)) {
          throw new UpgradeAdminError('target_drift');
        }
        if (baseline.latestVersion !== active[0].version_id) throw new UpgradeAdminError('baseline_version_mismatch');
        const expected = { ...config.target, currentVersion: config.currentVersion, activeVersion: active[0].version_id };
        const result = await runOperation({ expected, artifact, operationId, api, enrollmentApproval, journal: createJournal(env.TICKETS), now: clock() });
        if (result?.version !== version || !['deployment_confirmed', 'previously_confirmed'].includes(result?.status)) {
          throw new UpgradeAdminError('operation_unavailable');
        }
        return { status: result.status, version, operationId };
      } catch (error) { throw mapError(error); }
    },
  };
}

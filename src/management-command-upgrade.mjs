import { randomUUID } from 'node:crypto';
import { loadVerifiedUpgradeArtifacts } from '../cloud/upgrade-artifacts.mjs';
import { createCloudflareUpgradeAdapter } from '../cloud/upgrade-cloudflare.mjs';
import { ensureEnrollmentAccessRoutes, inspectEnrollmentUpgradeReadiness } from '../cloud/upgrade-enrollment-readiness.mjs';
import { createUpgradeJournal, readUpgradeJournal } from '../cloud/upgrade-journal.mjs';
import { confirmRecordedDeployment, runUpgradeOperation } from '../cloud/upgrade-operation.mjs';
import { createUpgradeD1Rest } from './upgrade-d1-rest.mjs';

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const versionPattern = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(?:-preview\.(0|[1-9]\d{0,8}))?$/;

function bindingMap(version) {
  const map = new Map();
  for (const binding of version?.bindings ?? []) {
    if (!binding?.name || map.has(binding.name)) throw new Error('Cloudflare 版本的绑定无法核实，未继续升级。');
    map.set(binding.name, binding);
  }
  return map;
}

export async function upgradeManagementFromCommand({
  api, spec, databaseId, accessAudience, signed, request = fetch, ui,
}) {
  const target = { accountId: spec.accountId, worker: spec.worker };
  const probe = createCloudflareUpgradeAdapter(api, target);
  const db = createUpgradeD1Rest(api, { accountId: spec.accountId, databaseId });
  const deployment = await probe.readDeployment(target);
  const live = deployment.deployments[0];
  if (deployment.deployments.length !== 1 || live.percentage !== 100 || !uuid.test(live.version_id)) {
    throw new Error('管理台不是单一版本运行，未上传或切换。请先在 Cloudflare 核对部署。');
  }
  const version = await probe.readVersion(target, live.version_id);
  const by = bindingMap(version);
  const plain = name => by.get(name)?.type === 'plain_text' ? by.get(name).text : undefined;
  const d1 = by.get('TICKETS');
  const doBinding = by.get('PROVISIONER_OAUTH');
  const currentVersion = plain('NODRELAY_RELEASE_VERSION');
  if (version.id !== live.version_id || !signed?.feed ||
      plain('NODRELAY_UPGRADE_CHANNEL') !== signed.channel || plain('NODRELAY_UPGRADE_FEED') !== signed.feed ||
      plain('NODRELAY_UPGRADE_PUBLIC_KEY') !== signed.publicKey ||
      !versionPattern.test(currentVersion ?? '') || (signed.channel === 'preview') !== currentVersion.includes('-preview.') ||
      plain('APP_ORIGIN') !== spec.origin || plain('OWNER_EMAIL') !== spec.ownerEmail ||
      plain('ACCESS_AUD') !== accessAudience || plain('FLEET_OAUTH_MODE') !== 'managed' ||
      plain('FLEET_OAUTH_RECOVERY') !== '1' || by.has('PROVISIONER_TOKEN') || by.has('FLEET_OAUTH_SEED') ||
      by.has('FLEET_OAUTH_RECONNECT') ||
      d1?.type !== 'd1' || d1.id !== databaseId ||
      doBinding?.type !== 'durable_object_namespace' || !doBinding.namespace_id) {
    throw new Error('运行中的管理台、数据库或升级配置与原回执不符，未上传或切换。');
  }
  let hosted;
  try { hosted = JSON.parse(plain('FLEET_SPEC')); } catch {}
  if (hosted?.accountScopedAccess !== true || !Object.entries(spec).every(([name, value]) => hosted[name] === value)) {
    throw new Error('运行中的管理台与原回执指向不同目标，未上传或切换。');
  }

  const expected = { ...target, zoneId: spec.zoneId, origin: spec.origin, ownerEmail: spec.ownerEmail,
    accessAudience, activeVersion: live.version_id, currentVersion };
  const journal = createUpgradeJournal(db);
  const previous = await readUpgradeJournal(db, target);
  if (previous && previous.phase !== 'confirmed') {
    const result = await confirmRecordedDeployment({ expected: { ...expected, activeVersion: previous.baseVersion },
      operationId: previous.operationId, api: probe, journal });
    if (result.status === 'deployment_confirmed') return { confirmedVersion: result.version };
    if (result.status === 'baseline_active_rollout_unconfirmed') {
      throw new Error('核对时 Cloudflare 流量仍全部指向旧版，候选版本已上传，但上次切换的结果仍未确认。未重新提交，请稍后查看管理台升级状态。');
    }
    throw new Error('上次上传或切换尚未确认，本次仅核对状态，未重复提交。请在管理台查看升级状态。');
  }
  if (deployment.latestVersion !== live.version_id) {
    throw new Error('Cloudflare 正在运行的版本与最近上传的版本不同。为避免继承错误配置，本次未上传或切换。');
  }
  const publicKey = await crypto.subtle.importKey('spki', Buffer.from(signed.publicKey, 'base64url'),
    'Ed25519', false, ['verify']);
  const { release, artifact, manifestSha256 } = await loadVerifiedUpgradeArtifacts({
    base: signed.feed, channel: signed.channel, publicKey, currentVersion, request, allowCurrent: true, format: 'auto',
  });
  if (release.version === currentVersion) return { currentVersion };
  ui?.note?.(`v${currentVersion} → v${release.version}。保留域名、登录、数据库和已接入设备。`, '管理台升级');
  if (release.schema === 2) {
    const added = await ensureEnrollmentAccessRoutes({ api, spec });
    if (added.length) ui?.note?.(`已为设备安装补齐公开入口：${added.join('、')}。其他登录配置未改动。`, 'Access');
  }
  const execute = () => runUpgradeOperation({
    expected, artifact, operationId: randomUUID(),
    api: createCloudflareUpgradeAdapter(api, target, { enrollment: release.schema === 2 }),
    journal,
    enrollmentApproval: release.schema === 2 ? { manifestSha256,
      inspect: () => inspectEnrollmentUpgradeReadiness({ api, db, spec }) } : undefined,
  });
  const result = ui?.wait ? await ui.wait('正在验签、上传并切换管理台版本', 'Cloudflare 已确认版本切换', execute) : await execute();
  return { confirmedVersion: result.version };
}

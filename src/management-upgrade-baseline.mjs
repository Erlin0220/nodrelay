import { createHash, randomUUID } from 'node:crypto';
import { planUpgradeBaseline, validateUpgradeBaselineCandidate } from '../cloud/upgrade-baseline-plan.mjs';
import { createCloudflareUpgradeAdapter } from '../cloud/upgrade-cloudflare.mjs';
import { commandLeaseWaitMs, createUpgradeJournal } from '../cloud/upgrade-journal.mjs';
import { createUpgradeD1Rest } from './upgrade-d1-rest.mjs';

const migrations = [
  ['0004_enrollment_intents.sql', 'enrollment_intents', ['id', 'device_id', 'code_digest', 'code_ciphertext', 'snapshot',
    'state', 'created_at', 'resolved_at', 'recovery_digest', 'claimed_architecture'], 'enrollment_intents_pending_device'],
  ['0005_upgrade_journal.sql', 'management_upgrade_journal', ['target', 'record']],
];
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

function requireTraffic(state, active, latest) {
  const visits = state?.deployments;
  if (state?.latestVersion !== latest || visits?.length !== 1 ||
      visits[0]?.version_id !== active || visits[0]?.percentage !== 100) {
    throw new Error('Cloudflare 的在用版本或最新上传发生变化，已停止，未继续切换流量。');
  }
}

function sameRecord(record, release, expected, sha256) {
  return record?.sha256 === sha256 && record.version === release.webUpgrade.version &&
    record.original === expected.activeVersion;
}

// Called only after the installer has verified its signed release and ownership
// of the exact existing managed deployment. Caller holds its install receipt lock.
// A pending write is never blindly retried. No access, domains, OAuth grants,
// secrets or catalog entries are written by this operation.
export async function adoptManagementUpgradeBaseline({ api, expected, release, journal, readMigration, onLeaseWait, onLeaseAcquired, signal }) {
  if (!(release?.bundle instanceof Uint8Array) || !release.bundle.length || !release.webUpgrade ||
      typeof journal?.read !== 'function' || typeof journal?.write !== 'function' || typeof readMigration !== 'function') {
    throw new Error('诺联升级基线缺少签名安装包或安装回执。');
  }
  const adapter = createCloudflareUpgradeAdapter(api, expected, { baseline: true });
  const digest = createHash('sha256').update(release.bundle).digest('hex');
  const previous = await journal.read();
  if (previous && !sameRecord(previous, release, expected, digest)) {
    throw new Error('安装回执记录的是另一项升级。未改动 Cloudflare。');
  }
  const first = await adapter.readDeployment(expected);
  const active = await adapter.readVersion(expected, expected.activeVersion);
  // After interrupted staging/cutover reconstruct the original plan from its
  // owned version. This synthetic input only validates old metadata; real live
  // traffic must be rechecked at each phase below.
  const historical = { deployments: [{ version_id: active.id, percentage: 100 }], latestVersion: active.id };
  const plan = planUpgradeBaseline({ release, expected, deployment: previous ? historical : first, active });
  const assertFresh = async latest => requireTraffic(await adapter.readDeployment(expected), expected.activeVersion, latest);

  const record = previous ?? { operationId: randomUUID(), original: active.id, version: release.webUpgrade.version, sha256: digest };
  if (previous?.phase === 'deploying' || previous?.phase === 'confirmed') {
    // Recover an acknowledged or ambiguous commit only from exact Cloudflare
    // version and traffic readback, never by sending a second deployment POST.
    if (!uuid.test(previous.staged?.id ?? '')) throw new Error('安装回执缺少 Cloudflare 候选版本。');
    requireTraffic(first, previous.staged.id, previous.staged.id);
    validateUpgradeBaselineCandidate(plan, { staged: previous.staged, candidate: await adapter.readVersion(expected, previous.staged.id) });
    if (previous.phase !== 'confirmed') await journal.write({ ...previous, phase: 'confirmed' });
    return { versionId: previous.staged.id, releaseVersion: previous.version, recovered: true };
  }
  if (previous && !['prepared', 'staged'].includes(previous.phase)) {
    throw new Error('上次上传结果未确认。请先核对 Cloudflare 版本，不会重复上传。');
  }
  const path = '/accounts/' + expected.accountId + '/d1/database/' + expected.databaseId + '/query';
  const lease = createUpgradeJournal(createUpgradeD1Rest(api, expected), onLeaseWait ?
    { waitMs: commandLeaseWaitMs, onWait: onLeaseWait, onAcquiredAfterWait: onLeaseAcquired, signal: () => signal } : {});
  return lease.withLock(expected, async ({ assertHeld }) => {
    const fence = async latest => {
      await assertFresh(latest);
      await assertHeld();
    };
    const advance = async (next, fallback, latest) => {
      await fence(latest);
      await journal.write(next);
      try { await fence(latest); }
      catch (error) {
        // This catch surrounds only a pre-dispatch check, never an attempted write.
        await journal.write(fallback);
        throw error;
      }
    };
    let staged = previous?.staged;
    if (!staged) {
      // Trusted checked-in additive migrations: run only after full baseline
      // validation, verify tables, then check the active version again.
      for (const [file, table, columns, index] of migrations) {
        const sql = await readMigration(file);
        await fence(active.id);
        await d1Query(api, path, sql);
        const types = await d1Query(api, path,
          "SELECT name, type, pk FROM pragma_table_info(?) ORDER BY cid", [table]);
        const found = types[0]?.results ?? [];
        if (JSON.stringify(found.map(item => item.name)) !== JSON.stringify(columns) || found[0]?.pk !== 1 ||
            (index && !(await d1Query(api, path,
              "SELECT name FROM pragma_index_list(?) WHERE name = ? AND [unique] = 1 AND partial = 1",
              [table, index]))[0]?.results?.some(row => row.name === index))) {
          throw new Error('现有数据表结构与当前安装包不兼容，未切换 Worker。');
        }
      }
      await advance({ ...record, phase: 'uploading' }, { ...record, phase: 'prepared' }, active.id);
      staged = await adapter.uploadVersion(expected, { ...plan.upload, bundle: release.bundle, module: 'worker.js',
        operationId: record.operationId });
      await journal.write({ ...record, phase: 'staged', staged });
    }
    await fence(staged.id);
    validateUpgradeBaselineCandidate(plan, { staged, candidate: await adapter.readVersion(expected, staged.id) });
    await advance({ ...record, phase: 'deploying', staged }, { ...record, phase: 'staged', staged }, staged.id);
    await adapter.deployVersion(expected, { strategy: 'percentage', versions: [{ version_id: staged.id, percentage: 100 }] });
    requireTraffic(await adapter.readDeployment(expected), staged.id, staged.id);
    await journal.write({ ...record, phase: 'confirmed', staged });
    return { versionId: staged.id, releaseVersion: record.version, recovered: false };
  });
}

async function d1Query(api, endpoint, sql, params = []) {
  const results = await api.post(endpoint, { sql, params: params.map(String) });
  if (!Array.isArray(results) || !results.length || results.some(result => result.success !== true)) {
    throw new Error('Cloudflare 未确认数据迁移结果，未切换 Worker。');
  }
  return results;
}

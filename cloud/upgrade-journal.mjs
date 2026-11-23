import { base64url } from 'jose';

const duration = 90; // Same lock and duration as existing managed device mutations.
export const commandLeaseWaitMs = 95_000;
const pollMs = 3_000;
const normalLeaseLimit = duration + 5;

function key(target) {
  if (!/^[a-f0-9]{32}$/.test(target?.accountId ?? '') ||
      !/^fleet-[a-z0-9][a-z0-9-]{1,14}[a-z0-9]-[a-f0-9]{12}$/.test(target?.worker ?? '')) {
    throw new Error('Invalid upgrade journal target');
  }
  return JSON.stringify([target.accountId, target.worker]);
}

function upgradeStateError(code, message, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { code });
}

function ownership(state) {
  if (state === null) return 'missing';
  if (state?.active === 0) return 'expired';
  if (state?.active === 1 && state.own === 0) return 'other';
  if (state?.active === 1 && state.own === 1) return 'current';
  return 'unknown';
}

function diagnostic(error, stage, state, mutation) {
  error.diagnostic = {
    stage, ownership: ownership(state),
    ...(Number.isSafeInteger(mutation?.meta?.changes) && { changes: mutation.meta.changes }),
    ...(Array.isArray(mutation?.results) && { rows: mutation.results.length }),
    ...(Number.isSafeInteger(state?.seconds_left) && { secondsLeft: state.seconds_left }),
  };
  return error;
}

export async function readUpgradeJournal(db, target) {
  const row = await db.prepare('SELECT record FROM management_upgrade_journal WHERE target = ?')
    .bind(key(target)).first();
  return row ? JSON.parse(row.record) : undefined;
}

export function createUpgradeJournal(db, {
  waitMs = 0, onWait, onAcquiredAfterWait, signal = () => undefined, now = () => performance.now(),
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  return {
    async withLock(target, run) {
      const id = key(target);
      const owner = base64url.encode(crypto.getRandomValues(new Uint8Array(32)));
      const readLease = () => db.prepare(`SELECT (owner = ?) AS own, (expires_at > unixepoch()) AS active,
          (expires_at - unixepoch()) AS seconds_left FROM fleet_leases WHERE id = 1`).bind(owner).first();
      const release = () => db.prepare('DELETE FROM fleet_leases WHERE id = 1 AND owner = ?').bind(owner).run();
      let cleanup = true;
      try {
        const deadline = now() + Math.min(waitMs, commandLeaseWaitMs);
        let announced = false;
        let raced = 0;
        cleanup = false;
        for (;;) {
          signal()?.throwIfAborted();
          let claim;
          let lease;
          const unconfirmed = error => diagnostic(upgradeStateError('management_lock_unconfirmed',
            '未能核实云端管理锁。未继续升级。', error), 'acquire', lease, claim);
          const busy = message => diagnostic(upgradeStateError('management_lock_busy', message),
            'acquire', lease, claim);
          try {
            cleanup = true;
            // Claim atomically; REST writes need not return their changed row.
            claim = await db.prepare(`INSERT INTO fleet_leases (id, owner, expires_at) VALUES (1, ?, unixepoch() + ?)
              ON CONFLICT(id) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at
              WHERE fleet_leases.expires_at <= unixepoch()`).bind(owner, duration).run();
            lease = await readLease();
          } catch (error) {
            throw unconfirmed(error);
          }
          const state = ownership(lease);
          if (state === 'current') {
            signal()?.throwIfAborted();
            if (announced) onAcquiredAfterWait?.();
            break;
          }
          // A contender can release between a definite no-op and our SELECT.
          if (waitMs > 0 && claim?.meta?.changes === 0 && (state === 'missing' || state === 'expired') &&
              raced++ < 2 && now() < deadline) continue;
          if (state !== 'other') throw unconfirmed();

          cleanup = false; // Never release somebody else's claim.
          if (!waitMs) throw busy('另一个管理操作持有云端锁。请等它结束，再重试。');
          while (ownership(lease) === 'other') {
            const remaining = deadline - now();
            const seconds = lease.seconds_left;
            if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > normalLeaseLimit) {
              throw busy('云端锁的到期时间异常，未继续升级。请核对日志，不要手动清锁。');
            }
            if (remaining <= 0) throw busy(`云端锁仍被占用，已停止自动等待。当前预计还剩 ${seconds} 秒，未重复提交升级。`);
            if (!announced) { onWait?.(); announced = true; }
            await sleep(Math.min(remaining, pollMs));
            signal()?.throwIfAborted();
            try { lease = await readLease(); } catch (error) { throw unconfirmed(error); }
          }
          if (!['missing', 'expired'].includes(ownership(lease))) throw unconfirmed();
          if (now() >= deadline) {
            throw unconfirmed();
          }
        }
        const assertHeld = async () => {
          let state;
          let mutation;
          try {
            mutation = await db.prepare('UPDATE fleet_leases SET expires_at = unixepoch() + ? WHERE id = 1 AND owner = ? AND expires_at > unixepoch()')
              .bind(duration, owner).run();
            state = await readLease();
          } catch (error) {
            throw diagnostic(upgradeStateError('management_lock_lost', '无法核实云端管理锁仍属于本次操作。未继续升级。', error),
              'renew', state, mutation);
          }
          if (ownership(state) !== 'current') {
            throw diagnostic(upgradeStateError('management_lock_lost', '升级操作已失去锁。请核对状态后再试。'),
              'renew', state, mutation);
          }
        };
        return await run({
          assertHeld,
          read: () => readUpgradeJournal(db, target),
          async write(record) {
            const data = JSON.stringify(record);
            if (typeof data !== 'string' || data.length > 4096) throw new Error('Invalid upgrade journal record');
            let verified;
            let mutation;
            try {
              mutation = await db.prepare(`INSERT INTO management_upgrade_journal (target, record)
                SELECT ?, ? WHERE EXISTS (SELECT 1 FROM fleet_leases WHERE id = 1 AND owner = ? AND expires_at > unixepoch())
                ON CONFLICT(target) DO UPDATE SET record = excluded.record`).bind(id, data, owner).run();
              verified = await db.prepare(`SELECT (record = ?) AS matched FROM management_upgrade_journal
                WHERE target = ? AND EXISTS (SELECT 1 FROM fleet_leases WHERE id = 1 AND owner = ? AND expires_at > unixepoch())`)
                .bind(data, id, owner).first();
            } catch (error) {
              throw diagnostic(upgradeStateError('management_journal_unconfirmed', '未能核实升级记录。请先核对当前状态，不要重复提交。', error),
                'journal_write', undefined, mutation);
            }
            if (verified?.matched !== 1) {
              throw diagnostic(upgradeStateError('management_journal_unconfirmed', '未能核实升级记录。请先核对当前状态，不要重复提交。'),
                'journal_write', undefined, mutation);
            }
          },
        });
      } finally {
        // Includes an ambiguous claim or failed readback. The owner predicate
        // prevents removing any other user's lock; expiry is the last resort.
        if (cleanup) { try { await release(); } catch { /* Lease expires. */ } }
      }
    },
  };
}

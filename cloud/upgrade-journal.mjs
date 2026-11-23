import { base64url } from 'jose';

const duration = 90; // Same lock and duration as existing managed device mutations.

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
  };
  return error;
}

export async function readUpgradeJournal(db, target) {
  const row = await db.prepare('SELECT record FROM management_upgrade_journal WHERE target = ?')
    .bind(key(target)).first();
  return row ? JSON.parse(row.record) : undefined;
}

export function createUpgradeJournal(db) {
  return {
    async withLock(target, run) {
      const id = key(target);
      const owner = base64url.encode(crypto.getRandomValues(new Uint8Array(32)));
      const readLease = () => db.prepare(`SELECT (owner = ?) AS own, (expires_at > unixepoch()) AS active
        FROM fleet_leases WHERE id = 1`).bind(owner).first();
      const release = () => db.prepare('DELETE FROM fleet_leases WHERE id = 1 AND owner = ?').bind(owner).run();
      let cleanup = true;
      try {
        let claim;
        let lease;
        try {
          // Keep the claim atomic. REST write responses can omit rows;
          // a separate read is the authority on ownership, not RETURNING.
          claim = await db.prepare(`INSERT INTO fleet_leases (id, owner, expires_at) VALUES (1, ?, unixepoch() + ?)
            ON CONFLICT(id) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at
            WHERE fleet_leases.expires_at <= unixepoch()`).bind(owner, duration).run();
          lease = await readLease();
        } catch (error) {
          throw diagnostic(upgradeStateError('management_lock_unconfirmed', '未能核实云端管理锁。未继续升级。', error),
            'acquire', lease, claim);
        }
        if (ownership(lease) !== 'current') {
          if (ownership(lease) === 'other') {
            cleanup = false;
            throw diagnostic(upgradeStateError('management_lock_busy', '另一个管理操作持有云端锁。请等它结束，再重试。'),
              'acquire', lease, claim);
          }
          throw diagnostic(upgradeStateError('management_lock_unconfirmed', '未能核实云端管理锁。未继续升级。'),
            'acquire', lease, claim);
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

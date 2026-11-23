import { base64url } from 'jose';

const duration = 90; // Same lock and duration as existing managed device mutations.

function key(target) {
  if (!/^[a-f0-9]{32}$/.test(target?.accountId ?? '') ||
      !/^fleet-[a-z0-9][a-z0-9-]{1,14}[a-z0-9]-[a-f0-9]{12}$/.test(target?.worker ?? '')) {
    throw new Error('Invalid upgrade journal target');
  }
  return JSON.stringify([target.accountId, target.worker]);
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
      // Browser and remote installer share D1's clock, not their local clocks.
      const lease = await db.prepare(`INSERT INTO fleet_leases (id, owner, expires_at) VALUES (1, ?, unixepoch() + ?)
        ON CONFLICT(id) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at
        WHERE fleet_leases.expires_at <= unixepoch() RETURNING owner`).bind(owner, duration).first();
      if (!lease) throw new Error('已有管理操作正在执行。请先等待其结果，不要重复提交。');
      const assertHeld = async () => {
        const result = await db.prepare('UPDATE fleet_leases SET expires_at = unixepoch() + ? WHERE id = 1 AND owner = ? AND expires_at > unixepoch() RETURNING owner')
          .bind(duration, owner).first();
        if (!result) throw new Error('升级操作已失去锁。请核对状态后再试。');
      };
      try {
        return await run({
          assertHeld,
          read: () => readUpgradeJournal(db, target),
          async write(record) {
            const data = JSON.stringify(record);
            if (typeof data !== 'string' || data.length > 4096) throw new Error('Invalid upgrade journal record');
            const written = await db.prepare(`INSERT INTO management_upgrade_journal (target, record)
              SELECT ?, ? WHERE EXISTS (SELECT 1 FROM fleet_leases WHERE id = 1 AND owner = ? AND expires_at > unixepoch())
              ON CONFLICT(target) DO UPDATE SET record = excluded.record RETURNING target`)
              .bind(id, data, owner).first();
            if (!written) throw new Error('升级操作已失去锁。未更改升级记录。');
          },
        });
      } finally {
        await db.prepare('DELETE FROM fleet_leases WHERE id = 1 AND owner = ?').bind(owner).run().catch(() => {});
      }
    },
  };
}

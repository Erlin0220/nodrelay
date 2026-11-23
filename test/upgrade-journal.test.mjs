import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createUpgradeJournal, readUpgradeJournal } from '../cloud/upgrade-journal.mjs';
import { deviceLease } from '../cloud/devices.mjs';

const target = { accountId: 'a'.repeat(32), worker: 'fleet-night-0123456789ab' };
async function dbFixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  for (const file of ['0002_devices.sql', '0005_upgrade_journal.sql'])
    db.exec(await readFile(new URL('../cloud/' + file, import.meta.url), 'utf8'));
  return { db, d1: { prepare(sql) {
    const statement = db.prepare(sql);
    return { bind(...args) { return { async first() { return statement.get(...args); }, async run() { return statement.run(...args); } }; } };
  } } };
}
test('persists pre-write journal across executions and release, serializing against device mutations', async t => {
  const { d1 } = await dbFixture(t);
  const journal = createUpgradeJournal(d1);
  assert.equal(await readUpgradeJournal(d1, target), undefined);
  await journal.withLock(target, async txn => {
    await assert.rejects(deviceLease(d1, () => assert.fail('blocked device mutation')), /operation is still running/);
    await assert.rejects(journal.withLock(target, () => assert.fail('blocked duplicate upgrade')), { code: 'management_lock_busy' });
    await txn.assertHeld();
    await txn.write({ phase: 'uploading' });
    assert.deepEqual(await txn.read(), { phase: 'uploading' });
  });
  await createUpgradeJournal(d1).withLock(target, async txn => {
    assert.deepEqual(await txn.read(), { phase: 'uploading' });
    await txn.write({ phase: 'confirmed' });
  });
  assert.deepEqual(await readUpgradeJournal(d1, target), { phase: 'confirmed' });
});
test('an expired lease cannot overwrite a newer fencer or erase its lock', async t => {
  const { db, d1 } = await dbFixture(t);
  await createUpgradeJournal(d1).withLock(target, async stale => {
    db.exec("UPDATE fleet_leases SET expires_at = 0 WHERE id = 1");
    await createUpgradeJournal(d1).withLock(target, async current => {
      await current.write({ phase: 'deploying' });
      await assert.rejects(stale.assertHeld(), /失去锁/);
      await assert.rejects(stale.write({ phase: 'confirmed' }), { code: 'management_journal_unconfirmed' });
      await current.assertHeld();
    });
  });
  assert.deepEqual(await readUpgradeJournal(d1, target), { phase: 'deploying' });
});

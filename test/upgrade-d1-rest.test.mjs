import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createUpgradeD1Rest } from '../src/upgrade-d1-rest.mjs';
import { createUpgradeJournal } from '../cloud/upgrade-journal.mjs';

const target = { accountId: 'a'.repeat(32), worker: 'fleet-test-sandbox-0123456789ab',
  databaseId: '12345678-1234-1234-1234-123456789abc' };
const endpoint = '/accounts/' + target.accountId + '/d1/database/' + target.databaseId + '/query';

test('upgrade D1 REST adapter pins its target, pairs string-only parameters with unchanged SQL, and matches both first and all results', async () => {
  let next = [];
  const requests = [];
  const db = createUpgradeD1Rest({ async post(path, body) {
    requests.push({ path, body });
    return [{ success: true, results: next, meta: { changes: 0 } }];
  } }, target);
  const read = db.prepare('SELECT name, pk FROM pragma_table_info(?) ORDER BY cid');
  next = [{ name: 'record', pk: 1 }];
  const tableA = read.bind('management_upgrade_journal');
  const tableB = read.bind('enrollment_intents');
  assert.deepEqual(await tableA.all(), { success: true, results: next, meta: { changes: 0 } });
  assert.deepEqual(await tableB.first(), next[0]);
  next = [];
  assert.equal(await read.bind("scope' OR 1=1").first(), null);
  await db.prepare('DELETE FROM fleet_leases WHERE id = ? AND owner = ?').bind(1, 'fixture-owner').run();
  assert.deepEqual(requests.map(x => [x.path, x.body.params]), [
    [endpoint, ['management_upgrade_journal']], [endpoint, ['enrollment_intents']], [endpoint, ["scope' OR 1=1"]],
    [endpoint, ['1', 'fixture-owner']],
  ]);
  assert.ok(requests[2].body.sql.includes('(?)'));
});

test('invalid target, SQL, bindings or mismatched method stop before any D1 provider call', async () => {
  let submitted = false;
  const api = { async post() { submitted = true; } };
  for (const change of [{ accountId: 'A'.repeat(32) }, { accountId: 'other/path' },
    { databaseId: 'a'.repeat(32) }, { databaseId: target.databaseId + '?origin=elsewhere' }]) {
    assert.throws(() => createUpgradeD1Rest(api, { ...target, ...change }), /D1/);
  }
  const db = createUpgradeD1Rest(api, target);
  for (const sql of ['SELECT 1; DELETE FROM fleet_leases', 'DROP TABLE fleet_leases', 'SELECT 1 /* extra */',
    'SELECT 1 -- comment', 'PRAGMA user_version']) assert.throws(() => db.prepare(sql), /statement/);
  for (const value of [false, 1.1, Infinity, null, { arbitrary: true }, 'a'.repeat(4097)]) {
    assert.throws(() => db.prepare('SELECT ?').bind(value), /parameters/);
  }
  await assert.rejects(db.prepare('UPDATE fleet_leases SET expires_at = 1').all(), /read-only/);
  await assert.rejects(db.prepare('SELECT 1').run(), /write upgrade/);
  await assert.rejects(db.prepare('DELETE FROM fleet_leases').first(), /first-row/);
  assert.equal(submitted, false);
});

test('refuses ambiguous or failed result and does not attempt a second POST', async () => {
  const fixture = { success: true, results: [] };
  for (const payload of [undefined, [], [fixture, fixture], [{ success: false, results: [] }],
    [{ success: true }], [{ success: true, results: ['wrong'] }], [{ success: true, results: [], meta: 'wrong' }]]) {
    let calls = 0;
    const db = createUpgradeD1Rest({ async post() { calls++; return payload; } }, target);
    await assert.rejects(db.prepare('SELECT 1').first(), /未经|未确认/);
    assert.equal(calls, 1);
  }
});

test('CLI REST transport and Worker binding share the real SQLite lease and journal semantics', async t => {
  const sqlite = new DatabaseSync(':memory:');
  t.after(() => sqlite.close());
  sqlite.exec('CREATE TABLE fleet_leases (id INTEGER PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL)');
  sqlite.exec(await readFile(new URL('../cloud/0005_upgrade_journal.sql', import.meta.url), 'utf8'));
  const native = { prepare(sql) {
    return { bind(...params) {
      return { first: async () => sqlite.prepare(sql).get(...params) ?? null,
        run: async () => sqlite.prepare(sql).run(...params) };
    } };
  } };
  const db = createUpgradeD1Rest({ async post(path, { sql, params }) {
    assert.equal(path, endpoint);
    if (sql.trimStart().startsWith('SELECT')) return [{ success: true, results: sqlite.prepare(sql).all(...params) }];
    const { changes } = sqlite.prepare(sql).run(...params);
    // Live D1 REST responses need not return rows for write statements.
    return [{ success: true, ...(sql.startsWith('DELETE') && { results: [] }), meta: { changes } }];
  } }, target);
  const cli = createUpgradeJournal(db), browser = createUpgradeJournal(native);
  const record = { phase: 'uploading', target: 'fixture' };
  await cli.withLock(target, async txn => {
    assert.equal(await txn.read(), undefined);
    await txn.assertHeld();
    await txn.write(record);
    assert.deepEqual(await txn.read(), record);
    await assert.rejects(browser.withLock(target, async () => assert.fail('browser took a live CLI lease')), { code: 'management_lock_busy' });
  });
  await browser.withLock(target, async txn => {
    assert.deepEqual(await txn.read(), record);
    await assert.rejects(cli.withLock(target, async () => assert.fail('CLI took a live browser lease')), { code: 'management_lock_busy' });
    await txn.write({ ...record, phase: 'confirmed' });
  });
  await cli.withLock(target, async txn => assert.deepEqual(await txn.read(), { ...record, phase: 'confirmed' }));
});

test('an unconfirmed lease fails closed, releases only its own write, and never calls the upgrade body', async t => {
  const sqlite = new DatabaseSync(':memory:');
  t.after(() => sqlite.close());
  sqlite.exec('CREATE TABLE fleet_leases (id INTEGER PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL)');
  let fault = 'readback_missing';
  const db = createUpgradeD1Rest({ async post(_path, { sql, params }) {
    if (sql.startsWith('SELECT')) {
      if (fault === 'readback_missing') return [{ success: true, results: [] }];
      return [{ success: true, results: sqlite.prepare(sql).all(...params) }];
    }
    const { changes } = sqlite.prepare(sql).run(...params);
    if (fault === 'lost_ack' && sql.startsWith('INSERT')) throw new Error('reply lost');
    return [{ success: true, results: null, meta: { changes } }];
  } }, target);
  const journal = createUpgradeJournal(db);
  await assert.rejects(journal.withLock(target, () => assert.fail('upgrade must not start')), error => {
    assert.equal(error.code, 'management_lock_unconfirmed');
    assert.deepEqual(error.diagnostic, { stage: 'acquire', ownership: 'missing', changes: 1, rows: 0 });
    return true;
  });
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM fleet_leases').get().n, 0);
  fault = 'lost_ack';
  await assert.rejects(journal.withLock(target, () => assert.fail('upgrade must not start')), {
    code: 'management_lock_unconfirmed',
  });
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM fleet_leases').get().n, 0);
  fault = null;
  sqlite.prepare('INSERT INTO fleet_leases VALUES (1, ?, unixepoch() + 90)').run('other-worker');
  await assert.rejects(journal.withLock(target, () => assert.fail('upgrade must not start')), {
    code: 'management_lock_busy',
  });
  assert.equal(sqlite.prepare('SELECT owner FROM fleet_leases WHERE id = 1').get().owner, 'other-worker');
});

test('a REST success without a persisted journal write cannot authorize an external operation', async t => {
  const sqlite = new DatabaseSync(':memory:');
  t.after(() => sqlite.close());
  sqlite.exec('CREATE TABLE fleet_leases (id INTEGER PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL)');
  sqlite.exec(await readFile(new URL('../cloud/0005_upgrade_journal.sql', import.meta.url), 'utf8'));
  const db = createUpgradeD1Rest({ async post(_path, { sql, params }) {
    if (sql.startsWith('SELECT')) return [{ success: true, results: sqlite.prepare(sql).all(...params) }];
    if (sql.startsWith('INSERT INTO management_upgrade_journal')) {
      return [{ success: true, results: [], meta: { changes: 1 } }];
    }
    const { changes } = sqlite.prepare(sql).run(...params);
    return [{ success: true, results: [], meta: { changes } }];
  } }, target);
  await assert.rejects(createUpgradeJournal(db).withLock(target, async txn => {
    await txn.write({ phase: 'uploading' });
    assert.fail('must not continue without an exact durable record');
  }), { code: 'management_journal_unconfirmed' });
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM fleet_leases').get().n, 0);
});

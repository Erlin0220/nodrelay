import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { enrollmentUpgradeAccessPaths } from '../cloud/upgrade-enrollment-release.mjs';
import { inspectEnrollmentUpgradeReadiness } from '../cloud/upgrade-enrollment-readiness.mjs';

const spec = { origin: 'https://qa.example.test', accountId: 'a'.repeat(32),
  worker: 'fleet-fixture-111111111111', label: 'fleet-fixture-111111111111', accountScopedAccess: true };
const root = '/accounts/' + spec.accountId + '/access/apps';
async function state(t, { wider = false, missing = false, absentPolicy = false, drift = false, indexDrift } = {}) {
  const sqlite = new DatabaseSync(':memory:');
  t.after(() => sqlite.close());
  for (const name of ['0004_enrollment_intents.sql', '0005_upgrade_journal.sql']) {
    if (!drift || name.startsWith('0005')) sqlite.exec(await readFile(new URL('../cloud/' + name, import.meta.url), 'utf8'));
  }
  if (indexDrift) {
    sqlite.exec('DROP INDEX enrollment_intents_pending_device');
    sqlite.exec('CREATE UNIQUE INDEX enrollment_intents_pending_device ON enrollment_intents ' + indexDrift);
  }
  const applications = enrollmentUpgradeAccessPaths.map((path, index) => {
    const domain = 'qa.example.test' + path;
    return { id: String(index + 1).repeat(32), name: spec.label + path.replaceAll('/', '-'), type: 'self_hosted', domain,
      destinations: [{ type: 'public', uri: domain }, ...(wider && index === 0 ? [{ type: 'public', uri:'qa.example.test/*' }] : [])] };
  });
  if (missing) applications.shift();
  const steps = [];
  const api = {
    async list(path) {
      steps.push('list');
      if (path === root) return applications;
      if (path.endsWith('/policies')) return absentPolicy ? [] : [{
        name: spec.label + '-device-bootstrap', decision: 'bypass', include: [{ everyone: {} }], exclude: [], require: [],
      }];
      throw new Error('Unknown Cloudflare route');
    },
    async get(path) {
      steps.push('get');
      return applications.find(app => path === root + '/' + app.id);
    },
    async post() { throw new Error('Supplied API must not be used for writes'); },
  };
  const db = { prepare(query) { const statement = sqlite.prepare(query); return {
    bind(...args) { return { async all() { return { results: statement.all(...args) }; } }; },
    async first() { return statement.get() ?? null; },
  }; } };
  return { steps, run: () => inspectEnrollmentUpgradeReadiness({ api, db, spec }) };
}

test('reads the existing schema and every exact public bootstrap Access route without modifying provider resources', async t => {
  const fixture = await state(t);
  const checks = await fixture.run();
  assert.equal(checks.verifiedD1, true);
  assert.deepEqual(Object.keys(checks.exactAccessRoutes), enrollmentUpgradeAccessPaths);
  assert.equal(fixture.steps.filter(x => x === 'get').length, 5);
});

test('stops before upgrade for stale schema, any missing Access route/rule, or broader public destinations', async t => {
  const absentSchema = await state(t, { drift: true });
  await assert.rejects(absentSchema.run(), /expected D1/);
  assert.deepEqual(absentSchema.steps, []);
  for (const flags of [{ missing:true }, { absentPolicy:true }]) {
    await assert.rejects((await state(t, flags)).run(), /original exact enrollment Access|policy does not match/);
  }
  await assert.rejects((await state(t, { wider:true })).run(), /different or wider/);
});

test('rejects a same-name pending index with the wrong key or state filter before reading Access', async t => {
  for (const indexDrift of ["(code_digest) WHERE state = 'pending'", "(device_id) WHERE state = 'claimed'"]) {
    const fixture = await state(t, { indexDrift });
    await assert.rejects(fixture.run(), /expected pending-device index/);
    assert.deepEqual(fixture.steps, []);
  }
});

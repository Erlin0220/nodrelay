import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import test from 'node:test';
import { checkLegacyLoopback, deviceRegistrationText, LoopbackConflictError, waitForDeviceRegistration } from '../src/device-install-status.mjs';

test('preflight reports both occupied legacy ports and closes only its own listeners', async () => {
  const looked = [];
  const closed = [];
  const foreign = Object.assign(new Error('foreign process'), { code: 'EADDRINUSE' });
  await assert.rejects(checkLegacyLoopback(true, { open: async port => {
    looked.push(port);
    if (port !== 7831) throw foreign;
    return async () => closed.push(port);
  } }), error => {
    assert.ok(error instanceof LoopbackConflictError);
    assert.deepEqual(error.ports, [7829, 7830]);
    return true;
  });
  assert.deepEqual(looked, [7829, 7830, 7831]);
  assert.deepEqual(closed, [7831]);
});

test('preflight does not test disabled browser port or disguise permission errors as conflicts', async () => {
  const looked = [];
  const denied = Object.assign(new Error('denied'), { code: 'EACCES' });
  let closed = false;
  await assert.rejects(checkLegacyLoopback(false, { open: async port => {
    looked.push(port);
    if (port === 7830) throw denied;
    return async () => { closed = true; };
  } }), denied);
  assert.deepEqual(looked, [7829, 7830]);
  assert.equal(closed, true);
});

test('installer ignores stale active status and waits for a genuine current registration', async () => {
  const startedAt = Date.parse('2026-01-01T00:00:00Z');
  let clock = startedAt;
  const observations = [
    { status: 'active', observedAt: new Date(startedAt - 1000).toISOString() },
    { status: 'unconfirmed', httpStatus: 409, observedAt: new Date(startedAt).toISOString() },
    { status: 'active', observedAt: new Date(startedAt + 400).toISOString() },
  ];
  const current = await waitForDeviceRegistration('fixture', startedAt, {
    now: () => clock, sleep: async ms => { clock += ms; }, load: async () => observations.shift(),
  });
  assert.equal(clock, startedAt + 500);
  assert.equal(current.status, 'active');
});

test('terminal reports timeout or a conflict honestly and requires no duplicate install', async () => {
  let clock = 1000;
  const conflict = { status: 'unconfirmed', httpStatus: 409, observedAt: new Date(1000).toISOString() };
  const current = await waitForDeviceRegistration('fixture', 1000, {
    timeout: 400, now: () => clock, sleep: async ms => { clock += ms; }, load: async () => conflict,
  });
  assert.deepEqual(current, conflict);
  assert.match(deviceRegistrationText(current), /尚未确认.*HTTP 409.*不用重新生成/);
  assert.match(deviceRegistrationText({ status: 'revoked' }), /撤销/);
  assert.match(deviceRegistrationText({ status: 'active' }), /管理台已确认/);
});

test('an actual exclusive loopback bind detects an unrelated listener without interrupting it', async t => {
  const other = createServer();
  await new Promise((resolve, reject) => {
    other.once('error', reject);
    other.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => other.close(resolve)));
  const { port } = other.address();
  await assert.rejects(checkLegacyLoopback(false, { ports: [[port, '测试服务']] }), {
    name: 'Error', message: new RegExp(String(port)),
  });
  assert.equal(other.address().port, port);
  assert.equal(other.listening, true);
});

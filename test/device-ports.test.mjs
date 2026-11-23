import assert from 'node:assert/strict';
import test from 'node:test';
import { bootstrapInstaller } from '../cloud/install-command.mjs';
import { validateCredentials, validateDevicePorts } from '../cloud/tickets.mjs';
import { chooseLoopbackPorts, legacyPorts, LoopbackConflictError, portalPorts } from '../src/device-install-status.mjs';

const inUse = () => Object.assign(new Error('foreign process'), { code: 'EADDRINUSE' });

function fakeHost(occupied = []) {
  const open = new Set();
  let next = 50000;
  const opener = async port => {
    if (occupied.includes(port)) throw inUse();
    const bound = port === 0 ? next++ : port;
    assert.ok(!open.has(bound), 'a probe must never reuse a port that is still held');
    open.add(bound);
    return { port: bound, close: async () => { open.delete(bound); } };
  };
  return { opener, open };
}

test('a fresh instance keeps the legacy ports while every one of them is free', async () => {
  const host = fakeHost();
  assert.deepEqual(await chooseLoopbackPorts(true, { negotiable: true, open: host.opener }), legacyPorts(true));
  assert.deepEqual(legacyPorts(false), { development: 7829, runtime: 7830 });
  assert.equal(host.open.size, 0);
});

test('an occupied legacy port is reported without fallback when the console cannot route other ports', async () => {
  const host = fakeHost([7830]);
  await assert.rejects(chooseLoopbackPorts(false, { open: host.opener }), error =>
    error instanceof LoopbackConflictError && error.ports.length === 1 && error.ports[0] === 7830 &&
    /安装未领取设备票据/.test(error.message) && /升级管理台/.test(error.message));
  assert.equal(host.open.size, 0);
});

test('a negotiating console gets a complete distinct set of kernel ports beside an existing instance', async () => {
  const host = fakeHost([7829, 7831]);
  const ports = await chooseLoopbackPorts(true, { negotiable: true, open: host.opener });
  assert.deepEqual(Object.keys(ports).sort(), ['browser', 'development', 'runtime']);
  assert.equal(new Set(Object.values(ports)).size, 3);
  assert.ok(Object.values(ports).every(port => ![7829, 7830, 7831].includes(port)));
  assert.deepEqual(portalPorts(ports), { development: ports.development, browser: ports.browser });
  assert.equal(host.open.size, 0);
});

test('ports persisted by an earlier attempt are verified and never replaced', async () => {
  const previous = { development: 41001, runtime: 41002 };
  assert.deepEqual(await chooseLoopbackPorts(false, { negotiable: true, previous, open: fakeHost().opener }), previous);
  await assert.rejects(chooseLoopbackPorts(false, { negotiable: true, previous, open: fakeHost([41002]).opener }),
    error => error instanceof LoopbackConflictError && error.ports[0] === 41002);
});

test('device port records accept exactly the Portal-facing roles of the release', () => {
  assert.deepEqual(validateDevicePorts({ browser: 41003, development: 41001 }, true), { development: 41001, browser: 41003 });
  for (const [ports, browser] of [
    [{ development: 41001 }, true], [{ development: 41001, browser: 41003 }, false], [{ development: 41001, browser: 41001 }, true],
    [{ development: 80 }, false], [{ development: '41001' }, false], [{ development: 41001, runtime: 41002 }, false], [[41001], false], [null, false],
  ]) assert.throws(() => validateDevicePorts(ports, browser), /Invalid device ports/);
});

test('device credentials carry negotiated ports only when they match the browser capability', () => {
  const base = { deviceId: 'mac-mini', portalToken: 'p'.repeat(43), tunnelToken: 't'.repeat(40), activationToken: 'a'.repeat(43) };
  assert.deepEqual(validateCredentials({ ...base, ports: { development: 41001 }, extra: true }), { ...base, ports: { development: 41001 } });
  assert.deepEqual(validateCredentials(base), base);
  assert.throws(() => validateCredentials({ ...base, ports: { development: 41001, browser: 41003 } }), /Invalid device ports/);
});

test('only the enrollment-intent bootstrap tells the device that the console routes negotiated ports', () => {
  const asset = { url: 'https://downloads.example.test/fleet.tgz', sha256: 'a'.repeat(64) };
  const group = { version: '1.0.0', assets: { x64: asset } };
  for (const os of ['linux', 'windows']) {
    assert.match(bootstrapInstaller('https://console.example.test', os, group, { enrollmentIntent: true }), /DEVSPACE_FLEET_PORT_PROTOCOL/);
    assert.doesNotMatch(bootstrapInstaller('https://console.example.test', os, group), /DEVSPACE_FLEET_PORT_PROTOCOL/);
  }
});

test('the installer names each local port that never started listening before any Cloudflare result', async () => {
  const { waitForLocalServices, LocalServiceError } = await import('../src/device-install-status.mjs');
  let clock = 0;
  const up = new Set([41001]);
  const options = { timeout: 3000, now: () => clock, sleep: async ms => { clock += ms; if (clock >= 1000) up.add(41002); } };
  const probed = [];
  const probe = async port => { probed.push(port); return up.has(port); };
  assert.deepEqual(await waitForLocalServices({ development: 41001, runtime: 41002 }, { ...options, probe }), []);
  assert.ok(probed.filter(port => port === 41001).length === 1, 'a port already listening is not probed again');
  clock = 0;
  const missing = await waitForLocalServices({ development: 41001, runtime: 41002, browser: 41003 }, { ...options, probe });
  assert.deepEqual(missing, [[41003, '浏览器 MCP']]);
  const error = new LocalServiceError(missing, '/private/service.log');
  assert.match(error.message, /41003（浏览器 MCP）.*Cloudflare 与 Portal 尚未检查.*\/private\/service\.log/);
});

test('a real loopback listener counts as started and a closed port does not', async () => {
  const { createServer } = await import('node:net');
  const { waitForLocalServices } = await import('../src/device-install-status.mjs');
  const server = createServer(socket => socket.destroy());
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const open = server.address().port;
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const closed = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  try {
    assert.deepEqual(await waitForLocalServices({ development: open, runtime: closed }, { timeout: 300 }), [[closed, 'Personal DevSpace']]);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('the activation check reports local MCP names and keeps only well-formed server states from the console', async () => {
  const { checkConnection } = await import('../src/device-connection.mjs');
  const sent = [];
  const request = async (_url, init) => {
    sent.push(JSON.parse(init.body));
    return Response.json({ status: 'active', servers: [
      { name: 'files', status: 'registered' }, { name: 'git', status: 'pending', reason: 'http_error' },
      { name: 'Bad', status: 'registered' }, { name: 'odd', status: 'weird' }, { name: 'xx', status: 'pending', reason: 'has spaces' },
    ] });
  };
  const config = { manager: 'https://console.example.test', deviceId: 'mac-mini' };
  const signal = new AbortController().signal;
  const result = await checkConnection(config, 'a'.repeat(43), signal, { request, servers: ['files', 'git'] });
  assert.deepEqual(sent[0], { deviceId: 'mac-mini', servers: ['files', 'git'] });
  assert.deepEqual(result, { status: 'active', servers: [{ name: 'files', status: 'registered' },
    { name: 'git', status: 'pending', reason: 'http_error' }, { name: 'xx', status: 'pending' }] });
  await checkConnection(config, 'a'.repeat(43), signal, { request });
  assert.deepEqual(sent[1], { deviceId: 'mac-mini' }, 'an unreadable MCP file sends no list');
});

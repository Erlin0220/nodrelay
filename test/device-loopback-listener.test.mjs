import assert from 'node:assert/strict';
import test from 'node:test';
import { bindDeviceLoopback } from '../src/device.mjs';

async function start(t, identity) {
  const binding = await bindDeviceLoopback((_request, reply) => reply.end(identity), 0);
  t.after(() => new Promise((resolve, reject) => {
    binding.listener.close(error => error ? reject(error) : resolve());
  }));
  return binding;
}

async function read({ port }) {
  const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(3000) });
  assert.equal(response.status, 200);
  return response.text();
}

test('kernel-assigned loopback listeners stay bound and serve only their own endpoints', async t => {
  const [legacy, first, second] = await Promise.all([
    start(t, 'legacy'), start(t, 'first'), start(t, 'second'),
  ]);
  assert.equal(new Set([legacy.port, first.port, second.port]).size, 3);
  for (const binding of [legacy, first, second]) {
    assert.deepEqual(binding.listener.address(), { address: '127.0.0.1', family: 'IPv4', port: binding.port });
    await assert.rejects(bindDeviceLoopback(() => {}, binding.port), { code: 'EADDRINUSE' });
  }
  assert.deepEqual(await Promise.all([read(legacy), read(first), read(second)]), ['legacy', 'first', 'second']);
});

test('loopback bind rejects invalid numeric inputs without opening a socket', async () => {
  for (const invalid of [-1, 65536, '7829', null, 3.5]) {
    await assert.rejects(bindDeviceLoopback(() => {}, invalid), RangeError);
  }
});

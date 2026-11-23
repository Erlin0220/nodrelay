import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadConfig, profiles } from '../src/config.mjs';
import { writePrivateFile } from '../src/private-directory.mjs';
import { call, connect, device, fixtureBackend, listen, PORTAL_TOKEN, result } from './helpers.mjs';

test('probe only opens the fixed checkout and returns a challenge-bound fingerprint', async t => {
  const marker = 'fleet-test-marker-not-a-secret-1234';
  const calls = [];
  const backend = await fixtureBackend(t, ['open_workspace', 'read', 'exec_command'], ({ name, arguments: args }) => {
    calls.push([name, args]);
    return result(name === 'open_workspace' ? { workspaceId: 'probe-fixture' } : { result: marker });
  });
  const { origin, url } = await device(t, backend.url, 'probe');
  for (const headers of [{}, { Authorization: 'Bearer ' + 'b'.repeat(43) }]) {
    assert.equal((await fetch(url, { method: 'POST', headers })).status, 401);
  }
  assert.equal((await fetch(url, { method: 'POST', headers: {
    Authorization: 'Bearer ' + PORTAL_TOKEN, Origin: 'https://foreign.invalid',
  } })).status, 403);
  assert.equal((await fetch(origin + '/mcp')).status, 404);

  const client = await connect(t, url, PORTAL_TOKEN);
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['device_probe']);
  assert.equal((await call(client, 'exec_command', { cmd: 'unused' })).isError, true);
  assert.equal((await call(client, 'device_probe', { challenge: 'bad', path: '../private' })).isError, true);
  assert.deepEqual(calls, []);
  const challenge = 'unique_challenge_1';
  const proof = await call(client, 'device_probe', { challenge });
  assert.deepEqual(proof.structuredContent, {
    deviceId: 'mac-fixture', challenge, markerSha256: createHash('sha256').update(marker).digest('hex'),
  });
  assert.ok(!JSON.stringify(proof).includes(marker));
  assert.deepEqual(calls, [
    ['open_workspace', { path: '/fixtures/acceptance', mode: 'checkout', includeBootstrapContext: false }],
    ['read', { workspaceId: 'probe-fixture', path: 'portal-probe.txt' }],
  ]);
});

test('colliding workspaces and processes stay on their device across host and Runtime reconnects', async t => {
  const tools = [...profiles.development.tools, 'run_agent'];
  const raw = 'ws_duplicate';
  const backend = async id => {
    const calls = [];
    const fixture = await fixtureBackend(t, tools, ({ name, arguments: args, _meta }) => {
      calls.push({ name, args, _meta });
      if (name === 'open_workspace') return result({ workspaceId: raw, instruction: `Use ${raw}.` });
      if (name === 'exec_command') {
        const text = `${id} 123\nProcess running with session ID 1.`;
        return { content: [{ type: 'text', text }], structuredContent: { sessionId: 1, running: true, result: text } };
      }
      return result({ id, runtimeSessionId: args.sessionId });
    });
    return { ...fixture, calls };
  };
  const [first, second] = await Promise.all([backend('first'), backend('second')]);
  const peerToken = 'p'.repeat(43);
  const [a, b] = await Promise.all([
    device(t, first.url, 'development'), device(t, second.url, 'development', { deviceId: 'another-host', portalToken: peerToken }),
  ]);
  const [client, peer] = await Promise.all([connect(t, a.url, PORTAL_TOKEN), connect(t, b.url, peerToken)]);
  const listing = (await client.listTools()).tools;
  assert.deepEqual(listing.map(tool => tool.name), profiles.development.tools);
  assert.equal(listing.find(tool => tool.name === 'write_stdin').inputSchema.properties.sessionId.type, 'string');
  assert.ok(listing.find(tool => tool.name === 'exec_command').inputSchema.required.includes('operationId'));

  const opened = await client.callTool({ name: 'open_workspace', arguments: { path: '/fixture' },
    _meta: { 'openai/session': 'conversation-a', progressToken: 41 } });
  const { workspaceId } = opened.structuredContent;
  assert.match(workspaceId, /^w[\w-]+\.[\w-]{43}$/);
  assert.equal(opened.structuredContent.instruction, `Use ${workspaceId}.`);
  assert.ok(opened.content[0].text.includes(workspaceId));
  assert.deepEqual(first.calls[0]._meta, { 'openai/session': 'conversation-a' });
  const peerWorkspace = (await call(peer, 'open_workspace', { path: '/fixture' })).structuredContent.workspaceId;
  assert.notEqual(workspaceId, peerWorkspace);
  for (const wrong of [raw, workspaceId]) {
    const rejected = await call(peer, 'exec_command', { workspaceId: wrong, operationId: randomUUID() });
    assert.match(rejected.content[0].text, /Workspace handle is invalid/);
  }
  assert.equal(second.calls.length, 1);

  const [started, peerStarted] = await Promise.all([
    call(client, 'exec_command', { workspaceId, operationId: randomUUID() }),
    call(peer, 'exec_command', { workspaceId: peerWorkspace, operationId: randomUUID() }),
  ]);
  const { sessionId } = started.structuredContent;
  assert.match(sessionId, /^p1\.[\w-]{43}$/);
  assert.match(started.content[0].text, /first 123\nProcess running with session ID p1\./);
  assert.equal(first.calls[1].args.workspaceId, raw);
  assert.notEqual(sessionId, peerStarted.structuredContent.sessionId);
  assert.equal((await call(peer, 'write_stdin', { workspaceId: peerWorkspace, sessionId })).isError, true);

  await client.close();
  const resumed = await connect(t, a.url, PORTAL_TOKEN);
  const poll = () => call(resumed, 'write_stdin', { workspaceId, sessionId });
  assert.equal((await poll()).structuredContent.runtimeSessionId, 1);
  first.dropSessions();
  const stale = await poll();
  assert.equal(stale.isError, true);
  assert.match(stale.content[0].text, /Inspect the original device/);
  assert.equal(first.calls.filter(call => call.name === 'write_stdin').length, 1);
  assert.equal((await call(peer, 'read', { workspaceId: peerWorkspace })).structuredContent.id, 'second');
  await resumed.listTools();
  assert.equal((await poll()).isError, true);
  const replacement = (await call(resumed, 'open_workspace', { path: '/fixture' })).structuredContent.workspaceId;
  assert.notEqual(replacement, workspaceId);
  assert.equal((await call(resumed, 'write_stdin', { workspaceId: replacement, sessionId })).isError, true);
  assert.equal((await call(resumed, 'read', { workspaceId: replacement })).structuredContent.id, 'first');

  first.setOffline(true);
  assert.equal((await call(resumed, 'read', { workspaceId: replacement })).isError, true);
  assert.equal((await call(peer, 'read', { workspaceId: peerWorkspace })).structuredContent.id, 'second');
  first.setOffline(false);
  const restartedAdapter = await device(t, first.url, 'development');
  const rebooted = await connect(t, restartedAdapter.url, PORTAL_TOKEN);
  assert.equal((await call(rebooted, 'read', { workspaceId: replacement })).isError, true);
  const reopened = (await call(rebooted, 'open_workspace', { path: '/fixture' })).structuredContent.workspaceId;
  assert.equal((await call(rebooted, 'read', { workspaceId: reopened })).structuredContent.id, 'first');
});

test('a lost Runtime reply leaves the command uncertain and same-key retries do not replay it', async t => {
  let dispatched = 0;
  const backend = await fixtureBackend(t, profiles.development.tools, ({ name }) => {
    assert.equal(name, 'open_workspace');
    return result({ workspaceId: 'ws_duplicate' });
  }, {
    beforeTool({ name }, res) {
      if (name !== 'exec_command') return false;
      dispatched++;
      res.destroy();
      return true;
    },
  });
  const { url } = await device(t, backend.url, 'development');
  const client = await connect(t, url, PORTAL_TOKEN);
  const { workspaceId } = (await call(client, 'open_workspace', { path: '/fixture' })).structuredContent;
  const input = { workspaceId, cmd: 'fixture operation', operationId: randomUUID() };
  const uncertain = await call(client, 'exec_command', input);
  assert.equal(uncertain.isError, true);
  assert.match(uncertain.content[0].text, /Inspect the original device/);
  assert.equal(dispatched, 1);
  await client.listTools();
  assert.deepEqual(await call(client, 'exec_command', input), uncertain);
  const replacement = (await call(client, 'open_workspace', { path: '/fixture' })).structuredContent.workspaceId;
  const changed = await call(client, 'exec_command', { ...input, workspaceId: replacement });
  assert.match(changed.content[0].text, /bound to different arguments/);
  assert.equal(dispatched, 1);
});

test('a lost adapter response can be recovered with the original operationId', { timeout: 10000 }, async t => {
  let dispatched = 0;
  let adapterReply;
  const runtimeReceived = Promise.withResolvers();
  const runtimeMayReply = Promise.withResolvers();
  t.after(() => runtimeMayReply.resolve());
  const backend = await fixtureBackend(t, profiles.development.tools, async ({ name, arguments: args }) => {
    if (name === 'open_workspace') return result({ workspaceId: 'ws_duplicate' });
    assert.equal(name, 'exec_command');
    assert.equal(args.operationId, undefined);
    const run = ++dispatched;
    runtimeReceived.resolve();
    await runtimeMayReply.promise;
    return result({ run });
  });
  const { url } = await device(t, backend.url, 'development');
  const client = await connect(t, url, PORTAL_TOKEN);
  const { workspaceId } = (await call(client, 'open_workspace', { path: '/fixture' })).structuredContent;
  const input = { workspaceId, cmd: 'fixture operation', operationId: randomUUID() };

  const missingKey = await call(client, 'exec_command', { workspaceId, cmd: input.cmd });
  assert.match(missingKey.content[0].text, /UUID v4 operationId/);
  assert.equal(dispatched, 0);

  // The relay reads the completed MCP response, then closes the outer client socket.
  const relay = await listen(t, createServer(async (req, res) => {
    const body = [];
    for await (const chunk of req) body.push(chunk);
    try {
      const upstream = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: req.headers.authorization,
          Accept: 'application/json, text/event-stream',
          'Content-Type': 'application/json',
        },
        body: Buffer.concat(body),
      });
      adapterReply = await upstream.json();
    } catch (error) {
      adapterReply = { error };
    } finally {
      res.destroy();
    }
  }));
  const outerFailure = assert.rejects(fetch(relay, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + PORTAL_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 712, method: 'tools/call',
      params: { name: 'exec_command', arguments: input } }),
  }), /fetch failed/);
  await Promise.race([runtimeReceived.promise, outerFailure]);
  assert.equal(dispatched, 1);
  const pending = await call(client, 'exec_command', input);
  assert.match(pending.content[0].text, /in progress/);
  runtimeMayReply.resolve();
  await outerFailure;
  assert.deepEqual(adapterReply.result.structuredContent, { run: 1 });

  await client.close();
  const reconnected = await connect(t, url, PORTAL_TOKEN);
  const reordered = { cmd: input.cmd, operationId: input.operationId, workspaceId };
  assert.deepEqual(await call(reconnected, 'exec_command', reordered), adapterReply.result);
  const conflict = await call(reconnected, 'exec_command', { ...input, cmd: 'different operation' });
  assert.match(conflict.content[0].text, /bound to different arguments/);
  assert.equal(dispatched, 1);
  assert.deepEqual((await call(reconnected, 'exec_command', { ...input, operationId: randomUUID() })).structuredContent, { run: 2 });
});

test('a command keeps its reply when the client disconnects after dispatch', { timeout: 10000 }, async t => {
  let dispatched = 0;
  const dispatchedCommand = Promise.withResolvers();
  const finish = Promise.withResolvers();
  t.after(() => finish.resolve());
  const backend = await fixtureBackend(t, profiles.development.tools, async ({ name }) => {
    if (name === 'open_workspace') return result({ workspaceId: 'ws_duplicate' });
    dispatched++;
    dispatchedCommand.resolve();
    await finish.promise;
    return result({ completed: true });
  });
  const { url } = await device(t, backend.url, 'development');
  const client = await connect(t, url, PORTAL_TOKEN);
  const { workspaceId } = (await call(client, 'open_workspace', { path: '/fixture' })).structuredContent;
  const input = { workspaceId, cmd: 'fixture operation', operationId: randomUUID() };
  const disconnect = new AbortController();
  const first = assert.rejects(fetch(url, {
    method: 'POST',
    signal: disconnect.signal,
    headers: { Authorization: 'Bearer ' + PORTAL_TOKEN, 'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 713, method: 'tools/call',
      params: { name: 'exec_command', arguments: input } }),
  }), { name: 'AbortError' });
  await Promise.race([dispatchedCommand.promise, first]);
  disconnect.abort();
  await first;
  const pending = await call(client, 'exec_command', input);
  assert.match(pending.content[0].text, /in progress/);
  finish.resolve();
  let reply;
  for (let attempt = 0; attempt < 20; attempt++) {
    reply = await call(client, 'exec_command', input);
    if (!reply.isError || !reply.content[0].text.includes('in progress')) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.deepEqual(reply.structuredContent, { completed: true }, JSON.stringify(reply));
  assert.equal(dispatched, 1);
});

test('an oversized command reply cannot be recovered or accidentally executed again', async t => {
  let dispatched = 0;
  const backend = await fixtureBackend(t, profiles.development.tools, ({ name }) => {
    if (name === 'open_workspace') return result({ workspaceId: 'ws_duplicate' });
    dispatched++;
    return result({ output: 'x'.repeat(32769) });
  });
  const client = await connect(t, (await device(t, backend.url, 'development')).url, PORTAL_TOKEN);
  const { workspaceId } = (await call(client, 'open_workspace', { path: '/fixture' })).structuredContent;
  const input = { workspaceId, cmd: 'fixture operation', operationId: randomUUID() };
  assert.equal((await call(client, 'exec_command', input)).structuredContent.output.length, 32769);
  const retry = await call(client, 'exec_command', input);
  assert.match(retry.content[0].text, /already sent and its reply is unavailable/);
  assert.equal(dispatched, 1);
});

test('a process reply cannot substitute a different upstream session identifier', async t => {
  const backend = await fixtureBackend(t, profiles.development.tools, ({ name }) => {
    if (name === 'open_workspace') return result({ workspaceId: 'ws_fixture' });
    return result({ running: true, sessionId: name === 'exec_command' ? 1 : 2 });
  });
  const client = await connect(t, (await device(t, backend.url, 'development')).url, PORTAL_TOKEN);
  const { workspaceId } = (await call(client, 'open_workspace', { path: '/fixture' })).structuredContent;
  const { sessionId } = (await call(client, 'exec_command', { workspaceId, operationId: randomUUID() })).structuredContent;
  const response = await call(client, 'write_stdin', { workspaceId, sessionId });
  assert.equal(response.isError, true);
  assert.equal(response.structuredContent?.sessionId, undefined);
});

test('browser route consumes the existing policy tools and preserves browser results', async t => {
  const args = { browser_profile: 'existing-profile', url: 'https://example.com' };
  const response = { content: [
    { type: 'text', text: 'Approved page' },
    { type: 'image', mimeType: 'image/png', data: 'AAAA' },
  ] };
  const backend = await fixtureBackend(t, [...profiles.browser.tools, 'browser_type', 'exec_command', 'browser_run_code', 'browser_evaluate'], params => {
    if (params.name === 'browser_type') {
      assert.deepEqual(params.arguments, { browser_profile: args.browser_profile, text: 'fleet sample' });
      return response;
    }
    assert.equal(params.name, 'browser_navigate');
    assert.deepEqual(params.arguments, args);
    return response;
  }, { stateless: true });
  const { url } = await device(t, backend.url, 'browser');
  const client = await connect(t, url, PORTAL_TOKEN);
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), [...profiles.browser.tools, 'browser_type']);
  assert.deepEqual(await call(client, 'browser_navigate', args), response);
  assert.deepEqual(await call(client, 'browser_type', { browser_profile: args.browser_profile, text: 'fleet sample' }), response);
  assert.equal((await call(client, 'browser_wait_for', {})).isError, true);
  assert.equal((await call(client, 'browser_evaluate', {})).isError, true);
  assert.equal((await call(client, 'browser_run_code', {})).isError, true);
  assert.equal((await call(client, 'exec_command', {})).isError, true);
});

test('a backend redirect is never followed', async t => {
  let requests = 0;
  const destination = await listen(t, { listen: (port, host, cb) => {
    const { createServer } = process.getBuiltinModule('node:http');
    return createServer((_req, res) => { requests++; res.end(); }).listen(port, host, cb);
  } });
  const redirector = await listen(t, { listen: (port, host, cb) => {
    const { createServer } = process.getBuiltinModule('node:http');
    return createServer((_req, res) => {
      res.writeHead(307, { Location: destination + '/mcp' });
      res.end();
    }).listen(port, host, cb);
  } });
  const { url } = await device(t, redirector + '/mcp', 'probe');
  const client = await connect(t, url, PORTAL_TOKEN);
  assert.equal((await call(client, 'device_probe', { challenge: 'unique_challenge_1' })).isError, true);
  assert.equal(requests, 0);
});

test('file configuration pins a loopback backend and rejects a shared credential', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'fleet-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const portalTokenFile = join(directory, 'portal.token');
  const tokenFile = join(directory, 'runtime.private.json');
  const configPath = join(directory, 'device.private.json');
  const config = {
    schema: 1, deviceId: 'mac-fixture', profile: 'development', port: 12820, portalTokenFile,
    backend: { url: 'http://127.0.0.1:12821/mcp', tokenFile, tokenKey: 'apiToken' },
  };
  await writePrivateFile(portalTokenFile, PORTAL_TOKEN);
  await writePrivateFile(tokenFile, JSON.stringify({ apiToken: 'b'.repeat(43) }));
  await writePrivateFile(configPath, JSON.stringify(config));
  const save = () => writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  await save();
  assert.equal((await loadConfig(configPath)).backend.hostname, '127.0.0.1');
  config.backend.url = 'http://localhost.example/mcp';
  await save();
  await assert.rejects(loadConfig(configPath), /loopback/);
  config.backend.url = 'http://127.0.0.1:12821/mcp';
  await save();
  await writeFile(tokenFile, JSON.stringify({ apiToken: PORTAL_TOKEN }));
  await assert.rejects(loadConfig(configPath), /independent Portal token/);
});

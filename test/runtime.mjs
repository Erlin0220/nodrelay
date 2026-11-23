import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { BACKEND_TOKEN, PORTAL_TOKEN, call, connect, device, listen } from './helpers.mjs';

const longJob = process.env.FLEET_TEST_LONG_PROCESS === '1';
test('the device adapter reaches a real isolated Personal DevSpace Runtime', { timeout: longJob ? 100000 : 30000 }, async t => {
  const checkout = process.env.DEVSPACE_CHECKOUT;
  assert.ok(checkout && isAbsolute(checkout), 'Set DEVSPACE_CHECKOUT to the absolute path of a built Personal DevSpace checkout');
  const entry = file => import(pathToFileURL(join(checkout, 'dist', file)).href);
  const [{ createServer }, { loadConfig }, { personalExtensions }] = await Promise.all([
    entry('server.js'), entry('config.js'), entry('personal/index.js'),
  ]);
  const root = await mkdtemp(join(tmpdir(), 'fleet-runtime-'));
  let runtime;
  t.after(async () => {
    try {
      await runtime?.close();
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
  const project = join(root, 'project');
  await mkdir(project);
  const marker = 'devspace-real-runtime-probe-fixture';
  await writeFile(join(project, 'portal-probe.txt'), marker + '\n');
  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, 'config'), DEVSPACE_ALLOWED_ROOTS: project,
    DEVSPACE_STATE_DIR: join(root, 'state'), DEVSPACE_WORKTREE_ROOT: join(root, 'worktrees'),
    DEVSPACE_OAUTH_OWNER_TOKEN: 'isolated-fleet-fixture-owner-not-real',
    DEVSPACE_SUBAGENTS: 'false', DEVSPACE_TOOL_MODE: 'codex', DEVSPACE_WIDGETS: 'off',
    HOST: '127.0.0.1', PORT: '1', DEVSPACE_PUBLIC_BASE_URL: 'http://127.0.0.1:1', DEVSPACE_LOG_LEVEL: 'error',
  });
  runtime = createServer(config, personalExtensions(config, { apiToken: BACKEND_TOKEN }));
  const backend = (await listen(t, runtime.app)) + '/mcp';

  const probe = await device(t, backend, 'probe', { probeDirectory: project });
  const probeClient = await connect(t, probe.url, PORTAL_TOKEN);
  const evidence = await call(probeClient, 'device_probe', { challenge: 'mac_fixture_challenge' });
  assert.equal(evidence.structuredContent?.markerSha256, createHash('sha256').update(marker).digest('hex'), JSON.stringify(evidence));

  const dev = await device(t, backend, 'development');
  const client = await connect(t, dev.url, PORTAL_TOKEN);
  assert.ok((await client.listTools()).tools.some(tool => tool.name === 'exec_command'));
  const forbidden = await call(client, 'open_workspace', { path: root });
  assert.equal(forbidden.isError, true);
  const openRequest = { name: 'open_workspace', arguments: { path: project, includeBootstrapContext: false },
    _meta: { 'openai/session': 'fixture-runtime-conversation' } };
  const opened = await client.callTool(openRequest);
  assert.ok(opened.structuredContent?.workspaceId, JSON.stringify(opened));
  const { workspaceId } = opened.structuredContent;
  assert.match(workspaceId, /^w[\w-]+\.[\w-]{43}$/);
  assert.ok(opened.content[0].text.includes(workspaceId));
  const reconnected = await connect(t, dev.url, PORTAL_TOKEN);
  assert.equal((await reconnected.callTool(openRequest)).structuredContent.workspaceId, workspaceId);
  const patched = await call(client, 'apply_patch', {
    workspaceId, patch: '*** Begin Patch\n*** Add File: result.txt\n+FLEET_FILE_PROOF\n*** End Patch',
  });
  assert.notEqual(patched.isError, true, JSON.stringify(patched));
  const read = await call(client, 'read', { workspaceId, path: 'result.txt' });
  assert.match(read.structuredContent.result, /FLEET_FILE_PROOF/);
  const cmd = `"${process.execPath}" -e "setTimeout(() => console.log('FLEET_PROCESS_PROOF'), 600)"`;
  const operation = { workspaceId, cmd, waitTimeMs: 1, operationId: randomUUID() };
  const started = await call(client, 'exec_command', operation);
  const repeated = await call(reconnected, 'exec_command', operation);
  assert.deepEqual(repeated, started);
  assert.match(started.structuredContent?.sessionId ?? '', /^p\d+\./, JSON.stringify(started));
  const polled = await call(reconnected, 'write_stdin', {
    workspaceId, sessionId: started.structuredContent.sessionId, waitTimeMs: 3000,
  });
  assert.match(polled.structuredContent.result, /FLEET_PROCESS_PROOF/);
  assert.equal(polled.structuredContent.exitCode, 0);

  if (longJob) {
    const command = `"${process.execPath}" -e "setTimeout(() => console.log('FLEET_LONG_PROCESS_PROOF'), 61500)"`;
    const begin = Date.now();
    const initial = await call(client, 'exec_command', { workspaceId, cmd: command, waitTimeMs: 1, operationId: randomUUID() });
    const handle = initial.structuredContent.sessionId;
    assert.ok(handle);
    let final;
    for (let attempt = 0; attempt < 9; attempt++) {
      const before = Date.now();
      final = await call(client, 'write_stdin', { workspaceId, sessionId: handle, waitTimeMs: 12000 });
      assert.ok(Date.now() - before < 20000, 'Each poll stays well below the Portal deadline');
      assert.notEqual(final.isError, true);
      if (!final.structuredContent.running) break;
    }
    assert.ok(Date.now() - begin >= 60000);
    assert.match(final.structuredContent.result, /FLEET_LONG_PROCESS_PROOF/);
    assert.equal(final.structuredContent.exitCode, 0);
  }
});

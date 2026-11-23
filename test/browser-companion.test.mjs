import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { attachBrowserBackend, checkBrowserBackend } from '../src/browser-setup.mjs';
import { profiles } from '../cloud/profiles.mjs';
import { loadConfig } from '../src/config.mjs';
import { ensurePrivateDirectory, readPrivateFile, writePrivateFile } from '../src/private-directory.mjs';
import { BACKEND_TOKEN, PORTAL_TOKEN, call, connect, device, fixtureBackend, result } from './helpers.mjs';

async function localFiles(t, url, serverName = 'fixture') {
  const parent = await mkdtemp(join(tmpdir(), 'nodrelay-browser-setup-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, 'private');
  await ensurePrivateDirectory(root);
  const tokenFile = join(root, 'browser-provider.token');
  const path = join(root, 'provider.json');
  await writePrivateFile(tokenFile, BACKEND_TOKEN + '\n');
  await writePrivateFile(path, JSON.stringify({
    schema: 1, purpose: 'nodrelay-browser-only', url, serverName, tokenFile,
  }));
  return { root, path, tokenFile, output: join(root, 'browser-backend.private.json') };
}

test('attaches a dedicated browser backend with the expected identity and keeps its credential in place', async t => {
  const provider = await fixtureBackend(t, [...profiles.browser.tools, 'browser_hover'], () => assert.fail('setup called a tool'));
  const { root, path, tokenFile, output } = await localFiles(t, provider.url);
  await checkBrowserBackend(path);
  await assert.rejects(readPrivateFile(output), { code: 'ENOENT' });
  await attachBrowserBackend(path, root);
  await attachBrowserBackend(path, root);
  const saved = await readPrivateFile(output);
  assert.deepEqual(JSON.parse(saved), { url: provider.url, serverName: 'fixture', tokenFile });
  assert.ok(!saved.includes(BACKEND_TOKEN));
  assert.equal(await readPrivateFile(tokenFile), BACKEND_TOKEN + '\n');
});

test('attachment refuses a paused backend, an unexpected identity, and a broad development credential', async t => {
  const provider = await fixtureBackend(t, profiles.browser.tools, () => assert.fail('setup called a tool'));
  const paused = await localFiles(t, provider.url);
  provider.setOffline(true);
  await assert.rejects(checkBrowserBackend(paused.path), /unavailable or rejected/);
  await assert.rejects(attachBrowserBackend(paused.path, paused.root), /unavailable or rejected/);
  await assert.rejects(readPrivateFile(paused.output), { code: 'ENOENT' });
  provider.setOffline(false);
  const wrong = await localFiles(t, provider.url, 'other provider');
  await assert.rejects(attachBrowserBackend(wrong.path, wrong.root), /identity differs/);
  const mixed = await fixtureBackend(t, [...profiles.browser.tools, 'exec_command'], () => assert.fail('setup called a tool'));
  const broad = await localFiles(t, mixed.url);
  await assert.rejects(attachBrowserBackend(broad.path, broad.root), /outside the browser capability/);
  await assert.rejects(readPrivateFile(broad.output), { code: 'ENOENT' });
});

test('the browser adapter rejects a paused, substituted, or widened companion after reconnection', async t => {
  let dispatched = 0;
  const provider = await fixtureBackend(t, profiles.browser.tools, () => result({ dispatched: ++dispatched }));
  const { root, path, output } = await localFiles(t, provider.url);
  await attachBrowserBackend(path, root);
  const portalTokenFile = join(root, 'portal.token');
  const configFile = join(root, 'browser.private.json');
  await writePrivateFile(portalTokenFile, PORTAL_TOKEN);
  await writePrivateFile(configFile, JSON.stringify({ schema: 1, deviceId: 'test-browser', profile: 'browser', port: 7831,
    portalTokenFile, backend: JSON.parse(await readPrivateFile(output)) }));
  const config = await loadConfig(configFile);
  const relay = await device(t, provider.url, 'browser', config);
  const client = await connect(t, relay.url, PORTAL_TOKEN);
  assert.equal((await call(client, 'browser_snapshot', {})).structuredContent.dispatched, 1);
  assert.equal((await client.listTools()).tools.length, profiles.browser.tools.length);
  provider.setOffline(true);
  await assert.rejects(client.listTools(), /Local MCP backend unavailable/);
  assert.equal(dispatched, 1);
  assert.equal((await call(client, 'browser_snapshot', {})).isError, true);
  provider.setOffline(false);
  provider.setIdentity('another provider');
  assert.equal((await call(client, 'browser_snapshot', {})).isError, true);
  provider.setIdentity('fixture');
  provider.setTools([...profiles.browser.tools, 'exec_command']);
  assert.equal((await call(client, 'browser_snapshot', {})).isError, true);
  assert.equal((await call(client, 'exec_command', {})).isError, true);
  assert.equal(dispatched, 1);
  provider.setTools(profiles.browser.tools);
  assert.equal((await call(client, 'browser_snapshot', {})).structuredContent.dispatched, 2);
});

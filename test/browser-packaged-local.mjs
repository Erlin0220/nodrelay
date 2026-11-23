import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { BACKEND_TOKEN, PORTAL_TOKEN, call, connect, fixtureBackend, listen, result } from './helpers.mjs';
import { profiles } from '../cloud/profiles.mjs';
import { readPrivateFile, writePrivateFile } from '../src/private-directory.mjs';

const exec = promisify(execFile);
const archive = process.env.FLEET_TEST_BROWSER_ARCHIVE;
const driver = process.env.FLEET_TEST_PLAYWRIGHT;
const digest = value => createHash('sha256').update(value).digest('hex');

test('browser archive rejects pause before enrollment and relays a real browser after local setup', {
  skip: process.platform !== 'darwin' || !archive || !driver,
  timeout: 90000,
}, async t => {
  assert.ok(isAbsolute(archive) && isAbsolute(driver));
  const fixture = await mkdtemp(join(tmpdir(), 'fleet-browser-package-proof-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const bundle = join(fixture, 'bundle');
  const home = join(fixture, 'home');
  const state = join(fixture, 'state');
  await Promise.all([mkdir(bundle), mkdir(home), mkdir(state, { mode: 0o700 })]);
  await exec('tar', ['-xzf', archive, '-C', bundle], { timeout: 60000 });
  assert.equal(JSON.parse(await readFile(join(bundle, 'bundle.json'), 'utf8')).browser, true);
  const cert = join(fixture, 'test.pem');
  const key = join(fixture, 'test.key');
  await exec('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', key, '-out', cert]);
  let enrollmentRequests = 0;
  const management = createHttpsServer({ cert: await readFile(cert), key: await readFile(key) }, (_request, response) => {
    enrollmentRequests++;
    response.writeHead(500).end();
  });
  const manager = (await listen(t, management)).replace('http:', 'https:');
  const target = await listen(t, createHttpServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html' }).end('<title>Nodrelay packaged browser proof</title>');
  }));
  const { chromium } = await import(pathToFileURL(driver).href);
  const browser = await chromium.launch({ channel: 'chrome' });
  t.after(() => browser.close());
  const context = await browser.newContext();
  const page = await context.newPage();
  const provider = await fixtureBackend(t, profiles.browser.tools, async ({ name, arguments: args }) => {
    if (name === 'browser_navigate') {
      assert.equal(args.url, target);
      await page.goto(target);
    }
    return result({ title: await page.title() });
  }, { stateless: true });
  const tokenFile = join(fixture, 'provider.token');
  const configFile = join(fixture, 'provider.json');
  await writePrivateFile(tokenFile, BACKEND_TOKEN);
  await writePrivateFile(configFile, JSON.stringify({ schema: 1, purpose: 'nodrelay-browser-only',
    serverName: 'fixture', url: provider.url, tokenFile }));
  const env = { ...process.env, HOME: home, NODE_EXTRA_CA_CERTS: cert, NODRELAY_BROWSER_BACKEND_CONFIG: configFile };
  provider.setOffline(true);
  await assert.rejects(exec('/bin/sh', [join(bundle, 'install.sh')], { env: { ...env,
    DEVSPACE_FLEET_MANAGER: manager, DEVSPACE_FLEET_DEVICE: 'fixture-browser', DEVSPACE_FLEET_TICKET: 'v'.repeat(43),
  }, timeout: 10000 }), /browser backend is unavailable/);
  assert.equal(enrollmentRequests, 0);
  await assert.rejects(readFile(join(home, '.devspace-fleet', digest(manager).slice(0, 12), 'credentials.private.json')), { code: 'ENOENT' });
  provider.setOffline(false);
  const node = join(bundle, 'bin/node');
  await exec(node, [join(bundle, 'browser/preflight.mjs')], { env, timeout: 10000 });
  await exec(node, [join(bundle, 'browser/setup.mjs'), state], { env, timeout: 10000 });
  const backendFile = join(state, 'browser-backend.private.json');
  const backendText = await readPrivateFile(backendFile);
  assert.deepEqual(JSON.parse(backendText), { url: provider.url, serverName: 'fixture', tokenFile });
  assert.equal(backendText.includes(BACKEND_TOKEN), false);

  const packagedModule = part => import(pathToFileURL(join(bundle, 'fleet/src', part)).href);
  const [{ loadConfig }, { createDeviceApp }] = await Promise.all([packagedModule('config.mjs'), packagedModule('device.mjs')]);
  const portalTokenFile = join(fixture, 'portal.token');
  const adapterConfigFile = join(fixture, 'browser.private.json');
  await writePrivateFile(portalTokenFile, PORTAL_TOKEN);
  await writePrivateFile(adapterConfigFile, JSON.stringify({ schema: 1, deviceId: 'fixture-browser', profile: 'browser',
    port: 7831, portalTokenFile, backend: JSON.parse(backendText) }));
  const adapter = await listen(t, createDeviceApp(await loadConfig(adapterConfigFile))) + '/browser/mcp';
  assert.equal((await fetch(adapter, { method: 'POST', headers: { Authorization: `Bearer ${BACKEND_TOKEN}` } })).status, 401);
  const client = await connect(t, adapter, PORTAL_TOKEN);
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), profiles.browser.tools);
  assert.equal((await call(client, 'browser_navigate', { url: target })).structuredContent?.title, 'Nodrelay packaged browser proof');
  assert.equal((await call(client, 'exec_command', {})).isError, true);
});

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { cloudflareApi, CloudflareRequestTimeoutError } from '../cloud/cloudflare.mjs';
import { hostedInstallers } from '../cloud/device-paths.mjs';
import { bootstrapInstaller } from '../cloud/install-command.mjs';
import { managementBootstrapOAuthScopes, managementGrant, managementIdentityOAuthScopes, managementOAuthScopes, runtimeGrant } from '../cloud/oauth-grant.mjs';
import { addPortalCallback } from '../cloud/portal-client-callbacks.mjs';
import { archiveInterruptedManagementLock, takeManagementLock } from '../src/management-lock.mjs';
import { managementRelease } from '../src/management-release.mjs';
import { checkManagementReadiness, chooseManagementZone, getManagementOwnerEmail, openManagementWhenReady,
  finishCloudDeployment, repairManagementLogin, reconnectManagement, trackManagementCreates, verifyManagementZone, waitForManagementAccess } from '../src/management-setup.mjs';
import { createManagementTerminal, InstallationCancelled } from '../src/management-terminal.mjs';
import { writePrivateFile } from '../src/private-directory.mjs';
import { applySetup, targetPlatforms } from '../src/setup-core.mjs';
import { account, cloudFixture, spec, catalog, ticketKey } from './cloudflare-fixture.mjs';

test('callback changes stop when a fresh read detects a concurrent Access change', async () => {
  const app = {
    id: 'fixture-portal-app', name: spec.label, type: 'mcp_portal', domain: spec.portalHostname,
    oauth_configuration: { enabled: true, dynamic_client_registration: { enabled: true, allowed_uris: [] } },
    policies: [{ id: 'fixture-owner' }],
  };
  let reads = 0;
  const api = {
    list: async path => path.endsWith('/policies') ? app.policies : [app],
    get: async () => {
      const current = structuredClone(app);
      if (++reads === 2) current.policies.push({ id: 'new-owner-policy' });
      return current;
    },
    put() { assert.fail('The callback update must leave the recently changed Access application alone'); },
  };
  await assert.rejects(addPortalCallback(api, spec, 'https://client.example.test/oauth'), /配置刚刚更新/);
});

test('the management command verifies the signature and Worker before Cloudflare access', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nodrelay-management-release-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = join(root, 'management-release.json');
  const key = join(root, 'publisher.pub');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const bundle = 'export default {}';
  const metadata = { schema: 1, oauthClientId: 'fixture-oauth-client',
    oauthRedirect: 'http://127.0.0.1:18871/oauth/callback', workerBundle: './worker.js',
    workerSha256: createHash('sha256').update(bundle).digest('hex'), releases: catalog };
  const writeManifest = async (schema, additions = {}) => {
    const body = Buffer.from(JSON.stringify({ ...metadata, schema, ...additions }));
    await writeFile(manifest, body);
    await writeFile(manifest + '.sig', sign(null, body, privateKey));
  };
  await writeFile(key, publicKey.export({ type: 'spki', format: 'pem' }));
  await writeManifest(1);
  await writeFile(join(root, 'worker.js'), bundle);
  assert.equal((await managementRelease(manifest, key)).clientId, 'fixture-oauth-client');
  assert.equal((await managementRelease(manifest, key)).automaticAdministrator, false);
  await writeManifest(2);
  assert.equal((await managementRelease(manifest, key)).automaticAdministrator, true);
  await writeManifest(2, { zeroTrustBootstrap: true });
  assert.equal((await managementRelease(manifest, key)).zeroTrustBootstrap, true);
  await writeManifest(1, { zeroTrustBootstrap: true });
  await assert.rejects(managementRelease(manifest, key), /valid Nodrelay/);
  const upgrade = { version: '0.1.5-preview.9', channel: 'preview', feed: 'https://downloads.example.test/nodrelay/' };
  await writeManifest(2, { webUpgrade: upgrade });
  assert.deepEqual((await managementRelease(manifest, key)).webUpgrade, {
    ...upgrade, publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
  });
  await writeManifest(2, { enrollmentProtocol: 'intent-v1' });
  await assert.rejects(managementRelease(manifest, key), /requires a verified management upgrade baseline/);
  await writeManifest(2, { enrollmentProtocol: 'intent-v1', webUpgrade: upgrade });
  await assert.rejects(managementRelease(manifest, key), /all currently supported native targets/);
  const template = Object.values(catalog)[0];
  const all = Object.fromEntries(targetPlatforms.map(platform => [platform,
    { ...template, url: `https://releases.example.test/${platform}.archive` }]));
  await writeManifest(2, { enrollmentProtocol: 'intent-v1', webUpgrade: upgrade, releases: all });
  const approved = (await managementRelease(manifest, key)).enrollment;
  assert.equal(approved.protocol, 'intent-v1');
  assert.deepEqual(Object.keys(approved.history.macos[template.version].assets), ['arm64', 'x64']);
  assert.deepEqual(Object.keys(approved.history.windows[template.version].assets), ['x64']);
  await writeManifest(2, { webUpgrade: { ...upgrade, feed: 'https://alice:pass@downloads.example.test/' } });
  await assert.rejects(managementRelease(manifest, key), /upgrade baseline is invalid/);
  await writeManifest(2, { webUpgrade: upgrade, bridgeCatalogSha256: 'c'.repeat(64) });
  assert.equal((await managementRelease(manifest, key)).bridgeCatalogSha256, 'c'.repeat(64));
  await writeManifest(2, { webUpgrade: upgrade, bridgeCatalogSha256: 'unsigned' });
  await assert.rejects(managementRelease(manifest, key), /previous device catalog digest is invalid/);
  await writeManifest(1, { webUpgrade: upgrade });
  await assert.rejects(managementRelease(manifest, key), /verified owner installer/);
  await writeManifest(2);
  await writeFile(join(root, 'worker.js'), 'tampered code');
  await assert.rejects(() => managementRelease(manifest, key), /bundle does not match/);
  await writeFile(manifest, '{}');
  await assert.rejects(() => managementRelease(manifest, key), /signature is invalid/);
});

test('discovery picks a sole authorized account and active domain without prompting', async () => {
  const account = { id: 'only-account', name: '个人账户' };
  const zone = { name: 'zone.example.test', status: 'active', account };
  const api = { async list(path, query) {
    if (path === '/accounts') return [account];
    assert.equal(path, '/zones');
    assert.equal(query['account.id'], account.id);
    return [zone];
  } };
  const messages = [];
  const ui = {
    select() { assert.fail('A sole option requires no prompt'); },
    success(message) { messages.push(message); },
  };
  assert.equal(await chooseManagementZone(api, ui), zone);
  assert.match(messages[0], /Cloudflare 账户.*个人账户.*已自动选择/);
  assert.match(messages[1], /部署域名.*zone\.example\.test.*已自动选择/);
});

test('discovery presents paginated accounts then only eligible domains from the chosen account', async () => {
  const accounts = Array.from({ length: 51 }, (_, index) => ({ id: `account-${index + 1}`, name: `Team ${index + 1}` }));
  const account = accounts.at(-1);
  const first = { name: 'first.example.test', status: 'active', account };
  const second = { name: 'second.example.test', status: 'active', account };
  const requests = [];
  const api = cloudflareApi('fixture-oauth-token', { async request(url, options) {
    requests.push(url.pathname + ':' + url.searchParams.get('page'));
    assert.equal(options.headers.Authorization, 'Bearer fixture-oauth-token');
    assert.equal(url.searchParams.get('per_page'), '50');
    if (url.pathname.endsWith('/accounts')) {
      const start = (Number(url.searchParams.get('page')) - 1) * 50;
      return Response.json({ success: true, result: accounts.slice(start, start + 50) });
    }
    assert.equal(url.pathname, '/client/v4/zones');
    assert.equal(url.searchParams.get('account.id'), account.id);
    assert.equal(url.searchParams.get('status'), 'active');
    return Response.json({ success: true, result: [first, second,
      { ...first, name: 'other.example.test', account: accounts[0] },
      { ...first, name: 'pending.example.test', status: 'pending' },
      { ...first, name: 'app.workers.dev' },
      { ...first, name: 'app.pages.dev' },
    ] });
  } });
  const prompts = [];
  const ui = { select(prompt, options) {
    prompts.push({ prompt, labels: options.map(({ label }) => label) });
    return options.at(-1).value;
  } };
  assert.deepEqual(await chooseManagementZone(api, ui), second);
  assert.deepEqual(requests, ['/client/v4/accounts:1', '/client/v4/accounts:2', '/client/v4/zones:1']);
  assert.deepEqual(prompts, [
    { prompt: '选择 Cloudflare 账户', labels: accounts.map(({ name }) => name) },
    { prompt: '选择部署域名', labels: ['first.example.test', 'second.example.test'] },
  ]);
});

test('discovery explains the absence of accounts or active domains', async () => {
  const account = { id: 'no-domains', name: '我的账户' };
  const ui = { select() { assert.fail('An empty list requires no prompt'); }, success() {} };
  const api = { async list(path) { assert.equal(path, '/accounts'); return []; } };
  await assert.rejects(chooseManagementZone(api, ui), /未返回可用的 Cloudflare 账户.*重新运行/);
  const messages = [];
  await assert.rejects(chooseManagementZone({
    async list(path) { return path === '/accounts' ? [account] : []; },
  }, { success() {}, info(message) { messages.push(message); }, select() { return 'cancel'; } }), InstallationCancelled);
  assert.match(messages[0], /我的账户.*没有可用的已激活域名.*添加或激活域名/);
});

test('duplicate account names are disambiguated without exposing full IDs, email addresses or control sequences', async () => {
  const name = '\x1b[31m alice@example.test\n的账户 \x1b[0m';
  const accounts = [
    { id: 'a'.repeat(24) + '00000001', name },
    { id: 'b'.repeat(24) + '00000002', name },
  ];
  const zone = { name: 'zone.example.test', status: 'active', account: accounts[1] };
  const api = { async list(path, query) {
    if (path === '/accounts') return accounts;
    assert.equal(query['account.id'], accounts[1].id);
    return [zone];
  } };
  const ui = {
    select(_prompt, options) {
      assert.deepEqual(options.map(({ label }) => label), [
        '[…00000001] a•••@example.test 的账户',
        '[…00000002] a•••@example.test 的账户',
      ]);
      return options[1].value;
    },
    success() {},
  };
  assert.equal(await chooseManagementZone(api, ui), zone);
});

function terminalFixture() {
  const input = new PassThrough();
  const output = new PassThrough();
  let transcript = '';
  output.setEncoding('utf8');
  output.on('data', chunk => { transcript += chunk; });
  output.columns = 80;
  output.rows = 24;
  return { input, transcript: () => transcript, ui: createManagementTerminal({ input, output }) };
}

test('the terminal uses directional focus, Enter and Ctrl+C', { timeout: 2000 }, async () => {
  const { input, transcript, ui } = terminalFixture();
  const options = [{ value: 'first', label: '第一项' }, { value: 'second', label: '第二项' }];
  const selection = ui.select('选择域名', options);
  input.write('\x1b[B');
  input.write('\r');
  assert.equal(await selection, 'second');
  assert.match(transcript(), /↑\/↓ 移动 · 回车确认/);
  const cancelled = ui.select('选择账户', options);
  input.write('\x03');
  await assert.rejects(cancelled, InstallationCancelled);
});

test('the installation confirmation shows both actions on one line and defaults to Confirm', { timeout: 2000 }, async () => {
  const { input, transcript, ui } = terminalFixture();
  const defaultChoice = ui.confirm('部署资源？', '确认部署');
  assert.match(transcript(), /←\/→ 移动 · 回车确认/);
  assert.match(transcript(), /● 确认部署 \/ ○ 取消/);
  input.write('\r');
  assert.equal(await defaultChoice, true);

  const choice = ui.confirm('部署资源？', '确认部署');
  input.write('\x1b[C');
  assert.match(transcript(), /○ 确认部署 \/ ● 取消/);
  input.write('\x1b[D');
  input.write('\x1b[C');
  input.write('\r');
  assert.equal(await choice, false);

  const recovery = ui.confirm('上次操作结果已核对？', '继续部署', false);
  assert.match(transcript(), /○ 继续部署 \/ ● 取消/);
  input.write('\r');
  assert.equal(await recovery, false);

  const cancelled = ui.confirm('部署资源？', '确认部署');
  input.write('\x03');
  await assert.rejects(cancelled, InstallationCancelled);
});

test('administrator discovery uses the authenticated Cloudflare profile and fails closed', async () => {
  const email = 'Admin@example.test';
  const api = (profile, status = 200) => cloudflareApi('fixture-profile-credential', {
    async request(url, options) {
      assert.equal(url.href, 'https://api.cloudflare.com/client/v4/user');
      assert.equal(options.method, 'GET');
      assert.equal(options.headers.Authorization, 'Bearer fixture-profile-credential');
      return Response.json({ success: status === 200, result: profile }, { status });
    },
  });
  assert.equal(await getManagementOwnerEmail(api({ email })), email);
  for (const status of [401, 403]) {
    await assert.rejects(getManagementOwnerEmail(api({ email }, status)), /用户资料只读权限.*user-details\.read/);
  }
  await assert.rejects(getManagementOwnerEmail(api({ email }, 503)), /检查网络/);
  for (const profile of [null, {}, { email: '\x1b[2J' + email }, { email, suspended: true }, { email, email_verified: false }]) {
    await assert.rejects(getManagementOwnerEmail(api(profile)), error =>
      /未返回可用的登录邮箱/.test(error.message) && !error.message.includes(email));
  }
});

test('a live management lock cannot be archived and a legacy lock is left in place', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nodrelay-management-lock-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'test.json.lock');
  const release = await takeManagementLock(path);
  const owner = JSON.parse(await readFile(path, 'utf8'));
  try {
    await assert.rejects(takeManagementLock(path), error => error.kind === 'active' && error.owner.pid === process.pid);
    await assert.rejects(archiveInterruptedManagementLock(path, owner), error => error.kind === 'active');
  } finally {
    await release();
  }
  await writePrivateFile(path, '');
  await assert.rejects(takeManagementLock(path), error => error.kind === 'unknown');
  assert.equal(await readFile(path, 'utf8'), '');
});

test('only one recovery can archive an interrupted generation and a stale owner cannot remove a replacement', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nodrelay-management-lock-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const child = spawn(process.execPath, ['-e', '']);
  await once(child, 'exit');
  const owner = { version: 1, pid: child.pid, id: 'a'.repeat(32) };
  const path = join(root, 'test.json.lock');
  await writePrivateFile(path, JSON.stringify(owner));
  await assert.rejects(takeManagementLock(path), error => error.kind === 'interrupted' && error.owner.pid === child.pid);
  const attempts = await Promise.allSettled([
    archiveInterruptedManagementLock(path, owner), archiveInterruptedManagementLock(path, owner),
  ]);
  assert.equal(attempts.filter(attempt => attempt.status === 'fulfilled').length, 1);
  assert.deepEqual(JSON.parse(await readFile(path + '.interrupted-' + owner.id, 'utf8')), owner);
  const release = await takeManagementLock(path);
  try {
    await assert.rejects(archiveInterruptedManagementLock(path, owner), /锁已变更/);
    await assert.rejects(takeManagementLock(path), error => error.kind === 'active');
  } finally {
    await release();
  }
});

test('SIGKILL after publishing the archive leaves a recoverable lock for concurrent resume attempts', { timeout: 15000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'nodrelay-management-lock-crash-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const child = spawn(process.execPath, ['-e', '']);
  await once(child, 'exit');
  const owner = { version: 1, pid: child.pid, id: 'b'.repeat(32) };
  const path = join(root, 'test.json.lock');
  const archive = path + '.interrupted-' + owner.id;
  await writePrivateFile(path, JSON.stringify(owner));

  const fixture = `
    const fs = require('node:fs/promises');
    const originalLink = fs.link;
    fs.link = async (source, destination) => {
      await originalLink(source, destination);
      if (destination !== process.argv[2]) return;
      process.send('archive published');
      await new Promise(() => {});
    };
    require('node:module').syncBuiltinESMExports();
    (async () => {
      const { archiveInterruptedManagementLock } = await import(process.argv[3]);
      await archiveInterruptedManagementLock(process.argv[1], JSON.parse(process.argv[4]));
    })().catch(error => { console.error(error); process.exitCode = 1; });
    process.on('message', () => {});
  `;
  const moduleUrl = new URL('../src/management-lock.mjs', import.meta.url);
  const recovering = spawn(process.execPath, ['-e', fixture, path, archive, moduleUrl.href, JSON.stringify(owner)], {
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  const exited = once(recovering, 'exit');
  t.after(() => {
    if (recovering.exitCode === null && recovering.signalCode === null) recovering.kill('SIGKILL');
  });
  assert.equal(await Promise.race([
    once(recovering, 'message').then(([message]) => message),
    exited.then(() => 'exited before publishing the archive'),
  ]), 'archive published');
  assert.deepEqual(JSON.parse(await readFile(archive, 'utf8')), owner);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), owner);
  assert.equal(recovering.kill('SIGKILL'), true);
  await exited;

  await assert.rejects(takeManagementLock(path), error => error.kind === 'interrupted' && error.owner.id === owner.id);
  const attempts = await Promise.allSettled([
    archiveInterruptedManagementLock(path, owner), archiveInterruptedManagementLock(path, owner),
  ]);
  assert.equal(attempts.filter(attempt => attempt.status === 'fulfilled').length, 1);

  const contenders = await Promise.allSettled([takeManagementLock(path), takeManagementLock(path)]);
  const winners = contenders.filter(attempt => attempt.status === 'fulfilled');
  assert.equal(winners.length, 1);
  try {
    await assert.rejects(archiveInterruptedManagementLock(path, owner), /锁已变更/);
    await assert.rejects(takeManagementLock(path), error => error.kind === 'active');
    assert.deepEqual(JSON.parse(await readFile(archive, 'utf8')), owner);
  } finally {
    await winners[0].value();
  }
  const release = await takeManagementLock(path);
  await release();
});

test('a separate file at the archive path is rejected even if its metadata matches the old lock', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nodrelay-management-lock-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const child = spawn(process.execPath, ['-e', '']);
  await once(child, 'exit');
  const owner = { version: 1, pid: child.pid, id: 'c'.repeat(32) };
  const path = join(root, 'test.json.lock');
  await writePrivateFile(path, JSON.stringify(owner));
  await writePrivateFile(path + '.interrupted-' + owner.id, JSON.stringify(owner));
  await assert.rejects(archiveInterruptedManagementLock(path, owner), error => error.kind === 'unknown');
  await assert.rejects(takeManagementLock(path), error => error.kind === 'interrupted');
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), owner);
});

for (const phase of ['headers', 'body']) {
  test(`Cloudflare request deadline aborts a stalled response at the ${phase}`, { timeout: 5000 }, async t => {
    let received = false;
    const server = createServer((_request, response) => {
      received = true;
      if (phase === 'body') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.write('{"success":');
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => {
      server.closeAllConnections();
      return new Promise(resolve => server.close(resolve));
    });
    const url = `http://127.0.0.1:${server.address().port}`;
    let signal;
    let status;
    const api = cloudflareApi('fixture', {
      requestTimeoutMs: 500,
      async request(_url, options) {
        signal = options.signal;
        const response = await fetch(url, options);
        status = response.status;
        return response;
      },
    });
    await assert.rejects(api.post('/fixture', {}), error =>
      error instanceof CloudflareRequestTimeoutError && error.method === 'POST' && error.timeoutMs === 500);
    assert.equal(received, true);
    assert.equal(status, phase === 'body' ? 200 : undefined);
    assert.equal(signal.aborted, true);
  });
}

test('an uncertain Cloudflare create is recorded before the request and requires explicit review to repeat', async () => {
  const state = {};
  const endpoint = '/zones/fixture/dns_records';
  const body = { name: 'portal.example.test', content: 'fixture.invalid' };
  const snapshots = [];
  let attempts = 0;
  const api = { async post() {
    attempts++;
    assert.deepEqual(snapshots.at(-1).pendingCreates, [JSON.stringify([endpoint, body.name])]);
    if (attempts === 1) throw new Error('response lost');
    return { id: 'fixture-id' };
  } };
  const save = async value => snapshots.push(structuredClone(value));
  const refused = trackManagementCreates(api, state, save, async (path, name) => {
    assert.equal(path, endpoint);
    assert.equal(name, body.name);
    throw new InstallationCancelled();
  });
  await assert.rejects(refused.post(endpoint, body), /response lost/);
  await assert.rejects(refused.post(endpoint, body), InstallationCancelled);
  assert.equal(attempts, 1);
  const approved = trackManagementCreates(api, state, save, async () => {});
  assert.deepEqual(await approved.post(endpoint, body), { id: 'fixture-id' });
  assert.equal(attempts, 2);
  assert.equal(snapshots.at(-1).pendingCreates, undefined);
  await assert.rejects(approved.post(endpoint, body), /曾确认创建资源.*当前查询未找到/);
  assert.equal(attempts, 2);
});

test('the installer only accepts a TLS redirect to the configured Access team for that hostname', async () => {
  const origin = 'https://console.example.test';
  const issuer = 'https://example.cloudflareaccess.com';
  const target = '/cdn-cgi/access/login/console.example.test';
  const ready = request => waitForManagementAccess(origin, issuer, {}, { timeoutMs: 0, request });
  assert.equal(await ready(async (_url, options) => {
    assert.equal(options.redirect, 'manual');
    return Response.redirect(issuer + target);
  }), true);
  for (const wrong of ['https://other.cloudflareaccess.com' + target, issuer + '/cdn-cgi/access/login/other.example.test']) {
    assert.equal(await ready(async () => Response.redirect(wrong)), false);
  }
  assert.equal(await ready(async () => new Response('public', { status: 200 })), false);
  assert.equal(await ready(async () => { throw new Error('network'); }), false);
});

test('console startup waits for the expected Access login and every pinned public installer', async () => {
  const console = 'https://console.example.test';
  const issuer = 'https://example.cloudflareaccess.com';
  const releases = { ...catalog, 'macos-arm64': { url: 'https://downloads.example.test/mac.tgz', sha256: '1'.repeat(64), version: '1.1.0', browser: false } };
  const groups = hostedInstallers(releases);
  let attempts = 0;
  assert.equal(await waitForManagementAccess(console, issuer, releases, { timeoutMs: 500, intervalMs: 1, request(url, options) {
    assert.equal(options.redirect, 'manual');
    const login = issuer + '/cdn-cgi/access/login/console.example.test';
    if (url === console) {
      attempts++;
      if (attempts === 1) throw new Error('DNS not ready');
      return Response.redirect(login);
    }
    const platform = /^\/device\/install\/(windows|macos|linux)\?version=1\.1\.0$/.exec(url.slice(console.length))?.[1];
    assert.ok(platform);
    const script = bootstrapInstaller(console, platform, groups[platform]);
    if (platform !== 'windows') return new Response(script);
    if (attempts === 2) return Response.redirect(login);
    if (attempts === 3) return new Response('<html>Sign in</html>', { headers: { 'Content-Type': 'text/html' } });
    if (attempts === 4) return new Response(script.replace(releases['windows-x64'].sha256, 'f'.repeat(64)));
    if (attempts === 5) return new Response(script + '\n');
    if (attempts === 6) return new Response(script.slice(0, -1));
    return new Response(script);
  } }), true);
  assert.equal(attempts, 7);
  assert.equal(await waitForManagementAccess(console, issuer, catalog, { timeoutMs: 0, request() {
    return new Response(null, { status: 503 });
  } }), false);
});

test('a pending deployment fails explicitly and can be checked using only public GET requests', async () => {
  const management = 'https://console.example.test';
  const accessIssuer = 'https://example.cloudflareaccess.com';
  const groups = hostedInstallers(catalog);
  const checks = [];
  const request = (url, options) => {
    assert.equal(options.method, undefined);
    assert.equal(options.headers?.Authorization, undefined);
    checks.push(url);
    if (url === management) return Response.redirect(accessIssuer + '/cdn-cgi/access/login/console.example.test');
    const platform = new URL(url).pathname.split('/').at(-1);
    return new Response(bootstrapInstaller(management, platform, groups[platform]));
  };
  await assert.rejects(openManagementWhenReady({ management, accessIssuer }, catalog, {
    timeoutMs: 0, request: () => new Response(null, { status: 503 }),
  }), /not ready.*--check/);

  for (const origin of ['http://console.example.test', 'https://user:password@console.example.test',
    'https://console.example.test/admin', 'https://console.example.test:444']) {
    await assert.rejects(checkManagementReadiness(origin, accessIssuer, catalog, { request }), /management HTTPS origin/);
  }
  await assert.rejects(checkManagementReadiness(management, 'https://other.example.test', catalog, { request }), /exact Cloudflare Access issuer/);
  assert.equal(checks.length, 0);
  await assert.rejects(checkManagementReadiness(management, accessIssuer, catalog, {
    request: () => new Response(null, { status: 503 }),
  }), /not ready/);
  assert.equal(await checkManagementReadiness(management + '/', accessIssuer, catalog, { request }), management);
  assert.deepEqual(checks.sort(), [management, management + '/device/install/linux?version=1.1.0',
    management + '/device/install/windows?version=1.1.0'].sort());
});

test('stopping the post-deployment wait aborts the readiness request and skips further checks', async () => {
  const controller = new AbortController();
  const reason = new InstallationCancelled();
  let checks = 0;
  await assert.rejects(waitForManagementAccess(spec.origin, 'https://example.cloudflareaccess.com', {}, {
    signal: controller.signal,
    request(_url, { signal }) {
      checks++;
      controller.abort(reason);
      assert.equal(signal.reason, reason);
      signal.throwIfAborted();
    },
  }), error => error === reason);
  assert.equal(checks, 1);
});

for (const bootstrapGranted of [false, true]) {
  test(`identity-scoped management grants configure the broker and exact owner policies (bootstrap granted: ${bootstrapGranted})`, async () => {
    const token = { access_token: 'a'.repeat(48), refresh_token: 'r'.repeat(48), token_type: 'Bearer', expires_in: 3599,
      scope: (bootstrapGranted ? managementBootstrapOAuthScopes : managementIdentityOAuthScopes).join(' ') };
    const grant = managementGrant(token, managementBootstrapOAuthScopes);
    assert.throws(() => runtimeGrant({ ...token, scope: token.scope.replace('access.write', 'zone-access.write') },
      undefined, managementIdentityOAuthScopes), /different grant/);
    assert.throws(() => runtimeGrant({ ...token, scope: managementOAuthScopes.join(' ') },
      undefined, managementIdentityOAuthScopes), /different grant/);
    const native = { id: '2'.repeat(32), type: 'cloudflare' };
    const otp = { id: '3'.repeat(32), type: 'onetimepin' };
    const google = { id: '4'.repeat(32), type: 'google' };
    const cf = cloudFixture({ directPolicies: true, identityProviders: [google, native, otp] });
    const state = { ticketKey };
    const releases = { ...catalog, 'macos-arm64': {
      url: 'https://downloads.example.test/mac.tgz', sha256: '1'.repeat(64), version: '1.2.0', browser: false,
    } };
    const snapshots = [];
    const result = await applySetup(cloudflareApi('administrator-test-auth', { request: cf.request }), spec, {
      state, save: async value => snapshots.push(JSON.stringify(value)), bundle: 'export default {}', releases,
      migrations: ['CREATE TABLE IF NOT EXISTS fixture (id TEXT)'], managedOAuth: { clientId: 'fixture-oauth-client', grant, userDetails: true },
    });
    assert.equal(result.management, spec.origin);
    assert.equal(cf.db.tokens.length, 0);
    assert.equal(cf.db.policies.length, 0);
    const portal = cf.db.apps.find(app => app.type === 'mcp_portal');
    assert.deepEqual(portal.allowed_idps, [native.id, otp.id]);
    assert.equal(portal.auto_redirect_to_identity, false);
    assert.equal(portal.policies[0].decision, 'allow');
    assert.deepEqual(portal.policies[0].include, [{ email: { email: spec.ownerEmail } }]);
    const dcr = portal.oauth_configuration.dynamic_client_registration;
    assert.equal(dcr.enabled, true);
    assert.ok(dcr.allowed_uris.includes('https://chatgpt.com/connector/oauth/*'));
    for (const uri of [
      'https://www.cursor.com/agents/mcp/oauth/callback',
      'http://localhost:8787/callback',
      'cursor://anysphere.cursor-mcp/oauth/callback',
      'http://127.0.0.1:33418/',
    ]) assert.ok(dcr.allowed_uris.includes(uri));
    assert.ok(!dcr.allowed_uris.some(uri => /workbuddy/i.test(uri)));
    const host = new URL(spec.origin).hostname;
    const management = cf.db.apps.find(app => app.domain === host);
    assert.deepEqual(management.allowed_idps, [native.id]);
    assert.equal(management.auto_redirect_to_identity, true);
    assert.ok(!cf.writes.some(([, path]) => path.includes('/access/identity_providers')));
    const managementPolicy = management.policies[0];
    assert.equal(managementPolicy.decision, 'allow');
    assert.deepEqual(managementPolicy.include, [{ email: { email: spec.ownerEmail } }]);
    assert.deepEqual(cf.db.apps.filter(app => app.domain?.startsWith(host + '/device/install/'))
      .map(app => [app.domain, app.policies[0].decision]).sort(), ['linux', 'macos', 'windows']
      .map(platform => [host + '/device/install/' + platform, 'bypass']));
    assert.ok(!cf.db.apps.some(app => app.domain === host + '/device/*'));
    const metadata = cf.db.scripts[0].metadata;
    assert.deepEqual(JSON.parse(metadata.bindings.find(binding => binding.name === 'RELEASE_CATALOG').text), releases);
    assert.deepEqual(metadata.migrations.new_sqlite_classes, ['OAuthProvisioner']);
    assert.ok(metadata.bindings.some(b => b.type === 'durable_object_namespace' && b.name === 'PROVISIONER_OAUTH'));
    assert.ok(metadata.bindings.some(b => b.type === 'plain_text' && b.name === 'FLEET_OAUTH_USER_DETAILS' && b.text === '1'));
    assert.equal(metadata.bindings.some(b => b.name === 'FLEET_OAUTH_ZERO_TRUST_BOOTSTRAP' && b.text === '1'), bootstrapGranted);
    assert.ok(metadata.bindings.some(b => b.type === 'secret_text' && b.name === 'FLEET_OAUTH_SEED' && JSON.parse(b.text).refresh === grant.refresh));
    assert.ok(snapshots.every(snapshot => !snapshot.includes(grant.refresh) && !snapshot.includes(grant.access)));
    assert.equal(state.managedOAuth, true);
    assert.equal(state.oauthKey, undefined);
  });

}

test('an automatically discovered Cloudflare email never assumes a separate SSO identity can log in', async () => {
  const profile = { email: spec.ownerEmail, email_verified: true };
  const google = { id: '4'.repeat(32), type: 'google', config: { email_claim_name: 'work_email' } };
  const otp = { id: '3'.repeat(32), type: 'onetimepin' };
  const grant = { access: 'a'.repeat(48), refresh: 'r'.repeat(48), expiresAt: Math.floor(Date.now() / 1000) + 600 };
  const options = { state: { ticketKey }, save: () => assert.fail('Do not save a partial deployment'),
    migrations: [], releases: catalog, bundle: 'export default {}',
    managedOAuth: { clientId: 'fixture-oauth-client', grant, userDetails: true },
  };
  const googleOnly = cloudFixture({ directPolicies: true, identityProviders: [google], profile });
  const api = cloudflareApi('administrator-test-auth', { request: googleOnly.request });
  assert.equal(await getManagementOwnerEmail(api), profile.email);
  await assert.rejects(applySetup(api, spec, options), /先完成诺联的浏览器 SSO 身份验证/);
  assert.deepEqual(googleOnly.writes, []);

  const cf = cloudFixture({ directPolicies: true, identityProviders: [google, otp], profile });
  const management = { id: '5'.repeat(32), name: spec.label + '-management', type: 'self_hosted',
    domain: new URL(spec.origin).hostname, allowed_idps: [google.id], auto_redirect_to_identity: true, aud: 'fixture-audience',
    policies: [{ name: spec.label + '-owner', decision: 'allow', include: [{ email: { email: profile.email } }] }],
  };
  cf.db.apps.push(management);
  const resumeApi = cloudflareApi('administrator-test-auth', { request: cf.request });
  await assert.rejects(applySetup(resumeApi, spec, options), /当前 Access 应用.*One-time PIN.*原安装命令/);
  assert.deepEqual(cf.writes, []);
  assert.deepEqual(management.allowed_idps, [google.id]);
  assert.equal(management.auto_redirect_to_identity, true);

  // Only an account administrator enables OTP on the existing application.
  management.allowed_idps = [google.id, otp.id];
  management.auto_redirect_to_identity = false;
  assert.equal((await applySetup(resumeApi, spec, { ...options, save: async () => {} })).management, spec.origin);
  assert.deepEqual(management.allowed_idps, [google.id, otp.id]);
  assert.deepEqual(management.policies[0].include, [{ email: { email: profile.email } }]);
  assert.ok(!cf.writes.some(([, path]) => path.startsWith(account + '/access/apps/' + management.id) ||
    path.includes('/access/identity_providers')));

  const verified = { ...spec, ownerEmail: 'sso-owner@example.test' };
  assert.notEqual(verified.ownerEmail, profile.email);
  const state = { ticketKey, spec: verified, ssoIdentity: { issuer: 'https://fixture.cloudflareaccess.com', providerId: google.id } };
  const proofOptions = { ...options, state, save: async () => {} };
  const { management: origin } = await applySetup(api, verified, proofOptions);
  assert.equal(origin, verified.origin);
  const ownerApps = googleOnly.db.apps.filter(app => app.domain === new URL(origin).hostname || app.type === 'mcp_portal');
  assert.equal(ownerApps.length, 2);
  for (const app of ownerApps) {
    assert.deepEqual(app.allowed_idps, [google.id]);
    assert.equal(app.allow_authenticate_via_warp, false);
    assert.deepEqual(app.policies[0].include, [{ email: { email: verified.ownerEmail } }]);
    assert.deepEqual(app.policies[0].require, [{ login_method: { id: google.id } }]);
  }
  assert.equal(googleOnly.db.scripts[0].metadata.bindings.find(binding => binding.name === 'OWNER_EMAIL').text, verified.ownerEmail);
  assert.ok(!googleOnly.writes.some(([, path]) => path.includes('/access/identity_providers')));
});

test('resuming with a missing saved D1 database refuses before creating a new one', async () => {
  const cf = cloudFixture({ directPolicies: true });
  const grant = { access: 'a'.repeat(48), refresh: 'r'.repeat(48), expiresAt: Math.floor(Date.now() / 1000) + 600 };
  await assert.rejects(applySetup(cloudflareApi('administrator-test-auth', { request: cf.request }), spec, {
    state: { ticketKey, databaseId: 'recorded-d1' }, save: async () => {},
    migrations: [], releases: catalog, bundle: 'export default {}', managedOAuth: { clientId: 'fixture-oauth-client', grant },
  }), /D1 database ownership changed/);
  assert.equal(cf.writes.some(([method, path]) => method === 'POST' && path === account + '/d1/database'), false);
});

test('the selected Cloudflare domain is rechecked against its original target account', async () => {
  const zone = { id: 'a'.repeat(32), name: 'zone.example.test', status: 'active', account: { id: 'b'.repeat(32) } };
  const api = result => ({ async get(path) { assert.equal(path, '/zones/' + zone.id); return result; } });
  assert.equal(await verifyManagementZone(api(zone), zone), zone);
  await assert.rejects(verifyManagementZone(api({ ...zone, account: { id: 'c'.repeat(32) } }), zone), /域名或账户已变更/);
});

test('reconnect only stages a secret on the exact owned single-version management Worker', async () => {
  const clientId = 'fixture-public-management';
  const grant = { access: 'fixture-access-' + 'a'.repeat(40), refresh: 'fixture-refresh-' + 'a'.repeat(40),
    expiresAt: Math.floor(Date.now() / 1000) + 900 };
  const path = `/accounts/${spec.accountId}/workers/scripts/${spec.worker}`;
  const settings = ({ owner = spec.ownerEmail, staged = false } = {}) => ({ bindings: [
    ...Object.entries({ FLEET_OAUTH_MODE: 'managed', FLEET_OAUTH_RECOVERY: '1', FLEET_OAUTH_CLIENT_ID: clientId,
      APP_ORIGIN: spec.origin, OWNER_EMAIL: owner, FLEET_SPEC: JSON.stringify({ ...spec, accountScopedAccess: true }) })
      .map(([name, text]) => ({ type: 'plain_text', name, text })),
    { type: 'secret_text', name: 'FLEET_OAUTH_KEY' }, { type: 'durable_object_namespace', name: 'PROVISIONER_OAUTH' },
    ...(staged ? [{ type: 'secret_text', name: 'FLEET_OAUTH_RECONNECT' }] : []),
  ] });
  const writes = [];
  const api = (config = {}, pending = false) => ({
    async get(name) {
      if (name === path + '/settings') return settings(config);
      if (name === path + '/deployments') return { deployments: [{ versions: [{ version_id: 'live', percentage: 100 }] }] };
      assert.equal(name, path + '/versions');
      return { items: [{ id: pending ? 'staged' : 'live' }] };
    },
    async put(name, body) { writes.push([name, body]); },
  });
  await assert.rejects(reconnectManagement(api({ owner: 'other@example.test' }), spec, clientId, grant), /do not match/);
  await assert.rejects(reconnectManagement(api({ staged: true }), spec, clientId, grant), /already staged/);
  await assert.rejects(reconnectManagement(api({}, true), spec, clientId, grant), /pending or split/);
  assert.deepEqual(writes, []);
  assert.equal(await reconnectManagement(api(), spec, clientId, grant), spec.origin);
  const [[endpoint, payload]] = writes;
  assert.equal(writes.length, 1);
  assert.equal(endpoint, path + '/secrets');
  assert.equal(payload.name, 'FLEET_OAUTH_RECONNECT');
  assert.equal(payload.type, 'secret_text');
  const secret = JSON.parse(payload.text);
  assert.match(secret.generation, /^[a-f0-9]{32}$/);
  assert.deepEqual({ grant: secret.grant, clientId: secret.clientId }, { grant, clientId });
});

test('installer reports the exact pending readiness checks instead of declaring the deployment failed', async () => {
  const management = 'https://console.example.test';
  const accessIssuer = 'https://example.cloudflareaccess.com';
  const portal = 'https://portal.example.test/mcp';
  const messages = [];
  await assert.rejects(openManagementWhenReady({ management, portal, accessIssuer }, catalog, {
    ui: { wait: (_start, _done, run) => run(undefined, message => messages.push(message)) },
    timeoutMs: 0,
    request(url) {
      if (url === management) return Response.redirect(accessIssuer + '/cdn-cgi/access/login/console.example.test');
      if (url.startsWith(management + '/device/install/linux?')) {
        return new Response(bootstrapInstaller(management, 'linux', hostedInstallers(catalog).linux));
      }
      return new Response(null, { status: 503 });
    },
  }), error => {
    assert.match(error.message, /部署已提交/);
    assert.match(error.message, /MCP 客户端连接入口.*设备安装命令的脚本下载（Windows）/);
    assert.doesNotMatch(error.message, /管理台登录入口/);
    return true;
  });
  assert.deepEqual(messages, ['部署检查 1/3 项 · 管理台登录入口：已通过 · MCP 客户端连接入口：等待生效 · 设备安装命令的脚本下载（Windows）：等待生效']);
});

test('Cloudflare API drives completion even with an unreadable status endpoint; wrong binding never opens', async () => {
  const management = spec.origin, portal = 'https://' + spec.portalHostname + '/mcp';
  const domain = new URL(management).hostname;
  const info = { accountId: spec.accountId, zoneId: spec.zoneId, worker: spec.worker, portalId: spec.portalId,
    managementAppId: 'manager', portalAppId: 'portal', accessScope: 'account' };
  let wrongBinding = false, denied = false;
  const api = { async get(path) {
    assert.ok(path.startsWith('/accounts/'), 'Only the Cloudflare control plane is contacted');
    if (path.endsWith('/versions')) return { items: [{ id: 'current' }] };
    if (path.endsWith('/deployments')) {
      if (denied) throw new Error('OAuth scope did not allow reading deployments');
      return { deployments: [{ versions: [{ percentage: 100, version_id: 'current' }] }] };
    }
    if (path.endsWith('/workers/domains')) return [{ hostname: domain, service: wrongBinding ? 'other' : info.worker, zone_id: info.zoneId }];
    if (path.endsWith('/access/apps/manager')) return { type: 'self_hosted', domain };
    if (path.endsWith('/access/apps/portal')) return { type: 'mcp_portal', domain: spec.portalHostname, oauth_configuration: { enabled: true } };
    assert.ok(path.endsWith('/mcp/portals/' + info.portalId));
    return { hostname: spec.portalHostname };
  } };
  const opened = [], output = [];
  const ui = { note: message => output.push(message), finish: message => output.push(message),
    wait: (_start, _end, run) => run(undefined, () => {}) };
  const finalize = () => finishCloudDeployment({ management, portal, cloudDeployment: info }, api, ui,
    { browse: url => opened.push(url), retryDelay: 0 });
  assert.ok((await finalize()).every(item => item.state === 'confirmed'));
  denied = true;
  assert.equal((await finalize())[0].state, 'unverified');
  assert.match(output.at(-1), /部分状态尚未核实/);
  assert.deepEqual(opened, [management, management]);
  wrongBinding = true;
  await assert.rejects(finalize(), /未自动打开/);
  assert.equal(opened.length, 2);
});

test('existing OTP-only manager swaps only its Access login option, preserving audience and owner policy', async () => {
  const domain = new URL(spec.origin).hostname;
  const native = { id: '2'.repeat(32), type: 'cloudflare' }, otp = { id: '3'.repeat(32), type: 'onetimepin' };
  const cf = cloudFixture({ directPolicies: true, identityProviders: [otp, native] });
  const id = '4'.repeat(32);
  const rule = { name: spec.label + '-owner', decision: 'allow', include: [{ email: { email: spec.ownerEmail } }] };
  const app = { id, aud: 'existing-audience', domain, name: spec.label + '-management', type: 'self_hosted',
    allowed_idps: [otp.id], auto_redirect_to_identity: false, session_duration: '24h', policies: [rule] };
  cf.db.apps.push(app);
  const api = cloudflareApi('administrator-test-auth', { request: cf.request });
  const run = () => repairManagementLogin(api, spec, { providers: [otp, native] });
  assert.equal(await run(), true);
  assert.equal(await run(), false);
  assert.equal(app.aud, 'existing-audience');
  assert.equal(app.session_duration, '24h');
  assert.deepEqual(app.allowed_idps, [native.id]);
  assert.deepEqual(app.policies, [rule]);
  assert.deepEqual(cf.writes, [['PUT', account + '/access/apps/' + id]]);
  app.allowed_idps = ['5'.repeat(32)];
  await assert.rejects(run(), /自定义登录方式/);
  assert.equal(cf.writes.length, 1);
});

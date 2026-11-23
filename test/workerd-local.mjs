import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { confirmedRevocation } from '../cloud/device-revocation.mjs';
import { cloudflareApi } from '../cloud/cloudflare.mjs';
import { portalCallbackPresets } from '../cloud/portal-client-callbacks.mjs';
import { profiles } from '../cloud/profiles.mjs';
import { inspectEnrollmentUpgradeReadiness } from '../cloud/upgrade-enrollment-readiness.mjs';
import { applySetup } from '../src/setup-core.mjs';
import { spec, catalog, ticketKey, cloudFixture } from './cloudflare-fixture.mjs';
import { device, fixtureBackend, listen } from './helpers.mjs';

const { FLEET_WORKER_BUNDLE, FLEET_MINIFLARE, FLEET_TEST_LOCAL_ARCHIVE, FLEET_TEST_RUNTIME_OAUTH, FLEET_TEST_PLAYWRIGHT } = process.env;
const useLocal = FLEET_TEST_LOCAL_ARCHIVE === '1';
const managedOAuth = FLEET_TEST_RUNTIME_OAUTH === 'managed';
const useOAuth = FLEET_TEST_RUNTIME_OAUTH === '1' || managedOAuth;
const { sha256, version } = catalog['linux-x64'];
const releases = useLocal
  ? { ...catalog, 'linux-x64': { localFile: 'device.tgz', sha256, version } }
  : catalog;

async function openConsole(t, dispatch, admin) {
  const playwright = await import(pathToFileURL(FLEET_TEST_PLAYWRIGHT).href);
  const chromium = playwright.chromium ?? playwright.default?.chromium;
  assert.ok(chromium, 'The configured Playwright module must expose Chromium');
  const browser = await chromium.launch(process.env.FLEET_TEST_CHROMIUM
    ? { executablePath: process.env.FLEET_TEST_CHROMIUM } : { channel: 'chrome' });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 800 } });
  const commands = { reserve: 0, create: 0, intent: 0 };
  const origin = await listen(t, createServer(async (incoming, outgoing) => {
    try {
      if (incoming.method === 'POST' && incoming.url === '/admin/devices/reserve') commands.reserve++;
      if (incoming.method === 'POST' && incoming.url === '/admin/devices') commands.create++;
      if (incoming.method === 'POST' && incoming.url === '/admin/enrollment-intents') commands.intent++;
      const headers = new Headers({ 'Cf-Access-Jwt-Assertion': admin });
      for (const name of ['accept', 'content-type']) if (incoming.headers[name]) headers.set(name, incoming.headers[name]);
      if (incoming.headers.origin === origin) headers.set('Origin', spec.origin);
      const body = incoming.method === 'POST' ? Readable.toWeb(incoming) : undefined;
      const answer = await dispatch(incoming.url, { method: incoming.method, headers, body, ...(body && { duplex: 'half' }) });
      for (const [name, value] of answer.headers) {
        if (!['connection', 'content-length', 'content-encoding', 'transfer-encoding'].includes(name)) outgoing.setHeader(name, value);
      }
      outgoing.writeHead(answer.status).end(Buffer.from(await answer.arrayBuffer()));
    } catch {
      outgoing.writeHead(500).end();
    }
  }));
  return { page, origin, commands };
}

async function visitBrowserSetup(t, dispatch, admin) {
  const { page, origin, commands } = await openConsole(t, dispatch, admin);
  const manifestSha256 = 'd'.repeat(64);
  const upgradeChecks = { currentVersion: '1.0.0', nextVersion: '1.0.1', manifestSha256, includesEnrollment: true };
  let attempt = { starts: 0, reconciles: 0 };
  let releaseAvailable = false;
  await page.route(origin + '/admin/upgrade/check', route => route.fulfill({ json: releaseAvailable
    ? upgradeChecks : { currentVersion: '1.0.0' } }));
  await page.route(origin + '/admin/upgrade/status', route => route.fulfill({ json: attempt.operationId
    ? { phase: 'deploying', operationId: attempt.operationId, currentVersion: '1.0.0' }
    : { phase: 'idle', currentVersion: '1.0.0' } }));
  await page.route(origin + '/admin/upgrade/start', async route => {
    attempt.starts++;
    const form = new URLSearchParams(route.request().postData());
    assert.equal(form.get('version'), upgradeChecks.nextVersion);
    assert.equal(form.get('manifestSha256'), manifestSha256);
    assert.equal(form.has('releaseSha256'), false);
    attempt.operationId = form.get('operationId');
    assert.match(attempt.operationId, /^[a-f0-9-]{36}$/);
    attempt.capture(route);
  });
  await page.route(origin + '/admin/upgrade/reconcile', async route => {
    attempt.reconciles++;
    const form = new URLSearchParams(route.request().postData());
    assert.deepEqual([...form], [['operationId', attempt.operationId]]);
    await route.fulfill({ json: { status: attempt.reconciles === 1
      ? 'baseline_active_rollout_unconfirmed' : 'deployment_confirmed' } });
  });
  await page.goto(origin);
  await page.locator('#brand-version').filter({ hasText: 'v1.0.0' }).waitFor();
  assert.equal(await page.locator('#open-upgrade').isVisible(), false);
  releaseAvailable = true;
  for (const width of [1100, 360]) {
    attempt = { starts: 0, reconciles: 0 };
    const startReceived = new Promise(resolve => { attempt.capture = resolve; });
    await page.setViewportSize({ width, height: 800 });
    await page.goto(origin);
    const upgradeButton = page.locator('#open-upgrade');
    await upgradeButton.waitFor();
    assert.equal(await upgradeButton.getAttribute('aria-label'), '升级');
    assert.equal(await upgradeButton.locator('.upgrade-available-icon').isVisible(), true);
    assert.equal(await upgradeButton.locator('.upgrade-recovery-icon').isVisible(), false);
    await upgradeButton.press('Enter');
    const panel = page.getByRole('dialog', { name: '升级诺联管理台' });
    const status = panel.locator('#upgrade-status');
    const close = panel.getByRole('button', { name: '关闭', exact: true });
    const confirm = panel.getByRole('button', { name: '确认升级' });
    const reconcile = panel.getByRole('button', { name: '核对实际状态' });
    await confirm.waitFor();
    assert.match(await panel.locator('#upgrade-description').textContent(), /v1\.0\.0 → v1\.0\.1/);
    assert.match(await panel.locator('#upgrade-description').textContent(), /旧命令仍按原版本运行/);
    assert.equal(attempt.starts, 0);
    await confirm.waitFor();
    await confirm.press('Enter');
    const pending = await startReceived;
    assert.equal(await close.evaluate(button => document.activeElement === button), true);
    await page.keyboard.press('Escape');
    await upgradeButton.press('Enter');
    await panel.getByText('正在等待 Cloudflare 响应，请勿重复提交。', { exact: true }).waitFor();
    await pending.abort('failed');
    await reconcile.waitFor();
    assert.equal(await confirm.isVisible(), false);
    assert.equal(await reconcile.evaluate(button => {
      const rect = button.getBoundingClientRect();
      return rect.left >= 0 && rect.right <= innerWidth;
    }), true);
    await reconcile.press('Enter');
    await status.filter({ hasText: /流量仍全部指向旧版.*上次切换的结果仍未确认/ }).waitFor();
    assert.equal(await reconcile.evaluate(button => document.activeElement === button), true);
    await page.keyboard.press('Enter');
    await status.filter({ hasText: 'Cloudflare 已确认切换流量。' }).waitFor();
    assert.equal(await close.evaluate(button => document.activeElement === button), true);
    assert.equal(attempt.starts, 1);
    assert.equal(attempt.reconciles, 2);
    await page.keyboard.press('Escape');
    assert.equal(await upgradeButton.evaluate(button => document.activeElement === button), true);
    t.diagnostic(`Browser upgrade recovery passed at ${width}px`);
  }
  await page.setViewportSize({ width: 390, height: 800 });
  const pageTheme = () => page.evaluate(() => getComputedStyle(document.documentElement).colorScheme);
  await page.emulateMedia({ colorScheme: 'light' });
  assert.equal(await pageTheme(), 'light');
  const theme = page.getByRole('button', { name: /^外观主题/ });
  await theme.press('ArrowDown');
  await page.getByRole('menuitemradio', { name: '浅色' }).press('ArrowDown');
  await page.getByRole('menuitemradio', { name: '深色' }).press('Enter');
  assert.equal(await pageTheme(), 'dark');
  await page.reload();
  assert.equal(await pageTheme(), 'dark');
  await theme.click();
  await page.getByRole('menuitemradio', { name: '跟随系统' }).click();
  assert.equal(await pageTheme(), 'light');
  await page.emulateMedia({ colorScheme: 'dark' });
  assert.equal(await pageTheme(), 'dark');
  const portalLayout = () => page.evaluate(() => {
    const address = document.querySelector('#address');
    const range = document.createRange();
    range.selectNodeContents(address);
    const lines = new Set([...range.getClientRects()].map(rect => rect.top));
    const copy = document.querySelector('#copy-address').getBoundingClientRect();
    const portal = document.querySelector('.portal').getBoundingClientRect();
    return { lines: lines.size, fits: copy.right <= portal.right &&
      document.documentElement.scrollWidth <= innerWidth };
  });
  await page.setViewportSize({ width: 1100, height: 800 });
  const currentAddress = await page.locator('#address').textContent();
  await page.locator('#address').evaluate(node => { node.textContent = 'https://portal.example.test/mcp'; });
  assert.deepEqual(await portalLayout(), { lines: 1, fits: true });
  await page.setViewportSize({ width: 320, height: 800 });
  await page.locator('#address').evaluate(node => { node.textContent = 'https://' + 'a'.repeat(63) + '.example.test/mcp'; });
  assert.equal((await portalLayout()).fits, true);
  await page.locator('#address').evaluate((node, original) => { node.textContent = original; }, currentAddress);
  await page.setViewportSize({ width: 390, height: 800 });
  const callbackButton = page.getByRole('button', { name: '客户端回调配置' });
  const callbackPanel = page.getByRole('dialog').filter({ has: page.locator('#callback-title') });
  await page.route(origin + '/admin/client-callbacks', route => route.fulfill({ status: 503,
    json: { error: '测试：临时读取失败' } }), { times: 1 });
  await callbackButton.click();
  await callbackPanel.getByRole('button', { name: '重试读取回调设置' }).click();
  await callbackPanel.getByText('已启用', { exact: true }).waitFor();
  await callbackPanel.locator('#workbuddy-state').getByText('待配置').waitFor();
  await callbackPanel.getByRole('button', { name: '添加其他客户端' }).click();
  await callbackPanel.getByRole('textbox', { name: '客户端名称' }).fill('Browser fixture');
  const address = callbackPanel.getByRole('textbox', { name: '回调地址' });
  const save = callbackPanel.getByRole('button', { name: '保存', exact: true });
  const callback = 'https://client.example.test/oauth/callback';
  await address.fill(callback + '?code=fixture');
  await save.click();
  await callbackPanel.locator('#callback-save-error').waitFor();
  await address.fill(callback);
  await save.click();
  await callbackPanel.getByRole('status').getByText('回调地址已保存到 Portal。').waitFor();
  const configured = callbackPanel.locator('#callback-configured-list').getByText(callback, { exact: true });
  await configured.waitFor();
  await page.reload();
  await callbackButton.click();
  await configured.waitFor();
  await callbackPanel.getByRole('button', { name: '关闭', exact: true }).click();

  await page.getByRole('button', { name: '添加设备', exact: true }).click();
  const add = page.getByRole('dialog');
  assert.equal(await add.getByRole('radio').count(), 0);
  const deviceName = '办公室浏览器';
  await add.getByRole('textbox', { name: '设备名称' }).fill(deviceName);
  const reserve = page.waitForResponse(response => response.url() === origin + '/admin/devices/reserve');
  await add.getByRole('button', { name: '添加设备', exact: true }).click();
  const reserved = await reserve;
  assert.equal(reserved.status(), 200);
  assert.deepEqual([...new URLSearchParams(reserved.request().postData())], [['name', deviceName]]);
  const { deviceId, draftSaved } = await reserved.json();
  assert.equal(draftSaved, true);
  assert.match(deviceId, /^dev-[0-9a-f]{16}$/);
  const workerRow = page.getByRole('row').filter({ has: page.getByText(deviceName, { exact: true }) });
  await workerRow.getByText('未选择系统', { exact: true }).waitFor();
  assert.equal(await workerRow.getAttribute('data-device'), deviceId);
  assert.deepEqual(commands, { reserve: 1, create: 0, intent: 0 });
  await workerRow.getByRole('button', { name: '安装命令' }).click();
  await add.getByText('Linux', { exact: true }).click();
  assert.equal(await add.locator('#confirm-browser').isVisible(), false);
  await add.getByText('Windows', { exact: true }).click();
  const confirm = add.getByRole('checkbox', { name: '为此设备启用浏览器工具' });
  assert.equal(await confirm.isChecked(), false);
  const issue = add.getByRole('button', { name: '生成安装命令' });
  await issue.click();
  assert.equal(commands.create, 0);
  await confirm.check();
  const issued = page.waitForResponse(response => response.url() === `${origin}/admin/devices` && response.request().method() === 'POST');
  await issue.click();
  assert.equal((await issued).status(), 200);
  await add.getByRole('heading', { name: '设备连接指令' }).waitFor();
  assert.match(await add.locator('#command-instructions').textContent(), /浏览器专用后端/);
  await add.locator('#device-command-expiration').filter({ hasText: '命令还可使用' }).waitFor();
  await add.locator('#device-enrollment-progress').filter({ hasText: '等待设备接入' }).waitFor();
  const command = await add.locator('#device-command').textContent();
  return {
    command, deviceId,
    async checkEnrollment() {
      await add.locator('#device-enrollment-progress').filter({ hasText: '设备已接入 Portal' }).waitFor({ timeout: 15000 });
      await page.locator('tr[data-device="' + deviceId + '"][data-state="active"]').waitFor({ state: 'attached' });
      assert.equal(await add.locator('#device-command').textContent(), '');
      assert.equal(await add.locator('#copy-device-command').isDisabled(), true);
      let releaseList;
      const list = new Promise(resolve => { releaseList = resolve; });
      await page.route(origin + '/', async route => { await list; await route.fulfill({ status: 503 }); }, { times: 1 });
      try {
        await add.getByRole('button', { name: '关闭弹层' }).click();
        await page.getByRole('button', { name: '添加设备', exact: true }).click();
        await add.getByRole('heading', { name: '添加设备', exact: true }).waitFor();
        assert.equal(await add.getByRole('textbox', { name: '设备名称' }).inputValue(), '');
        assert.equal(await add.locator('#device-command-result').isVisible(), false);
        await add.getByRole('button', { name: '关闭弹层' }).click();
      } finally { releaseList(); }
      const retry = page.getByRole('button', { name: '重试刷新列表' });
      await retry.waitFor();
      let resumeRetry;
      const retryBlocked = new Promise(resolve => { resumeRetry = resolve; });
      let retryRequests = 0;
      const holdRetry = async route => { retryRequests++; await retryBlocked; await route.continue(); };
      await page.route(origin + '/', holdRetry);
      try {
        await retry.focus();
        await page.keyboard.press('Enter');
        await page.locator('#retry-device-list[aria-disabled="true"]').waitFor();
        assert.equal(await retry.evaluate(node => node === document.activeElement), true);
        await page.keyboard.press('Enter');
      } finally { resumeRetry(); }
      await retry.waitFor({ state: 'hidden' });
      assert.equal(await page.locator('#device-search').evaluate(node => node === document.activeElement), true);
      assert.equal(retryRequests, 1);
      await page.unroute(origin + '/', holdRetry);
      t.diagnostic('Keyboard list retry retained and restored focus');
    },
    async checkStatus(browserStatus) {
      await page.goto(origin);
      await workerRow.getByRole('button', { name: '查看状态' }).click();
      const status = page.getByRole('dialog', { name: '设备状态' });
      await status.locator('#browser-detail').filter({ hasText: browserStatus }).waitFor();
      assert.equal(await status.locator('#mcp-detail').textContent(), '目录已验证');
    },
  };
}

async function visitDurableEnrollment(t, dispatch, admin, form, db) {
  const { page, origin, commands } = await openConsole(t, dispatch, admin);
  await page.goto(origin);
  const deviceName = '长期安装设备';
  const addButton = page.getByRole('button', { name: '添加设备', exact: true });
  await addButton.click();
  const dialog = page.getByRole('dialog');
  assert.equal(await dialog.getByRole('radio').count(), 0);
  await dialog.getByRole('textbox', { name: '设备名称' }).fill(deviceName);
  await dialog.getByRole('button', { name: '添加设备', exact: true }).click();
  const row = page.getByRole('row').filter({ has: page.getByText(deviceName, { exact: true }) });
  const launch = row.getByRole('button', { name: '安装命令', exact: true });
  await launch.waitFor();
  const deviceId = await row.getAttribute('data-device');
  assert.match(deviceId, /^dev-[0-9a-f]{16}$/);
  assert.deepEqual(commands, { reserve: 1, create: 0, intent: 0 });
  assert.equal(await row.getAttribute('data-intent'), null);
  const command = dialog.locator('#device-command');
  const copy = dialog.locator('#copy-device-command');
  const status = dialog.locator('#device-enrollment-progress');
  await launch.click();
  // One command covers every hosted system. The fixture's Windows bundle
  // carries browser tools, so the dialog asks for that consent once.
  await dialog.getByRole('checkbox', { name: '为此设备启用浏览器工具' }).check();
  await dialog.getByRole('button', { name: '显示安装命令' }).click();
  await command.waitFor();
  const first = await db.prepare("SELECT id FROM enrollment_intents WHERE device_id = ? AND state = 'pending'")
    .bind(deviceId).first();
  const intentId = first?.id;
  assert.match(intentId, /^[a-f0-9-]{36}$/);
  assert.equal(await copy.isEnabled(), true);
  assert.match(await command.textContent(),
    /^bash <\(curl -fsSL https:\/\/raw\.githubusercontent\.com\/Erlin0220\/nodrelay\/refs\/heads\/main\/install\.sh\) -e https:\/\/\S+ -t [A-Za-z0-9_-]{43}$/);
  assert.match(await dialog.locator('#device-command-expiration').textContent(), /不会过期/);
  assert.deepEqual(commands, { reserve: 1, create: 1, intent: 0 });
  const systems = dialog.locator('#device-command-systems');
  await systems.getByText('Windows', { exact: true }).click();
  assert.match(await command.textContent(), /^powershell\.exe -NoProfile -ExecutionPolicy Bypass -Command "try \{ iwr /);
  await systems.getByText('Linux', { exact: true }).click();
  assert.match(await command.textContent(), /^bash </);
  assert.deepEqual(commands, { reserve: 1, create: 1, intent: 0 }, 'switching systems sends nothing');

  // A separate owner session revokes the original reservation and reuses the name.
  assert.equal((await form('/admin/enrollment-intents', { deviceId, intentId, action: 'revoke' })).status, 200);
  assert.equal((await form('/admin/devices', { deviceId, platform: 'linux' })).status, 200);
  const replacement = await db.prepare("SELECT id FROM enrollment_intents WHERE device_id = ? AND state = 'pending'")
    .bind(deviceId).first();
  assert.ok(replacement?.id && replacement.id !== intentId);
  await copy.focus();
  await status.filter({ hasText: '这条安装命令已撤销' }).waitFor({ timeout: 15000 });
  assert.equal(await copy.isDisabled(), true);
  assert.equal(await command.textContent(), '');
  assert.equal(await status.evaluate(node => node === document.activeElement), true);
  t.diagnostic('Browser durable enrollment keeps a revoked command bound to its original intent');
}

for (const durable of [false, true]) test(durable ? 'managed Worker renders durable enrollment using actual D1'
  : 'managed Worker registers and revokes an enrolled device using actual D1', {
  skip: !FLEET_WORKER_BUNDLE || !FLEET_MINIFLARE || (durable && !managedOAuth), timeout: 35000,
}, async t => {
  const { Miniflare, Response: LocalResponse } = await import(pathToFileURL(FLEET_MINIFLARE).href);
  const access = 'fixture-runtime-access-' + 'a'.repeat(40);
  const refresh = 'fixture-runtime-refresh-' + 'a'.repeat(40);
  const cloudflare = cloudFixture(useOAuth ? { provisionerToken: access, directPolicies: managedOAuth } : {});
  const oauthBindings = {
    FLEET_OAUTH_CLIENT_ID: 'fixture-runtime-client',
    FLEET_OAUTH_KEY: Buffer.alloc(32, 17).toString('base64url'),
    FLEET_OAUTH_SEED: JSON.stringify({ access: 'expired-access-' + 'x'.repeat(40), refresh, expiresAt: 0 }),
    ...(managedOAuth && { FLEET_OAUTH_MODE: 'managed' }),
  };
  let refreshes = 0;
  let seedRemovals = 0;
  const localRoutes = new Map();
  if (useOAuth) {
    if (!managedOAuth) cloudflare.db.policies.push({ id: 'fixture-owner-policy' });
    cloudflare.db.portal = { id: spec.portalId, name: spec.label, hostname: spec.portalHostname, servers: [] };
    if (managedOAuth) {
      cloudflare.db.apps.push({
        id: 'f'.repeat(32), name: spec.label, type: 'mcp_portal', domain: spec.portalHostname,
        policies: [{ id: 'fixture-access-policy', decision: 'allow', include: [{ email: { email: spec.ownerEmail } }] }],
        oauth_configuration: { enabled: true, dynamic_client_registration: {
          enabled: true, allowed_uris: portalCallbackPresets.flatMap(({ uris }) => uris),
        } },
      });
    }
  } else {
    await applySetup(cloudflareApi('administrator-test-auth', { request: cloudflare.request }), spec, {
      state: { ticketKey }, save: async () => {},
      bundle: 'export default {}', releases,
      migrations: ['CREATE TABLE IF NOT EXISTS fixture (id TEXT)'],
    });
  }
  const issuer = 'https://fixture.cloudflareaccess.com';
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk = { ...await exportJWK(publicKey), alg: 'RS256', kid: 'local-fixture', use: 'sig' };
  const admin = await new SignJWT({ email: spec.ownerEmail })
    .setProtectedHeader({ alg: 'RS256', kid: jwk.kid })
    .setIssuer(issuer).setAudience('issuer-audience').setSubject('fixture-owner').setExpirationTime('5m').sign(privateKey);
  const instance = new Miniflare({
    name: 'devspace-fleet-managed-local', modules: true,
    script: (await readFile(FLEET_WORKER_BUNDLE, 'utf8')).replace(/^\/\/# sourceMappingURL=.*$/m, ''),
    compatibilityDate: '2026-07-30',
    d1Databases: ['TICKETS'], cf: false,
    ...(useOAuth && { durableObjects: { PROVISIONER_OAUTH: 'OAuthProvisioner' } }),
    bindings: {
      APP_ORIGIN: spec.origin, ACCESS_ISSUER: issuer, ACCESS_AUD: 'issuer-audience', OWNER_EMAIL: spec.ownerEmail,
      TICKET_KEY: ticketKey, RELEASE_CATALOG: JSON.stringify(releases),
      FLEET_SPEC: JSON.stringify({ ...spec, ...(managedOAuth
        ? { accountScopedAccess: true }
        : { policyId: cloudflare.db.policies[0].id }) }),
      ...(useOAuth ? oauthBindings : { PROVISIONER_TOKEN: 'generated-provisioner' }),
      ...(durable && { FLEET_ENROLLMENT_PROTOCOL: 'intent-v1', FLEET_ENROLLMENT_HISTORY: '{}' }),
    },
    async outboundService(request) {
      const adapterUrl = localRoutes.get(request.url);
      if (adapterUrl) {
        const { method, headers } = request;
        const answer = await fetch(adapterUrl, { method, headers, body: await request.text() });
        return new LocalResponse(await answer.arrayBuffer(), { status: answer.status, headers: answer.headers });
      }
      if (request.url === 'https://dash.cloudflare.com/oauth2/token') {
        assert.equal(useOAuth, true);
        refreshes++;
        const form = new URLSearchParams(await request.text());
        assert.equal(form.get('grant_type'), 'refresh_token');
        assert.equal(form.get('client_id'), oauthBindings.FLEET_OAUTH_CLIENT_ID);
        assert.equal(form.get('refresh_token'), refresh);
        return new LocalResponse(JSON.stringify({ access_token: access, refresh_token: refresh + '-rotated',
          token_type: 'Bearer', expires_in: 900 }), { headers: { 'Content-Type': 'application/json' } });
      }
      if (request.url === issuer + '/cdn-cgi/access/certs') {
        return new LocalResponse(JSON.stringify({ keys: [jwk] }), { headers: { 'Content-Type': 'application/json' } });
      }
      const seedPath = `https://api.cloudflare.com/client/v4/accounts/${spec.accountId}/workers/scripts/${spec.worker}/secrets/FLEET_OAUTH_SEED`;
      if (request.url === seedPath) {
        assert.equal(managedOAuth, true);
        assert.equal(request.method, 'DELETE');
        assert.equal(request.headers.get('Authorization'), 'Bearer ' + access);
        seedRemovals++;
        return new LocalResponse(null, { status: 204 });
      }
      const result = await cloudflare.request(request.url, {
        method: request.method, headers: { Authorization: request.headers.get('Authorization') },
        ...(request.body && { body: await request.text() }),
      });
      return new LocalResponse(await result.arrayBuffer(), { status: result.status, headers: result.headers });
    },
  });
  t.after(() => instance.dispose());

  const realDb = await instance.getD1Database('TICKETS');
  for (const file of ['0001_tickets.sql', '0002_devices.sql', '0003_portal_callback_labels.sql', '0004_enrollment_intents.sql', '0005_upgrade_journal.sql']) {
    const migration = await readFile(new URL('../cloud/' + file, import.meta.url), 'utf8');
    for (const statement of migration.split(';').map(sql => sql.trim()).filter(Boolean)) await realDb.prepare(statement).run();
  }
  if (managedOAuth && !durable) {
    // Check SQLite introspection through the real D1 binding, not just the Node wrapper.
    // This provider is deliberately stopped at the first read; no outbound call is made.
    let providerReads = 0;
    const api = {
      get: () => assert.fail('unexpected second provider call'),
      list: () => { providerReads++; throw new Error('fixture: D1 preflight confirmed'); },
    };
    const inspect = () => inspectEnrollmentUpgradeReadiness({
      api, db: realDb, spec: { ...spec, accountScopedAccess: true, zoneScopedAccess: false },
    });
    await assert.rejects(inspect, /fixture: D1 preflight confirmed/);
    assert.equal(providerReads, 1);
    await realDb.prepare('DROP INDEX enrollment_intents_pending_device').run();
    await realDb.prepare(`CREATE UNIQUE INDEX enrollment_intents_pending_device
      ON enrollment_intents (device_id) WHERE state = 'claimed'`).run();
    await assert.rejects(inspect, /requires the expected pending-device index/);
    assert.equal(providerReads, 1);
    await realDb.prepare('DROP INDEX enrollment_intents_pending_device').run();
    const migration = await readFile(new URL('../cloud/0004_enrollment_intents.sql', import.meta.url), 'utf8');
    await realDb.prepare(migration.split(';').map(sql => sql.trim()).find(sql => sql.startsWith('CREATE UNIQUE INDEX'))).run();
    t.diagnostic('Workerd D1 accepted the migration and rejected the drifted pending-device index');
  }
  const dispatch = (path, init) => instance.dispatchFetch(spec.origin + path, init);
  const form = (path, input) => dispatch(path, {
    method: 'POST', headers: { Origin: spec.origin, 'Cf-Access-Jwt-Assertion': admin }, body: new URLSearchParams(input),
  });
  assert.equal((await dispatch('/')).status, 403);
  if (durable) {
    if (FLEET_TEST_PLAYWRIGHT) await visitDurableEnrollment(t, dispatch, admin, form, realDb);
    else {
      const deviceId = 'durable-local';
      assert.equal((await form('/admin/devices/reserve', { deviceId })).status, 200);
      const draft = await realDb.prepare('SELECT platform, credentials, tunnel_id FROM fleet_devices WHERE id = ?')
        .bind(deviceId).first();
      assert.deepEqual(draft, { platform: '', credentials: null, tunnel_id: null });
      assert.equal(await realDb.prepare('SELECT id FROM enrollment_intents WHERE device_id = ?').bind(deviceId).first(), null);
      const issued = await form('/admin/devices', { deviceId, platform: 'linux' });
      assert.equal(issued.status, 200);
      const { intentId } = await realDb.prepare('SELECT id AS intentId FROM enrollment_intents WHERE device_id = ?')
        .bind(deviceId).first();
      const target = { deviceId, intentId };
      const revealed = await form('/admin/enrollment-intents', { ...target, action: 'reveal' });
      assert.equal(revealed.status, 200);
      assert.equal((await revealed.json()).durable, true);
      assert.equal((await form('/admin/enrollment-intents', { ...target, action: 'revoke' })).status, 200);
      const status = await dispatch('/admin/devices/enrollment?' + new URLSearchParams(target),
        { headers: { 'Cf-Access-Jwt-Assertion': admin } });
      assert.deepEqual(await status.json(), { registration: 'revoked' });
    }
    assert.deepEqual(cloudflare.writes, []);
    return;
  }
  const page = await form('/admin/devices', { deviceId: 'worker-test', platform: 'linux-x64' });
  assert.equal(page.status, 200);
  const commandPage = await page.text();
  if (useLocal) {
    assert.match(commandPage, /本次试点使用目标设备上已准备的安装包/);
    assert.match(commandPage, /cp &#39;\.\/device\.tgz&#39;/);
    assert.doesNotMatch(commandPage, /curl --disable/);
  }
  const ticket = /DEVSPACE_FLEET_TICKET=&#39;([A-Za-z0-9_-]{43})&#39;/.exec(commandPage)[1];
  const post = (path, body, token) => dispatch(path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
    body: JSON.stringify(body),
  });
  const attempts = await Promise.all(Array.from({ length: 4 }, () => post('/device/enroll', { ticket })));
  assert.deepEqual(attempts.map(response => response.status).sort(), [200, 404, 404, 404]);
  const credentials = await attempts.find(response => response.ok).json();
  if (useOAuth) {
    for (const value of [access, refresh]) assert.equal(JSON.stringify(credentials).includes(value), false);
    assert.equal((await dispatch('/access-token')).status, 403);
  }
  assert.equal((await post('/device/activate', { deviceId: 'worker-test' }, 'z'.repeat(43))).status, 401);
  assert.equal((await post('/device/activate', { deviceId: 'worker-test' }, credentials.activationToken)).status, 200);
  let peer;
  if (useOAuth) {
    const peerPage = await form('/admin/devices', { deviceId: 'worker-peer', platform: 'linux-x64' });
    assert.equal(peerPage.status, 200);
    const peerTicket = /DEVSPACE_FLEET_TICKET=&#39;([A-Za-z0-9_-]{43})&#39;/.exec(await peerPage.text())[1];
    const enrollment = await post('/device/enroll', { ticket: peerTicket });
    assert.equal(enrollment.status, 200);
    peer = await enrollment.json();
    assert.equal((await post('/device/activate', { deviceId: 'worker-peer' }, peer.activationToken)).status, 200);
    assert.equal(new Set(cloudflare.db.tunnels.map(tunnel => tunnel.id)).size, 2);
  }
  assert.equal((await form('/admin/device', { deviceId: 'worker-test', action: 'disable' })).status, 200);
  const revoked = await post('/device/activate', { deviceId: 'worker-test' }, credentials.activationToken);
  assert.equal(revoked.status, 410);
  assert.equal(await confirmedRevocation(await revoked.json(), spec.origin, 'worker-test', credentials.activationToken), true);
  assert.equal((await post('/device/activate', { deviceId: 'worker-test' }, 'z'.repeat(43))).status, 401);
  if (useOAuth) {
    assert.equal(refreshes, 1);
    assert.equal(seedRemovals, managedOAuth ? 1 : 0);
    assert.equal(cloudflare.db.tokens.length, 0);
    assert.equal(cloudflare.db.tunnels[0].rotated, true);
    assert.equal(cloudflare.db.tunnels[1].rotated, undefined);
    assert.equal((await post('/device/activate', { deviceId: 'worker-peer' }, peer.activationToken)).status, 200);
    if (managedOAuth) {
      const deviceApps = cloudflare.db.apps.filter(app => app.type === 'mcp');
      assert.equal(deviceApps.length, 2);
      for (const app of deviceApps) {
        assert.deepEqual(app.policies.map(policy => [policy.decision, policy.include]), [
          ['allow', [{ email: { email: spec.ownerEmail } }]],
        ]);
      }
    }
  }
  if (managedOAuth && FLEET_TEST_PLAYWRIGHT) {
    const app = cloudflare.db.apps.find(row => row.type === 'mcp_portal');
    const policy = structuredClone(app.policies);
    const { command, deviceId: browserDeviceId, checkEnrollment, checkStatus } = await visitBrowserSetup(t, dispatch, admin);
    const allowed = app.oauth_configuration.dynamic_client_registration.allowed_uris;
    assert.ok(allowed.includes('https://client.example.test/oauth/callback'));
    assert.ok(!allowed.some(uri => uri.includes('?code=')));
    assert.deepEqual(app.policies, policy);
    const ticket = new RegExp(`'${browserDeviceId}' '([A-Za-z0-9_-]{43})' \\}$`).exec(command)?.[1];
    assert.ok(ticket, 'The administrator received a real one-time ticket from D1');
    const enrollment = await post('/device/enroll', { ticket });
    assert.equal(enrollment.status, 200);
    const browserCredentials = await enrollment.json();
    assert.equal(browserCredentials.deviceId, browserDeviceId);
    assert.notEqual(browserCredentials.browserToken, browserCredentials.portalToken);
    assert.equal((await post('/device/enroll', { ticket })).status, 404);

    const localProvider = await fixtureBackend(t, profiles.browser.tools, () => assert.fail('A readiness check dispatched a browser tool'));
    const adapter = await device(t, localProvider.url, 'browser', { expectedBrowserServer: 'fixture', portalToken: browserCredentials.browserToken });
    const direct = `https://${browserDeviceId}${spec.deviceSuffix}/browser/mcp`;
    localRoutes.set(direct, adapter.url);
    const activate = () => post('/device/activate', { deviceId: browserDeviceId }, browserCredentials.activationToken);
    const before = cloudflare.writes.length;
    localProvider.setOffline(true);
    assert.equal((await activate()).status, 409);
    assert.equal(cloudflare.writes.length, before);
    localProvider.setOffline(false);
    assert.equal((await activate()).status, 200);
    const routes = cloudflare.db.servers.filter(server => server.name.startsWith(browserDeviceId + '-'));
    assert.equal(routes.length, 2);
    assert.ok(routes.every(route => cloudflare.db.portal.servers.some(entry => entry.server_id === route.id)));
    await checkEnrollment();
    await checkStatus('目录已验证');
    localProvider.setOffline(true);
    await checkStatus('目录无法访问');
  }
});

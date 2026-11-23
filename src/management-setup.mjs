import { matchesInstallerFeed } from '../cloud/upgrade-feed-migration.mjs';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { cloudflareApi, cloudflareRequestTimeoutMs, CloudflareError, CloudflareRequestTimeoutError, publicAccessApp, safeCloudflareRoute } from '../cloud/cloudflare.mjs';
import { ensureScopedAccessApp } from '../cloud/zone-access.mjs';
import { hostedInstallers, installPath, operatingSystems } from '../cloud/device-paths.mjs';
import { bootstrapInstaller } from '../cloud/install-command.mjs';
import { managementBootstrapOAuthScopes, managementIdentityOAuthScopes, managementIdentityScope, managementOAuthScopes, usableStoredGrant } from '../cloud/oauth-grant.mjs';
import { authorize, openBrowser } from './cloudflare-oauth.mjs';
import { writeManagementFailure } from './management-diagnostics.mjs';
import { archiveInterruptedManagementLock, ManagementLockError, takeManagementLock } from './management-lock.mjs';
import { ensureManagementAccess } from './management-onboarding.mjs';
import { portalAccessReady, validatePortalUrl } from './portal-readiness.mjs';
import { managementRelease } from './management-release.mjs';
import { adoptManagementUpgradeBaseline } from './management-upgrade-baseline.mjs';
import { upgradeManagementFromCommand } from './management-command-upgrade.mjs';
import { createCloudflareUpgradeAdapter } from '../cloud/upgrade-cloudflare.mjs';
import { proveManagementSso, removeSsoProof } from './management-sso.mjs';
import { createManagementTerminal, InstallationCancelled, terminalLabel } from './management-terminal.mjs';
import { ensurePrivateDirectory, readPrivateFile, writePrivateFile } from './private-directory.mjs';
import { applySetup, directManagementProvider, isAdministratorEmail, isDeploymentNamespace, makeSetupSpec, managementAccessConfiguration, workersSubdomainName } from './setup-core.mjs';

async function chooseListed(options, label, prompt, ui) {
  if (options.length === 1) {
    const [only] = options;
    ui.success(`${label} · ${only.label}（已自动选择）`);
    return only.value;
  }
  return ui.select(prompt, options);
}

export async function chooseManagementZone(api, ui) {
  const accounts = await api.list('/accounts', { per_page: 50 });
  if (!accounts.length) {
    throw new Error('本次授权未返回可用的 Cloudflare 账户。请重新运行安装命令，并在浏览器中授权要部署的账户。');
  }
  const accountLabels = accounts.map(value => terminalLabel(value.name) || '未命名账户');
  let account;
  while (true) {
    account ??= await chooseListed(accounts.map((value, index) => {
      const label = accountLabels[index];
      return {
        value,
        label: accountLabels.indexOf(label) === accountLabels.lastIndexOf(label)
          ? label : `[…${terminalLabel(value.id).slice(-8)}] ${label}`,
      };
    }), 'Cloudflare 账户', '选择 Cloudflare 账户', ui);
    const zones = (await api.list('/zones', { 'account.id': account.id, status: 'active', per_page: 50 }))
      .filter(zone => zone.account?.id === account.id && zone.status === 'active' &&
        !/(^|\.)(workers|pages)\.dev$/.test(zone.name));
    if (!zones.length) {
      ui.info(`Cloudflare 账户「${terminalLabel(account.name) || '未命名账户'}」下没有可用的已激活域名。` +
        '诺联必须使用自有域名：每台设备的 Tunnel 地址和 MCP Portal 都要建在该账户的域名下，workers.dev 子域无法承载它们。' +
        '请在该账户控制台添加或激活域名，再选择重新检测；无需重新授权。');
      const action = await ui.select('下一步', [
        ...(accounts.length > 1 ? [{ value: 'back', label: '返回账户选择' }] : []),
        { value: 'retry', label: '已配置域名，重新检测' },
        { value: 'cancel', label: '取消安装' },
      ]);
      if (action === 'cancel') throw new InstallationCancelled();
      if (action === 'back') account = undefined;
      continue;
    }
    return chooseListed(zones.map(value => ({ value, label: terminalLabel(value.name) })), '部署域名', '选择部署域名', ui);
  }
}

export async function getManagementOwnerEmail(api) {
  const profile = await api.get('/user').catch(error => {
    if (error.status === 401 || error.status === 403) {
      throw new Error(`Cloudflare 没有允许读取当前登录邮箱。请重新授权用户资料只读权限（${managementIdentityScope}），并确认发行客户端已启用该权限。`);
    }
    throw new Error('暂时无法读取 Cloudflare 登录邮箱。请检查网络后重试安装。');
  });
  if (typeof profile?.email !== 'string' || !isAdministratorEmail(profile.email) ||
      profile.suspended === true || profile.email_verified === false) {
    throw new Error('Cloudflare 未返回可用的登录邮箱。请在 Cloudflare 核对账户邮箱和账户状态，再重试安装。');
  }
  return profile.email;
}

function readinessSignal(signal) {
  const timeout = AbortSignal.timeout(5000);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function managementAccessReady(management, issuer, request, signal) {
  try {
    const response = await request(management, { redirect: 'manual', headers: { Accept: 'text/html' }, signal: readinessSignal(signal) });
    await response.body?.cancel();
    if (![302, 303].includes(response.status)) return false;
    const login = new URL(response.headers.get('Location'));
    return login.origin === issuer && login.pathname === '/cdn-cgi/access/login/' + new URL(management).hostname;
  } catch { return false; }
}

export async function waitForManagementAccess(management, issuer, releases, {
  timeoutMs = 15 * 60 * 1000, intervalMs = 10000, request = fetch, signal, portal, onProgress,
} = {}) {
  if (portal !== undefined) validatePortalUrl(portal);
  const bootstraps = Object.entries(hostedInstallers(releases)).map(([platform, group]) => {
    const url = new URL(installPath(platform), management);
    url.searchParams.set('version', group.version);
    return { platform, url: url.href, expected: Buffer.from(bootstrapInstaller(url.origin, platform, group)) };
  });
  const bootstrapReady = async ({ url, expected }) => {
    try {
      const response = await request(url, { redirect: 'manual', signal: readinessSignal(signal) });
      if (response.status !== 200 || !response.body || response.headers.get('Content-Type')?.split(';')[0].trim() !== 'text/plain') {
        await response.body?.cancel();
        return false;
      }
      const reader = response.body.getReader();
      let offset = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) return offset === expected.length;
          const end = offset + value.length;
          if (end > expected.length || !expected.subarray(offset, end).equals(value)) return false;
          offset = end;
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
    } catch { return false; }
  };
  const deadline = Date.now() + timeoutMs;
  do {
    signal?.throwIfAborted();
    const [login, mcp, ...installers] = await Promise.all([
      managementAccessReady(management, issuer, request, signal),
      portal ? portalAccessReady(portal, issuer, request, signal) : undefined,
      ...bootstraps.map(bootstrapReady),
    ]);
    signal?.throwIfAborted();
    onProgress?.({ login, portal: mcp,
      installers: bootstraps.map(({ platform }, index) => ({ platform, ready: installers[index] })),
    });
    if (login && mcp !== false && installers.every(Boolean)) return true;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await sleep(Math.min(intervalMs, remaining), undefined, { signal });
  } while (Date.now() < deadline);
  return false;
}

function readinessItems({ login, portal, installers } = {}) {
  const waiting = installers?.filter(({ ready }) => !ready)
    .map(({ platform }) => operatingSystems[platform].label);
  return [
    ['管理台登录入口', login],
    ...(portal === undefined ? [] : [['MCP 客户端连接入口', portal]]),
    ...(installers?.length ? [[`设备安装命令的脚本下载${waiting.length ? '（' + waiting.join('、') + '）' : ''}`, !waiting.length]] : []),
  ];
}

function readinessError(management, accessIssuer, interactive = false, portal, lastCheck) {
  const portalOption = portal ? ` --portal ${portal}` : '';
  if (interactive) {
    const pending = readinessItems(lastCheck).filter(([, ready]) => !ready).map(([label]) => label);
    return new Error(`部署已提交，但以下项目暂未通过检查：${pending.join('、')}。管理台地址：${management}。`);
  }
  return new Error(`The management Access login, MCP Portal or a signed device installer is not ready at ${management}. ` +
    `After Cloudflare propagation, run the same installation command with --check ${management} ${accessIssuer}${portalOption}.`);
}

export async function checkManagementReadiness(management, accessIssuer, releases, options) {
  const site = new URL(management);
  if (site.protocol !== 'https:' || site.href !== site.origin + '/' || site.port ||
      !/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(accessIssuer)) {
    throw new Error('Supply a management HTTPS origin and its exact Cloudflare Access issuer.');
  }
  if (!await waitForManagementAccess(site.origin, accessIssuer, releases, { ...options, timeoutMs: 0 })) {
    throw readinessError(site.origin, accessIssuer, false, options?.portal);
  }
  return site.origin;
}

export async function openManagementWhenReady({ management, portal, accessIssuer }, releases, { ui, ...options } = {}) {
  if (ui) {
    try {
      let lastCheck;
      await ui.wait('部署已提交，正在检查登录和连接入口（最长 15 分钟，无需操作）', '登录、连接和下载检查通过', async (signal, update) => {
        const ready = await waitForManagementAccess(management, accessIssuer, releases, {
          ...options, signal, portal, onProgress(state) {
            lastCheck = state;
            const items = readinessItems(state);
            const passed = items.filter(([, ok]) => ok).length;
            update?.(`部署检查 ${passed}/${items.length} 项 · ` +
              items.map(([label, ok]) => `${label}：${ok ? '已通过' : '等待生效'}`).join(' · '));
            options.onProgress?.(state);
          },
        });
        if (!ready) throw readinessError(management, accessIssuer, true, portal, lastCheck);
      });
    } catch (error) {
      if (error instanceof InstallationCancelled) {
        ui.info(`Cloudflare 已接受部署。稍后可打开管理台：${management}。`);
      }
      throw error;
    }
    ui.note(`管理台     ${management}\nMCP Portal  ${portal}`, '安装完成');
    ui.finish('正在打开管理台。请先完成登录，再选择「添加设备」开始接入。MCP 客户端授权仍需在客户端完成。');
  } else {
    console.log('Waiting up to 15 minutes for the Cloudflare Access login, MCP Portal and hosted device installers...');
    if (!await waitForManagementAccess(management, accessIssuer, releases, { ...options, portal })) throw readinessError(management, accessIssuer, false, portal);
    console.log(`Nodrelay management console is ready at ${management}`);
  }
  openBrowser(management);
}

async function storeState(file, state) {
  const temporary = file + '.' + randomBytes(6).toString('hex');
  try {
    await writePrivateFile(temporary, JSON.stringify(state));
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function verifyManagementZone(api, zone) {
  if (!/^[a-f0-9]{32}$/.test(zone.id ?? '') || !/^[a-f0-9]{32}$/.test(zone.account?.id ?? '')) {
    throw new Error('Cloudflare returned an invalid account or domain identifier.');
  }
  const current = await api.get('/zones/' + zone.id);
  if (current?.id !== zone.id || current.status !== 'active' ||
      current.name !== zone.name || current.account?.id !== zone.account.id) {
    throw new Error('所选的 Cloudflare 域名或账户已变更。请重新运行安装命令并选择要部署的账户和域名。');
  }
  return current;
}

// Control-plane checks only. A failed public request from this Mac is never
// used to decide whether the installation was deployed.
export async function inspectCloudDeployment(api, { management, portal, cloudDeployment: info }) {
  if (!info) throw new Error('缺少部署回执，无法核对 Cloudflare 资源。');
  const account = '/accounts/' + info.accountId;
  const script = account + '/workers/scripts/' + info.worker;
  const access = (info.accessScope === 'zone' ? '/zones/' + info.zoneId : account) + '/access/apps/';
  const host = new URL(management).hostname;
  const portalHost = new URL(portal).hostname;
  const hasDestination = (app, domain) => [app?.domain, ...(app?.destinations ?? []).map(item => item?.uri)]
    .some(uri => uri === domain);
  const read = async (label, request) => {
    try { return { label, state: await request() }; }
    catch (error) {
      return { label, state: error instanceof CloudflareError && error.status === 404 ? 'pending' : 'unverified' };
    }
  };
  return Promise.all([
    read('Worker 已部署', async () => {
      const [wanted, current] = await Promise.all([
        api.get(script + '/versions', { per_page: 1 }),
        api.get(script + '/deployments'),
      ]);
      const version = wanted?.items?.[0]?.id;
      const versions = current?.deployments?.[0]?.versions;
      if (!version || !Array.isArray(versions)) return 'pending';
      return versions.length === 1 && versions[0].percentage === 100 && versions[0].version_id === version
        ? 'confirmed' : 'pending';
    }),
    read('管理台域名已绑定', async () => {
      const domains = await api.get(account + '/workers/domains', { hostname: host });
      if (!Array.isArray(domains)) return 'unverified';
      const matches = domains.filter(item => item.hostname === host);
      if (!matches.length) return 'pending';
      return matches.length === 1 && matches[0].service === info.worker && matches[0].zone_id === info.zoneId
        ? 'confirmed' : 'conflict';
    }),
    read('Access 登录已配置', async () => {
      const app = await api.get(access + info.managementAppId);
      if (!app) return 'pending';
      return app.type === 'self_hosted' && hasDestination(app, host) ? 'confirmed' : 'conflict';
    }),
    read('MCP Portal 已配置', async () => {
      const [resource, app] = await Promise.all([
        api.get(account + '/access/ai-controls/mcp/portals/' + info.portalId),
        api.get(access + info.portalAppId),
      ]);
      if (!resource || !app) return 'pending';
      return resource.hostname === portalHost && app.type === 'mcp_portal' && hasDestination(app, portalHost) &&
        app.oauth_configuration?.enabled === true ? 'confirmed' : 'conflict';
    }),
  ]);
}

export async function finishCloudDeployment(result, api, ui, {
  browse = openBrowser, retryDelay = 2000, attempts = 3,
} = {}) {
  const labels = { confirmed: '已确认', pending: '等待 Cloudflare 确认',
    unverified: '暂无法读取', conflict: '配置不匹配' };
  ui.note(result.management, '管理台地址');
  let checks;
  await ui.wait('正在通过 Cloudflare API 核对部署', 'Cloudflare API 核对结束', async (signal, update) => {
    for (let i = 0; i < attempts; i++) {
      signal?.throwIfAborted();
      checks = await inspectCloudDeployment(api, result);
      signal?.throwIfAborted();
      update?.(checks.map(({ label, state }) => label + '：' + labels[state]).join(' · '));
      if (checks.some(item => item.state === 'conflict') || !checks.some(item => item.state === 'pending')) break;
      if (i + 1 < attempts) await sleep(retryDelay, undefined, { signal });
    }
  });
  ui.note(checks.map(({ label, state }) => label + '：' + labels[state]).join('\n'), 'Cloudflare 部署状态');
  if (checks.some(item => item.state === 'conflict')) {
    throw new Error('Cloudflare 返回的部署配置与目标不符，未自动打开管理台。不要重装，请先核对现有资源。');
  }
  // The successful write path is already recorded. A failed *optional*
  // read-back must not cause people to redeploy or strand the console link.
  ui.finish(checks.every(item => item.state === 'confirmed')
    ? '部署完成，正在打开管理台。登录后，选择「添加设备」。'
    : 'Cloudflare 已接受部署，部分状态尚未核实。正在打开管理台；暂时打不开时可稍后直接访问，不用重装。');
  browse(result.management);
  return checks;
}

async function readOwnedManagementApp(api, spec) {
  const host = new URL(spec.origin).hostname;
  const desired = publicAccessApp(spec.label + '-management', host);
  const readOnly = { get: api.get, list: api.list,
    post() { throw new Error('原管理台或其管理员策略缺失，未改动登录配置。'); } };
  return ensureScopedAccessApp(readOnly, spec, desired, { accountScoped: true });
}

export async function repairManagementLogin(api, spec, { providers }) {
  const account = '/accounts/' + spec.accountId;
  const readApp = () => readOwnedManagementApp(api, spec);
  const old = await readApp();
  const native = providers.filter(({ type }) => type === 'cloudflare');
  if (native.length !== 1) throw new Error('未能识别唯一的 Cloudflare 登录方式，原管理台登录配置未更改。');
  const target = [native[0].id];
  if (JSON.stringify(old.allowed_idps) === JSON.stringify(target) && old.auto_redirect_to_identity === true) return false;
  const otp = new Set(providers.filter(({ type }) => type === 'onetimepin').map(({ id }) => id));
  const alreadyAllowed = Array.isArray(old.allowed_idps) && old.allowed_idps.length > 0 &&
    old.allowed_idps.every(id => id === target[0] || otp.has(id));
  if (!alreadyAllowed) throw new Error('原管理台有自定义登录方式，未自动覆盖。');
  const current = await readApp();
  if (JSON.stringify(current) !== JSON.stringify(old)) throw new Error('原管理台在核对期间发生变化，未覆盖。');
  // Preserve all current writable settings, omit read-only identity and
  // server-managed policies (verified separately before and after).
  const { id, aud, policies, created_at, updated_at, ...settings } = current;
  await api.put(account + '/access/apps/' + id, {
    ...settings, allowed_idps: target, auto_redirect_to_identity: true,
  });
  const next = await readApp();
  if (next.id !== id || next.aud !== aud || JSON.stringify(next.allowed_idps) !== JSON.stringify(target) ||
      next.auto_redirect_to_identity !== true) {
    throw new Error('Cloudflare 已收到登录配置更新，但尚未能核实结果。请检查现有管理台，勿重装。');
  }
  return true;
}

const reconnectSecret = 'FLEET_OAUTH_RECONNECT';

export async function reconnectManagement(api, spec, clientId, grant, { userDetails = false, zeroTrustBootstrap = false } = {}) {
  if (!usableStoredGrant(grant) || grant.expiresAt <= Math.floor(Date.now() / 1000) + 45) {
    throw new Error('The new Cloudflare authorization has expired. Start authorization recovery again.');
  }
  const script = `/accounts/${spec.accountId}/workers/scripts/${spec.worker}`;
  const settings = await api.get(script + '/settings');
  const bindings = new Map((settings?.bindings ?? []).map(binding => [binding.name, binding]));
  const plain = name => bindings.get(name)?.type === 'plain_text' ? bindings.get(name).text : undefined;
  const hosted = JSON.parse(plain('FLEET_SPEC') ?? 'null');
  if (plain('FLEET_OAUTH_MODE') !== 'managed' || plain('FLEET_OAUTH_RECOVERY') !== '1' ||
      (plain('FLEET_OAUTH_USER_DETAILS') === '1') !== userDetails ||
      (plain('FLEET_OAUTH_ZERO_TRUST_BOOTSTRAP') === '1') !== zeroTrustBootstrap ||
      plain('FLEET_OAUTH_CLIENT_ID') !== clientId || plain('APP_ORIGIN') !== spec.origin ||
      plain('OWNER_EMAIL') !== spec.ownerEmail || !hosted?.accountScopedAccess ||
      !Object.entries(spec).every(([name, value]) => hosted[name] === value) ||
      bindings.get('FLEET_OAUTH_KEY')?.type !== 'secret_text' ||
      bindings.get('PROVISIONER_OAUTH')?.type !== 'durable_object_namespace') {
    throw new Error('The live management Worker and OAuth client do not match this saved installation or support reconnect.');
  }
  if (bindings.has(reconnectSecret)) throw new Error('A reconnect is already staged. Read the management status to finish it before trying again.');
  const deployment = (await api.get(script + '/deployments'))?.deployments?.[0]?.versions;
  const latest = (await api.get(script + '/versions', { per_page: 1 }))?.items?.[0]?.id;
  if (!latest || deployment?.length !== 1 || deployment[0].percentage !== 100 || deployment[0].version_id !== latest) {
    throw new Error('The Worker has a pending or split deployment. Review its versions before reconnecting.');
  }
  const generation = randomBytes(16).toString('hex');
  await api.put(script + '/secrets', { name: reconnectSecret, type: 'secret_text', text: JSON.stringify({ generation, clientId, grant }) });
  return spec.origin;
}

async function confirmManagementAction(ui, message, action, initialValue = true) {
  if (!await ui.confirm(message, action, initialValue)) throw new InstallationCancelled();
}

async function readManagementState(path) {
  const old = await readPrivateFile(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
  return old === undefined ? undefined : JSON.parse(old);
}

function checkedSetupSpec(state, zone, ownerEmail, namespace) {
  const spec = makeSetupSpec({ ownerEmail, namespace }, zone, state.installationId);
  if (state.spec && JSON.stringify(state.spec) !== JSON.stringify(spec)) {
    throw new Error('回执与当前安装目标或管理员邮箱不符。请核对原账户、域名、邮箱和部署名称。');
  }
  return spec;
}

function checkRecoveryOAuth(state, release) {
  if (Boolean(state.oauthZeroTrustBootstrap) !== Boolean(release.zeroTrustBootstrap) || Boolean(state.oauthUserDetails) !== release.automaticAdministrator ||
      (state.oauthClientId && state.oauthClientId !== release.clientId)) {
    throw new Error('当前安装包的 Cloudflare 授权配置与原安装回执不符。请使用原签名安装包恢复。');
  }
}

export function automaticResumeSpec(state, release, grant, zone, profileEmail, namespace) {
  if (!state) return;
  if (state.bound) {
    checkRecoveryOAuth(state, release);
    const spec = checkedSetupSpec(state, zone, state.spec?.ownerEmail, namespace);
    throw new Error(`此目标已有完成回执：${spec.origin}。未重新部署。`);
  }
  if (state.ssoProof) throw new Error('上次临时 Access 登录验证尚未清理。未自动继续，也未改动 Cloudflare。');
  if (!state.spec) {
    throw new Error('上次 Zero Trust 初始化尚未形成完整部署回执，未自动继续。');
  }
  checkRecoveryOAuth(state, release);
  if (state.oauthClientId !== release.clientId) throw new Error('缺少原安装回执的 Cloudflare OAuth 客户端记录；未自动续跑。');
  const granted = release.zeroTrustBootstrap === true && grant.zeroTrustBootstrap === true;
  if (Boolean(state.oauthBootstrapGranted) !== granted) {
    const option = state.oauthBootstrapGranted ? '保留' : '取消';
    throw new Error(`本次授权与原回执不符。请重新授权并${option}「Access: Organizations, Identity Providers, and Groups Write」。`);
  }
  const spec = checkedSetupSpec(state, zone, state.spec.ownerEmail, namespace);
  if (typeof profileEmail !== 'string' || !isAdministratorEmail(profileEmail) ||
      (state.oauthProfileEmail !== undefined && (typeof state.oauthProfileEmail !== 'string' || state.oauthProfileEmail.toLowerCase() !== profileEmail.toLowerCase())) ||
      (!state.ssoIdentity && state.spec.ownerEmail.toLowerCase() !== profileEmail.toLowerCase())) {
    throw new Error('当前 Cloudflare 登录身份与原安装回执不符；未改动 Cloudflare。');
  }
  if (state.pendingCreates !== undefined && (!Array.isArray(state.pendingCreates) || state.pendingCreates.length)) {
    let resource = 'Cloudflare 资源';
    try {
      const [path, name] = JSON.parse(state.pendingCreates[0]);
      resource = [safeCloudflareRoute(path), terminalLabel(name)].filter(Boolean).join(' · ');
    } catch { /* Unreadable journal must also fail closed. */ }
    throw new Error(`上次创建结果尚未确认：${resource}。未重新发送创建请求。`);
  }
  if (!release.automaticAdministrator || state.trial || state.draft ||
      !/^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i.test(state.databaseId ?? '') ||
      !/^[A-Za-z0-9_-]{43}$/.test(state.ticketKey ?? '') ||
      !/^[A-Za-z0-9_-]{43}$/.test(state.oauthKey ?? '')) {
    throw new Error('原回执尚未完成 Worker 上传前的资源配置，或缺少 D1 / Worker 凭据记录。未自动续跑。');
  }
  return spec;
}

function resumeWriteError(path, body) {
  const route = safeCloudflareRoute(path);
  const name = terminalLabel(body?.name ?? body?.id);
  return new Error(`无法只读确认上次配置的资源：${route}${name ? ' · ' + name : ''}。未重建该资源。`);
}

export async function verifyAutomaticResume(api, spec, options) {
  const { state } = options;
  if (state.workersSubdomainAttempt !== undefined) {
    const expected = workersSubdomainName(spec.accountId);
    if (state.workersSubdomainAttempt !== expected) throw new Error('回执中的账户 Workers 子域不符。');
    const actual = await api.get(`/accounts/${spec.accountId}/workers/subdomain`).catch(error => {
      if (error.codes?.length === 1 && error.codes[0] === 10007) return null;
      throw error;
    });
    if (actual?.subdomain !== expected) {
      throw new Error('上次账户 Workers 子域注册结果尚未确认。未重复注册；请在 Cloudflare 核对。');
    }
  }
  const blocked = async (path, body) => { throw resumeWriteError(path, body); };
  const readOnly = { get: (...args) => api.get(...args), getOptional: (...args) => api.getOptional(...args),
    list: (...args) => api.list(...args), post: blocked, put: blocked, patch: blocked, del: blocked };
  await applySetup(readOnly, spec, { ...options, verifyPartial: true, save() { throw new Error('Unexpected receipt write during verification'); } });
}

export function guardAutomaticResumeWrites(api, spec, databaseId) {
  const account = `/accounts/${spec.accountId}/workers`;
  const script = `${account}/scripts/${spec.worker}`;
  return {
    ...api,
    async post(path, body) {
      if (path === script + '/subdomain' || `/accounts/${spec.accountId}/d1/database/${databaseId}/query` === path) {
        return api.post(path, body);
      }
      throw resumeWriteError(path, body);
    },
    async put(path, body) {
      if ([account + '/subdomain', account + '/domains', script].includes(path)) return api.put(path, body);
      throw resumeWriteError(path, body);
    },
    async patch(path, body) { throw resumeWriteError(path, body); },
    async del(path) { throw resumeWriteError(path); },
  };
}

export function trackManagementCreates(api, state, save, confirmRetry) {
  return { ...api, async post(path, body) {
    // These POSTs apply an existing setting or idempotent schema. Resource
    // creation POSTs may commit even if the response never reaches the installer.
    if (path.endsWith('/query') || path.endsWith('/subdomain')) return api.post(path, body);
    const name = body.name ?? body.id;
    const creation = JSON.stringify([path, name]);
    if (state.confirmedCreates?.includes(creation)) {
      throw new Error(`Cloudflare 曾确认创建资源「${name}」，但当前查询未找到它。请核对原资源，安装器已停止，避免重复创建。`);
    }
    state.pendingCreates ??= [];
    if (state.pendingCreates.includes(creation)) {
      await confirmRetry(path, name);
    } else {
      state.pendingCreates.push(creation);
      await save(state);
    }
    const result = await api.post(path, body);
    state.pendingCreates = state.pendingCreates.filter(item => item !== creation);
    if (!state.pendingCreates.length) delete state.pendingCreates;
    state.confirmedCreates ??= [];
    state.confirmedCreates.push(creation);
    await save(state);
    return result;
  } };
}

async function runDeploymentWork(ui, grant, work, request) {
  const controller = new AbortController();
  const stop = () => {
    if (controller.signal.aborted) return;
    controller.abort(new InstallationCancelled());
    ui.info(`已收到中止请求。单次 Cloudflare 请求（含读取响应）最多等待 ${cloudflareRequestTimeoutMs / 1000} 秒，之后停止发送请求。`);
  };
  // Keep the lock while an in-flight request settles. Abort at the next
  // request boundary so its outcome can still be recorded in the receipt.
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    const api = cloudflareApi(grant.access, { request, beforeRequest: () => controller.signal.throwIfAborted() });
    const result = await work(api);
    return { ...result, interrupted: controller.signal.aborted };
  } catch (error) {
    if (!(error instanceof CloudflareRequestTimeoutError)) throw error;
    const outcome = error.method === 'GET' ? '' : '该次写入结果未确认，请核对 Cloudflare 审计日志。';
    throw new Error(`Cloudflare ${error.method} 请求在 ${error.timeoutMs / 1000} 秒内未完成。${outcome}`, { cause: error });
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}

function deploymentSummary(spec) {
  return `管理台      ${spec.origin}\nMCP Portal  https://${spec.portalHostname}/mcp\n管理员邮箱  ${spec.ownerEmail}`;
}

export async function deployManagement(ui, release, grant, zone, profileEmail, namespace, { reconnect, resume }, {
  request, home = homedir(), previewAccount = process.env.NODRELAY_PREVIEW_BOOTSTRAP_ACCOUNT,
} = {}) {
  const bootstrapGranted = release.zeroTrustBootstrap === true && grant.zeroTrustBootstrap === true;
  const top = join(home, '.nodrelay');
  const directory = join(top, 'management');
  await ensurePrivateDirectory(top);
  await ensurePrivateDirectory(directory);
  const target = createHash('sha256').update(JSON.stringify([zone.account.id, zone.id, namespace])).digest('hex').slice(0, 24);
  const path = join(directory, target + '.json');
  const lockPath = path + '.lock';
  let releaseLock;
  let archived = false;
  let recoveredInstallReceipt;
  try { releaseLock = await takeManagementLock(lockPath); }
  catch (error) {
    if (!(error instanceof ManagementLockError) || error.kind !== 'interrupted') throw error;
    const saved = await readManagementState(path);
    const resumeBaseline = !reconnect && release.webUpgrade && saved?.bound && saved.managedOAuth === true &&
      saved.spec && isAdministratorEmail(profileEmail) && saved.spec.ownerEmail.toLowerCase() === profileEmail.toLowerCase() &&
      (!saved.oauthProfileEmail || saved.oauthProfileEmail.toLowerCase() === profileEmail.toLowerCase()) &&
      (!saved.upgradeBaseline || saved.upgradeBaseline.phase !== 'confirmed');
    // Reuse the normal no-replay checks before retiring a proven stopped
    // lock for an unfinished install. An absent or ambiguous receipt is not
    // permission to start over. The normal path checks the receipt again
    // after acquiring the replacement lock.
    const resumeInstall = !resume && !reconnect && !saved?.bound && !saved?.ssoProof && saved?.spec &&
      automaticResumeSpec(saved, release, grant, zone, profileEmail, namespace);
    if (!resume && !resumeBaseline && !resumeInstall) throw error;
    if (resumeInstall) recoveredInstallReceipt = JSON.stringify(saved);
    if (saved?.spec || saved?.ssoProof || saved?.zeroTrustBootstrap) checkRecoveryOAuth(saved, release);
    if (saved?.spec) checkedSetupSpec(saved, zone, saved.spec.ownerEmail, namespace);
    if (!resumeBaseline && !resumeInstall) {
      ui.note(`上次安装进程 PID ${error.owner.pid} 已退出。旧锁会归档，安装回执会保留。\n锁文件  ${error.path}`, '发现中断的安装');
      await confirmManagementAction(ui, '确认归档这把中断的锁？', '归档旧锁', false);
    }
    await archiveInterruptedManagementLock(lockPath, error.owner);
    releaseLock = await takeManagementLock(lockPath);
    archived = true;
  }
  try {
    const saved = await readManagementState(path);
    if (recoveredInstallReceipt !== undefined && JSON.stringify(saved) !== recoveredInstallReceipt) {
      throw new Error('恢复时安装回执发生变化。未改动 Cloudflare，请重新运行原安装命令。');
    }
    const state = saved ?? {
      installationId: randomBytes(6).toString('hex'), ticketKey: randomBytes(32).toString('base64url'),
    };
    const save = next => storeState(path, next);
    const api = cloudflareApi(grant.access, { request });
    if (state.ssoProof) {
      if (!resume || state.spec || state.bound) throw new Error('找到未清理的临时登录应用。未自动继续。');
      checkRecoveryOAuth(state, release);
      ui.note(`临时应用  ${terminalLabel(state.ssoProof.name)}`, '上一次 SSO 登录验证未清理');
      const removed = await ui.wait('正在核对并清理临时登录应用', '已核对临时登录应用', () =>
        removeSsoProof(api, zone.account.id, state.ssoProof));
      if (!removed) {
        ui.note('Cloudflare 当前未列出该应用。请查看审计日志，确认它未被创建，或已被删除，再清除本地回执。', '核对上一次创建结果');
        await confirmManagementAction(ui, '已核对审计日志，确认临时应用不存在？', '清除回执', false);
      }
      delete state.ssoProof;
      await save(state);
      return { recoveryOnly: '临时登录验证已清理。请重新运行原安装命令开始安装。' };
    }
    if (state.spec || state.zeroTrustBootstrap) checkRecoveryOAuth(state, release);
    if (state.bound && state.managedOAuth === true && state.spec && !reconnect && (!resume || (release.webUpgrade && state.upgradeBaseline)) && !state.ssoIdentity) {
      const spec = checkedSetupSpec(state, zone, state.spec.ownerEmail, namespace);
      if (!isAdministratorEmail(profileEmail) || spec.ownerEmail.toLowerCase() !== profileEmail.toLowerCase() ||
          (state.oauthProfileEmail && state.oauthProfileEmail.toLowerCase() !== profileEmail.toLowerCase())) {
        throw new Error('当前 Cloudflare 登录身份与原管理台管理员不符；未改动 Cloudflare。');
      }
      return await runDeploymentWork(ui, grant, async scoped => {
        const account = '/accounts/' + spec.accountId;
        const host = new URL(spec.origin).hostname;
        const domains = await scoped.get(account + '/workers/domains', { hostname: host });
        if (!Array.isArray(domains) || domains.filter(item => item.hostname === host).length !== 1 ||
            !domains.some(item => item.hostname === host && item.service === spec.worker && item.zone_id === spec.zoneId)) {
          throw new Error('原管理台域名不再指向回执中的 Worker，未改动登录配置。');
        }
        const app = await readOwnedManagementApp(scoped, spec);
        const workerSettings = await scoped.get(account + '/workers/scripts/' + spec.worker + '/settings');
        const bindings = new Map((workerSettings?.bindings ?? []).filter(binding => binding.type === 'plain_text')
          .map(binding => [binding.name, binding.text]));
        const hosted = JSON.parse(bindings.get('FLEET_SPEC') ?? 'null');
        if (!app.aud || bindings.get('ACCESS_AUD') !== app.aud || bindings.get('OWNER_EMAIL') !== spec.ownerEmail ||
            bindings.get('APP_ORIGIN') !== spec.origin || bindings.get('FLEET_OAUTH_CLIENT_ID') !== release.clientId ||
            !hosted?.accountScopedAccess || !Object.entries(spec).every(([key, value]) => hosted[key] === value)) {
          throw new Error('原 Worker、管理员和 Access 应用无法与回执对应，未改动登录配置。');
        }
        const original = await managementAccessConfiguration(scoped, spec.accountId);
        const pendingBaseline = state.upgradeBaseline && state.upgradeBaseline.phase !== 'confirmed';
        const baselineNames = ['NODRELAY_RELEASE_VERSION', 'NODRELAY_UPGRADE_CHANNEL', 'NODRELAY_UPGRADE_PUBLIC_KEY', 'NODRELAY_UPGRADE_FEED'];
        const completeBaseline = baselineNames.every(name => bindings.has(name));
        if (release.webUpgrade && completeBaseline && !pendingBaseline &&
            (bindings.get('NODRELAY_UPGRADE_CHANNEL') !== release.webUpgrade.channel ||
             bindings.get('NODRELAY_UPGRADE_PUBLIC_KEY') !== release.webUpgrade.publicKey ||
             !matchesInstallerFeed(bindings.get('NODRELAY_UPGRADE_FEED'), release.webUpgrade) ||
             !/^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(?:-preview\.(0|[1-9]\d{0,8}))?$/.test(bindings.get('NODRELAY_RELEASE_VERSION') ?? '') ||
             (release.webUpgrade.channel === 'stable' && bindings.get('NODRELAY_RELEASE_VERSION').includes('-preview.')))) {
          throw new Error('原管理台的网页升级配置与当前签名安装包不一致。未覆盖原配置。');
        }
        if (release.webUpgrade && (pendingBaseline || !completeBaseline)) {
          if (!original.providers.some(provider => provider.type === 'cloudflare')) {
            throw new Error('原管理台的 Cloudflare 登录尚未就绪。没有切换 Worker。');
          }
          const target = { accountId: spec.accountId, worker: spec.worker };
          const adapter = createCloudflareUpgradeAdapter(scoped, target);
          const versions = await adapter.readDeployment(target);
          const id = pendingBaseline ? state.upgradeBaseline.original : versions.latestVersion;
          const current = await adapter.readVersion(target, id);
          const namespaceId = current.bindings.find(binding => binding.name === 'PROVISIONER_OAUTH')?.namespace_id;
          const expected = { ...target, activeVersion: id, zoneId: spec.zoneId, origin: spec.origin, ownerEmail: spec.ownerEmail,
            accessAudience: app.aud, databaseId: state.databaseId, namespaceId };
          const upgraded = await ui.wait('正在为现有管理台启用网页升级', 'Cloudflare 已确认新版本', () =>
            adoptManagementUpgradeBaseline({ api: scoped, expected, release,
              journal: { read: async () => state.upgradeBaseline, write: async record => {
                state.upgradeBaseline = record;
                await save(state);
              } },
              readMigration: file => readFile(new URL('../cloud/' + file, import.meta.url), 'utf8'),
            }));
          try {
            const result = await upgradeManagementFromCommand({
              api: scoped, spec, databaseId: state.databaseId, accessAudience: app.aud, signed: release.webUpgrade, request, ui,
            });
            return { management: spec.origin, baselineAdopted: upgraded.releaseVersion, ...result };
          } catch (error) {
            throw new Error(`已启用升级并切换到 v${upgraded.releaseVersion}，但后续版本未确认：${error.message}`, { cause: error });
          }
        }
        if (release.webUpgrade && completeBaseline) {
          return { management: spec.origin, ...await upgradeManagementFromCommand({
            api: scoped, spec, databaseId: state.databaseId, accessAudience: app.aud, signed: release.webUpgrade, request, ui,
          }) };
        }
        if (pendingBaseline && !release.webUpgrade) throw new Error('安装回执中有尚未核实的版本切换，请重新使用同一个签名安装包。');
        let providers = original.providers;
        if (!providers.some(({ type }) => type === 'cloudflare')) {
          if (!providers.every(({ type }) => type === 'onetimepin') || !bootstrapGranted ||
              !Array.isArray(app.allowed_idps) || !app.allowed_idps.length ||
              !app.allowed_idps.every(id => providers.some(provider => provider.id === id)))
            throw new Error('现有管理台缺少 Cloudflare 账号登录。请重新运行原命令，并允许初始化 Zero Trust 登录方式。未改动现有管理台。');
          ({ providers } = await ensureManagementAccess(scoped, spec.accountId, {
            ui, state, save, browse: openBrowser, allowCreate: true, providerConsent: true, allowOrganizationCreate: false,
          }));
        }
        await repairManagementLogin(scoped, spec, { providers });
        return { management: spec.origin, loginRepaired: true };
      }, request);
    }
    // Once deployment has a target receipt, do not silently change the
    // permissions expected by an uploaded or partly deployed Worker.
    if (state.spec && Boolean(state.oauthBootstrapGranted) !== bootstrapGranted) {
      const option = state.oauthBootstrapGranted ? '保留' : '取消';
      throw new Error(`本次授权与原管理台的实际权限不符。请重新授权并${option}「Access: Organizations, Identity Providers, and Groups Write」。`);
    }
    if (resume && (state.bound || (!state.spec && !state.zeroTrustBootstrap))) {
      if (!archived) throw new Error('此目标没有未完成的安装回执。请核对账户、域名和部署名称。');
      if (state.spec) checkedSetupSpec(state, zone, state.spec.ownerEmail, namespace);
      const next = state.bound
        ? '此目标已有完成回执。可打开原管理台查看。若中断时正在恢复授权，请先在管理台查看授权恢复状态。'
        : '未找到安装回执。请在 Cloudflare 中核对该目标的资源和审计日志，确认没有上次遗留的部署后，再运行原安装命令。';
      return { recoveryOnly: next };
    }
    if (reconnect && (!state.bound || state.managedOAuth !== true || !state.spec)) {
      throw new Error('恢复授权需要原管理台的已完成安装回执。');
    }
    if (reconnect) {
      const spec = checkedSetupSpec(state, zone, state.spec.ownerEmail, namespace);
      ui.note(deploymentSummary(spec), '现有诺联管理台');
      await confirmManagementAction(ui, '更新此管理台保存的 Cloudflare 授权？', '恢复授权', false);
      ui.info('正在核对现有部署并提交新授权…');
      return await runDeploymentWork(ui, grant, async api => ({
        management: await reconnectManagement(api, spec, release.clientId, grant, { userDetails: release.automaticAdministrator, zeroTrustBootstrap: bootstrapGranted }),
      }), request).catch(error => {
        ui.info('请先在管理台查看是否已有待生效的授权，再重试授权恢复。');
        throw error;
      });
    }
    const automatic = Boolean(automaticResumeSpec(saved, release, grant, zone, profileEmail, namespace));
    let ownerEmail = state.spec?.ownerEmail ?? profileEmail;
    let ssoIdentity = state.ssoIdentity;
    let loginSummary = '';
    if (release.automaticAdministrator) {
      const access = automatic
        ? await managementAccessConfiguration(api, zone.account.id)
        : await runDeploymentWork(ui, grant, requestApi => ensureManagementAccess(requestApi, zone.account.id, {
          ui, state, browse: openBrowser, allowCreate: bootstrapGranted,
          // Explicit preview opt-in is scoped to the selected test account.
          allowNotEnabledMarkerBootstrap:
            previewAccount === zone.account.id,
          async save(next) {
            next.oauthUserDetails = true;
            next.oauthZeroTrustBootstrap = release.zeroTrustBootstrap === true;
            next.oauthClientId = release.clientId;
            await save(next);
          },
        }), request);
      if (access.interrupted) throw new InstallationCancelled();
      const { issuer, providers } = access;
      const direct = providers.filter(directManagementProvider);
      if (ssoIdentity) {
        const provider = providers.find(({ id }) => id === ssoIdentity.providerId);
        if (ssoIdentity.issuer !== issuer || !provider) throw new Error('原回执的 SSO 登录方式已变更。请让账户管理员核对后再恢复。');
        loginSummary = `\n原 SSO 登录  ${terminalLabel(provider.name) || terminalLabel(provider.type)}`;
      } else if (direct.length) {
        // Login methods are shown by Cloudflare when the management console opens.
      } else if (resume || automatic) {
        throw new Error('原部署没有经过验证的 SSO 登录方式。请让账户管理员恢复原登录方式后继续，安装器会保留原管理员。');
      } else {
        const provider = await chooseListed(providers.map(value => ({ value, label: terminalLabel(value.name) || terminalLabel(value.type) })),
          'SSO 登录方式', '选择用于管理台的现有 SSO 登录方式', ui);
        ui.note('诺联将创建一个仅用于核验身份的临时 Access 应用，验证结束后清理。请在浏览器中用准备管理诺联的身份登录。', '验证 SSO 身份');
        await confirmManagementAction(ui, '允许创建临时登录应用并打开浏览器？', '验证身份');
        try {
          const { email, ...identity } = await ui.wait('等待浏览器完成 SSO 验证（最长 5 分钟）', 'SSO 邮箱已验证', signal =>
            proveManagementSso(api, { accountId: zone.account.id, issuer, providerId: provider.id, redirectUri: release.redirectUri, signal,
              async save(proof) {
                if (proof) {
                  state.ssoProof = proof;
                  state.oauthUserDetails = true;
                  state.oauthZeroTrustBootstrap = release.zeroTrustBootstrap === true;
                  state.oauthClientId = release.clientId;
                } else {
                  delete state.ssoProof;
                }
                await save(state);
              },
            }));
          ownerEmail = email;
          ssoIdentity = identity;
        } finally {
          if (state.ssoProof) ui.info('临时登录验证尚未清理，已保留回执。');
        }
        loginSummary = `\n已验证登录  ${terminalLabel(provider.name) || terminalLabel(provider.type)}`;
        if (ownerEmail !== profileEmail) loginSummary += `\nCloudflare 授权邮箱  ${profileEmail}\n管理台使用上面已验证的 SSO 邮箱。`;
      }
    }
    const spec = checkedSetupSpec(state, zone, ownerEmail, namespace);
    if (automatic) {
      ui.note(deploymentSummary(spec) + loginSummary, '发现同一部署的未完成回执');
    } else {
      ui.note(deploymentSummary(spec) + loginSummary, resume ? '继续同一部署' : '即将部署');
    }
    if (!automatic) {
      await confirmManagementAction(ui, '邮箱和部署地址正确，并同意在 Worker 中保存可续期的 Cloudflare 授权？', '确认部署');
    }
    ui.info('正在部署 Cloudflare 资源…');
    return await runDeploymentWork(ui, grant, async api => {
      const managedOAuth = { clientId: release.clientId, grant, userDetails: release.automaticAdministrator, webUpgrade: release.webUpgrade, enrollment: release.enrollment };
      if (automatic) {
        await verifyAutomaticResume(api, spec, { state, managedOAuth, releases: release.releases });
        ui.info('已核实同一部署的现有资源，继续上传 Worker。');
      }
      state.spec = spec;
      if (profileEmail) state.oauthProfileEmail = profileEmail;
      state.oauthBootstrapGranted = bootstrapGranted;
      state.oauthClientId = release.clientId;
      if (release.automaticAdministrator) state.oauthUserDetails = true;
      state.oauthZeroTrustBootstrap = release.zeroTrustBootstrap === true;
      if (ssoIdentity) state.ssoIdentity = ssoIdentity;
      await save(state);
      const migrations = (await Promise.all(['0001_tickets.sql', '0002_devices.sql', '0003_portal_callback_labels.sql', '0004_enrollment_intents.sql', '0005_upgrade_journal.sql']
        .map(file => readFile(new URL('../cloud/' + file, import.meta.url), 'utf8'))))
        .flatMap(sql => sql.split(';').map(statement => statement.trim()).filter(Boolean));
      const tracked = trackManagementCreates(api, state, save, async (endpoint, name) => {
        throw resumeWriteError(endpoint, { name });
      });
      const result = await applySetup(automatic ? guardAutomaticResumeWrites(api, spec, state.databaseId) : tracked, spec, {
        state, save, bundle: release.bundle, migrations, releases: release.releases,
        managedOAuth, safeResume: automatic,
        async confirmWorkersSubdomain(name) {
          ui.note(`Cloudflare 需要为此账户注册 Workers 子域 ${name}.workers.dev。诺联仍使用所选自定义域名，不开启公开 Workers 地址或预览地址。`, '首次启用 Workers');
          await confirmManagementAction(ui, '为这个账户注册 Workers 子域并继续安装？', '确定');
        },
      });
      if (state.pendingCreates || state.confirmedCreates) {
        delete state.pendingCreates;
        delete state.confirmedCreates;
        await save(state);
      }
      return result;
    }, request).catch(error => {
      ui.info('已保留本地回执。不会自动重复提交结果不明的创建请求。');
      throw error;
    });
  } finally {
    await releaseLock();
  }
}

async function reportManagementFailure(error, context, show) {
  // Logging is best-effort: preserve the original error if local storage is
  // unavailable, rather than replacing it with a permissions or disk error.
  const path = await writeManagementFailure(error, context).catch(() => undefined);
  show(path ? `脱敏诊断日志：${path}` : '未能保存本地诊断日志。');
}

async function main(diagnostic) {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      plan: { type: 'boolean' }, check: { type: 'boolean' }, reconnect: { type: 'boolean' }, resume: { type: 'boolean' },
      namespace: { type: 'string' }, portal: { type: 'string' },
    },
  });
  diagnostic.mode = values.reconnect ? 'reconnect' : values.resume ? 'resume'
    : values.check ? 'check' : values.plan ? 'plan' : 'install';
  if (positionals.length !== (values.check ? 4 : 2) ||
      [values.plan, values.check, values.reconnect, values.resume].filter(Boolean).length > 1 ||
      ((values.plan || values.check) && values.namespace !== undefined) || (values.portal !== undefined && !values.check)) {
    throw new Error('Usage: setup-macos.sh SIGNED_MANIFEST TRUSTED_PUBLISHER_KEY [--plan | --check MANAGEMENT_ORIGIN ACCESS_ISSUER [--portal PORTAL_URL] | [--reconnect | --resume] [--namespace NAME]]');
  }
  const namespace = values.namespace ?? 'nodrelay';
  if (!isDeploymentNamespace(namespace)) {
    throw new Error('部署名称应为 3–16 个字符，以小写字母开头，只能包含小写字母、数字和连字符。');
  }
  const [manifest, publisherKey, origin, issuer] = positionals;
  diagnostic.stage = 'release_verification';
  const release = await managementRelease(resolve(manifest), resolve(publisherKey));
  diagnostic.version = release.webUpgrade?.version;
  const scopes = release.zeroTrustBootstrap ? managementBootstrapOAuthScopes : release.automaticAdministrator ? managementIdentityOAuthScopes : managementOAuthScopes;
  if (values.check) {
    diagnostic.stage = 'readiness';
    const ready = await checkManagementReadiness(origin, issuer, release.releases, { portal: values.portal });
    console.log(`Nodrelay management console is ready at ${ready}`);
    return;
  }
  if (values.plan) {
    console.log(JSON.stringify({ permissionScopes: scopes, platforms: Object.keys(hostedInstallers(release.releases)),
      deviceTargets: Object.entries(release.releases).map(([platform, { version, browser }]) => ({ platform, version, browser })),
      deviceAssets: 'versioned HTTPS downloads', automaticAccountDiscovery: true,
      automaticDomainDiscovery: true, automaticAdministratorDiscovery: release.automaticAdministrator,
      oauthTokenProvisioning: false }, null, 2));
    return;
  }
  diagnostic.stage = 'terminal';
  if (!process.stdin.isTTY || !process.stdout.isTTY || process.env.TERM === 'dumb') {
    throw new Error('请在 Mac 的交互式终端运行安装命令。');
  }
  const recovery = values.reconnect || values.resume;
  if (!recovery && !release.automaticAdministrator) {
    throw new Error(`这个签名安装包尚未验证 Cloudflare 用户资料只读权限（${managementIdentityScope}）。请使用支持自动识别管理员的新安装包。`);
  }
  const ui = createManagementTerminal();
  ui.intro(values.reconnect ? '诺联 Nodrelay · 恢复管理台授权'
    : values.resume ? '诺联 Nodrelay · 继续管理台部署' : '诺联 Nodrelay · 管理台安装');
  try {
    diagnostic.stage = 'authorization';
    ui.step(1, '授权 Cloudflare');
    ui.note([
      '读取账户与域名，配置 DNS、Worker、D1、Access、Tunnel 和 MCP Portal。',
      ...(release.automaticAdministrator ? ['请保留「User Details Read」，用于识别新部署的管理员邮箱。'] : []),
      ...(release.zeroTrustBootstrap ? ['可选账户级写权限：允许时可初始化 Zero Trust 组织和 Cloudflare 账号登录，且此权限会保留在 Worker 授权中。取消后仍可部署已配置 Zero Trust 的账户。不选择套餐或付款。'] : []),
      'Worker 保存可续期授权，用于持续管理设备。设备各自使用独立凭据。',
      '请只授权要部署的账户。Worker 的授权覆盖你在浏览器中批准的所有账户。',
      '', scopes.join(' · '),
    ].join('\n'), 'Cloudflare 权限');
    const grant = await ui.wait('请在浏览器登录并授权，完成后回到终端（Ctrl+C 取消）', 'Cloudflare 授权完成', signal =>
      authorize({ clientId: release.clientId, redirectUri: release.redirectUri, scopes,
        startThroughLoopback: true, refreshable: true, timeoutMs: 600000, signal }));
    const api = cloudflareApi(grant.access);
    diagnostic.stage = 'target_selection';
    ui.step(2, '选择账户与部署域名');
    const zone = await verifyManagementZone(api, await chooseManagementZone(api, ui));
    diagnostic.stage = 'administrator';
    ui.step(3, recovery ? '使用原回执中的管理员' : '识别管理员');
    const ownerEmail = values.reconnect || !release.automaticAdministrator ? undefined : await getManagementOwnerEmail(api);
    diagnostic.stage = 'deployment';
    ui.step(4, values.reconnect ? '确认并恢复授权' : values.resume ? '核对并继续部署' : '确认并部署');
    const result = await deployManagement(ui, release, grant, zone, ownerEmail, namespace, values);
    if (result.recoveryOnly) {
      ui.finish(result.recoveryOnly);
      return;
    }
    if (result.interrupted) {
      const next = values.reconnect
        ? '新授权已提交。请登录管理台，在「客户端回调设置」中完成恢复。'
        : `Cloudflare 已接受部署。稍后可打开管理台：${result.management}。`;
      ui.info(next);
      throw new InstallationCancelled();
    }
    if (values.reconnect) {
      ui.success(`新授权已提交至 ${result.management}`);
      ui.finish('正在打开管理台。登录后进入「客户端回调设置」完成授权恢复。');
      openBrowser(result.management);
      return;
    }
    if (result.confirmedVersion || result.baselineAdopted || result.currentVersion) {
      ui.note(result.management, '管理台地址');
      ui.finish(result.confirmedVersion || result.baselineAdopted
        ? `Cloudflare 已确认切换到 v${result.confirmedVersion ?? result.baselineAdopted}。正在打开管理台，请核对登录与设备。`
        : `管理台已是 v${result.currentVersion}，未重复部署。正在打开页面。`);
      openBrowser(result.management);
      return;
    }
    if (result.loginRepaired) {
      ui.note(result.management, '管理台地址');
      ui.finish('现有管理台已配置 Cloudflare 账号登录，正在打开。未重新部署。');
      openBrowser(result.management);
      return;
    }
    ui.success('Cloudflare 已接受部署');
    diagnostic.stage = 'deployment_confirmation';
    await finishCloudDeployment(result, cloudflareApi(grant.access, { requestTimeoutMs: 5000 }), ui);
  } catch (error) {
    if (error instanceof InstallationCancelled) {
      ui.cancel();
      process.exitCode = 1;
    } else {
      ui.error(error.name === 'SyntaxError' ? '诺联发行文件或 Cloudflare 响应格式无效。' : error.message);
      await reportManagementFailure(error, diagnostic, ui.info);
      process.exitCode = 1;
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const diagnostic = { stage: 'arguments' };
  try { await main(diagnostic); }
  catch (error) {
    console.error(error.name === 'SyntaxError' ? 'Invalid Nodrelay release or Cloudflare response' : error.message);
    if (!(error instanceof InstallationCancelled)) await reportManagementFailure(error, diagnostic, console.error);
    process.exitCode = 1;
  }
}

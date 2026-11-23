import { createHash, randomBytes } from 'node:crypto';
import { activatePath, enrollPath, hostedInstallers, installPath } from '../cloud/device-paths.mjs';
import { ensureAccessApp, ensureDns, ensurePolicy, issueProvisioningToken, publicAccessApp, single } from '../cloud/cloudflare.mjs';
import { ensureScopedAccessApp } from '../cloud/zone-access.mjs';
import { configureNewPortalCallbacks } from '../cloud/portal-client-callbacks.mjs';
import { oauthTokenValue } from '../cloud/oauth-grant.mjs';

const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/;
const hex = /^[a-f0-9]{32}$/;
export const accessResourceId = /^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i;
export const targetPlatforms = ['windows-x64', 'macos-arm64', 'macos-x64', 'linux-x64', 'linux-arm64'];

export function isAdministratorEmail(value) {
  return /^[^\s@<>\p{Cc}\p{Cf}]+@[^\s@<>\p{Cc}\p{Cf}]+\.[^\s@<>\p{Cc}\p{Cf}]+$/u.test(value ?? '');
}

export function isDeploymentNamespace(value) {
  return /^[a-z][a-z0-9-]{2,15}$/.test(value ?? '');
}

export function makeSetupSpec(config, zone, installationId) {
  if (!hex.test(zone?.id ?? '') || !hex.test(zone?.account?.id ?? '') || zone.status !== 'active' ||
      !HOST.test(zone.name) || /\.(workers|pages)\.dev$/.test(zone.name) ||
      !isDeploymentNamespace(config.namespace) ||
      !isAdministratorEmail(config.ownerEmail) ||
      !/^[a-f0-9]{12}$/.test(installationId)) throw new Error('Choose an active Cloudflare zone, namespace and exact administrator email');
  const label = `fleet-${config.namespace}-${installationId}`;
  return {
    label, installationId, accountId: zone.account.id, zoneId: zone.id, zone: zone.name,
    portalId: `fleet-${installationId}`,
    worker: label, database: label, ownerEmail: config.ownerEmail,
    origin: `https://${config.namespace}-fleet.${zone.name}`,
    portalHostname: `${config.namespace}-portal.${zone.name}`,
    deviceSuffix: `-${config.namespace}-device.${zone.name}`,
  };
}

export function validateReleaseCatalog(input) {
  if (!input || !Object.keys(input).length || Object.keys(input).some(key => !targetPlatforms.includes(key))) {
    throw new Error('Release catalog must describe at least one supported target');
  }
  const catalog = Object.fromEntries(Object.entries(input).map(([platform, asset]) => {
    if (!/^[a-f0-9]{64}$/.test(asset?.sha256 ?? '') || !/^[0-9][A-Za-z0-9._-]{0,39}$/.test(asset?.version ?? '')) {
      throw new Error('All installer assets need a pinned version and SHA-256');
    }
    if (asset.browser !== undefined && typeof asset.browser !== 'boolean') {
      throw new Error('An installer browser capability must be a boolean');
    }
    const { sha256, version } = asset;
    const pinned = { sha256, version, browser: asset.browser === true };
    if (asset.localFile !== undefined) {
      const suffix = platform.startsWith('windows-') ? '.zip' : '.tgz';
      if (asset.url !== undefined || typeof asset.localFile !== 'string' ||
          !/^[A-Za-z0-9][A-Za-z0-9._-]{0,149}$/.test(asset.localFile) || !asset.localFile.endsWith(suffix)) {
        throw new Error('A local installer needs a single archive basename and no URL');
      }
      return [platform, { localFile: asset.localFile, ...pinned }];
    }
    const url = new URL(asset.url);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
      throw new Error('Hosted installer assets need a pinned HTTPS URL');
    }
    return [platform, { url: url.href, ...pinned }];
  }));
  hostedInstallers(catalog);
  return catalog;
}

export function validateProvisionerLifetime(days) {
  if (days !== undefined && (!Number.isInteger(days) || days < 1 || days > 90)) {
    throw new Error('Set provisionerLifetimeDays to a whole number from 1 to 90');
  }
  return days;
}

export function isAccessIssuer(issuer) {
  return /^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(issuer ?? '');
}

function accessIssuer(organization) {
  const domain = organization?.auth_domain;
  return typeof domain === 'string' && !domain.startsWith('https://') ? `https://${domain}` : domain;
}

const missingOrganization = '所选账户尚未开通 Cloudflare Zero Trust。请在 Cloudflare 控制台完成初始化，或改选已开通的账户。';

export const directManagementProvider = ({ type }) => type === 'cloudflare' || type === 'onetimepin';

export async function managementLoginProviders(api, accountId) {
  const providers = await api.list(`/accounts/${accountId}/access/identity_providers`).catch(error => {
    if (error.status === 404) return [];
    if (error.status === 403) {
      throw new Error('无法读取该账户的 Zero Trust 登录方式。请用有权读取身份提供商的 Cloudflare 成员重新授权。');
    }
    throw error;
  });
  const supported = providers.filter(row => accessResourceId.test(row?.id ?? '') && typeof row.type === 'string' && row.type);
  if (!supported.length) {
    throw new Error('该账户没有可用的 Zero Trust 登录方式。请让账户管理员检查 Integrations → Identity providers，或改选已有登录方式的账户。');
  }
  return supported;
}

export async function managementAccessConfiguration(api, accountId) {
  let organization;
  try {
    organization = await api.getOptional(`/accounts/${accountId}/access/organizations`);
  } catch (error) {
    if (error.status === 403) {
      const codes = Array.isArray(error.codes) ? error.codes.filter(Number.isInteger).join(', ') : '';
      const ray = typeof error.rayId === 'string' && /^[a-zA-Z0-9-]{6,80}$/.test(error.rayId) ? `，Ray ID ${error.rayId}` : '';
      throw new Error(`部署前检查 Zero Trust 组织失败：Cloudflare GET /accounts/{account_id}/access/organizations 返回 HTTP 403${codes ? `，错误码 ${codes}` : ''}${ray}。请检查所选账户的 Zero Trust 是否已初始化，以及授权身份是否有读取该组织的权限；仅凭 403 不能判断具体原因。`, { cause: error });
    }
    throw error;
  }
  const issuer = accessIssuer(organization);
  if (!isAccessIssuer(issuer)) throw new Error(missingOrganization);
  return { issuer, providers: await managementLoginProviders(api, accountId) };
}

export function workersSubdomainName(accountId) {
  return 'nodrelay-' + createHash('sha256').update('nodrelay-workers-dev:' + accountId).digest('hex').slice(0, 20);
}

// The upload API does not expose a workers_dev switch. Only the exact
// first-upload error plus Wrangler's account GET "not found" code permits
// an explicitly approved account registration. Never guess from bare 404.
export async function uploadManagementWorker(api, {
  accountId, scriptPath, form, existing, state, save, confirmWorkersSubdomain,
}) {
  try {
    return await api.put(scriptPath, form);
  } catch (error) {
    if (existing || error.status !== 403 || error.codes?.length !== 1 || error.codes[0] !== 10063) throw error;
    if (!confirmWorkersSubdomain) {
      throw new Error('Cloudflare 拒绝首次上传 Worker（10063）。无法完成账户的 Workers 首次设置。', { cause: error });
    }
  }
  const route = `/accounts/${accountId}/workers/subdomain`;
  const name = workersSubdomainName(accountId);
  async function readSubdomain() {
    let current;
    try { current = await api.get(route); }
    catch (error) {
      // Wrangler treats only 10007 as "not found"; do not accept auth
      // errors, mixed codes, or transport failures as an absent resource.
      if ([200, 403, 404].includes(error.status) && error.codes?.length === 1 && error.codes[0] === 10007) return null;
      throw error;
    }
    if (typeof current?.subdomain !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(current.subdomain)) {
      throw new Error('Cloudflare 返回无效的账户 Workers 子域，已停止，未更改该设置。');
    }
    return current.subdomain;
  }
  const pending = state.workersSubdomainAttempt;
  if (pending !== undefined && pending !== name) throw new Error('回执中的 Workers 子域与当前账户不符。');
  const present = await readSubdomain();
  if (present !== null) {
    // An earlier uncertain registration may have succeeded. Never replace
    // an existing subdomain; if it is present, retry only the refused upload.
    return api.put(scriptPath, form);
  }
  if (pending) throw new Error('上次账户 Workers 子域注册仍未确认。不会重复写入，请先在 Cloudflare 核对后再恢复。');
  await confirmWorkersSubdomain(name);
  state.workersSubdomainAttempt = name;
  await save(state);
  // Recheck after confirmation and receipt persistence so another actor's
  // registration during the prompt is not overwritten.
  if (await readSubdomain() === null) {
    await api.put(route, { subdomain: name });
    if (await readSubdomain() !== name) {
      throw new Error('账户 Workers 子域注册尚未能确认。未重复注册。');
    }
  }
  return api.put(scriptPath, form);
}

export async function applySetup(api, spec, {
  state, save, bundle, migrations, releases, rotateToken = false, zeroTrustTeam, provisionerLifetimeDays, trialAccess, managedOAuth, confirmWorkersSubdomain, verifyPartial = false, safeResume = false,
}) {
  const lifetime = validateProvisionerLifetime(provisionerLifetimeDays);
  if (managedOAuth && (trialAccess || state.bound || state.draft || rotateToken ||
      !/^[A-Za-z0-9_-]{8,128}$/.test(managedOAuth.clientId ?? '') ||
      !oauthTokenValue.test(managedOAuth.grant?.access ?? '') || !oauthTokenValue.test(managedOAuth.grant?.refresh ?? '') ||
      !Number.isSafeInteger(managedOAuth.grant?.expiresAt) || managedOAuth.grant.expiresAt < Date.now() / 1000 + 120)) {
    throw new Error('Use a new management deployment with a verified OAuth grant');
  }
  if (state.trial || (trialAccess && (state.bound || state.draft || zeroTrustTeam || rotateToken ||
      !/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(trialAccess.existingAccessIssuer ?? '')))) {
    throw new Error('Use a fresh deployment and a verified existing Access issuer for the short-lived OAuth trial');
  }
  const account = `/accounts/${spec.accountId}`;
  const hostname = new URL(spec.origin).hostname;
  const scriptsPath = account + '/workers/scripts';
  const domainsPath = account + '/workers/domains';
  const dnsPath = `/zones/${spec.zoneId}/dns_records`;
  const worker = single(await api.get(scriptsPath), item => item.id === spec.worker, 'Worker script');
  if (worker && !worker.tags?.includes(spec.label)) throw new Error('Worker name already belongs to another deployment');
  const domain = single(await api.get(domainsPath, { hostname }), item => item.hostname === hostname, 'Worker domain');
  if (domain && domain.service !== spec.worker) throw new Error('Management hostname already belongs to another Worker');
  if ((verifyPartial || safeResume) && (worker || domain)) {
    throw new Error('Worker 或管理台域名已存在，无法自动确认上次上传结果；未重新写入 Worker。');
  }
  const conflictingDns = async () => (await api.list(dnsPath, { name: hostname })).some(item => item.name === hostname);
  if (!domain && await conflictingDns()) throw new Error('Management hostname already has a DNS record');
  if (state.bound && !worker) throw new Error('Previously deployed Worker is missing. Review Cloudflare before recovery.');
  const apps = await api.list(account + '/access/apps');
  const legacyBootstrap = hostname + '/device/*';
  if (apps.some(app => app.domain === legacyBootstrap || app.destinations?.some(dest => dest.uri === legacyBootstrap))) {
    throw new Error('A legacy wildcard device Access application exists. Review and migrate it explicitly before setup.');
  }
  let issuer = trialAccess?.existingAccessIssuer;
  let loginSettings = {};
  let nativeLogin;
  let exactLoginProviders = false;
  if (!trialAccess) {
    const organizations = account + '/access/organizations';
    let organization = await api.getOptional(organizations);
    if (!organization && !managedOAuth?.userDetails && /^[a-z][a-z0-9-]{2,30}$/.test(zeroTrustTeam ?? '')) {
      organization = await api.post(organizations, { name: zeroTrustTeam, auth_domain: zeroTrustTeam + '.cloudflareaccess.com' });
    }
    issuer = accessIssuer(organization);
    if (!isAccessIssuer(issuer)) {
      throw new Error(managedOAuth?.userDetails ? missingOrganization : 'This account needs an active Cloudflare Zero Trust organization with an identity provider');
    }
    if (managedOAuth?.userDetails) {
      const providers = await managementLoginProviders(api, spec.accountId);
      let ids;
      if (state.ssoIdentity) {
        const { providerId, issuer: verifiedIssuer } = state.ssoIdentity;
        if (state.spec?.ownerEmail !== spec.ownerEmail || verifiedIssuer !== issuer || !providers.some(({ id }) => id === providerId)) {
          throw new Error('原回执中的 SSO 登录方式或 Zero Trust 组织已变更，请让账户管理员核对后再继续。');
        }
        ids = [providerId];
        exactLoginProviders = true;
      } else {
        ids = [...new Set(providers.filter(directManagementProvider).map(({ id }) => id))];
        const natives = providers.filter(({ type }) => type === 'cloudflare');
        if (natives.length === 1) nativeLogin = natives[0].id;
        if (!ids.length) throw new Error('请先完成诺联的浏览器 SSO 身份验证，再部署管理台。');
      }
      loginSettings = { allowed_idps: ids, auto_redirect_to_identity: false,
        ...(exactLoginProviders && { allow_authenticate_via_warp: false }) };
    } else {
      const providerPath = account + '/access/identity_providers';
      const providers = await api.list(providerPath);
      if (!providers.length && zeroTrustTeam && issuer === 'https://' + zeroTrustTeam + '.cloudflareaccess.com') {
        await api.post(providerPath, { name: 'One-time PIN', type: 'onetimepin', config: {} });
      } else if (!providers.length) {
        throw new Error('This account needs an Access identity provider');
      }
    }
  }
  const branding = spec.label;
  const zoneScopedAccess = trialAccess?.zoneScopedAccess === true;
  const accountScopedAccess = Boolean(managedOAuth);
  let ownerPolicyId;
  let bootstrapPolicyId;
  if (!zoneScopedAccess && !accountScopedAccess) {
    ownerPolicyId = (await ensurePolicy(api, account, branding + '-owner', 'allow', [{ email: { email: spec.ownerEmail } }])).id;
    bootstrapPolicyId = (await ensurePolicy(api, account, branding + '-device-bootstrap', 'bypass', [{ everyone: {} }])).id;
  }
  const protect = (app, { bootstrap = false, managed = false } = {}) => zoneScopedAccess || accountScopedAccess
    ? ensureScopedAccessApp(api, spec, app, { bootstrap, managed, accountScoped: accountScopedAccess, exactLoginProviders })
    : ensureAccessApp(api, account, app, bootstrap ? bootstrapPolicyId : ownerPolicyId, { attachNewManagedApp: managed });
  const managementLogin = nativeLogin && !state.bound && !safeResume && !verifyPartial
    ? { allowed_idps: [nativeLogin], auto_redirect_to_identity: true }
    : loginSettings;
  const management = await protect({ ...publicAccessApp(branding + '-management', hostname), ...managementLogin });
  if (typeof management?.aud !== 'string' || !management.aud) throw new Error('Management Access audience unavailable');
  const downloads = Object.keys(hostedInstallers(releases)).map(installPath);
  for (const path of [enrollPath, activatePath, ...downloads]) {
    await protect(publicAccessApp(branding + path.replaceAll('/', '-'), hostname + path), { bootstrap: true });
  }

  const portalPath = account + '/access/ai-controls/mcp/portals';
  const portal = await api.getOptional(portalPath + '/' + spec.portalId);
  if (portal && (portal.name !== branding || portal.hostname !== spec.portalHostname)) throw new Error('Portal ownership differs');
  if (!portal) await api.post(portalPath, {
    id: spec.portalId, name: branding, hostname: spec.portalHostname, code_mode: 'off', secure_web_gateway: false,
  });
  const portalAccess = await protect({ ...publicAccessApp(branding, spec.portalHostname, 'mcp_portal'), ...loginSettings }, { managed: true });
  if (!state.bound) await configureNewPortalCallbacks(api, { ...spec, zoneScopedAccess }, portalAccess.id);
  await ensureDns(api, spec.zoneId, spec.portalHostname, 'gateway.agents.cloudflare.com', branding);

  const d1Path = account + '/d1/database';
  const existingDatabase = single(await api.list(d1Path, { name: spec.database }),
    item => item.name === spec.database, 'D1 database');
  if (state.databaseId && state.databaseId !== existingDatabase?.uuid) throw new Error('D1 database ownership changed');
  if (verifyPartial) {
    if (!existingDatabase || existingDatabase.uuid !== state.databaseId) throw new Error('无法验证回执中的 D1 数据库。');
    return;
  }
  const database = existingDatabase ?? await api.post(d1Path, { name: spec.database });
  if (!database?.uuid) throw new Error('D1 database ID unavailable');
  state.databaseId = database.uuid;
  await save(state);
  await api.post(`${d1Path}/${database.uuid}/query`, { batch: migrations.map(sql => ({ sql })) });

  const needToken = !trialAccess && !managedOAuth && (!state.bound || rotateToken);
  if (needToken && !state.draft) {
    if (!state.provisionerAttempt) {
      state.provisionerAttempt = randomBytes(5).toString('hex');
      await save(state);
    }
    const expiresOn = lifetime ? new Date(Math.floor(Date.now() / 1000) * 1000 + lifetime * 86400000).toISOString() : undefined;
    state.draft = await issueProvisioningToken(api, spec.accountId, spec.zoneId,
      branding + '-provisioner-' + state.provisionerAttempt, expiresOn);
    await save(state);
  }

  const accessBinding = zoneScopedAccess ? { zoneScopedAccess } : accountScopedAccess ? { accountScopedAccess } : { policyId: ownerPolicyId };
  const bindings = Object.entries({
    APP_ORIGIN: spec.origin, ACCESS_ISSUER: issuer, ACCESS_AUD: management.aud,
    OWNER_EMAIL: spec.ownerEmail, FLEET_SPEC: JSON.stringify({ ...spec, ...accessBinding }),
    RELEASE_CATALOG: JSON.stringify(releases),
  }).map(([name, text]) => ({ type: 'plain_text', name, text }));
  bindings.push({ type: 'd1', name: 'TICKETS', id: database.uuid });
  if (managedOAuth) {
    state.oauthKey ??= randomBytes(32).toString('base64url');
    await save(state);
    if (!state.ticketKey) throw new Error('Management ticket signing key unavailable');
    bindings.push({ type: 'durable_object_namespace', name: 'PROVISIONER_OAUTH', class_name: 'OAuthProvisioner' },
      { type: 'plain_text', name: 'FLEET_OAUTH_CLIENT_ID', text: managedOAuth.clientId },
      { type: 'plain_text', name: 'FLEET_OAUTH_MODE', text: 'managed' },
      { type: 'plain_text', name: 'FLEET_OAUTH_RECOVERY', text: '1' },
      { type: 'secret_text', name: 'TICKET_KEY', text: state.ticketKey },
      { type: 'secret_text', name: 'FLEET_OAUTH_KEY', text: state.oauthKey },
      { type: 'secret_text', name: 'FLEET_OAUTH_SEED', text: JSON.stringify(managedOAuth.grant) });
    if (managedOAuth.grant.zeroTrustBootstrap === true) bindings.push({ type: 'plain_text', name: 'FLEET_OAUTH_ZERO_TRUST_BOOTSTRAP', text: '1' });
    if (managedOAuth.userDetails) bindings.push({ type: 'plain_text', name: 'FLEET_OAUTH_USER_DETAILS', text: '1' });
    const enrollment = managedOAuth.enrollment;
    if (enrollment) {
      if (!managedOAuth.webUpgrade || enrollment.protocol !== 'intent-v1') throw new Error('Device enrollment lacks a trusted management baseline');
      bindings.push({ type: 'plain_text', name: 'FLEET_ENROLLMENT_PROTOCOL', text: enrollment.protocol },
        { type: 'plain_text', name: 'FLEET_ENROLLMENT_HISTORY', text: JSON.stringify(enrollment.history) });
    }
    const webUpgrade = managedOAuth.webUpgrade;
    if (webUpgrade) {
      for (const [name, text] of Object.entries({
        NODRELAY_RELEASE_VERSION: webUpgrade.version, NODRELAY_UPGRADE_CHANNEL: webUpgrade.channel,
        NODRELAY_UPGRADE_PUBLIC_KEY: webUpgrade.publicKey, NODRELAY_UPGRADE_FEED: webUpgrade.feed,
      })) bindings.push({ type: 'plain_text', name, text });
    }
  } else if (!state.bound) {
    const credential = trialAccess?.access ?? state.draft?.value;
    if (!state.ticketKey || !credential) throw new Error('Initial Worker secrets unavailable');
    bindings.push(
      { type: 'secret_text', name: 'TICKET_KEY', text: state.ticketKey },
      { type: 'secret_text', name: 'PROVISIONER_TOKEN', text: credential },
    );
  }
  const form = new FormData();
  form.set('metadata', new Blob([JSON.stringify({
    main_module: 'worker.js', compatibility_date: '2026-07-30',
    observability: { enabled: false }, tags: [spec.label], bindings,
    ...(managedOAuth && !worker && { migrations: { new_tag: 'nodrelay-oauth-v1', new_sqlite_classes: ['OAuthProvisioner'] } }),
    ...(state.bound && { keep_bindings: ['secret_text'] }),
  })], { type: 'application/json' }));
  form.set('worker.js', new Blob([bundle], { type: 'application/javascript+module' }), 'worker.js');
  const scriptPath = scriptsPath + '/' + spec.worker;
  if (safeResume && (await api.get(scriptsPath)).some(item => item.id === spec.worker)) {
    throw new Error('上次 Worker 上传结果已变化；已停止，不覆盖已存在的 Worker。');
  }
  await uploadManagementWorker(api, {
    accountId: spec.accountId, scriptPath, form, existing: Boolean(worker), state, save,
    confirmWorkersSubdomain: managedOAuth ? confirmWorkersSubdomain : undefined,
  });
  if (state.bound && rotateToken) {
    await api.put(scriptPath + '/secrets', { name: 'PROVISIONER_TOKEN', text: state.draft.value, type: 'secret_text' });
  }
  await api.post(scriptsPath + '/' + spec.worker + '/subdomain', { enabled: false, previews_enabled: false });
  if (!domain) {
    if (await conflictingDns()) throw new Error('Management hostname acquired a DNS record while deploying');
    await api.put(domainsPath, { hostname, service: spec.worker, zone_id: spec.zoneId, enabled: true, previews_enabled: false });
  }
  if (managedOAuth) {
    state.bound = true;
    state.managedOAuth = true;
    delete state.ticketKey;
    delete state.oauthKey;
    await save(state);
  } else if (trialAccess) {
    state.trial = true;
    state.bound = true;
    state.provisionerExpiresOn = new Date(trialAccess.expiresAt).toISOString();
    delete state.ticketKey;
    await save(state);
  } else if (needToken) {
    state.retiredProvisioner = state.provisionerId;
    state.provisionerId = state.draft.id;
    state.provisionerExpiresOn = state.draft.expiresOn;
    state.bound = true;
    delete state.ticketKey;
    delete state.draft;
    delete state.provisionerAttempt;
    await save(state);
  }
  return {
    management: spec.origin, portal: 'https://' + spec.portalHostname + '/mcp',
    accessIssuer: issuer,
    cloudDeployment: { accountId: spec.accountId, zoneId: spec.zoneId, worker: spec.worker,
      portalId: spec.portalId, managementAppId: management.id, portalAppId: portalAccess.id,
      accessScope: zoneScopedAccess ? 'zone' : 'account' },
    retiredProvisioner: state.retiredProvisioner, provisionerExpiresOn: state.provisionerExpiresOn,
  };
}

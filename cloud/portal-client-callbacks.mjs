import { single } from './cloudflare.mjs';

export const portalCallbackPresets = [
  { client: 'ChatGPT', uris: [
    'https://chatgpt.com/connector_platform_oauth_redirect',
    'https://chatgpt.com/connector/oauth/*',
  ] },
  { client: 'Claude', uris: ['https://claude.ai/api/mcp/auth_callback'] },
  { client: 'Cursor', uris: [
    'https://www.cursor.com/agents/mcp/oauth/callback',
    'http://localhost:8787/callback',
    'cursor://anysphere.cursor-mcp/oauth/callback',
  ] },
  { client: 'VS Code', uris: ['https://vscode.dev/redirect', 'http://127.0.0.1:33418/'] },
];
const defaultUris = portalCallbackPresets.flatMap(preset => preset.uris);

export class PortalCallbackError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function applicationPath(spec) {
  return (spec.zoneScopedAccess ? '/zones/' + spec.zoneId : '/accounts/' + spec.accountId) + '/access/apps';
}

function ownsPortal(app, spec) {
  return app?.name === spec.label && app.type === 'mcp_portal' &&
    (app.domain === spec.portalHostname || (!app.domain && app.destinations?.length === 1 &&
      app.destinations[0].uri === spec.portalHostname)) &&
    (!app.destinations?.length || app.destinations.length === 1 && app.destinations[0].uri === spec.portalHostname);
}

async function loadPortal(api, spec, id) {
  const path = applicationPath(spec);
  const appId = id ?? single(await api.list(path, { domain: spec.portalHostname }),
    app => ownsPortal(app, spec), 'managed Portal Access application')?.id;
  if (!appId) throw new PortalCallbackError('找不到该部署的 Portal Access 应用。', 409);
  const resource = path + '/' + appId;
  const app = await api.get(resource);
  if (!ownsPortal(app, spec)) throw new PortalCallbackError('Portal Access 应用归属已变化。', 409);
  return { resource, app };
}

function registrationOf(app) {
  return app.oauth_configuration?.dynamic_client_registration ?? {};
}

function callbackState(app) {
  const registration = registrationOf(app);
  return {
    enabled: app.oauth_configuration?.enabled === true && registration.enabled === true,
    allowedUris: registration.allowed_uris ?? [],
    allowLocalhost: registration.allow_any_on_localhost === true,
    allowLoopback: registration.allow_any_on_loopback === true,
    presets: portalCallbackPresets,
  };
}

function exactRedirect(value) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9+.-]*:\/[^#*{}\s\\]+$/i.test(value) || value.length > 2048) {
    throw new PortalCallbackError('请输入客户端的完整回调地址。它不能包含通配符或片段。', 400);
  }
  const url = URL.parse(value);
  const allowedScheme = url?.protocol === 'https:' ||
    (url?.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) ||
    url?.protocol === 'cursor:' ||
    /^[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)+:$/i.test(url?.protocol ?? '');
  if (!url || !allowedScheme || url.username || url.password ||
      (/^https?:$/.test(url.protocol) && !/^https?:\/\/[^/]/i.test(value))) {
    throw new PortalCallbackError('回调地址必须使用 HTTPS、环回 HTTP 或客户端的原生回调协议。', 400);
  }
  if ([...url.searchParams.keys()].some(key => /^(?:code|state|client_secret|access_token|refresh_token|id_token|token)$/i.test(key))) {
    throw new PortalCallbackError('请使用客户端的回调地址，去掉授权码或凭据。', 400);
  }
  return value;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}

function policySnapshot(policies) {
  return policies.map(({ updated_at, ...policy }) => JSON.stringify(canonical(policy))).sort().join('\n');
}

function applicationSnapshot(app) {
  const { updated_at, policies, oauth_configuration, ...settings } = app;
  const { dynamic_client_registration, ...oauth } = oauth_configuration ?? {};
  const { enabled, allowed_uris, ...registration } = dynamic_client_registration ?? {};
  return JSON.stringify(canonical({ settings, oauth, registration, policies: policySnapshot(policies ?? []) }));
}

async function updateCallbacks(api, spec, resource, original, uris, initialize = false) {
  const policies = policySnapshot(await api.list(resource + '/policies'));
  const current = await api.get(resource);
  if (!ownsPortal(current, spec) || JSON.stringify(canonical(current)) !== JSON.stringify(canonical(original))) {
    throw new PortalCallbackError('Portal 配置刚刚更新，请刷新后重试。', 409);
  }
  const existing = registrationOf(current);
  // Cloudflare's Access PUT expects the configuration returned by GET.
  await api.put(resource, {
    ...current,
    oauth_configuration: {
      ...current.oauth_configuration,
      dynamic_client_registration: {
        ...existing,
        ...(initialize && { enabled: true }),
        allowed_uris: uris,
      },
    },
  });
  const app = await api.get(resource);
  const state = callbackState(app);
  if (!ownsPortal(app, spec) || !state.enabled || applicationSnapshot(app) !== applicationSnapshot(current) ||
      state.allowedUris.length !== uris.length ||
      !uris.every(uri => state.allowedUris.includes(uri)) ||
      policySnapshot(await api.list(resource + '/policies')) !== policies) {
    throw new PortalCallbackError('Cloudflare 回读与预期不符，请检查 Portal 配置后再试。', 409);
  }
  return state;
}

export async function readPortalCallbacks(api, spec) {
  return callbackState((await loadPortal(api, spec)).app);
}

export async function addPortalCallback(api, spec, input) {
  const uri = exactRedirect(input);
  const { resource, app } = await loadPortal(api, spec);
  const state = callbackState(app);
  if (!state.enabled) throw new PortalCallbackError('该 Portal 尚未启用动态客户端注册。', 409);
  if (state.allowedUris.includes(uri)) return state;
  return updateCallbacks(api, spec, resource, app, [...state.allowedUris, uri]);
}

export async function configureNewPortalCallbacks(api, spec, appId) {
  const { resource, app } = await loadPortal(api, spec, appId);
  const state = callbackState(app);
  const uris = [...new Set([...state.allowedUris, ...defaultUris])];
  if (state.enabled && uris.length === state.allowedUris.length) return state;
  return updateCallbacks(api, spec, resource, app, uris, true);
}

const endpoint = 'https://api.cloudflare.com/client/v4';
export const cloudflareRequestTimeoutMs = 15000;
export const connectorScope = 'teams-connector-cloudflared.write';
export const runtimePermissions = ['MCP Portals Write', 'Access: Apps and Policies Write', 'Cloudflare One Connector: cloudflared Write'];
export const deploymentScopes = [
  'zone.read', 'dns.write', 'access.write', 'access-acct.read',
  'workers-scripts.write', 'd1.write', 'mcp-portals.write', connectorScope, 'account-api-tokens.write',
];

// Only fixed API vocabulary is displayed. Never print path parameters, query
// strings, response bodies, credentials, or user-controlled resource names.
const routeWords = new Set(['accounts', 'zones', 'user', 'access', 'organizations', 'identity_providers',
  'apps', 'policies', 'dns_records', 'workers', 'scripts', 'd1', 'database', 'query', 'mcp',
  'portals', 'cfd_tunnel', 'token', 'tokens', 'subdomain', 'domains', 'permission_groups', 'versions']);
export function safeCloudflareRoute(path) {
  if (typeof path !== 'string' || !path.startsWith('/')) return '/{resource}';
  return path.split('?')[0].split('/').map((part, index) => index === 0 ? '' :
    routeWords.has(part) ? part : '{id}').join('/');
}

export const accessNotEnabled = 'access_not_enabled';

function accountAccessOrganizationError(method, url, status, payload) {
  if (method !== 'GET' || status !== 403 || url.search ||
      !/^\/client\/v4\/accounts\/[a-f0-9]{32}\/access\/organizations$/.test(url.pathname) ||
      payload?.success !== false || payload.result !== null || !Array.isArray(payload.errors) ||
      payload.errors.length !== 1) return;
  const error = payload.errors[0];
  if (error?.code === 9999 && typeof error.message === 'string' &&
      error.message.startsWith('access.api.error.not_enabled:')) return accessNotEnabled;
}

export class CloudflareError extends Error {
  constructor(method, status, codes, { path, rayId, reason } = {}) {
    const route = path ? ` ${safeCloudflareRoute(path)}` : '';
    const ray = typeof rayId === 'string' && /^[a-zA-Z0-9-]{6,80}$/.test(rayId) ? rayId : undefined;
    super(`Cloudflare ${method}${route} failed (HTTP ${status}${codes.length ? ', codes ' + codes.join(', ') : ''}${ray ? ', Ray ID ' + ray : ''})`);
    this.status = status;
    this.codes = codes;
    if (reason === accessNotEnabled) this.reason = accessNotEnabled;
    if (ray) this.rayId = ray;
  }
}

export class CloudflareRequestTimeoutError extends Error {
  constructor(method, timeoutMs) {
    super(`Cloudflare ${method} request did not complete within ${timeoutMs / 1000} seconds`);
    this.method = method;
    this.timeoutMs = timeoutMs;
  }
}

export function cloudflareApi(token, { request = fetch, beforeRequest, requestTimeoutMs = cloudflareRequestTimeoutMs } = {}) {
  async function send(method, path, body, query) {
    const access = typeof token === 'function' ? await token() : token;
    await beforeRequest?.();
    const url = new URL(endpoint + path);
    for (const [name, value] of Object.entries(query ?? {})) url.searchParams.set(name, String(value));
    const headers = { Authorization: `Bearer ${access}` };
    const form = body instanceof FormData;
    if (body && !form) headers['Content-Type'] = 'application/json';
    const controller = new AbortController();
    const { signal } = controller;
    const exchange = async () => {
      const response = await request(url, {
        method, headers, redirect: 'manual', signal,
        ...(body && { body: form ? body : JSON.stringify(body) }),
      });
      signal.throwIfAborted();
      if (method === 'DELETE' && response.status === 204) return { result: undefined };
      const payload = await response.json().catch(() => {
        signal.throwIfAborted();
        return undefined;
      });
      if (!response.ok || payload?.success !== true) {
        const codes = Array.isArray(payload?.errors)
          ? payload.errors.map(error => error?.code).filter(Number.isInteger) : [];
        throw new CloudflareError(method, response.status, codes, {
          path, rayId: response.headers.get('cf-ray'),
          reason: accountAccessOrganizationError(method, url, response.status, payload),
        });
      }
      return payload;
    };
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new CloudflareRequestTimeoutError(method, requestTimeoutMs);
        reject(error);
        controller.abort(error);
      }, requestTimeoutMs);
    });
    try { return await Promise.race([exchange(), deadline]); }
    finally { clearTimeout(timer); }
  }

  return {
    async get(path, query) { return (await send('GET', path, undefined, query)).result; },
    async getOptional(path) {
      try { return (await send('GET', path)).result; }
      catch (error) { if (error.status !== 404) throw error; }
    },
    async list(path, { per_page: pageSize = 100, ...query } = {}) {
      const items = [];
      for (let page = 1; page <= 20; page++) {
        const response = await send('GET', path, undefined, { ...query, page, per_page: pageSize });
        if (!Array.isArray(response.result)) throw new Error('Unexpected Cloudflare list response');
        items.push(...response.result);
        // The server may cap per_page or send a short page. When it reports
        // the page count, do not mistake an incomplete resource list for absence.
        const totalPages = response.result_info?.total_pages;
        if (Number.isSafeInteger(totalPages) && totalPages >= 0) {
          if (page >= totalPages) return items;
        } else if (response.result.length < (response.result_info?.per_page ?? pageSize)) return items;
      }
      throw new Error('Cloudflare list exceeded the reconciliation limit');
    },
    async post(path, body) { return (await send('POST', path, body)).result; },
    async put(path, body) { return (await send('PUT', path, body)).result; },
    async patch(path, body) { return (await send('PATCH', path, body)).result; },
    async del(path) { return (await send('DELETE', path)).result; },
  };
}

export function single(items, predicate, label) {
  const matches = items.filter(predicate);
  if (matches.length > 1) throw new Error(`Duplicate ${label}; stop and inspect Cloudflare`);
  return matches[0];
}

export async function ensureDns(api, zoneId, name, target, owner) {
  const path = `/zones/${zoneId}/dns_records`;
  const existing = single(await api.list(path, { name }), item => item.name === name, 'DNS record');
  if (!existing) return api.post(path, { name, type: 'CNAME', content: target, proxied: true, ttl: 1, comment: owner });
  if (existing.type !== 'CNAME' || existing.content.replace(/\.$/, '') !== target ||
      !existing.proxied || existing.comment !== owner) {
    throw new Error('DNS hostname already belongs to a different configuration');
  }
  return existing;
}

export async function ensurePolicy(api, account, name, decision, include) {
  const path = account + '/access/policies';
  const existing = single(await api.list(path), row => row.name === name, 'Access policy');
  if (!existing) return api.post(path, { name, decision, include, exclude: [], require: [] });
  if (existing.decision !== decision || JSON.stringify(existing.include) !== JSON.stringify(include) ||
      existing.exclude?.length || existing.require?.length) {
    throw new Error('Access policy drifted; inspect before continuing');
  }
  return existing;
}

export async function ensureAccessApp(api, account, app, policyId, { attachNewManagedApp = false } = {}) {
  const path = account + '/access/apps';
  const applications = await api.list(path);
  const predicate = row => app.domain
    ? row.domain === app.domain || row.destinations?.some(dest => dest.uri === app.domain)
    : row.destinations?.some(dest => dest.mcp_server_id === app.destinations[0].mcp_server_id);
  const existing = single(applications, row => row.name === app.name || predicate(row), 'Access application');
  if (!existing) return api.post(path, { ...app, policies: [{ id: policyId, precedence: 1 }] });
  const policies = existing.policies ?? [];
  const appIsExact = predicate(existing) && existing.type === app.type &&
    existing.name === app.name && policies.length === 1 &&
    (policies[0]?.id ?? policies[0]) === policyId &&
    (!app.oauth_configuration?.enabled || existing.oauth_configuration?.enabled === true);
  if (appIsExact) return existing;
  if (attachNewManagedApp && !policies.length && existing.id && predicate(existing) &&
      existing.name === app.name && existing.type === app.type) {
    return api.put(path + '/' + existing.id, { ...app, policies: [{ id: policyId, precedence: 1 }] });
  }
  throw new Error('Access application drifted or already belongs to another service');
}

export function publicAccessApp(name, domain, type = 'self_hosted') {
  return {
    name, domain, type, destinations: [{ type: 'public', uri: domain }],
    ...(type === 'mcp_portal' && { oauth_configuration: { enabled: true } }),
  };
}

export async function issueProvisioningToken(api, accountId, zoneId, name, expiresOn) {
  const account = `/accounts/${accountId}`;
  const path = account + '/tokens';
  const sameName = (await api.list(path)).some(token => token.name === name);
  if (sameName) throw new Error('Cloudflare already has a credential for this attempt. Revoke the orphaned token before retrying.');
  const permissions = await api.get(path + '/permission_groups');
  const resolveGroups = (names, scope) => names.map(label => {
    const group = single(permissions, item => item.name === label && item.scopes?.includes(scope), label);
    if (!group?.id) throw new Error(`Account cannot grant ${label}`);
    return { id: group.id };
  });
  const accountScope = 'com.cloudflare.api.account';
  const zoneScope = 'com.cloudflare.api.account.zone';
  const result = await api.post(path, { name, ...(expiresOn && { expires_on: expiresOn }), policies: [
    { effect: 'allow', permission_groups: resolveGroups(runtimePermissions, accountScope),
      resources: { [`${accountScope}.${accountId}`]: '*' } },
    { effect: 'allow', permission_groups: resolveGroups(['DNS Write'], zoneScope),
      resources: { [`${zoneScope}.${zoneId}`]: '*' } },
  ] });
  if (!result?.id || !result.value) throw new Error('Cloudflare did not return the provisioning credential');
  if (expiresOn && Date.parse(result.expires_on) !== Date.parse(expiresOn)) {
    const tokenPath = path + '/' + encodeURIComponent(result.id);
    const confirmed = await api.get(tokenPath).catch(() => undefined);
    if (Date.parse(confirmed?.expires_on) !== Date.parse(expiresOn)) {
      try { await api.del(tokenPath); }
      catch { throw new Error('Cloudflare did not confirm the token expiry or cleanup. Revoke the token named ' + name + ' before retrying.'); }
      throw new Error('Cloudflare did not confirm the requested token expiry. The new token was revoked.');
    }
  }
  return { id: result.id, value: result.value, ...(expiresOn && { expiresOn }) };
}

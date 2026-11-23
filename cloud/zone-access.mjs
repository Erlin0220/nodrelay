import { single } from './cloudflare.mjs';

function matchesDestination(row, app) {
  return app.domain
    ? row.domain === app.domain || row.destinations?.some(item => item.uri === app.domain)
    : row.destinations?.some(item => item.mcp_server_id === app.destinations[0].mcp_server_id);
}

export async function ensureScopedAccessApp(api, spec, app, { bootstrap = false, managed = false, accountScoped = false,
  exactLoginProviders = false } = {}) {
  const accountPath = `/accounts/${spec.accountId}/access/apps`;
  const path = accountScoped ? accountPath : `/zones/${spec.zoneId}/access/apps`;
  const matches = row => row.name === app.name || matchesDestination(row, app);
  const exact = row => row && row.name === app.name && row.type === app.type && matchesDestination(row, app);
  const scoped = single(await api.list(path), matches, 'Access application');
  if (!accountScoped) {
    const account = single(await api.list(accountPath), matches, 'account Access application');
    if (account && account.id !== scoped?.id) {
      throw new Error('Cloudflare Access application is outside the zone API; account Access write is required');
    }
  }
  if (scoped && !exact(scoped)) throw new Error('Zone Access application ownership does not match');
  const rule = {
    name: bootstrap ? `${spec.label}-device-bootstrap` : `${spec.label}-owner`,
    decision: bootstrap ? 'bypass' : 'allow',
    include: bootstrap ? [{ everyone: {} }] : [{ email: { email: spec.ownerEmail } }],
    exclude: [], require: !bootstrap && exactLoginProviders ? [{ login_method: { id: app.allowed_idps[0] } }] : [], precedence: 1,
  };
  const created = scoped ?? await api.post(path, managed ? app : { ...app, policies: [rule] }).catch(error => {
    if (!accountScoped && app.type === 'mcp' && error.status === 400 && error.codes?.includes(12130)) {
      throw new Error('Cloudflare rejected the zone-scoped MCP Access application (12130). Configure it at account scope.', { cause: error });
    }
    throw error;
  });
  if (!/^[a-f0-9-]{32,36}$/.test(created?.id ?? '')) throw new Error('Zone Access application ID unavailable');
  const appPath = `${path}/${created.id}`;
  const current = await api.get(appPath);
  if (!exact(current) || (app.oauth_configuration?.enabled && current.oauth_configuration?.enabled !== true)) {
    throw new Error('Cloudflare zone Access application failed destination or OAuth verification');
  }
  if (app.allowed_idps) {
    const allowed = current.allowed_idps;
    const selected = Array.isArray(allowed) && allowed.length > 0;
    const hasCompatibleProvider = selected && allowed.some(id => app.allowed_idps.includes(id));
    const usesAccountDefaults = allowed === undefined || (Array.isArray(allowed) && !allowed.length);
    const compatible = current.auto_redirect_to_identity === true
      ? hasCompatibleProvider && allowed.length === 1
      : hasCompatibleProvider || (scoped && usesAccountDefaults);
    const matchesAllowed = selected && new Set(allowed).size === app.allowed_idps.length &&
      allowed.every(id => app.allowed_idps.includes(id));
    if (!compatible || ((!scoped || exactLoginProviders) && !matchesAllowed) ||
        (exactLoginProviders && current.allow_authenticate_via_warp !== false)) {
      const method = exactLoginProviders ? '已验证的 SSO 登录方式' : 'Cloudflare 或 One-time PIN';
      throw new Error(`当前 Access 应用未提供所需的管理员登录方式。请在 Zero Trust → Access controls → Applications 中核对该应用的${method}，再运行原安装命令。`);
    }
  }
  const policies = `${appPath}/policies`;
  let rules = await api.list(policies);
  if (!rules.length && (managed || !scoped)) {
    await api.post(policies, rule);
    rules = await api.list(policies);
  }
  const [existing] = rules;
  if (rules.length !== 1 || existing.name !== rule.name || existing.decision !== rule.decision ||
      JSON.stringify(existing.include) !== JSON.stringify(rule.include) || existing.exclude?.length ||
      JSON.stringify(existing.require ?? []) !== JSON.stringify(rule.require)) {
    throw new Error('Cloudflare zone Access application policy does not match the requested restriction');
  }
  return current;
}

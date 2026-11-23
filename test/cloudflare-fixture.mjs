import assert from 'node:assert/strict';
import { runtimePermissions } from '../cloud/cloudflare.mjs';
import { makeSetupSpec, validateReleaseCatalog } from '../src/setup-core.mjs';

const accountId = 'a'.repeat(32);
const zoneId = 'b'.repeat(32);
export const spec = makeSetupSpec({ namespace: 'demo', ownerEmail: 'owner@example.test' }, {
  id: zoneId, account: { id: accountId }, status: 'active', name: 'example.test',
}, '1'.repeat(12));
export const account = '/accounts/' + accountId;
export const catalog = validateReleaseCatalog({
  'linux-x64': { url: 'https://downloads.example.test/fleet.tgz', sha256: 'af'.repeat(32), version: '1.1.0' },
  'windows-x64': { url: 'https://downloads.example.test/fleet.zip', sha256: 'ce'.repeat(32), version: '1.1.0', browser: true },
});
export const ticketKey = Buffer.alloc(32, 12).toString('base64url');
const envelope = (result, status = 200) => Response.json({
  success: status < 400, errors: status < 400 ? [] : [{ code: status }], result,
}, { status });

export function cloudFixture({ omitTokenExpiry = false, provisionerToken = 'generated-provisioner', directPolicies = false,
  identityProviders = [{ id: '2'.repeat(32), type: 'cloudflare' }], profile, databaseId = 'fixture-d1' } = {}) {
  const db = { policies: [], apps: [], dns: [], tokens: [], d1: [], domains: [], scripts: [], tunnels: [], servers: [], portal: null };
  const writes = [];
  const offline = new Set();
  const mcpCatalogs = new Map();
  let unavailableOnce;
  const request = async (url, init) => {
    url = new URL(url);
    const path = url.pathname.replace('/client/v4', '');
    let body = init.body instanceof FormData || !init.body ? init.body : JSON.parse(init.body);
    if (url.origin !== 'https://api.cloudflare.com') {
      if (offline.has(url.hostname) || offline.has(url.href)) return new Response(null, { status: 503 });
      if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
      const browser = url.pathname === '/browser/mcp';
      const tools = (browser
        ? ['browser_profiles', 'browser_navigate', 'browser_snapshot', 'browser_tabs', 'browser_click']
        : ['open_workspace', 'read', 'apply_patch', 'exec_command', 'write_stdin']).map(name => ({ name }));
      return Response.json({ jsonrpc: '2.0', id: body.id,
        result: body.method === 'initialize' ? { protocolVersion: '2025-11-25' } : mcpCatalogs.get(url.href) ?? { tools } });
    }
    assert.ok(['Bearer administrator-test-auth', 'Bearer ' + provisionerToken].includes(init.headers.Authorization));
    if (init.method !== 'GET') writes.push([init.method, path]);
    if (unavailableOnce?.path === path && (unavailableOnce.method ? unavailableOnce.method === init.method : init.method !== 'GET')) {
      unavailableOnce = undefined;
      return envelope(null, 503);
    }
    const list = (rows, item) => {
      if (init.method === 'GET') return envelope(rows);
      rows.push(item);
      return envelope(item);
    };
    if (path === account + '/access/organizations') return envelope({ auth_domain: 'fixture.cloudflareaccess.com' });
    if (path === '/user' && profile) return envelope(profile);
    if (path === account + '/access/identity_providers') return envelope(identityProviders);
    if (path === account + '/access/policies') return list(db.policies, { id: 'policy-' + db.policies.length, ...body });
    if (path === account + '/access/apps') {
      const appId = String(db.apps.length + 1).padStart(32, '0');
      return list(db.apps, { id: appId, aud: 'issuer-audience', ...body });
    }
    if (path.startsWith(account + '/access/apps/')) {
      const [id, component] = path.slice((account + '/access/apps/').length).split('/');
      const app = db.apps.find(a => a.id === id);
      if (!app) return envelope(null, 404);
      if (component === 'policies') return list(app.policies ??= [], body);
      if (init.method === 'PUT') Object.assign(app, body);
      return envelope(app);
    }
    if (path.endsWith('/mcp/portals')) {
      assert.equal(init.method, 'POST');
      db.portal = { ...body, servers: [{ server_id: 'existing-fixed-mapping', on_behalf: true }] };
      if (!directPolicies) db.apps.push({ id: 'auto-portal-app', name: body.name, type: 'mcp_portal', domain: body.hostname });
      return envelope(db.portal);
    }
    if (path.includes('/mcp/portals/')) {
      if (!db.portal || path.split('/').at(-1) !== db.portal.id) return envelope(null, 404);
      if (init.method === 'PUT') Object.assign(db.portal, body);
      return envelope(db.portal);
    }
    if (path.startsWith('/zones/' + zoneId + '/dns_records')) return list(db.dns, { id: 'dns-' + db.dns.length, ...body });
    if (path.endsWith('/d1/database')) return list(db.d1, { uuid: databaseId, ...body });
    if (path.endsWith('/' + databaseId + '/query')) {
      assert.ok(body.batch.every(x => x.sql.includes('IF NOT EXISTS')));
      return envelope([]);
    }
    if (path.endsWith('/tokens/permission_groups')) return envelope([
      ...runtimePermissions.map((name, id) => ({ name, id: `account-${id}`, scopes: ['com.cloudflare.api.account'] })),
      { name: 'DNS Write', id: 'dns', scopes: ['com.cloudflare.api.account.zone'] },
    ]);
    if (path.endsWith('/tokens')) {
      if (init.method === 'GET') return envelope([]);
      assert.deepEqual(body.policies[0].resources, { ['com.cloudflare.api.account.' + accountId]: '*' });
      assert.deepEqual(body.policies[1].resources, { ['com.cloudflare.api.account.zone.' + zoneId]: '*' });
      db.tokens.push(body);
      return envelope({ id: 'provisioner', value: 'generated-provisioner', expires_on: omitTokenExpiry ? undefined : body.expires_on });
    }
    if (path === account + '/tokens/provisioner') {
      if (init.method === 'DELETE') db.tokens.length = 0;
      return envelope({ id: 'provisioner' });
    }
    if (path.endsWith('/workers/scripts')) return envelope(db.scripts);
    if (path.endsWith('/workers/scripts/' + spec.worker)) {
      const metadata = JSON.parse(await body.get('metadata').text());
      assert.ok(metadata.bindings.some(x => ['PROVISIONER_OAUTH', 'PROVISIONER_TOKEN'].includes(x.name)) ||
        metadata.keep_bindings?.includes('secret_text'));
      db.scripts = [{ id: spec.worker, tags: metadata.tags, metadata }];
      return envelope(db.scripts[0]);
    }
    if (path.endsWith('/' + spec.worker + '/subdomain')) {
      assert.deepEqual(body, { enabled: false, previews_enabled: false });
      return envelope({});
    }
    if (path.endsWith('/workers/domains')) return list(db.domains, body);
    if (path.endsWith('/cfd_tunnel')) {
      const id = '00000000-0000-0000-0000-' + String(db.tunnels.length + 1).padStart(12, '0');
      return list(db.tunnels, { ...body, id, status: 'healthy' });
    }
    if (path.includes('/cfd_tunnel/')) {
      const [id, subresource] = path.split('/cfd_tunnel/')[1].split('/');
      const tunnel = db.tunnels.find(x => x.id === id);
      if (subresource === 'token') return envelope('t'.repeat(80));
      if (subresource === 'configurations') tunnel.config = body.config;
      if (subresource === 'connections') tunnel.disconnected = true;
      if (init.method === 'PATCH') tunnel.rotated = true;
      return envelope(tunnel);
    }
    if (path.endsWith('/mcp/servers')) return list(db.servers, { ...body, status: 'ready' });
    if (path.includes('/mcp/servers/')) {
      const [id] = path.split('/mcp/servers/')[1].split('/');
      const server = db.servers.find(x => x.id === id);
      return server ? envelope(server) : envelope(null, 404);
    }
    throw new Error('Unexpected Cloudflare fixture request ' + path);
  };
  return { request, db, writes, offline, mcpCatalogs, failNext(path, method) { unavailableOnce = { path, method }; } };
}

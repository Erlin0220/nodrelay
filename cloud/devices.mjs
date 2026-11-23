import { base64url } from 'jose';
import { activationDigest, revokeResponse } from './device-revocation.mjs';
import { CloudflareError, CloudflareRequestTimeoutError, cloudflareApi, ensureAccessApp, ensureDns, single } from './cloudflare.mjs';
import { ensureScopedAccessApp } from './zone-access.mjs';
import { hostedInstallers, operatingSystems } from './device-paths.mjs';
import { claimEnrollmentIntent, getEnrollmentIntent, revokeEnrollmentIntent } from './enrollment-intents.mjs';
import { workerOAuthAccess } from './oauth-provisioning.mjs';
import { addPortalCallback, PortalCallbackError, readPortalCallbacks } from './portal-client-callbacks.mjs';
import { profiles as routes } from './profiles.mjs';
import { devicePattern, issueTicket, protect, ticketCancellation, tokenPattern, unprotect, validateCredentials, validateDevicePorts } from './tickets.mjs';

const now = () => Math.floor(Date.now() / 1000);
const randomToken = () => base64url.encode(crypto.getRandomValues(new Uint8Array(32)));
const tunnelIdPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

export class DeviceError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

function validId(id) {
  if (typeof id !== 'string' || !devicePattern.test(id)) throw new DeviceError('Invalid device ID');
}

const displayCharacters = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
function deviceDisplayName(input) {
  const invalid = () => new DeviceError('设备名称请输入 1 至 20 个可见字符。');
  if (typeof input !== 'string' || input.length > 512 ||
      /[\p{Cc}\p{Cs}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(input)) throw invalid();
  const name = input.trim().normalize('NFC');
  if (!name || !/[^\s\p{Cf}]/u.test(name) || [...displayCharacters.segment(name)].length > 20) throw invalid();
  return name;
}
const deviceLabelsTable = "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'fleet_device_labels'";
const createDeviceLabels = `CREATE TABLE IF NOT EXISTS fleet_device_labels (
  device_id TEXT PRIMARY KEY NOT NULL REFERENCES fleet_devices(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL
)`;
const randomDeviceId = () => 'dev-' + Array.from(crypto.getRandomValues(new Uint8Array(8)),
  byte => byte.toString(16).padStart(2, '0')).join('');

export async function deviceLease(db, action, request = fetch) {
  const owner = randomToken();
  const row = await db.prepare(`INSERT INTO fleet_leases (id, owner, expires_at) VALUES (1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at
    WHERE fleet_leases.expires_at <= ? RETURNING owner`).bind(owner, now() + 90, now()).first();
  if (!row) throw new DeviceError('Another device operation is still running. Retry shortly.', 409);
  const guard = async () => {
    const result = await db.prepare('UPDATE fleet_leases SET expires_at = ? WHERE owner = ? AND expires_at > ? RETURNING owner')
      .bind(now() + 90, owner, now()).first();
    if (!result) throw new DeviceError('Device operation lease expired. Retry from the management page.', 409);
  };
  try { return await action({ request, beforeRequest: guard }, guard); }
  finally {
    await db.prepare('DELETE FROM fleet_leases WHERE owner = ?').bind(owner).run().catch(() => {});
  }
}

// Reuse the existing fleet primary key to reserve a device before choosing an OS.
// Empty platform is never a trusted installer key and requires no schema migration.
export const draftDevicePredicate = "platform = '' AND status = 'pending' AND credentials IS NULL AND tunnel_id IS NULL";
const registrationStatus = `CASE WHEN ${draftDevicePredicate} THEN 'draft' ELSE status END`;

async function readDevice(db, id) {
  validId(id);
  return db.prepare(`SELECT *, (${draftDevicePredicate}) AS draft FROM fleet_devices WHERE id = ?`).bind(id).first();
}

const liveTicket = (db, id) => db.prepare('SELECT 1 FROM enrollment_tickets WHERE device_id = ? AND expires_at > ?')
  .bind(id, now()).first();
const uniqueName = id => id + '-' + crypto.randomUUID().slice(0, 5);
const bindDraft = (db, row, platform, encrypted) => db.prepare(`UPDATE fleet_devices
  SET platform = ?, credentials = ?, updated_at = ? WHERE id = ? AND unique_name = ?
  AND ${draftDevicePredicate} RETURNING *`).bind(platform, encrypted, now(), row.id, row.unique_name).first();

async function reservedIntent(db, id) {
  // Older installed control planes may not have applied the intents migration yet.
  if (!await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'enrollment_intents'").first()) return;
  return db.prepare(`SELECT id, state FROM enrollment_intents WHERE device_id = ?
    AND state IN ('pending', 'claimed') ORDER BY state LIMIT 1`).bind(id).first();
}

function identity(spec, row) {
  const hostname = row.id + spec.deviceSuffix;
  const profile = (kind, token, port) => ({
    ...routes[kind], ...(port !== undefined && { port }), kind, token, id: row.unique_name + (kind === 'development' ? '-d' : '-b'),
    url: 'https://' + hostname + routes[kind].path,
  });
  return { hostname, profile };
}

function tunnelRules(hostname, profiles) {
  return [...profiles.map(r => ({
    hostname, path: '^' + r.path + '$', service: `http://127.0.0.1:${r.port}`,
    originRequest: { httpHostHeader: `127.0.0.1:${r.port}` },
  })), { service: 'http_status:404' }];
}

async function ensureTunnel(api, account, spec, db, row, profiles) {
  const path = account + '/cfd_tunnel';
  const name = `${spec.label}-${row.unique_name}`;
  const { hostname } = identity(spec, row);
  const found = row.tunnel_id
    ? await api.get(path + '/' + row.tunnel_id)
    : single(await api.list(path, { name, is_deleted: false }), tunnel => tunnel.name === name, 'device Tunnel');
  if (found && (found.name !== name || found.config_src !== 'cloudflare')) throw new DeviceError('Tunnel ownership could not be verified', 409);
  const tunnel = found ?? await api.post(path, { name, config_src: 'cloudflare' });
  if (!tunnelIdPattern.test(tunnel?.id ?? '')) throw new Error('Tunnel ID unavailable');
  if (!row.tunnel_id) await db.prepare('UPDATE fleet_devices SET tunnel_id = ? WHERE id = ?').bind(tunnel.id, row.id).run();
  await ensureDns(api, spec.zoneId, hostname, tunnel.id + '.cfargotunnel.com', spec.label);
  const config = { ingress: tunnelRules(hostname, profiles) };
  await api.put(`${path}/${tunnel.id}/configurations`, { config });
  return tunnel.id;
}

async function ensureMcpServer(api, account, spec, route) {
  const path = account + '/access/ai-controls/mcp/servers';
  const existing = await api.getOptional(path + '/' + route.id);
  if (existing && (existing.name !== route.id || existing.hostname !== route.url || existing.auth_type !== 'bearer')) {
    throw new DeviceError('MCP server ownership changed', 409);
  }
  if (!existing) {
    await api.post(path, { id: route.id, name: route.id, hostname: route.url, auth_type: 'bearer', auth_credentials: route.token });
  }
  const app = {
    name: route.id, type: 'mcp', destinations: [{ type: 'via_mcp_server_portal', mcp_server_id: route.id }],
  };
  if (spec.zoneScopedAccess || spec.accountScopedAccess) {
    await ensureScopedAccessApp(api, spec, app, { managed: true, accountScoped: spec.accountScopedAccess });
  } else await ensureAccessApp(api, account, app, spec.policyId, { attachNewManagedApp: true });
  const synced = await api.post(path + '/' + route.id + '/sync');
  if (synced?.status !== 'ready') throw Object.assign(
    new DeviceError('Cloudflare has not synced the MCP tool catalog yet. Retry device activation.', 409),
    { activationCode: 'tool_catalog_pending' },
  );
}

function overrides(items) {
  return items?.flatMap(item => item.portal_alias !== undefined || item.portal_description !== undefined || item.portal_enabled !== undefined
    ? [{ name: item.name, alias: item.portal_alias, description: item.portal_description, enabled: item.portal_enabled }] : []);
}

async function updatePortal(api, account, spec, { add = [], remove = [] }) {
  const path = account + '/access/ai-controls/mcp/portals/' + spec.portalId;
  const portal = await api.get(path);
  if (portal.hostname !== spec.portalHostname || portal.name !== spec.label) throw new DeviceError('Portal ownership changed', 409);
  const previous = (portal.servers ?? []).map(row => ({
    server_id: row.server_id ?? row.id, on_behalf: row.on_behalf, default_disabled: row.default_disabled,
    updated_tools: overrides(row.updated_tools), updated_prompts: overrides(row.updated_prompts),
  }));
  const ids = new Set(previous.map(row => row.server_id));
  const next = previous.filter(row => !remove.includes(row.server_id));
  for (const server_id of add) if (!ids.has(server_id)) next.push({ server_id, on_behalf: false });
  if (JSON.stringify(next) !== JSON.stringify(previous)) await api.put(path, { servers: next });
}

function constantTimeEqual(actual, expected) {
  if (actual.length !== expected.length) return false;
  let different = 0;
  for (let index = 0; index < actual.length; index++) different |= actual.charCodeAt(index) ^ expected.charCodeAt(index);
  return different === 0;
}

async function sameToken(actual, expected) {
  if (typeof actual !== 'string' || !tokenPattern.test(actual)) return false;
  return constantTimeEqual(await activationDigest(actual), await activationDigest(expected));
}

function probeError(message, reason, httpStatus) {
  const activationCode = ['connection_failed', 'http_error'].includes(reason) ? 'route_unavailable' : 'unexpected_mcp';
  return Object.assign(new DeviceError(message, 409), { reason, httpStatus, activationCode });
}

async function probeJson(response) {
  try { return await response.json(); }
  catch { throw probeError('The device returned an invalid MCP response', 'invalid_response'); }
}

async function verifyRoute(route, request) {
  const headers = {
    Authorization: `Bearer ${route.token}`, 'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  const dispatch = async (method, params, id) => {
    let response;
    try {
      response = await request(route.url, {
        method: 'POST', headers, redirect: 'manual', signal: AbortSignal.timeout(7000),
        body: JSON.stringify({ jsonrpc: '2.0', method, params, id }),
      });
    } catch {
      throw probeError('The device authenticated MCP route is still unavailable. Retry activation.', 'connection_failed');
    }
    if (!response.ok) throw probeError('The device authenticated MCP route is still unavailable. Retry activation.', 'http_error', response.status);
    return response;
  };
  const initialized = await dispatch('initialize', {
    protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'devspace-fleet-manager', version: '1.0.0' },
  }, 1);
  const result = (await probeJson(initialized))?.result;
  if (result?.protocolVersion !== '2025-11-25') throw probeError('The device did not negotiate the expected MCP protocol', 'protocol_mismatch');
  headers['MCP-Protocol-Version'] = result.protocolVersion;
  await dispatch('notifications/initialized');
  const listing = await dispatch('tools/list', {}, 2);
  const catalog = (await probeJson(listing))?.result;
  const names = Array.isArray(catalog?.tools) ? catalog.tools.map(tool => tool?.name) : [];
  if (!route.tools.every(name => names.includes(name))) {
    throw probeError('The device did not expose its expected tool catalog', 'catalog_mismatch');
  }
  if (route.kind === 'browser') {
    const allowed = [...route.tools, ...route.optional];
    if (catalog.nextCursor !== undefined || new Set(names).size !== names.length ||
        names.some(name => !allowed.includes(name))) {
      throw probeError('The browser endpoint did not expose a single browser-only tool catalog', 'catalog_mismatch');
    }
  }
}

export function createDevices(env, request = fetch) {
  const spec = JSON.parse(env.FLEET_SPEC);
  const releases = JSON.parse(env.RELEASE_CATALOG);
  const installers = { ...releases, ...hostedInstallers(releases) };
  const account = '/accounts/' + spec.accountId;
  const db = env.TICKETS;
  const token = env.PROVISIONER_OAUTH ? async () => {
    const access = await workerOAuthAccess(env.PROVISIONER_OAUTH);
    if (!access) throw new DeviceError('Nodrelay Cloudflare authorization is unavailable. Reconnect it before retrying.', 503);
    return access;
  } : env.PROVISIONER_TOKEN;
  const wrap = (row, action) => protect(env.TICKET_KEY, row.unique_name, action);
  const unwrap = row => unprotect(env.TICKET_KEY, row.unique_name, row.credentials);
  const authorized = async (row, token) => {
    if (!row || !row.credentials || typeof token !== 'string' || !tokenPattern.test(token)) return;
    const stored = await unwrap(row);
    if (row.status === 'disabled') {
      if (stored.revocation) {
        return constantTimeEqual(await activationDigest(token), stored.activationHash) ? stored : undefined;
      }
      if (await sameToken(token, stored.activationToken)) {
        return { revocation: await revokeResponse(spec.origin, row.id, token) };
      }
      return;
    }
    if (await sameToken(token, stored.activationToken)) return stored;
  };
  const deviceRoutes = (row, tokens) => {
    const { profile } = identity(spec, row);
    return [profile('development', tokens.portalToken, tokens.ports?.development),
      ...(tokens.browserToken ? [profile('browser', tokens.browserToken, tokens.ports?.browser)] : [])];
  };
  const run = action => deviceLease(db, (options, guard) =>
    action(cloudflareApi(token, options), guard), request);
  const callbackLabels = async state => {
    const { results } = await db.prepare('SELECT redirect_uri, client_name FROM portal_callback_labels ORDER BY client_name, redirect_uri').all();
    return {
      ...state,
      clients: results.filter(row => state.allowedUris.includes(row.redirect_uri))
        .map(row => ({ redirectUri: row.redirect_uri, clientName: row.client_name })),
    };
  };

  return {
    releases,
    async clientCallbacks() {
      return callbackLabels(await readPortalCallbacks(cloudflareApi(token, { request }), spec));
    },
    async registerClientCallback(name, uri) {
      const clientName = typeof name === 'string' ? name.trim() : '';
      if (!clientName || clientName.length > 64 || /[\x00-\x1f\x7f]/.test(clientName)) {
        throw new PortalCallbackError('客户端名称应为 1 至 64 个可见字符。', 400);
      }
      return run(async api => {
        const state = await addPortalCallback(api, spec, uri);
        await db.prepare(`INSERT INTO portal_callback_labels (redirect_uri, client_name)
          VALUES (?, ?) ON CONFLICT (redirect_uri) DO NOTHING`).bind(uri, clientName).run();
        return callbackLabels(state);
      });
    },
    async list() {
      const labeled = await db.prepare(deviceLabelsTable).first();
      return (await db.prepare(`SELECT id, platform, ${registrationStatus} AS status, updated_at
        ${labeled ? ', display_name AS displayName' : ''} FROM fleet_devices
        ${labeled ? 'LEFT JOIN fleet_device_labels ON device_id = id' : ''} ORDER BY id`).all()).results;
    },
    async reserveNamed(input) {
      const name = deviceDisplayName(input);
      return deviceLease(db, async (_options, guard) => {
        let id;
        for (let attempt = 0; attempt < 4; attempt++) {
          const candidate = randomDeviceId();
          if (await readDevice(db, candidate) || await reservedIntent(db, candidate) || await liveTicket(db, candidate)) continue;
          id = candidate;
          break;
        }
        if (!id) throw new DeviceError('暂时无法分配设备 ID，请重试。', 503);
        await guard();
        // Existing web upgrades keep their D1 schema. Add labels only on the
        // owner's first named-device write; old rows and older Workers still work.
        if (!await db.prepare(deviceLabelsTable).first()) await db.prepare(createDeviceLabels).run();
        await guard();
        // Both rows commit together. A conflicting ID must not rename an existing device.
        await db.batch([
          db.prepare(`INSERT INTO fleet_devices (id, platform, status, unique_name, updated_at)
            VALUES (?, '', 'pending', ?, ?)`).bind(id, uniqueName(id), now()),
          db.prepare('INSERT INTO fleet_device_labels (device_id, display_name) VALUES (?, ?)').bind(id, name),
        ]);
        return { deviceId: id, draftSaved: true };
      });
    },
    async reserve(id) {
      validId(id);
      return deviceLease(db, async (_options, guard) => {
        const conflict = () => new DeviceError('这个设备 ID 已存在或已有接入命令。', 409);
        if (await db.prepare('SELECT 1 FROM fleet_devices WHERE id = ?').bind(id).first() ||
            await reservedIntent(db, id) || await liveTicket(db, id)) throw conflict();
        await guard();
        const row = await db.prepare(`INSERT INTO fleet_devices (id, platform, status, unique_name, updated_at)
          VALUES (?, '', 'pending', ?, ?) ON CONFLICT DO NOTHING RETURNING id`).bind(id, uniqueName(id), now()).first();
        if (!row) throw conflict();
        return { deviceId: row.id, draftSaved: true };
      });
    },
    async launch(id, platform, { confirmBrowser = false } = {}) {
      validId(id);
      if (!Object.hasOwn(installers, platform)) throw new DeviceError('No verified installer is configured for this platform');
      return run(async (api, guard) => {
        if (await reservedIntent(db, id)) throw new DeviceError('This device ID is reserved by a durable enrollment intent.', 409);
        let row = await readDevice(db, id);
        if (row && !row.draft && (row.platform !== platform || row.status !== 'pending')) {
          throw new DeviceError('This device already exists or is disabled. Choose a new device ID.', 409);
        }
        if (await liveTicket(db, id)) throw new DeviceError('This device already has an unclaimed ticket. Cancel it or wait for expiration.', 409);
        let credentials = row && !row.draft && await unwrap(row);
        const asset = credentials?.asset ?? installers[platform];
        if (asset.assets && JSON.stringify(asset) !== JSON.stringify(installers[platform])) {
          throw new DeviceError('The device is pinned to a previous hosted release. Choose a new device ID.', 409);
        }
        if (Boolean(asset.browser) !== confirmBrowser) {
          throw new DeviceError(asset.browser ? '请确认在此设备上启用浏览器工具。' : '此安装包未提供浏览器工具。', 400);
        }
        if (!row || row.draft) {
          credentials = { asset, portalToken: randomToken(), activationToken: randomToken(),
            ...(asset.browser && { browserToken: randomToken() }) };
          const unique = row?.unique_name ?? uniqueName(id);
          const encrypted = await wrap({ unique_name: unique }, credentials);
          await guard();
          row = row ? await bindDraft(db, row, platform, encrypted) : await db.prepare(`INSERT INTO fleet_devices
            (id, platform, status, unique_name, credentials, updated_at) VALUES (?, ?, 'pending', ?, ?, ?)
            ON CONFLICT DO NOTHING RETURNING *`).bind(id, platform, unique, encrypted, now()).first();
          if (!row) throw new DeviceError('Device state changed. Refresh the management page before retrying.', 409);
        }
        if (Boolean(asset.browser) !== Boolean(credentials.browserToken)) {
          throw new DeviceError('The pending device browser capability differs from its original release. Cancel it or use a new device ID.', 409);
        }
        const tunnel = await ensureTunnel(api, account, spec, db, row, deviceRoutes(row, credentials));
        const tunnelToken = await api.get(`${account}/cfd_tunnel/${tunnel}/token`);
        const issued = await issueTicket(db, env.TICKET_KEY, { deviceId: id, tunnelToken, ...credentials });
        if (!issued) throw new DeviceError('This device already has an unclaimed ticket. Cancel it or wait for expiration.', 409);
        return { ...issued, asset };
      });
    },
    async claimHostedEnrollment(input) {
      const id = input?.deviceId;
      validId(id);
      if (typeof input.platform !== 'string' || !Object.hasOwn(operatingSystems, input.platform)) {
        throw new DeviceError('Hosted enrollment requires a supported operating system');
      }
      const reject = () => new DeviceError('Hosted enrollment rejected', 404);
      let ports;
      if (input.ports !== undefined) {
        try { ports = validateDevicePorts(input.ports, input.browser === true); }
        catch { throw new DeviceError('Hosted enrollment requires valid local device ports'); }
      }
      return run(async (api, guard) => {
        const reservation = await reservedIntent(db, id);
        if (!reservation) throw reject();
        let row = await readDevice(db, id);
        let stored = row?.credentials && await unwrap(row);
        if (row && !row.draft && (row.status !== 'pending' || row.platform !== input.platform || stored?.claimIntentId !== reservation.id)) throw reject();
        if (await liveTicket(db, id)) throw reject();
        const intent = await getEnrollmentIntent(db, reservation.id);
        const choice = intent?.releases[input.platform];
        if (choice?.platform !== input.platform || !Object.values(choice.assets).every(asset => asset.url)) throw reject();
        await guard();
        const claim = await claimEnrollmentIntent(db, input);
        if (!claim || claim.id !== reservation.id) throw reject();
        if (!row || row.draft) {
          const unique = row?.unique_name ?? uniqueName(id);
          stored = { claimIntentId: claim.id, claimedArchitecture: claim.architecture, asset: claim.release,
            portalToken: randomToken(), activationToken: randomToken(), ...(claim.release.browser && { browserToken: randomToken() }),
            ...(ports && { ports }) };
          const encrypted = await wrap({ unique_name: unique }, stored);
          await guard();
          row = row ? await bindDraft(db, row, input.platform, encrypted) : await db.prepare(`INSERT INTO fleet_devices (id, platform, status, unique_name, credentials, updated_at)
            VALUES (?, ?, 'pending', ?, ?, ?) ON CONFLICT DO NOTHING RETURNING *`)
            .bind(id, input.platform, unique, encrypted, now()).first();
          if (!row) throw reject();
        }
        // A resumed claim must name the same loopback ports the Tunnel was routed to.
        if (stored.claimedArchitecture !== claim.architecture || JSON.stringify(stored.asset) !== JSON.stringify(claim.release) ||
            JSON.stringify(stored.ports) !== JSON.stringify(ports)) throw reject();
        const tunnel = await ensureTunnel(api, account, spec, db, row, deviceRoutes(row, stored));
        const tunnelToken = await api.get(`${account}/cfd_tunnel/${tunnel}/token`);
        await guard();
        return validateCredentials({ deviceId: id, tunnelToken, ...stored });
      });
    },
    async activate(id, token) {
      validId(id);
      const existing = await readDevice(db, id);
      const authorization = await authorized(existing, token);
      if (!authorization) throw new DeviceError('Device activation rejected', 401);
      if (authorization.revocation) return authorization.revocation;
      if (existing.status === 'active') return { status: 'active' };
      return run(async (api, guard) => {
        const row = await readDevice(db, id);
        const tokens = await authorized(row, token);
        if (!tokens) throw new DeviceError('Device activation rejected', 401);
        if (tokens.revocation) return tokens.revocation;
        if (row.status === 'active') return { status: 'active' };
        if (!row.tunnel_id) throw Object.assign(new DeviceError('Device has no registered Tunnel', 409),
          { activationCode: 'tunnel_pending' });
        const profiles = deviceRoutes(row, tokens);
        await guard();
        const proofs = await Promise.allSettled(profiles.map(route => verifyRoute(route, request)));
        const failed = proofs.find(result => result.status === 'rejected');
        if (failed) throw failed.reason;
        for (const route of profiles) await ensureMcpServer(api, account, spec, route);
        await updatePortal(api, account, spec, { add: profiles.map(route => route.id) });
        await db.prepare("UPDATE fleet_devices SET status = 'active', updated_at = ? WHERE id = ?")
          .bind(now(), id).run();
        return { status: 'active' };
      });
    },
    async enrollmentStatus(id) {
      validId(id);
      const row = await db.prepare(`SELECT ${registrationStatus} AS status FROM fleet_devices WHERE id = ?`).bind(id).first();
      if (!row) throw new DeviceError('Unknown device', 404);
      return { registration: row.status };
    },
    async status(id) {
      const row = await readDevice(db, id);
      if (!row) throw new DeviceError('Unknown device', 404);
      if (row.draft) return { deviceId: id, registration: 'draft', tunnel: 'unregistered', mcp: 'not_enabled', checkedAt: now() };
      const api = cloudflareApi(token, { request });
      const tunnelCheck = (async () => {
        if (!row.tunnel_id) return { tunnel: 'unregistered' };
        try {
          const result = await api.get(`${account}/cfd_tunnel/${row.tunnel_id}`);
          return { tunnel: result?.status ?? 'unverified' };
        } catch (error) {
          return { tunnel: 'check_failed', tunnelDiagnostic: error instanceof CloudflareError
            ? { reason: 'http_error', httpStatus: error.status, codes: error.codes }
            : { reason: error instanceof CloudflareRequestTimeoutError ? 'timeout'
              : error instanceof DeviceError ? 'authorization' : 'check_failed' } };
        }
      })();
      const stored = row.credentials ? await unwrap(row) : null;
      const { profile } = identity(spec, row);
      const serverIds = [profile('development').id, ...(stored?.browserToken ? [profile('browser').id] : [])];
      const mcpProfiles = { development: 'unverified', browser: stored?.browserToken ? 'unverified' : 'not_enabled' };
      const mcpDiagnostics = {};
      if (row.status === 'disabled') mcpProfiles.development = mcpProfiles.browser = 'disabled';
      if (row.status === 'active' && stored) {
        const profiles = deviceRoutes(row, stored);
        const proofs = await Promise.allSettled(profiles.map(route => verifyRoute(route, request)));
        for (const [index, route] of profiles.entries()) {
          const proof = proofs[index];
          mcpProfiles[route.kind] = proof.status === 'fulfilled' ? 'catalog_verified' : 'unavailable';
          if (proof.status === 'rejected') {
            const error = proof.reason;
            mcpDiagnostics[route.kind] = { reason: error?.reason ?? 'check_failed',
              ...(Number.isInteger(error?.httpStatus) && { httpStatus: error.httpStatus }) };
          }
        }
      }
      const mcp = mcpProfiles.browser === 'unavailable' ? 'unavailable' : mcpProfiles.development;
      return {
        deviceId: id, registration: row.status, ...(await tunnelCheck), mcp, mcpProfiles,
        mcpDiagnostics, checkedAt: now(),
        ...(row.status === 'disabled'
          ? { revocation: !stored || stored.revocation ? 'complete' : 'pending' }
          : { serverIds, release: stored?.asset?.version }),
      };
    },
    async disable(id) {
      validId(id);
      return run(async (api, guard) => {
        const row = await readDevice(db, id);
        if (!row) {
          const reservation = await reservedIntent(db, id);
          if (!reservation) throw new DeviceError('Unknown device', 404);
          const intent = await getEnrollmentIntent(db, reservation.id);
          if (!intent) throw new DeviceError('Unknown device', 404);
          await guard();
          await db.prepare(`INSERT INTO fleet_devices (id, platform, status, unique_name, updated_at)
            VALUES (?, ?, 'disabled', ?, ?)`).bind(id, intent.release?.platform ?? '', uniqueName(id), now()).run();
          if (reservation.state === 'pending') await revokeEnrollmentIntent(db, reservation.id);
          return { status: 'disabled' };
        }
        if (row.draft) {
          const reservation = await reservedIntent(db, id);
          await guard();
          if (reservation?.state === 'pending') await revokeEnrollmentIntent(db, reservation.id);
          await guard();
          const disabled = await db.prepare(`UPDATE fleet_devices SET status = 'disabled', updated_at = ?
            WHERE id = ? AND unique_name = ? AND ${draftDevicePredicate} RETURNING id`).bind(now(), id, row.unique_name).first();
          if (!disabled) throw new DeviceError('Device state changed. Refresh the management page before retrying.', 409);
          return { status: 'disabled' };
        }
        const stored = row.credentials ? await unwrap(row) : null;
        if (row.status === 'disabled' && (!stored || stored.revocation)) return { status: 'disabled' };
        await db.batch([
          db.prepare("UPDATE fleet_devices SET status = 'disabled', updated_at = ? WHERE id = ?").bind(now(), id),
          ticketCancellation(db, id),
        ]);
        if (row.tunnel_id) {
          const path = `${account}/cfd_tunnel/${row.tunnel_id}`;
          const tunnel = await api.get(path);
          if (tunnel.name !== `${spec.label}-${row.unique_name}`) throw new DeviceError('Tunnel ownership changed', 409);
          await api.put(path + '/configurations', { config: { ingress: tunnelRules('', []) } });
          if (row.credentials) {
            const secret = base64url.encode(crypto.getRandomValues(new Uint8Array(32)))
              .replaceAll('-', '+').replaceAll('_', '/') + '=';
            await api.patch(path, { tunnel_secret: secret });
            await api.del(path + '/connections');
          }
        }
        await updatePortal(api, account, spec, { remove: [row.unique_name + '-d', row.unique_name + '-b'] });
        const revoked = stored && await wrap(row, {
          activationHash: await activationDigest(stored.activationToken),
          revocation: await revokeResponse(spec.origin, id, stored.activationToken),
        });
        await db.prepare('UPDATE fleet_devices SET credentials = ? WHERE id = ?').bind(revoked, id).run();
        return { status: 'disabled' };
      });
    },
  };
}

import { protect, tokenPattern, unprotect } from './tickets.mjs';
import { cloudflareApi } from './cloudflare.mjs';
import { managementBootstrapOAuthScopes, managementIdentityOAuthScopes, managementOAuthScopes, oauthTokenValue, runtimeGrant, usableStoredGrant } from './oauth-grant.mjs';

const tokenEndpoint = 'https://dash.cloudflare.com/oauth2/token';
const credentialRoute = 'https://fleet-oauth.internal/access-token';
const recordKey = 'credential';
const credentialLabel = 'fleet-runtime-oauth';
const reconnectBinding = 'FLEET_OAUTH_RECONNECT';
const now = () => Math.floor(Date.now() / 1000);

export class OAuthProvisioner {
  constructor(state, env, request = fetch) {
    this.storage = state.storage;
    this.env = env;
    this.request = request;
  }

  async fetch(request) {
    if (request.url !== credentialRoute || request.method !== 'POST') return new Response(null, { status: 404 });
    try {
      this.inFlight ??= this.access().finally(() => { this.inFlight = undefined; });
      const access = await this.inFlight;
      return Response.json({ access }, { headers: { 'Cache-Control': 'no-store' } });
    } catch {
      return Response.json({ error: 'runtime_authorization_unavailable' }, { status: 503 });
    }
  }

  async access() {
    const { FLEET_OAUTH_KEY: key, FLEET_OAUTH_SEED: seed, FLEET_OAUTH_CLIENT_ID: clientId } = this.env;
    if (!tokenPattern.test(key ?? '') || !/^[A-Za-z0-9_-]{8,128}$/.test(clientId ?? '')) {
      throw new Error('The Nodrelay OAuth binding is incomplete.');
    }
    let record = await this.storage.get(recordKey);
    const combined = this.env.FLEET_OAUTH_MODE === 'managed';
    let generation = record?.generation;
    let applied = record?.applied ?? (generation ? [generation] : []);
    let consumedReconnect = false;
    const reconnect = combined && this.env[reconnectBinding];
    if (reconnect) {
      const next = JSON.parse(reconnect);
      if (!/^[a-f0-9]{32}$/.test(next?.generation ?? '') || next.clientId !== clientId ||
          !usableStoredGrant(next.grant)) throw new Error('The Nodrelay OAuth reconnect grant is invalid.');
      if (!applied.includes(next.generation)) {
        if (next.grant.expiresAt <= now() + 45) throw new Error('The Nodrelay OAuth reconnect grant expired.');
        generation = next.generation;
        applied = [...applied, generation];
        record = { generation, applied, sealed: await protect(key, credentialLabel, next.grant) };
        await this.storage.put(recordKey, record);
      }
      consumedReconnect = next.generation === generation;
    }
    if (!record && seed) {
      const initial = JSON.parse(seed);
      if (!usableStoredGrant(initial)) throw new Error('The Nodrelay OAuth seed is invalid.');
      record = await protect(key, credentialLabel, initial);
      await this.storage.put(recordKey, record);
    }
    const sealed = typeof record === 'string' ? record : record?.sealed;
    if (typeof sealed !== 'string') throw new Error('The Nodrelay OAuth grant must be reconnected.');
    const credential = await unprotect(key, credentialLabel, sealed);
    if (credential.expiresAt > now() + 45) {
      await this.clearSeed(credential.access, 'FLEET_OAUTH_SEED');
      if (consumedReconnect) await this.clearSeed(credential.access, reconnectBinding);
      return credential.access;
    }

    // Keep the reconnect generation in the journal so an ambiguous refresh
    // cannot fall back to the same grant while its bootstrap binding exists.
    await this.storage.put(recordKey, generation ? { state: 'refresh_started', generation, applied } : { state: 'refresh_started' });
    const { request } = this;
    const response = await request(tokenEndpoint, {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(10000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId, refresh_token: credential.refresh }),
    });
    if (!response.ok) throw new Error('Cloudflare did not renew the Fleet grant.');
    const managementScopes = this.env.FLEET_OAUTH_ZERO_TRUST_BOOTSTRAP === '1' ? managementBootstrapOAuthScopes : this.env.FLEET_OAUTH_USER_DETAILS === '1' ? managementIdentityOAuthScopes : managementOAuthScopes;
    const renewed = runtimeGrant(await response.json(), credential, combined ? managementScopes : undefined);
    const next = await protect(key, credentialLabel, renewed);
    await this.storage.put(recordKey, generation ? { generation, applied, sealed: next } : next);
    await this.clearSeed(renewed.access, 'FLEET_OAUTH_SEED');
    if (consumedReconnect) await this.clearSeed(renewed.access, reconnectBinding);
    return renewed.access;
  }

  async clearSeed(access, binding) {
    this.clearedSeeds ??= new Set();
    if (!this.env[binding] || this.env.FLEET_OAUTH_MODE !== 'managed' || this.clearedSeeds.has(binding)) return;
    const { accountId, worker, label } = JSON.parse(this.env.FLEET_SPEC);
    if (!/^[a-f0-9]{32}$/.test(accountId ?? '') || worker !== label || !/^fleet-[a-z0-9]+-[a-f0-9]{12}$/.test(worker ?? '')) {
      throw new Error('The OAuth seed does not belong to this management Worker.');
    }
    const path = `/accounts/${accountId}/workers/scripts/${worker}/secrets/${binding}`;
    try {
      await cloudflareApi(access, { request: this.request }).del(path);
    } catch (error) {
      if (error.status !== 404) throw error;
    }
    this.clearedSeeds.add(binding);
  }
}

export async function workerOAuthAccess(namespace) {
  const broker = namespace.get(namespace.idFromName('fleet-provisioner'));
  const response = await broker.fetch(credentialRoute, { method: 'POST' });
  if (!response.ok) return;
  const { access } = await response.json();
  return typeof access === 'string' && oauthTokenValue.test(access) ? access : undefined;
}

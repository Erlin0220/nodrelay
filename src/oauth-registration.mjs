import { connectorScope, single } from '../cloud/cloudflare.mjs';
import { managementBootstrapOAuthScopes, managementBootstrapScope, managementIdentityOAuthScopes, managementIdentityScope, runtimeOAuthScopes } from '../cloud/oauth-grant.mjs';
import { loopbackCallback } from './cloudflare-oauth.mjs';

const accountPattern = /^[a-f0-9]{32}$/;

function publicUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new Error('Publisher metadata must use HTTPS URLs');
  }
  return url.href;
}

export function registrationSpec(config, scopes, { runtime = false, management = false } = {}) {
  if (runtime && management) throw new Error('Choose either management or runtime OAuth registration.');
  if (!accountPattern.test(config.accountId ?? '') || !/^[a-z][a-z0-9-]{2,15}$/.test(config.namespace ?? '')) {
    throw new Error('OAuth registration requires an explicit accountId and Fleet namespace');
  }
  const publisher = config.oauthPublisher;
  return {
    accountId: config.accountId,
    runtime,
    body: {
      client_name: 'Nodrelay (' + config.namespace + (runtime ? ' runtime)' : management ? ' management)' : ')'),
      grant_types: runtime || management ? ['authorization_code', 'refresh_token'] : ['authorization_code'],
      redirect_uris: [loopbackCallback(config.oauthRedirect).href],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scopes: runtime ? runtimeOAuthScopes : management ? (config.zeroTrustBootstrap === true ? managementBootstrapOAuthScopes : managementIdentityOAuthScopes).filter(scope => scope !== 'offline_access') : scopes,
      optional_scopes: runtime ? [] : management ? [managementIdentityScope, ...(config.zeroTrustBootstrap === true ? [managementBootstrapScope] : [])]
        : scopes.filter(scope => ['account-api-tokens.write', connectorScope, 'access-acct.write'].includes(scope)),
      ...(publisher && { client_uri: publicUrl(publisher.url), logo_uri: publicUrl(publisher.logo) }),
    },
  };
}

function matchesClient(client, body) {
  const refreshable = body.grant_types.includes('refresh_token');
  return Object.entries(body).every(([key, value]) => {
    let actual = client?.[key];
    if (refreshable && key === 'scopes' && Array.isArray(actual)) actual = actual.filter(scope => scope !== 'offline_access');
    if (refreshable && key === 'optional_scopes' && actual === undefined) actual = [];
    return Array.isArray(value)
      ? Array.isArray(actual) && actual.length === value.length && value.every(item => actual.includes(item))
      : actual === value;
  });
}

export async function registerOAuthClient(api, { accountId, body, runtime }, { beforeCreate } = {}) {
  const path = '/accounts/' + accountId + '/oauth_clients';
  const names = [body.client_name, body.client_name.replace(/^Nodrelay /, 'DevSpace Fleet ')];
  const existing = single(await api.list(path), row => names.includes(row.client_name), 'OAuth client');
  if (!existing) await beforeCreate?.();
  const client = existing ?? await api.post(path, body);
  const expected = existing ? { ...body, client_name: existing.client_name } : body;
  if (!matchesClient(client, expected) || !/^[A-Za-z0-9_-]{8,128}$/.test(client?.client_id ?? '') ||
      (!['private', 'public'].includes(client.visibility)) || (runtime && client.visibility !== 'private') ||
      (client.visibility === 'public' && (!body.client_uri || client.client_uri_verification?.status !== 'verified'))) {
    throw new Error('OAuth client settings or publisher verification differ. Review the client in Cloudflare before continuing.');
  }
  return { oauthClientId: client.client_id, oauthRedirect: body.redirect_uris[0], visibility: client.visibility };
}

export async function verifyPublicManagementClient(api, config, clientId) {
  const { accountId, body } = registrationSpec(config, [], { management: true });
  // The published client was given an explicit product name in Cloudflare.
  // Require an exact reviewed name when requested, without altering new registration.
  if (config.oauthPublisher?.clientName !== undefined) {
    if (config.oauthPublisher.clientName !== 'Nodrelay') throw new Error('Unknown existing management OAuth client name');
    body.client_name = config.oauthPublisher.clientName;
  }
  if (!body.client_uri || !body.logo_uri || !/^[A-Za-z0-9_-]{8,128}$/.test(clientId ?? '')) {
    throw new Error('Public management OAuth verification requires a client ID and the publisher URL and logo.');
  }
  const client = await api.get('/accounts/' + accountId + '/oauth_clients/' + clientId);
  if (client?.client_id !== clientId || client.visibility !== 'public' ||
      client.client_uri_verification?.status !== 'verified' || !matchesClient(client, body)) {
    throw new Error(`The Cloudflare client is not verified for public Nodrelay management with the expected scopes (${managementIdentityScope} must be optional) and callback.`);
  }
  return { oauthClientId: clientId, oauthRedirect: body.redirect_uris[0], visibility: client.visibility };
}

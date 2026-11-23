export const runtimeOAuthScopes = ['mcp-portals.write', 'zone-access.write', 'teams-connector-cloudflared.write', 'dns.write'];
export const managementOAuthScopes = [
  'mcp-portals.write', 'access.write', 'teams-connector-cloudflared.write', 'dns.write',
  'workers-scripts.write', 'd1.write', 'zone.read', 'access-acct.read', 'offline_access',
];
export const managementIdentityScope = 'user-details.read';
export const managementIdentityOAuthScopes = [...managementOAuthScopes, managementIdentityScope];
export const managementBootstrapScope = 'access-acct.write';
export const managementBootstrapOAuthScopes = [...managementIdentityOAuthScopes, managementBootstrapScope];
export const oauthTokenValue = /^[!-~]{20,8192}$/;

export function runtimeGrant(token, previous, expected = runtimeOAuthScopes, optional = []) {
  const { access_token: access, refresh_token: refresh, expires_in: duration, scope, token_type: type } = token ?? {};
  const scopes = typeof scope === 'string' ? scope.trim().split(/\s+/) : undefined;
  if (scope !== undefined || !previous) {
    if (!scopes || !expected.every(value => scopes.includes(value)) ||
        scopes.some(value => value !== 'offline_access' && !expected.includes(value) && !optional.includes(value))) {
      throw new Error('Cloudflare issued a different grant than the Fleet runtime permissions.');
    }
  }
  if (typeof type !== 'string' || type.toLowerCase() !== 'bearer' ||
      !Number.isSafeInteger(duration) || duration < 60 || duration > 86400 ||
      typeof access !== 'string' || !oauthTokenValue.test(access) ||
      typeof refresh !== 'string' || !oauthTokenValue.test(refresh) || refresh === previous?.refresh) {
    throw new Error('Cloudflare did not issue a usable bearer and rotating refresh credential.');
  }
  return { access, refresh, expiresAt: Math.floor(Date.now() / 1000) + duration };
}

// The signed release allows requesting bootstrap, but only the OAuth response
// establishes whether the user granted it. All other requested scopes stay mandatory.
export function managementGrant(token, requested) {
  const mayBootstrap = requested.includes(managementBootstrapScope);
  const required = requested.filter(scope => scope !== managementBootstrapScope);
  const grant = runtimeGrant(token, undefined, required, mayBootstrap ? [managementBootstrapScope] : []);
  if (mayBootstrap && token.scope.trim().split(/\s+/).includes(managementBootstrapScope)) {
    grant.zeroTrustBootstrap = true;
  }
  return grant;
}

export function usableStoredGrant(grant) {
  return Number.isSafeInteger(grant?.expiresAt) && typeof grant.access === 'string' &&
    oauthTokenValue.test(grant.access) && typeof grant.refresh === 'string' && oauthTokenValue.test(grant.refresh);
}

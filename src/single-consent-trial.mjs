import { oauthTokenValue, runtimeOAuthScopes } from '../cloud/oauth-grant.mjs';
import { applySetup } from './setup-core.mjs';

const tokenEndpoint = 'https://dash.cloudflare.com/oauth2/token';

export async function deploySingleConsentTrial(api, spec, configuration, {
  clientId, refreshToken, existingAccessIssuer, keepLatestRefreshToken, verifyRuntimeAccess, request = fetch,
}) {
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(clientId ?? '') || typeof refreshToken !== 'string' ||
      !oauthTokenValue.test(refreshToken) || typeof keepLatestRefreshToken !== 'function') {
    throw new Error('A verified OAuth grant with a local revocation handler is required for the trial');
  }
  const response = await request(tokenEndpoint, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId, grant_type: 'refresh_token', refresh_token: refreshToken,
      scope: runtimeOAuthScopes.join(' '),
    }),
  });
  if (!response.ok) throw new Error('Cloudflare did not issue a scoped trial credential');
  const data = await response.json();
  if (typeof data.refresh_token === 'string' && oauthTokenValue.test(data.refresh_token)) {
    await keepLatestRefreshToken(data.refresh_token);
  }
  const hasScope = Object.hasOwn(data, 'scope');
  const scopes = typeof data.scope === 'string' ? data.scope.trim().split(/\s+/) : [];
  const matchesRuntime = runtimeOAuthScopes.every(scope => scopes.includes(scope)) &&
    scopes.every(scope => scope === 'offline_access' || runtimeOAuthScopes.includes(scope));
  // RFC 6749 permits omitting scope when it matches the request. Verify that
  // behavior with Cloudflare's account-specific API checks before any write.
  if ((!matchesRuntime && hasScope) || (!hasScope && typeof verifyRuntimeAccess !== 'function')) {
    throw new Error('Cloudflare did not confirm exactly the device provisioning scopes');
  }
  if (typeof data.token_type !== 'string' || data.token_type.toLowerCase() !== 'bearer' || typeof data.access_token !== 'string' ||
      !oauthTokenValue.test(data.access_token) || !Number.isSafeInteger(data.expires_in) ||
      data.expires_in < 300 || data.expires_in > 3600) {
    throw new Error('Cloudflare did not issue a usable short-lived access token');
  }
  const expiresAt = Date.now() + data.expires_in * 1000;
  if (verifyRuntimeAccess && !await verifyRuntimeAccess(data.access_token)) {
    throw new Error('Cloudflare API probes did not confirm the credential boundary');
  }
  return applySetup(api, spec, {
    ...configuration,
    trialAccess: {
      access: data.access_token,
      expiresAt,
      existingAccessIssuer,
    },
  });
}

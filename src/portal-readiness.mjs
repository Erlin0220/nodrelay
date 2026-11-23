// Public transport/authentication readiness only, not an authenticated MCP tool call.
export function validatePortalUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      url.pathname !== '/mcp' || url.search || url.hash) {
    throw new Error('Supply the exact HTTPS MCP Portal URL ending in /mcp.');
  }
  return url;
}

export async function portalAccessReady(portal, issuer, request = fetch, signal) {
  const url = validatePortalUrl(portal);
  try {
    const timeout = AbortSignal.timeout(5000);
    const response = await request(url.href, { redirect: 'manual', headers: { Accept: 'application/json, text/event-stream' },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    await response.body?.cancel();
    if ([302, 303].includes(response.status)) {
      const login = new URL(response.headers.get('Location'));
      return login.origin === issuer && login.pathname === '/cdn-cgi/access/login/' + url.hostname;
    }
    // OAuth-protected MCP servers may advertise resource discovery rather than
    // redirect. A bare 401/403 or an HTML/200 page is not readiness evidence.
    if (response.status !== 401) return false;
    const challenge = response.headers.get('WWW-Authenticate') ?? '';
    if (!/^Bearer\s/i.test(challenge)) return false;
    const advertised = /(?:^|[,\s])resource_metadata="([^"]+)"/.exec(challenge)?.[1];
    if (!advertised) return false;
    const metadata = new URL(advertised);
    return metadata.origin === url.origin && !metadata.username && !metadata.password &&
      !metadata.search && !metadata.hash &&
      (metadata.pathname === '/.well-known/oauth-protected-resource' ||
        metadata.pathname === '/.well-known/oauth-protected-resource/mcp');
  } catch { return false; }
}

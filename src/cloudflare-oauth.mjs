import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { managementGrant, managementIdentityScope, runtimeGrant, runtimeOAuthScopes } from '../cloud/oauth-grant.mjs';

const authEndpoint = 'https://dash.cloudflare.com/oauth2/auth';
const tokenEndpoint = 'https://dash.cloudflare.com/oauth2/token';
const invalidScopeMessage = 'Cloudflare 拒绝了所请求的 OAuth 权限。请使用公开客户端权限已经核验的安装包。';

export function openBrowser(url) {
  const opener = process.platform === 'darwin' ? ['open', url]
    : process.platform === 'win32' ? ['rundll32.exe', 'url.dll,FileProtocolHandler', url]
      : ['xdg-open', url];
  const child = spawn(opener[0], opener.slice(1), { stdio: 'ignore', detached: true, windowsHide: true });
  child.on('error', () => {});
  child.unref();
}

export function loopbackCallback(redirectUri) {
  const callback = new URL(redirectUri);
  if (callback.protocol !== 'http:' || callback.hostname !== '127.0.0.1' ||
      !callback.port || callback.pathname !== '/oauth/callback' || callback.search || callback.hash ||
      callback.username || callback.password) throw new Error('Use the exact registered loopback callback');
  return callback;
}

export async function authorize({
  clientId, redirectUri, scopes, runtime = false, refreshable = false, browse = openBrowser, request = fetch,
  timeoutMs = 240000, startThroughLoopback = false, signal, oidc,
}) {
  signal?.throwIfAborted();
  if (!clientId || !redirectUri) throw new Error('The release must supply its registered Cloudflare OAuth client');
  if (runtime) scopes = [...runtimeOAuthScopes, 'offline_access'];
  const callback = loopbackCallback(redirectUri);
  const verifier = randomBytes(48).toString('base64url');
  const state = randomBytes(32).toString('base64url');
  const localStart = new URL('/oauth/start', callback.origin);
  if (startThroughLoopback) localStart.searchParams.set('nonce', randomBytes(24).toString('base64url'));
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const authorization = new URL(oidc ? oidc.issuer + '/authorization' : authEndpoint);
  authorization.search = new URLSearchParams({
    client_id: clientId, response_type: 'code', redirect_uri: callback.href,
    scope: scopes.join(' '), state, code_challenge: challenge, code_challenge_method: 'S256',
    ...(oidc && { nonce: oidc.nonce }),
  }).toString();

  const server = createServer();
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(Number(callback.port), '127.0.0.1', resolve);
    });
    signal?.throwIfAborted();
    let timer;
    let onAbort;
    const code = await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Cloudflare authorization expired')), timeoutMs);
      onAbort = () => reject(signal.reason);
      signal?.addEventListener('abort', onAbort, { once: true });
      server.on('request', (req, res) => {
        const query = new URL(req.url, callback.origin);
        const local = req.method === 'GET' && req.headers.host === callback.host && query.origin === callback.origin;
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        if (startThroughLoopback && local && query.href === localStart.href) {
          res.statusCode = 302;
          res.setHeader('Location', authorization.href);
          return res.end();
        }
        const valid = local && query.pathname === callback.pathname && query.searchParams.get('state') === state;
        if (!valid) { res.statusCode = 404; return res.end('Request rejected'); }
        const value = query.searchParams.get('code');
        if (!value || query.searchParams.has('error')) {
          res.statusCode = 400;
          const reason = query.searchParams.get('error');
          const methodRejected = query.searchParams.get('error_description')?.includes('code_challenge_method is not supported');
          if (reason === 'invalid_request' && methodRejected) {
            res.end('Cloudflare rejected the PKCE method. Return to Nodrelay.');
            return reject(new Error('Cloudflare rejected the PKCE code challenge method (invalid_request)'));
          }
          res.end('Authorization did not complete. Return to Nodrelay.');
          if (reason === 'invalid_scope') return reject(new Error(invalidScopeMessage));
          return reject(new Error(reason === 'access_denied' ? 'Cloudflare authorization declined' : 'Cloudflare authorization did not complete'));
        }
        res.end('Cloudflare authorization received. Return to Nodrelay for setup progress.', () => resolve(value));
      });
      browse(startThroughLoopback ? localStart.href : authorization.href);
    }).finally(() => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    });

    signal?.throwIfAborted();
    const timeout = AbortSignal.timeout(15000);
    const response = await request(oidc ? oidc.issuer + '/token' : tokenEndpoint, {
      method: 'POST', redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', client_id: clientId, redirect_uri: callback.href,
        code, code_verifier: verifier,
      }),
    });
    const token = await response.json().catch(() => undefined);
    if (oidc) {
      if (!response.ok || typeof token?.id_token !== 'string' || token.id_token.length > 16384) {
        throw new Error('Cloudflare Access 未返回可验证的登录凭证。请核对登录方式后重试。');
      }
      return token.id_token;
    }
    if (!response.ok && token?.error === 'invalid_scope') throw new Error(invalidScopeMessage);
    if (!response.ok || typeof token?.access_token !== 'string') throw new Error('Cloudflare token exchange failed');
    if (runtime) return runtimeGrant(token);
    if (refreshable) {
      if (scopes.includes(managementIdentityScope) &&
          !(typeof token.scope === 'string' && token.scope.split(/\s+/).includes(managementIdentityScope))) {
        throw new Error('Cloudflare 未授予用户资料只读权限。请重新运行安装命令，并在授权页面保留「User Details Read」。');
      }
      return managementGrant(token, scopes);
    }
    if (typeof token.scope === 'string') {
      const granted = token.scope.split(/\s+/);
      if (!scopes.every(scope => granted.includes(scope))) throw new Error('Cloudflare did not grant all setup permissions');
    }
    return token.access_token;
  } finally {
    server.close();
    server.closeAllConnections();
  }
}

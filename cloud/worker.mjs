import { enrollPath, activatePath, hostedInstallers, installPath, operatingSystems } from './device-paths.mjs';
import { bootstrapInstaller } from './install-command.mjs';
import { resolveEnrollmentBootstrap } from './enrollment-bootstrap.mjs';
import { enrollmentContext, enrollmentIsEnabled } from './enrollment-v1.mjs';
import { createDevices, DeviceError } from './devices.mjs';
import { manage } from './management.mjs';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { cancelTicket, issueTicket, redeemTicket, validateCredentials, devicePattern } from './tickets.mjs';
export { OAuthProvisioner } from './oauth-provisioning.mjs';

function contentSecurityPolicy(nonce) {
  const inline = nonce ? ` 'nonce-${nonce}'` : '';
  const imageData = nonce ? ' data:' : '';
  return `default-src 'none'; script-src 'self'${inline}; style-src 'self'${inline}; img-src 'self'${imageData}; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`;
}

const responseHeaders = {
  'Cache-Control': 'no-store',
  // Browser form POSTs need a same-origin Origin header for CSRF protection.
  'Referrer-Policy': 'same-origin',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': contentSecurityPolicy(),
};
const json = (value, status = 200) => Response.json(value, { status, headers: responseHeaders });
const issuers = new Map();

async function accessAdmin(request, env) {
  if (!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(env.ACCESS_ISSUER ?? '') ||
      !env.ACCESS_AUD || !env.OWNER_EMAIL) return false;
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) return false;
  const issuer = env.ACCESS_ISSUER;
  if (!issuers.has(issuer)) {
    issuers.set(issuer, createRemoteJWKSet(new URL('/cdn-cgi/access/certs', issuer), { timeoutDuration: 4000 }));
  }
  try {
    const { payload } = await jwtVerify(token, issuers.get(issuer), {
      issuer, audience: env.ACCESS_AUD, algorithms: ['RS256'], requiredClaims: ['exp', 'sub', 'email'],
    });
    // Access and the setup receipt may differ only in letter case.
    return typeof payload.email === 'string' && payload.email.toLowerCase() === env.OWNER_EMAIL.toLowerCase();
  } catch {
    return false;
  }
}

async function limitedBody(request) {
  if (!request.body) throw new Error('Expected request body');
  const reader = request.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let value = '', bytes = 0;
  try {
    while (true) {
      const { done, value: chunk } = await reader.read();
      if (done) return value + decoder.decode();
      bytes += chunk.length;
      if (bytes > 10000) throw new Error('Request body too large');
      value += decoder.decode(chunk, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

const page = `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<meta name="viewport" content="width=device-width"><title>诺联 Nodrelay 设备接入</title>
<main><h1>诺联 Nodrelay 设备接入</h1>
<p>使用已为此设备创建的 Tunnel 与 Portal 源站凭据生成十分钟安装票据。</p>
<form method="post" action="/admin/tickets" autocomplete="off">
<p><label>设备 ID <input name="deviceId" required pattern="[a-z][a-z0-9\\-]{0,23}"></label></p>
<p><label>Tunnel 令牌 <input name="tunnelToken" required type="password" maxlength="4096"></label></p>
<p><label>Portal 源站令牌 <input name="portalToken" required type="password" minlength="43" maxlength="43"></label></p>
<button>生成票据</button></form>
<h2>取消未使用的票据</h2>
<form method="post" action="/admin/cancel">
<label>设备 ID <input name="deviceId" required pattern="[a-z][a-z0-9\\-]{0,23}"></label>
<button>取消票据</button></form></main></html>`;
const assetResponse = (contentType, body, status = 200, headers) => new Response(body, {
  status, headers: { ...responseHeaders, 'Content-Type': typeof body === 'string' ? contentType + '; charset=utf-8' : contentType, ...headers },
});
const html = (body, status, nonce) => assetResponse('text/html', body, status,
  nonce ? { 'Content-Security-Policy': contentSecurityPolicy(nonce) } : undefined);

export function createWorker({ verifyAdmin = accessAdmin, deviceProvider, upgradeProvider } = {}) {
  return {
    async fetch(request, env, execution) {
      const url = new URL(request.url);
      if (url.origin !== env.APP_ORIGIN || url.protocol !== 'https:') return json({ error: 'Unknown origin' }, 404);
      const { pathname } = url;
      const provisioner = Boolean(env.PROVISIONER_TOKEN) !== Boolean(env.PROVISIONER_OAUTH);
      const managed = Boolean(env.FLEET_SPEC && provisioner && env.RELEASE_CATALOG);
      if (env.FLEET_SPEC && !managed) return json({ error: 'Managed deployment bindings missing' }, 503);
      const installPlatform = managed && Object.keys(operatingSystems).find(platform => pathname === installPath(platform));
      if (installPlatform) {
        if (request.method === 'POST') {
          // The public entry script exchanges an install code for its bound installer.
          if (!enrollmentIsEnabled(env)) return json({ error: 'Installer unavailable' }, 404);
          if (request.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
            return json({ error: 'Expected JSON' }, 415);
          }
          let input;
          try { input = JSON.parse(await limitedBody(request)); }
          catch { return json({ error: 'Invalid request' }, 400); }
          try {
            const script = await enrollmentContext(env).launch(env.APP_ORIGIN, installPlatform, input);
            return script ? assetResponse('text/plain', script)
              : json({ error: 'Install code unavailable. Copy the current command from the management console.' }, 404);
          } catch { return json({ error: 'Installer temporarily unavailable. Retry the same command.' }, 503); }
        }
        if (url.searchParams.has('manifest') || url.searchParams.has('v')) {
          if (!enrollmentIsEnabled(env)) return json({ error: 'Approved installer unavailable' }, 404);
          try {
            return await resolveEnrollmentBootstrap(request, { origin: env.APP_ORIGIN, ...enrollmentContext(env) });
          } catch { return json({ error: 'Approved installer unavailable' }, 404); }
        }
        const [version] = url.searchParams.getAll('version');
        if (request.method !== 'GET' || !version || [...url.searchParams].length !== 1) {
          return json({ error: 'Installer version unavailable. Generate a new connection command.' }, 404);
        }
        try {
          const group = hostedInstallers(JSON.parse(env.RELEASE_CATALOG))[installPlatform];
          if (!group || version !== group.version) {
            return json({ error: 'Installer version unavailable. Generate a new connection command.' }, 404);
          }
          return assetResponse('text/plain', bootstrapInstaller(url.origin, installPlatform, group));
        } catch {
          // A broken deployment binding is not a missing installer version.
          // Keep the response non-executable and do not echo binding values.
          return json({ error: 'Installer catalog temporarily unavailable. Contact the management console administrator.' }, 503);
        }
      }
      const redeem = pathname === (managed ? enrollPath : '/enroll');
      const activate = managed && pathname === activatePath;
      const mediaType = request.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase();
      if (!redeem && !activate && !await verifyAdmin(request, env)) return json({ error: 'Administrator login required' }, 403);
      if (managed && !redeem) return manage(request, env, url, { limitedBody, html, json, assetResponse, provider: deviceProvider, upgradeProvider, execution });
      if (request.method === 'GET' && pathname === '/') return html(page);
      if (request.method !== 'POST') return json({ error: 'Unknown route' }, 404);
      if (!redeem && request.headers.get('Origin') !== url.origin) return json({ error: 'Invalid origin' }, 403);
      try {
        if (redeem) {
          if (mediaType !== 'application/json') return json({ error: 'Expected JSON' }, 415);
          let input;
          try { input = JSON.parse(await limitedBody(request)); }
          catch { return json({ error: 'Invalid request' }, 400); }
          if (input?.protocol === 'intent-v1') {
            if (!managed || !enrollmentIsEnabled(env)) return json({ error: 'Enrollment protocol unavailable' }, 404);
            try {
              const devices = (deviceProvider ?? createDevices)(env);
              const enrolled = await devices.claimHostedEnrollment(input);
              return enrolled ? json(enrolled) : json({ error: 'Enrollment command unavailable' }, 404);
            } catch (error) {
              return error instanceof DeviceError
                ? json({ error: 'Enrollment could not proceed' }, error.status)
                : json({ error: 'Enrollment interrupted; retry only on the same device' }, 503);
            }
          }
          const credentials = await redeemTicket(env.TICKETS, env.TICKET_KEY, input?.ticket);
          return credentials ? json(credentials) : json({ error: 'Ticket unavailable' }, 404);
        }

        if (!['/admin/tickets', '/admin/cancel'].includes(pathname)) return json({ error: 'Unknown route' }, 404);
        if (mediaType !== 'application/x-www-form-urlencoded') return json({ error: 'Expected form' }, 415);
        let input;
        try { input = Object.fromEntries(new URLSearchParams(await limitedBody(request))); }
        catch { return json({ error: 'Invalid form' }, 400); }
        if (pathname === '/admin/cancel') {
          if (!devicePattern.test(input.deviceId ?? '')) return json({ error: 'Invalid device id' }, 400);
          await cancelTicket(env.TICKETS, input.deviceId);
          return html('<!doctype html><p>待领取票据已取消。</p><p><a href="/">返回设备接入</a></p>');
        }

        let credentials;
        try { credentials = validateCredentials(input); }
        catch { return json({ error: 'Invalid device credentials' }, 400); }
        const issued = await issueTicket(env.TICKETS, env.TICKET_KEY, credentials);
        if (!issued) return json({ error: 'This device already has an unclaimed ticket' }, 409);
        const command = `npm run enroll -- ${url.origin} .fleet-${credentials.deviceId}`;
        return html(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>设备安装票据</title>
          <h1>凭据领取</h1><p>在目标设备已验证的项目目录运行下方命令，并粘贴此票据。</p>
          <pre>${command}</pre><p>票据（有效期十分钟，成功领取后立即失效）</p>
          <pre>${issued.ticket}</pre><p><a href="/">返回设备接入</a></p></html>`);
      } catch {
        return json({ error: 'Enrollment temporarily unavailable' }, 503);
      }
    },
  };
}

export default createWorker();

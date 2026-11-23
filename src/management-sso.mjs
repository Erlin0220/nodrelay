import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { single } from '../cloud/cloudflare.mjs';
import { authorize, loopbackCallback } from './cloudflare-oauth.mjs';
import { accessResourceId, isAdministratorEmail, isAccessIssuer } from './setup-core.mjs';

const proofName = /^nodrelay-login-[a-f0-9]{32}$/;
const grantType = 'authorization_code_with_pkce';
const scopes = ['openid', 'email'];
const same = (value, expected) => Array.isArray(value) && value.length === expected.length &&
  expected.every(item => value.includes(item));
const appsPath = accountId => `/accounts/${accountId}/access/apps`;

function matchesProof(app, proof) {
  return app?.name === proof.name && app.type === 'saas' && app.saas_app?.auth_type === 'oidc' &&
    same(app.saas_app.redirect_uris, [proof.redirectUri]);
}

export async function removeSsoProof(api, accountId, proof) {
  if (!proofName.test(proof?.name ?? '') || loopbackCallback(proof.redirectUri).href !== proof.redirectUri ||
      (proof.id !== undefined && !accessResourceId.test(proof.id))) throw new Error('身份验证回执格式无效。');
  const path = appsPath(accountId);
  let id = proof.id;
  if (!id) {
    const listed = single(await api.list(path), row => row.name === proof.name, 'Nodrelay login verification application');
    if (!listed) return false;
    id = listed.id;
  }
  if (!accessResourceId.test(id ?? '')) throw new Error('无法确认临时登录应用的 ID。');
  const resource = `${path}/${id}`;
  const current = await api.getOptional(resource);
  if (!current) return false;
  if (current.id !== id || !matchesProof(current, proof)) throw new Error('临时登录应用的归属有变，请在 Cloudflare 中核对。');
  await api.del(resource).catch(error => { if (error.status !== 404) throw error; });
  return true;
}

async function waitForOidc(issuer, request, signal) {
  const deadline = Date.now() + 25000;
  do {
    signal?.throwIfAborted();
    const timeout = AbortSignal.timeout(4000);
    const response = await request(issuer + '/.well-known/openid-configuration', {
      redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    }).catch(() => undefined);
    if (response?.ok) {
      const metadata = await response.json().catch(() => undefined);
      if (metadata?.issuer !== issuer || metadata.authorization_endpoint !== issuer + '/authorization' ||
          metadata.token_endpoint !== issuer + '/token' || metadata.jwks_uri !== issuer + '/jwks') {
        throw new Error('Cloudflare Access 登录元数据与临时应用不符。');
      }
      return;
    }
    await sleep(1000, undefined, { signal });
  } while (Date.now() < deadline);
  throw new Error('Cloudflare Access 登录尚未就绪。请稍后重试。');
}

export async function verifySsoIdentity(token, key, { issuer, clientId, nonce }) {
  try {
    const { payload } = await jwtVerify(token, key, {
      issuer, audience: clientId, algorithms: ['RS256'], maxTokenAge: '5m',
      requiredClaims: ['exp', 'iat', 'sub', 'email', 'nonce'],
    });
    if (payload.nonce === nonce && (payload.aud === clientId || same(payload.aud, [clientId])) &&
        (payload.azp === undefined || payload.azp === clientId) && typeof payload.sub === 'string' && payload.sub &&
        typeof payload.email === 'string' && isAdministratorEmail(payload.email) &&
        (payload.email_verified === undefined || payload.email_verified === true)) return payload.email;
  } catch {
    // Do not print token or claim values from a failed login.
  }
  throw new Error('无法验证此次 Cloudflare Access 登录的邮箱。管理台尚未部署。');
}

export async function proveManagementSso(api, { accountId, issuer, providerId, redirectUri, save, signal,
  request = fetch, browserLogin = authorize, getKey = url => createRemoteJWKSet(url, { timeoutDuration: 4000 }) }) {
  redirectUri = loopbackCallback(redirectUri).href;
  if (!/^[a-f0-9]{32}$/.test(accountId) || !isAccessIssuer(issuer) || !accessResourceId.test(providerId ?? '')) {
    throw new Error('Cloudflare Access 组织或登录方式无效。');
  }
  const proof = { name: 'nodrelay-login-' + randomBytes(16).toString('hex'), redirectUri };
  const path = appsPath(accountId);
  const loginRule = { name: 'Nodrelay identity verification', decision: 'allow',
    include: [{ login_method: { id: providerId } }], exclude: [], require: [], precedence: 1 };
  let createStarted = false;
  let createRejected = false;
  await save(proof);
  try {
    signal?.throwIfAborted();
    createStarted = true;
    const created = await api.post(path, {
      name: proof.name, type: 'saas', app_launcher_visible: false, allowed_idps: [providerId], auto_redirect_to_identity: true,
      saas_app: { auth_type: 'oidc', grant_types: [grantType], scopes, redirect_uris: [redirectUri],
        allow_pkce_without_client_secret: true, access_token_lifetime: '5m' },
    }).catch(error => {
      createRejected = [400, 401, 403, 404, 422].includes(error.status);
      if (error.status === 400 || error.status === 422) {
        throw new Error('Cloudflare 拒绝创建临时登录应用或其本机回调。请检查账户的 Access SaaS/OIDC 设置。');
      }
      throw error;
    });
    if (!accessResourceId.test(created?.id ?? '')) throw new Error('Cloudflare 未返回临时登录应用的 ID。');
    proof.id = created.id;
    await save(proof);
    signal?.throwIfAborted();
    const resource = `${path}/${proof.id}`;
    const app = await api.get(resource);
    const saas = app?.saas_app;
    const clientId = saas?.client_id;
    if (app?.id !== proof.id || !matchesProof(app, proof) || app.app_launcher_visible !== false ||
        !same(app.allowed_idps, [providerId]) || !same(saas.grant_types, [grantType]) || !same(saas.scopes, scopes) ||
        saas.allow_pkce_without_client_secret !== true || !/^[A-Za-z0-9_-]{8,128}$/.test(clientId ?? '')) {
      throw new Error('临时登录应用的设置与请求不符。');
    }
    const policies = `${resource}/policies`;
    signal?.throwIfAborted();
    if ((await api.list(policies)).length) throw new Error('发现临时登录应用上的意外策略。');
    signal?.throwIfAborted();
    await api.post(policies, loginRule);
    const rules = await api.list(policies);
    const [rule] = rules;
    if (rules.length !== 1 || rule.name !== loginRule.name || rule.decision !== 'allow' || rule.exclude?.length ||
        rule.require?.length || JSON.stringify(rule.include) !== JSON.stringify(loginRule.include)) {
      throw new Error('临时登录应用的身份提供商策略与请求不符。');
    }
    const oidcIssuer = `${issuer}/cdn-cgi/access/sso/oidc/${clientId}`;
    await waitForOidc(oidcIssuer, request, signal);
    const nonce = randomBytes(32).toString('base64url');
    const token = await browserLogin({ clientId, redirectUri, scopes, signal, request, timeoutMs: 300000,
      startThroughLoopback: true, oidc: { issuer: oidcIssuer, nonce } });
    signal?.throwIfAborted();
    return { email: await verifySsoIdentity(token, getKey(new URL(oidcIssuer + '/jwks')), { issuer: oidcIssuer, clientId, nonce }),
      issuer, providerId };
  } finally {
    if (createStarted && !createRejected) {
      const removed = await removeSsoProof(api, accountId, proof).catch(() => false);
      if (!removed) throw new Error('临时登录应用的创建或清理结果未确认。请核对 Cloudflare 审计日志后用 --resume 继续。');
    }
    await save(undefined);
  }
}

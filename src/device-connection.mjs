import { activatePath, activationErrorCodes } from '../cloud/device-paths.mjs';
import { setTimeout as wait } from 'node:timers/promises';
import { confirmedRevocation } from '../cloud/device-revocation.mjs';

export async function checkConnection({ manager, deviceId }, token, signal, {
  request = fetch, timeout = 45000, servers,
} = {}) {
  let response;
  try {
    response = await request(manager + activatePath, {
      method: 'POST', redirect: 'error',
      signal: AbortSignal.any([AbortSignal.timeout(timeout), signal]),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      // The local MCP names this device offers. Omitted when the device's MCP
      // file is unreadable, so a broken edit never unregisters anything.
      body: JSON.stringify({ deviceId, ...(servers && { servers }) }),
    });
  } catch {
    return { status: 'unconfirmed', reason: 'network' };
  }

  const httpStatus = response.status;
  if (httpStatus !== 200 && httpStatus !== 410) {
    if (httpStatus === 409 && response.headers.get('Content-Type')?.split(';', 1)[0] === 'application/json') {
      // Activation conflicts expose only stable classifications, never vendor or origin text.
      const code = await response.json().then(body => body?.code, () => undefined);
      if (activationErrorCodes.includes(code)) return { status: 'unconfirmed', reason: code, httpStatus };
    } else await response.body?.cancel().catch(() => {});
    return { status: 'unconfirmed', reason: 'http', httpStatus };
  }
  if (response.headers.get('Content-Type')?.split(';', 1)[0] !== 'application/json') {
    await response.body?.cancel().catch(() => {});
    return { status: 'unconfirmed', reason: 'invalid_response', httpStatus };
  }
  const body = await response.json().catch(() => null);
  if (httpStatus === 200 && body?.status === 'active') {
    const reported = Array.isArray(body.servers) ? body.servers.filter(item =>
      typeof item?.name === 'string' && /^[a-z][a-z0-9-]{1,23}$/.test(item.name) && ['registered', 'pending'].includes(item.status))
      .map(({ name, status, reason }) => ({ name, status, ...(typeof reason === 'string' && /^[a-z_]{1,40}$/.test(reason) && { reason }) })) : undefined;
    return { status: 'active', ...(reported && { servers: reported }) };
  }
  if (httpStatus === 410 && await confirmedRevocation(body, manager, deviceId, token)) return { status: 'revoked' };
  return { status: 'unconfirmed', reason: 'invalid_response', httpStatus };
}

export async function monitorConnection(config, token, signal, {
  request = fetch,
  sleep = (ms, currentSignal) => wait(ms, undefined, { signal: currentSignal }),
  report = () => {},
  // Returns { names } or { error } for the device's MCP file, read each check.
  servers,
} = {}) {
  let delay = 1500;
  let previous;
  try {
    while (!signal.aborted) {
      const offered = servers ? await servers() : undefined;
      const result = await checkConnection(config, token, signal, { request, servers: offered?.names });
      const current = offered?.error ? { ...result, mcpConfigError: offered.error } : result;
      if (signal.aborted) break;
      const signature = JSON.stringify(current);
      if (signature !== previous) {
        await report(current);
        previous = signature;
      }
      if (current.status === 'revoked') return current.status;
      if (current.status === 'active') {
        delay = 1500;
        // A local MCP that has not registered yet is checked again sooner.
        await sleep(current.servers?.some(server => server.status === 'pending') ? 15000 : 60000, signal);
      } else {
        await sleep(delay, signal);
        delay = Math.min(delay * 2, 30000);
      }
    }
  } catch (error) {
    if (!signal.aborted || error.name !== 'AbortError') throw error;
  }
}

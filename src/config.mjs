import { readPrivateFile } from './private-directory.mjs';
import { isAbsolute } from 'node:path';
import { browserServerName } from './local-mcp.mjs';

import { profiles } from '../cloud/profiles.mjs';
export { profiles };

export function loopbackBackend(value) {
  const backend = new URL(value);
  if (backend.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(backend.hostname) ||
      backend.pathname !== '/mcp' || backend.username || backend.password || backend.search || backend.hash) {
    throw new Error('Backend must be a loopback HTTP /mcp endpoint');
  }
  return backend;
}

export async function loadConfig(path) {
  const config = JSON.parse(await readPrivateFile(path));
  if (config?.schema !== 1 || !/^[a-z][a-z0-9-]{0,23}$/.test(config.deviceId ?? '') ||
      !Object.hasOwn(profiles, config.profile) || !Number.isInteger(config.port) ||
      config.port < 1024 || config.port > 65535) {
    throw new Error('Invalid device id, profile or port');
  }

  const backend = loopbackBackend(config.backend?.url);
  const expectedBrowserServer = config.backend?.serverName;
  if (expectedBrowserServer !== undefined &&
      (config.profile !== 'browser' || typeof expectedBrowserServer !== 'string' || !browserServerName.test(expectedBrowserServer))) {
    throw new Error('Invalid browser backend identity');
  }
  if (backend.hostname === '127.0.0.1' && Number(backend.port) === config.port) {
    throw new Error('Backend and adapter must use different ports');
  }

  const portalToken = (await readPrivateFile(config.portalTokenFile)).trim();
  const backendFile = await readPrivateFile(config.backend.tokenFile);
  const backendToken = config.backend.tokenKey === 'apiToken' ? JSON.parse(backendFile).apiToken : backendFile.trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(portalToken) || typeof backendToken !== 'string' ||
      !/^[\x21-\x7e]{32,512}$/.test(backendToken) || portalToken === backendToken) {
    throw new Error('Use an independent Portal token and a valid local backend credential');
  }
  if (config.profile === 'probe' &&
      (typeof config.probeDirectory !== 'string' || !isAbsolute(config.probeDirectory))) {
    throw new Error('Set an absolute directory for the fixed acceptance marker');
  }

  return { ...config, backend, backendToken, portalToken, expectedBrowserServer };
}

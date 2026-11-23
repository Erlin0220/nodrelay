import { isAbsolute, join } from 'node:path';
import { loopbackBackend, profiles } from './config.mjs';
import { browserServerName, discoverLocalTools, localMcp } from './local-mcp.mjs';
import { ensurePrivateDirectory, readPrivateFile, writePrivateFile } from './private-directory.mjs';

const { tools: required, optional } = profiles.browser;
const allowed = [...required, ...optional];
const requestOptions = { timeout: 5000 };

async function verifyBrowserEndpoint(backend, token, serverName) {
  const { client, transport } = localMcp(backend, token, 'nodrelay-browser-setup');
  try {
    await client.connect(transport, requestOptions).catch(() => {
      throw new Error('The local browser backend is unavailable or rejected its dedicated credential');
    });
    await discoverLocalTools(client, required, allowed, requestOptions, serverName);
  } finally {
    await client.close().catch(() => {});
  }
}

async function configuredBrowserBackend(configurationFile) {
  if (typeof configurationFile !== 'string' || !isAbsolute(configurationFile)) {
    throw new Error('Configure NODRELAY_BROWSER_BACKEND_CONFIG with an absolute private file path');
  }
  const configText = await readPrivateFile(configurationFile);
  let cfg;
  try { cfg = JSON.parse(configText); }
  catch { throw new Error('The browser backend configuration must be valid JSON'); }
  if (cfg?.schema !== 1 || cfg.purpose !== 'nodrelay-browser-only' ||
      typeof cfg.serverName !== 'string' || !browserServerName.test(cfg.serverName) ||
      typeof cfg.tokenFile !== 'string' || !isAbsolute(cfg.tokenFile) ||
      (cfg.tokenKey !== undefined && cfg.tokenKey !== 'apiToken')) {
    throw new Error('The browser backend requires an explicit identity and browser-only private credential');
  }
  let backend;
  try { backend = loopbackBackend(cfg.url); }
  catch { throw new Error('The browser backend must be a loopback HTTP /mcp endpoint'); }
  if (!backend.port) throw new Error('The browser backend requires an explicit loopback port');
  const body = await readPrivateFile(cfg.tokenFile);
  let token;
  try { token = cfg.tokenKey === 'apiToken' ? JSON.parse(body).apiToken : body.trim(); }
  catch { throw new Error('Invalid browser backend credential'); }
  if (typeof token !== 'string' || !/^[\x21-\x7e]{32,512}$/.test(token)) {
    throw new Error('Invalid browser backend credential');
  }
  await verifyBrowserEndpoint(backend, token, cfg.serverName);
  return { url: backend.href, serverName: cfg.serverName, tokenFile: cfg.tokenFile,
    ...(cfg.tokenKey && { tokenKey: cfg.tokenKey }) };
}

export async function checkBrowserBackend(configurationFile) {
  await configuredBrowserBackend(configurationFile);
}

export async function attachBrowserBackend(configurationFile, privateRoot) {
  if (typeof privateRoot !== 'string' || !isAbsolute(privateRoot)) throw new Error('Use an absolute browser installation path');
  await ensurePrivateDirectory(privateRoot);
  const contents = JSON.stringify(await configuredBrowserBackend(configurationFile));
  const output = join(privateRoot, 'browser-backend.private.json');
  try { await writePrivateFile(output, contents); }
  catch (error) {
    if (error.code !== 'EEXIST' || await readPrivateFile(output) !== contents) throw error;
  }
}

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createDeviceApp } from '../src/device.mjs';
import { profiles } from '../src/config.mjs';

export const PORTAL_TOKEN = 'a'.repeat(43);
export const BACKEND_TOKEN = 'b'.repeat(43);

export async function listen(t, app) {
  const listener = await new Promise((resolve, reject) => {
    const http = app.listen(0, '127.0.0.1', error => error ? reject(error) : resolve(http));
    http.once('error', reject);
  });
  const origin = `http://127.0.0.1:${listener.address().port}`;
  t.after(async () => {
    const closed = new Promise(resolve => listener.close(resolve));
    listener.closeAllConnections();
    await closed;
  });
  return origin;
}

export async function connect(t, endpoint, token) {
  const client = new Client({ name: 'fleet-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  t.after(() => client.close());
  await client.connect(transport);
  return client;
}

export async function device(t, backend, profile, options = {}) {
  const config = {
    profile, deviceId: 'mac-fixture', backend: new URL(backend),
    portalToken: PORTAL_TOKEN, backendToken: BACKEND_TOKEN,
    probeDirectory: '/fixtures/acceptance', ...options,
  };
  const origin = await listen(t, createDeviceApp(config));
  return { origin, url: origin + profiles[profile].path };
}

const fields = { type: 'object', properties: { sessionId: { type: 'number' } } };

export async function fixtureBackend(t, tools, handle, { stateless = false, beforeTool } = {}) {
  const app = createMcpExpressApp();
  let epoch = 1;
  let serverName = 'fixture';
  let offline = false;
  const sessions = new Map();
  app.post('/mcp', async (req, res) => {
    if (offline) return res.sendStatus(503);
    if (req.headers.authorization !== `Bearer ${BACKEND_TOKEN}`) return res.sendStatus(401);
    const id = req.headers['mcp-session-id'];
    if (id && !sessions.has(id)) return res.sendStatus(404);
    if (req.body?.method === 'tools/call' && beforeTool?.(req.body.params, res)) return;
    const transport = id ? sessions.get(id) : new StreamableHTTPServerTransport({
      enableJsonResponse: true,
      sessionIdGenerator: stateless ? undefined : () => String(epoch++),
      onsessioninitialized: sessionId => sessions.set(sessionId, transport),
    });
    if (!id) {
      const server = new Server({ name: serverName, version: '1.0.0' }, { capabilities: { tools: {} } });
      server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: tools.map(name => ({ name, inputSchema: fields })),
      }));
      server.setRequestHandler(CallToolRequestSchema, async ({ params }) => handle(params));
      if (stateless) res.once('close', () => void server.close());
      await server.connect(transport);
    }
    await transport.handleRequest(req, res, req.body);
  });
  app.get('/mcp', (_req, res) => res.sendStatus(405));
  return {
    url: (await listen(t, app)) + '/mcp',
    dropSessions: () => sessions.clear(),
    setOffline: value => { offline = value; },
    setIdentity: value => { serverName = value; },
    setTools: value => { tools = value; },
  };
}

export const call = (client, name, args) => client.callTool({ name, arguments: args });
export const result = structuredContent => ({ content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent });

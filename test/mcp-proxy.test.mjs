import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { bindDeviceLoopback, createDeviceApp } from '../src/device.mjs';
import { enabledMcpNames } from '../src/mcp-proxy.mjs';

const sdk = fileURLToPath(new URL('../node_modules/@modelcontextprotocol/sdk/dist/esm/', import.meta.url));
const token = 'p'.repeat(43);
const windows = process.platform === 'win32';

// A real stdio MCP server, run with this Node binary like `npx some-server`.
const stdioServer = pidFile => `
import { writeFileSync } from 'node:fs';
import { Server } from ${JSON.stringify(join(sdk, 'server/index.js'))};
import { StdioServerTransport } from ${JSON.stringify(join(sdk, 'server/stdio.js'))};
import { CallToolRequestSchema, GetPromptRequestSchema, ListPromptsRequestSchema, ListToolsRequestSchema } from ${JSON.stringify(join(sdk, 'types.js'))};
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
const server = new Server({ name: 'fixture-stdio', version: '1.0.0' }, { capabilities: { tools: {}, prompts: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
  { name: 'echo', description: 'Echo text', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
  { name: 'secret', description: 'Hidden', inputSchema: { type: 'object' } },
] }));
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => ({ content: [{ type: 'text', text: 'echo:' + params.arguments.text + ':' + process.env.FIXTURE_FLAG }] }));
server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [{ name: 'greet' }] }));
server.setRequestHandler(GetPromptRequestSchema, async () => ({ messages: [{ role: 'user', content: { type: 'text', text: 'hello' } }] }));
await server.connect(new StdioServerTransport());
`;

async function httpServer(t) {
  const app = createMcpExpressApp({ host: '127.0.0.1' });
  app.post('/mcp', async (req, res) => {
    if (req.headers['x-fixture-key'] !== 'k1') return res.sendStatus(401);
    const server = new Server({ name: 'fixture-http', version: '1.0.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'lookup', inputSchema: { type: 'object' } }] }));
    server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: 'text', text: 'found' }] }));
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    res.once('close', () => void server.close());
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  const { listener, port } = await bindDeviceLoopback(app, 0);
  t.after(() => new Promise(resolve => listener.close(resolve)));
  return `http://127.0.0.1:${port}/mcp`;
}

async function device(t, servers) {
  const dir = await mkdtemp(join(tmpdir(), 'nodrelay-mcp-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'mcp.json');
  const save = async value => {
    await rm(file, { force: true });
    await writeFile(file, JSON.stringify({ mcpServers: value }), { mode: 0o600 });
  };
  await save(servers(dir));
  const app = createDeviceApp({ deviceId: 'fixture', profile: 'development', portalToken: token,
    backend: new URL('http://127.0.0.1:9/mcp'), backendToken: 'b'.repeat(32), mcpConfigFile: file });
  const { listener, port } = await bindDeviceLoopback(app, 0);
  t.after(() => new Promise(resolve => listener.close(resolve)));
  const base = `http://127.0.0.1:${port}`;
  const connect = async name => {
    const client = new Client({ name: 'portal-fixture', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp/${name}`),
      { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    t.after(() => client.close());
    return client;
  };
  return { dir, file, save, base, connect };
}

test('the adapter serves a configured stdio MCP through /mcp/<name> with its tool filter', { skip: windows && 'POSIX file modes' }, async t => {
  let pidFile;
  const d = await device(t, dir => {
    pidFile = join(dir, 'stdio.pid');
    return { notes: { command: process.execPath, args: ['--input-type=module', '-e', stdioServer(pidFile)],
      env: { FIXTURE_FLAG: 'on' }, tools: { deny: ['secret'] } } };
  });
  const client = await d.connect('notes');
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['echo']);
  const result = await client.callTool({ name: 'echo', arguments: { text: 'hi' } });
  assert.equal(result.content[0].text, 'echo:hi:on', 'the configured environment reaches the local server');
  assert.equal((await client.callTool({ name: 'secret', arguments: {} })).isError, true);
  assert.deepEqual((await client.listPrompts()).prompts.map(prompt => prompt.name), ['greet']);
  assert.equal((await client.getPrompt({ name: 'greet' })).messages[0].content.text, 'hello');

  const post = (path, headers = {}) => fetch(d.base + path, { method: 'POST', body: '{}', headers: {
    'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers } });
  assert.equal((await post('/mcp/notes')).status, 401);
  assert.equal((await post('/mcp/notes', { Authorization: `Bearer ${token}`, Origin: 'https://evil.example' })).status, 403);
  assert.equal((await post('/mcp/missing', { Authorization: `Bearer ${token}` })).status, 404);
  assert.equal((await post('/mcp/Bad_Name', { Authorization: `Bearer ${token}` })).status, 404);

  // An invalid edit keeps the last valid list; removing the server stops its process.
  await rm(d.file); await writeFile(d.file, '{ broken', { mode: 0o600 });
  assert.deepEqual((await (await d.connect('notes')).listTools()).tools.map(tool => tool.name), ['echo']);
  assert.ok((await enabledMcpNames(d.file)).error, 'the activation check reports the invalid file instead of an empty list');
  const pid = Number(await readFile(pidFile, 'utf8'));
  await d.save({});
  assert.equal((await post('/mcp/notes', { Authorization: `Bearer ${token}` })).status, 404);
  for (let i = 0; i < 40; i++) {
    try { process.kill(pid, 0); } catch { break; }
    await wait(50);
  }
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'the removed server process stopped');
  assert.deepEqual(await enabledMcpNames(d.file), { names: [] });
});

test('the adapter serves a local HTTP MCP with its configured headers', { skip: windows && 'POSIX file modes' }, async t => {
  const url = await httpServer(t);
  const d = await device(t, () => ({ lookup: { url, headers: { 'X-Fixture-Key': 'k1' } }, off: { url, disabled: true } }));
  const client = await d.connect('lookup');
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['lookup']);
  assert.equal((await client.callTool({ name: 'lookup', arguments: {} })).content[0].text, 'found');
  assert.deepEqual(await enabledMcpNames(d.file), { names: ['lookup'] });
  const disabled = await fetch(d.base + '/mcp/off', { method: 'POST', body: '{}', headers: { Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' } });
  assert.equal(disabled.status, 404);
});

test('a server that cannot start reports 502 and is retried on the next request', { skip: windows && 'POSIX file modes' }, async t => {
  const d = await device(t, dir => ({ broken: { command: join(dir, 'missing-binary') } }));
  const response = await fetch(d.base + '/mcp/broken', { method: 'POST', headers: { Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'x', version: '1' } } }) });
  assert.equal(response.status, 502);
  assert.match((await response.json()).error.message, /device service log/);
});

import { stat } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema, CallToolResultSchema, GetPromptRequestSchema, ListPromptsRequestSchema, ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema, ListToolsRequestSchema, ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { McpConfigError, parseMcpConfig, toolAllowed } from './mcp-config.mjs';
import { readPrivateFile } from './private-directory.mjs';

const listTimeout = { timeout: 15000 };
// Cloudflare's Portal ends a call after 60 seconds; answer before it does.
const callTimeout = 55000;
const toolError = text => ({ isError: true, content: [{ type: 'text', text }] });

// Read the device's private MCP file. A missing file means no MCP servers.
export async function readMcpConfig(file) {
  const text = await readPrivateFile(file).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  return text === null ? [] : parseMcpConfig(text);
}

// Names this device offers to the Portal, for the activation check. An
// unreadable or invalid file reports no list at all, so a typo never
// unregisters servers that were working.
export async function enabledMcpNames(file) {
  try { return { names: (await readMcpConfig(file)).filter(entry => !entry.disabled).map(entry => entry.name) }; }
  catch (error) { return { error: error instanceof McpConfigError ? error.message : 'MCP 配置文件无法读取，请检查文件权限。' }; }
}

export function configuredTransport(entry) {
  if (entry.kind === 'stdio') {
    // stderr goes to the device service log, where start-up errors belong.
    return new StdioClientTransport({ command: entry.command, args: entry.args, env: entry.env, cwd: entry.cwd, stderr: 'inherit' });
  }
  const url = new URL(entry.url);
  const sameServer = (target, options) => {
    const next = new URL(target instanceof Request ? target.url : target);
    if (next.origin !== url.origin) throw new Error('A local MCP server cannot redirect to another host');
    return fetch(target, { ...options, redirect: 'error' });
  };
  const requestInit = { headers: entry.headers };
  return entry.kind === 'sse'
    ? new SSEClientTransport(url, { requestInit, fetch: sameServer, eventSourceInit: { fetch: (target, init) => sameServer(target, { ...init, headers: { ...init?.headers, ...entry.headers } }) } })
    : new StreamableHTTPClientTransport(url, { requestInit, fetch: sameServer });
}

async function allPages(list, key) {
  const items = [];
  let cursor;
  for (let page = 0; page < 8; page++) {
    const result = await list(cursor ? { cursor } : {}, listTimeout);
    items.push(...(result[key] ?? []));
    if (!result.nextCursor || result.nextCursor === cursor) break;
    cursor = result.nextCursor;
  }
  return items;
}

// Keeps one upstream connection per configured MCP and answers Portal
// requests for /mcp/<name>. The file is re-read when it changes; a server
// whose settings changed is restarted, and a removed one is stopped.
export function createMcpHub(file, { transport = configuredTransport } = {}) {
  let loaded = { key: undefined, entries: [] };
  const live = new Map();

  async function entries() {
    const info = await stat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    const key = info ? `${info.mtimeMs}:${info.size}:${info.ino}` : 'missing';
    if (key !== loaded.key) {
      // Keep serving the last valid list while the file is being edited.
      const next = await readMcpConfig(file).catch(error => { if (loaded.key === undefined) throw error; return undefined; });
      if (next) {
        loaded = { key, entries: next };
        for (const [name, connection] of live) {
          const current = next.find(entry => entry.name === name && !entry.disabled);
          if (!current || current.fingerprint !== connection.fingerprint) await stop(name);
        }
      }
    }
    return loaded.entries;
  }

  async function stop(name) {
    const connection = live.get(name);
    live.delete(name);
    await (await connection?.pending.catch(() => undefined))?.client.close().catch(() => {});
  }

  function connect(entry) {
    const existing = live.get(entry.name);
    if (existing) return existing.pending;
    const connection = { fingerprint: entry.fingerprint };
    connection.pending = (async () => {
      const client = new Client({ name: 'nodrelay', version: '0.1.0' });
      client.onclose = () => { if (live.get(entry.name) === connection) live.delete(entry.name); };
      try {
        await client.connect(transport(entry), listTimeout);
        return { client, capabilities: client.getServerCapabilities() ?? {} };
      } catch (error) {
        await client.close().catch(() => {});
        throw error;
      }
    })();
    connection.pending.catch(() => { if (live.get(entry.name) === connection) live.delete(entry.name); });
    live.set(entry.name, connection);
    return connection.pending;
  }

  return {
    async names() { return (await entries()).filter(entry => !entry.disabled).map(entry => entry.name); },
    async close() { await Promise.all([...live.keys()].map(stop)); },
    async handle(name, req, res) {
      let entry;
      try { entry = (await entries()).find(item => item.name === name && !item.disabled); }
      catch { return res.status(503).json({ error: 'MCP configuration unavailable' }); }
      if (!entry) return res.sendStatus(404);
      let upstream;
      try { upstream = await connect(entry); }
      catch { return res.status(502).json({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'The local MCP server did not start. Check the device service log.' } }); }
      const { client, capabilities } = upstream;
      const current = live.get(name);
      // Restart an upstream that stopped answering, unless it was already replaced.
      const drop = async () => { if (live.get(name) === current) await stop(name); };
      const server = new Server({ name: `nodrelay-${name}`, version: '0.1.0' }, { capabilities: {
        tools: {}, ...(capabilities.prompts && { prompts: {} }), ...(capabilities.resources && { resources: {} }),
      } });
      res.once('close', () => void server.close().catch(() => {}));
      server.setRequestHandler(ListToolsRequestSchema, async () => {
        if (!capabilities.tools) return { tools: [] };
        const tools = await allPages((params, options) => client.listTools(params, options), 'tools')
          .catch(async error => { await drop(); throw error; });
        return { tools: tools.filter(tool => toolAllowed(entry, tool.name)) };
      });
      server.setRequestHandler(CallToolRequestSchema, async ({ params }, { signal }) => {
        if (!capabilities.tools || !toolAllowed(entry, params.name)) return toolError('This tool is not available from this device.');
        try {
          return await client.request({ method: 'tools/call', params: { name: params.name, arguments: params.arguments ?? {} } },
            CallToolResultSchema, { timeout: callTimeout, signal });
        } catch {
          return toolError('The local MCP server did not answer. Check the original device before repeating the call.');
        }
      });
      if (capabilities.prompts) {
        server.setRequestHandler(ListPromptsRequestSchema, async () => ({
          prompts: await allPages((params, options) => client.listPrompts(params, options), 'prompts'),
        }));
        server.setRequestHandler(GetPromptRequestSchema, async ({ params }) => client.getPrompt(params, listTimeout));
      }
      if (capabilities.resources) {
        server.setRequestHandler(ListResourcesRequestSchema, async () => ({
          resources: await allPages((params, options) => client.listResources(params, options), 'resources'),
        }));
        server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
          resourceTemplates: await allPages((params, options) => client.listResourceTemplates(params, options), 'resourceTemplates'),
        }));
        server.setRequestHandler(ReadResourceRequestSchema, async ({ params }) => client.readResource(params, { timeout: callTimeout }));
      }
      const http = new StreamableHTTPServerTransport({ enableJsonResponse: true });
      await server.connect(http);
      await http.handleRequest(req, res, req.body);
    },
  };
}

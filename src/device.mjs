import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { commandFingerprint, commandJournal, commandOperationId, commandSchema } from './command-journal.mjs';
import { loadConfig, profiles } from './config.mjs';
import { processId, processResult, processSchema, workspaceId, workspaceResult } from './device-handles.mjs';
import { discoverLocalTools, localMcp } from './local-mcp.mjs';
import { mcpNamePattern } from './mcp-config.mjs';
import { createMcpHub } from './mcp-proxy.mjs';

const HOST = '127.0.0.1';
const markerFile = 'portal-probe.txt';
const probeTool = {
  name: 'device_probe',
  description: 'Read a fixed acceptance marker through this device’s DevSpace Runtime. Supply a fresh challenge.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['challenge'],
    properties: { challenge: { type: 'string', pattern: '^[A-Za-z0-9_-]{16,64}$' } },
  },
  outputSchema: {
    type: 'object', required: ['deviceId', 'challenge', 'markerSha256'],
    properties: { deviceId: { type: 'string' }, challenge: { type: 'string' }, markerSha256: { type: 'string' } },
  },
};
const toolError = text => ({ isError: true, content: [{ type: 'text', text }] });
const shortRequest = { timeout: 4000 };

function upstreamConnection(config, requiredTools, allowedTools) {
  let pending;
  const discover = client => discoverLocalTools(client, requiredTools, allowedTools, shortRequest, config.expectedBrowserServer);
  function get() {
    return pending ??= (async () => {
      const { client, transport } = localMcp(config.backend, config.backendToken, 'devspace-fleet-local');
      try {
        await client.connect(transport, shortRequest);
        if (config.profile !== 'browser' && !transport.sessionId) throw new Error('Expected stateful DevSpace backend');
        return { client, tools: await discover(client), secret: randomBytes(32) };
      } catch (error) {
        await client.close().catch(() => {});
        throw error;
      }
    })().catch(error => {
      pending = undefined;
      throw error;
    });
  }
  async function disconnect(active) {
    const current = pending;
    if (!current || (await current) !== active || pending !== current) return;
    pending = undefined;
    await active.client.close().catch(() => {});
  }
  return {
    get,
    disconnect,
    async catalog() {
      const existingConnection = pending;
      const active = await get();
      if (config.profile !== 'browser' || !existingConnection) return active.tools;
      try {
        active.tools = await discover(active.client);
        return active.tools;
      } catch (error) {
        await disconnect(active);
        throw error;
      }
    },
  };
}

async function probe(config, client, args, signal) {
  if (Object.keys(args).length !== 1 || typeof args.challenge !== 'string' ||
      !/^[A-Za-z0-9_-]{16,64}$/.test(args.challenge)) {
    return toolError('Supply a 16–64 character challenge using letters, numbers, hyphens or underscores.');
  }
  const options = { ...shortRequest, signal };
  const opened = await client.callTool({ name: 'open_workspace', arguments: {
    path: config.probeDirectory, mode: 'checkout', includeBootstrapContext: false,
  } }, undefined, options);
  if (opened.isError || typeof opened.structuredContent?.workspaceId !== 'string') {
    return toolError('The fixed acceptance workspace is unavailable.');
  }
  const read = await client.callTool({ name: 'read', arguments: {
    workspaceId: opened.structuredContent.workspaceId, path: markerFile,
  } }, undefined, options);
  const marker = read.structuredContent?.result?.trim();
  if (read.isError || !marker || !/^[A-Za-z0-9_-]{32,128}$/.test(marker)) {
    return toolError('The fixed acceptance marker is missing or invalid.');
  }
  const evidence = {
    deviceId: config.deviceId, challenge: args.challenge,
    markerSha256: createHash('sha256').update(marker).digest('hex'),
  };
  return { content: [{ type: 'text', text: JSON.stringify(evidence) }], structuredContent: evidence };
}

export function createDeviceApp(config, { hub } = {}) {
  const { path, tools, optional = [] } = profiles[config.profile];
  const allowedTools = [...tools, ...optional];
  const upstream = upstreamConnection(config, tools, allowedTools);
  const commands = commandJournal();
  const app = createMcpExpressApp({ host: HOST });
  app.disable('x-powered-by');
  app.enable('case sensitive routing');
  app.enable('strict routing');
  // Every Portal route uses the device's Portal token and refuses browser
  // origins and anything but POST.
  const admitted = (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const suppliedToken = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization ?? '')?.[1];
    if (!suppliedToken || !timingSafeEqual(Buffer.from(suppliedToken), Buffer.from(config.portalToken))) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      res.sendStatus(401);
      return false;
    }
    if (req.headers.origin) {
      res.sendStatus(403);
      return false;
    }
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      res.sendStatus(405);
      return false;
    }
    return true;
  };
  // Any local MCP configured on this device, at /mcp/<name>.
  const mcpHub = config.profile === 'development' && (hub ?? (config.mcpConfigFile && createMcpHub(config.mcpConfigFile)));
  if (mcpHub) {
    app.all('/mcp/:name', async (req, res) => {
      if (!admitted(req, res)) return;
      if (!mcpNamePattern.test(req.params.name)) return res.sendStatus(404);
      await mcpHub.handle(req.params.name, req, res);
    });
  }
  app.all(path, async (req, res) => {
    if (!admitted(req, res)) return;

    const server = new Server({ name: `${config.deviceId}-${config.profile}`, version: '0.1.0' },
      { capabilities: { tools: {} } });
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    res.once('close', () => void server.close().catch(() => {}));
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      if (config.profile === 'probe') return { tools: [probeTool] };
      const catalog = await upstream.catalog().catch(() => undefined);
      if (!catalog) throw new Error('Local MCP backend unavailable');
      return { tools: allowedTools.filter(name => catalog.has(name)).map(name => {
        const { _meta, ...tool } = catalog.get(name);
        return commandSchema(processSchema(tool));
      }) };
    });
    server.setRequestHandler(CallToolRequestSchema, async ({ params }, { signal }) => {
      const { name } = params;
      const args = params.arguments ?? {};
      if (config.profile === 'probe' ? name !== probeTool.name : !allowedTools.includes(name)) {
        return toolError('Tool unavailable on this device endpoint.');
      }
      let runtimeArgs = args;
      let operationId;
      let fingerprint;
      if (name === 'exec_command') {
        ({ operationId, ...runtimeArgs } = args);
        if (typeof operationId !== 'string' || !commandOperationId.test(operationId)) {
          return toolError('Supply a lowercase UUID v4 operationId for this command.');
        }
        fingerprint = commandFingerprint(runtimeArgs);
        const existing = commands.lookup(operationId, fingerprint);
        if (existing) return existing;
      }

      const backend = await upstream.get().catch(() => undefined);
      if (!backend) return toolError('Local MCP backend unavailable. No tool call was dispatched.');
      if (config.profile !== 'probe' && !backend.tools.has(name)) return toolError('This tool is unavailable on the installed backend.');
      let forwarded = runtimeArgs;
      if (config.profile === 'development' && name !== 'open_workspace') {
        const localId = workspaceId(backend.secret, args.workspaceId);
        if (!localId) return toolError('Workspace handle is invalid or expired here. Open the workspace on the original device.');
        forwarded = { ...runtimeArgs, workspaceId: localId };
      }
      if (name === 'write_stdin') {
        const sessionId = processId(backend.secret, args.workspaceId, args.sessionId);
        if (!sessionId) return toolError('Process handle is invalid or expired for this device and workspace.');
        forwarded.sessionId = sessionId;
      }

      async function dispatch(requestSignal) {
        try {
          if (config.profile === 'probe') return await probe(config, backend.client, args, requestSignal);
          // DevSpace uses this metadata to reuse the workspace for a host conversation.
          const conversation = params._meta?.['openai/session'];
          const { _meta, ...result } = await backend.client.callTool({
            name, arguments: forwarded,
            ...(typeof conversation === 'string' && conversation && { _meta: { 'openai/session': conversation } }),
          }, undefined, { timeout: 45000, signal: requestSignal });
          if (name === 'open_workspace') return workspaceResult(backend.secret, result);
          return ['exec_command', 'write_stdin'].includes(name)
            ? processResult(backend.secret, args.workspaceId, result, name === 'write_stdin' ? forwarded.sessionId : undefined)
            : result;
        } catch {
          await upstream.disconnect(backend);
          return toolError('Local MCP reply unavailable. Inspect the original device before repeating the operation.');
        }
      }

      // The journal owns a dispatched command even if its requesting HTTP connection closes.
      if (operationId) {
        if (signal.aborted) return toolError('The request closed before the command was dispatched.');
        return commands.run(operationId, fingerprint, dispatch);
      }
      return dispatch(signal);
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  app.use((_error, _req, res, _next) => {
    if (!res.headersSent) res.status(400).send('Invalid MCP request');
  });
  return app;
}

// Bind the serving socket itself; do not discover a free port and release it
// before opening the real listener. Schema 1 configuration remains fixed-port.
export async function bindDeviceLoopback(app, requestedPort) {
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) {
    throw new RangeError('Invalid loopback listener port');
  }
  const listener = createServer(app);
  await new Promise((resolve, reject) => {
    function unavailable(error) {
      listener.off('listening', ready);
      reject(error);
    }
    function ready() {
      listener.off('error', unavailable);
      resolve();
    }
    listener.once('error', unavailable);
    listener.once('listening', ready);
    listener.listen({ port: requestedPort, host: HOST, exclusive: true });
  });
  return { listener, port: listener.address().port };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const config = await loadConfig(process.argv[2]);
    // The MCP list lives beside the adapter's own private configuration.
    if (config.profile === 'development') config.mcpConfigFile = join(dirname(resolve(process.argv[2])), 'mcp.json');
    const opened = await bindDeviceLoopback(createDeviceApp(config), config.port).catch(() => null);
    if (!opened) {
      console.error('Could not open the configured loopback listener');
      process.exitCode = 1;
    } else {
      console.log(`Listening on http://${HOST}:${opened.port}${profiles[config.profile].path}`);
    }
  } catch {
    console.error('Device configuration rejected. Check the config, backend URL and private credential files.');
    process.exitCode = 1;
  }
}

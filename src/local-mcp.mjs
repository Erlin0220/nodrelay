import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export const browserServerName = /^[\x20-\x7e]{1,128}$/;

export function localMcp(backend, token, name) {
  const client = new Client({ name, version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(backend, {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
    fetch(target, options) {
      const url = new URL(target instanceof Request ? target.url : target);
      if (url.href !== backend.href) throw new Error('Backend origin changed');
      return fetch(target, { ...options, redirect: 'error' });
    },
  });
  return { client, transport };
}

export async function discoverLocalTools(client, required, allowed, options, expectedBrowserServer) {
  if (expectedBrowserServer && client.getServerVersion()?.name !== expectedBrowserServer) {
    throw new Error('Browser backend identity differs from the configured identity');
  }
  const tools = new Map();
  let cursor;
  let pages = 0;
  do {
    if (++pages > 8) throw new Error('Backend tool catalog exceeded the discovery limit');
    const page = await client.listTools(cursor ? { cursor } : {}, options);
    for (const tool of page.tools) {
      if (allowed.includes(tool.name)) {
        if (expectedBrowserServer && tools.has(tool.name)) throw new Error('Duplicate browser backend tool');
        tools.set(tool.name, tool);
      } else if (expectedBrowserServer) throw new Error('Browser backend exposes a tool outside the browser capability');
    }
    if (page.nextCursor && page.nextCursor === cursor) throw new Error('Backend pagination stalled');
    cursor = page.nextCursor;
  } while (cursor && (expectedBrowserServer || tools.size < allowed.length));
  if (!required.every(name => tools.has(name))) throw new Error('Expected backend tools unavailable');
  return tools;
}

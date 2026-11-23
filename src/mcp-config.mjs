import { isAbsolute } from 'node:path';

// Each device's own MCP list, in the format Claude Desktop, Cursor and VS Code
// already use, so existing entries can be pasted or imported unchanged:
//   { "mcpServers": { "filesystem": { "command": "npx", "args": [...], "env": {...} } } }
// Nodrelay adds two optional fields per server: "disabled" and
// "tools": { "allow": [...], "deny": [...] }. The management console never
// writes this file: what runs on a computer is decided on that computer.
export const mcpNamePattern = /^[a-z][a-z0-9-]{1,23}$/;
export const maxEnabledServers = 16;
const maxServers = 32;
const loopbackHosts = new Set(['127.0.0.1', 'localhost', '[::1]']);
const envName = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const headerName = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
const fields = new Set(['command', 'args', 'env', 'cwd', 'url', 'headers', 'type', 'disabled', 'tools']);
// Client-specific settings that other tools add and Nodrelay does not use.
const ignored = new Set(['autoApprove', 'alwaysAllow', 'timeout', 'description', 'transportType', 'name']);

export class McpConfigError extends Error {
  constructor(message) { super(message); this.name = 'McpConfigError'; }
}

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0');

function strings(value, label, { max = 64, length = 4096 } = {}) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max || !value.every(item => typeof item === 'string' && item.length <= length && !item.includes('\0'))) {
    throw new McpConfigError(`${label} 必须是字符串数组。`);
  }
  return [...value];
}

function map(value, label, keyPattern, length) {
  if (value === undefined) return {};
  if (!record(value) || Object.keys(value).length > 64) throw new McpConfigError(`${label} 必须是键值对。`);
  for (const [key, item] of Object.entries(value)) {
    if (!keyPattern.test(key) || typeof item !== 'string' || item.length > length || item.includes('\0') || /[\r\n]/.test(item) && label.includes('headers')) {
      throw new McpConfigError(`${label} 中的 ${key} 无效。`);
    }
  }
  return { ...value };
}

function toolFilter(value, label) {
  if (value === undefined) return { allow: null, deny: [] };
  if (!record(value) || Object.keys(value).some(key => !['allow', 'deny'].includes(key))) {
    throw new McpConfigError(`${label}.tools 只能包含 allow 和 deny。`);
  }
  const allow = value.allow === undefined ? null : strings(value.allow, `${label}.tools.allow`, { max: 512, length: 128 });
  return { allow, deny: strings(value.deny, `${label}.tools.deny`, { max: 512, length: 128 }) };
}

function server(name, value) {
  const label = `mcpServers.${name}`;
  if (!mcpNamePattern.test(name)) {
    throw new McpConfigError(`MCP 名称「${name}」无效：请用 2–24 个小写字母、数字或连字符，以字母开头。`);
  }
  if (!record(value)) throw new McpConfigError(`${label} 必须是对象。`);
  const unknown = Object.keys(value).filter(key => !fields.has(key) && !ignored.has(key));
  if (unknown.length) throw new McpConfigError(`${label} 包含不支持的字段：${unknown.join('、')}。`);
  if (value.disabled !== undefined && typeof value.disabled !== 'boolean') throw new McpConfigError(`${label}.disabled 必须是 true 或 false。`);
  const common = { name, disabled: value.disabled === true, tools: toolFilter(value.tools, label) };
  const type = value.type ?? (value.command !== undefined ? 'stdio' : value.url !== undefined ? 'http' : undefined);
  if (type === 'stdio') {
    if (value.url !== undefined || value.headers !== undefined) throw new McpConfigError(`${label} 不能同时设置 command 和 url。`);
    if (!text(value.command, 1024)) throw new McpConfigError(`${label}.command 必须是要运行的命令。`);
    if (value.cwd !== undefined && !(text(value.cwd, 1024) && isAbsolute(value.cwd))) throw new McpConfigError(`${label}.cwd 必须是绝对路径。`);
    return { ...common, kind: 'stdio', command: value.command, args: strings(value.args, `${label}.args`),
      env: map(value.env, `${label}.env`, envName, 32768), ...(value.cwd !== undefined && { cwd: value.cwd }) };
  }
  if (type === 'http' || type === 'sse' || type === 'streamable-http') {
    if (value.command !== undefined || value.args !== undefined || value.env !== undefined || value.cwd !== undefined) {
      throw new McpConfigError(`${label} 不能同时设置 url 和 command。`);
    }
    const url = text(value.url, 2048) ? URL.parse(value.url) : null;
    // Only servers on this computer: Nodrelay is not a gateway to other hosts.
    if (!url || !['http:', 'https:'].includes(url.protocol) || !loopbackHosts.has(url.hostname) || url.username || url.password || url.hash) {
      throw new McpConfigError(`${label}.url 必须是本机地址，例如 http://127.0.0.1:3000/mcp。远程 MCP 可以直接添加到 Cloudflare MCP Portal。`);
    }
    const headers = map(value.headers, `${label}.headers`, headerName, 4096);
    if (Object.keys(headers).some(key => ['host', 'content-length', 'connection', 'transfer-encoding'].includes(key.toLowerCase()))) {
      throw new McpConfigError(`${label}.headers 不能设置 Host、Content-Length 等连接头。`);
    }
    return { ...common, kind: type === 'sse' ? 'sse' : 'http', url: url.href, headers };
  }
  throw new McpConfigError(`${label} 需要 command（本机命令）或 url（本机地址）。`);
}

// Parse the device's MCP file. Returns every server, sorted by name, each with
// a fingerprint that changes whenever its effective settings change.
export function parseMcpConfig(source) {
  let value;
  try { value = JSON.parse(source); } catch { throw new McpConfigError('MCP 配置不是有效的 JSON。'); }
  if (!record(value) || Object.keys(value).some(key => key !== 'mcpServers') || !record(value.mcpServers ?? {})) {
    throw new McpConfigError('MCP 配置的顶层只能是 { "mcpServers": { … } }。');
  }
  const entries = Object.entries(value.mcpServers ?? {});
  if (entries.length > maxServers) throw new McpConfigError(`最多配置 ${maxServers} 个 MCP。`);
  const servers = entries.map(([name, item]) => server(name, item)).sort((a, b) => a.name.localeCompare(b.name));
  if (servers.filter(item => !item.disabled).length > maxEnabledServers) {
    throw new McpConfigError(`同时启用的 MCP 最多 ${maxEnabledServers} 个，请用 "disabled": true 停用一部分。`);
  }
  return servers.map(item => ({ ...item, fingerprint: JSON.stringify(item) }));
}

export function toolAllowed(entry, name) {
  return (entry.tools.allow === null || entry.tools.allow.includes(name)) && !entry.tools.deny.includes(name);
}

// The serialised form written back by the CLI. Keeps the shape other MCP
// clients understand and omits defaults.
export function serializeServer(entry) {
  const out = entry.kind === 'stdio'
    ? { command: entry.command, ...(entry.args.length && { args: entry.args }), ...(Object.keys(entry.env).length && { env: entry.env }),
      ...(entry.cwd && { cwd: entry.cwd }) }
    : { ...(entry.kind === 'sse' && { type: 'sse' }), url: entry.url, ...(Object.keys(entry.headers).length && { headers: entry.headers }) };
  if (entry.tools.allow !== null || entry.tools.deny.length) {
    out.tools = { ...(entry.tools.allow !== null && { allow: entry.tools.allow }), ...(entry.tools.deny.length && { deny: entry.tools.deny }) };
  }
  if (entry.disabled) out.disabled = true;
  return out;
}

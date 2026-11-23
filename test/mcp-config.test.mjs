import assert from 'node:assert/strict';
import test from 'node:test';
import { McpConfigError, parseMcpConfig, serializeServer, toolAllowed } from '../src/mcp-config.mjs';

const parse = servers => parseMcpConfig(JSON.stringify({ mcpServers: servers }));

test('a Claude Desktop style file parses unchanged, sorted, with Nodrelay extras', () => {
  const servers = parse({
    github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_TOKEN: 'x' }, autoApprove: [] },
    files: { command: '/usr/local/bin/mcp-files', cwd: '/Users/me', tools: { allow: ['read'], deny: ['write'] } },
    local: { url: 'http://127.0.0.1:3001/mcp', headers: { Authorization: 'Bearer t' } },
    events: { type: 'sse', url: 'http://localhost:8080/sse', disabled: true },
  });
  assert.deepEqual(servers.map(server => [server.name, server.kind, server.disabled]),
    [['events', 'sse', true], ['files', 'stdio', false], ['github', 'stdio', false], ['local', 'http', false]]);
  const files = servers[1];
  assert.equal(toolAllowed(files, 'read'), true);
  assert.equal(toolAllowed(files, 'write'), false);
  assert.equal(toolAllowed(files, 'other'), false);
  assert.equal(toolAllowed(servers[2], 'anything'), true);
  assert.deepEqual(serializeServer(servers[2]), { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_TOKEN: 'x' } });
  assert.deepEqual(serializeServer(servers[0]), { type: 'sse', url: 'http://localhost:8080/sse', disabled: true });
  assert.notEqual(servers[1].fingerprint, servers[2].fingerprint);
});

test('only servers on this computer, valid names and known fields are accepted', () => {
  for (const [servers, message] of [
    [{ My_Server: { command: 'x' } }, /名称/],
    [{ a: { command: 'x' } }, /名称/],
    [{ remote: { url: 'https://mcp.example.com/mcp' } }, /本机地址/],
    [{ remote: { url: 'http://192.168.1.2:3000/mcp' } }, /本机地址/],
    [{ creds: { url: 'http://user:pass@127.0.0.1/mcp' } }, /本机地址/],
    [{ both: { command: 'x', url: 'http://127.0.0.1/mcp' } }, /同时/],
    [{ none: {} }, /command/],
    [{ typo: { command: 'x', arg: [] } }, /不支持的字段：arg/],
    [{ cwd: { command: 'x', cwd: 'relative/dir' } }, /绝对路径/],
    [{ hdr: { url: 'http://127.0.0.1/mcp', headers: { Host: 'x' } } }, /连接头/],
    [{ hdr: { url: 'http://127.0.0.1/mcp', headers: { 'X-A': 'a\r\nInjected: 1' } } }, /无效/],
    [{ env: { command: 'x', env: { 'BAD-NAME': 'v' } } }, /无效/],
    [{ filter: { command: 'x', tools: { only: [] } } }, /allow 和 deny/],
  ]) assert.throws(() => parse(servers), error => error instanceof McpConfigError && message.test(error.message), JSON.stringify(servers));
  assert.throws(() => parseMcpConfig('{ nope'), /JSON/);
  assert.throws(() => parseMcpConfig('{"servers":{}}'), /顶层/);
  const many = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`s${i}x`, { command: 'x' }]));
  assert.throws(() => parse(many), /最多 16/);
  assert.equal(parse({ ...many, s0x: { command: 'x', disabled: true } }).length, 17);
  assert.deepEqual(parseMcpConfig('{}'), []);
});

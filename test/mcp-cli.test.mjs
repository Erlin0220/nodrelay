import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runMcpCli } from '../src/mcp-cli.mjs';

const skip = process.platform === 'win32' && 'POSIX file modes';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'nodrelay-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'fake-mcp'), '#!/bin/sh\n');
  await chmod(join(bin, 'fake-mcp'), 0o755);
  const lines = [];
  const run = (...argv) => runMcpCli(['mcp', ...argv], { root, out: line => lines.push(line), env: { PATH: bin + ':/usr/bin' } });
  const config = async () => JSON.parse(await readFile(join(root, 'mcp.json'), 'utf8')).mcpServers;
  return { root, bin, lines, run, config };
}

test('add records an absolute command and the shell PATH, list shows Portal sync state', { skip }, async t => {
  const f = await fixture(t);
  assert.equal(await f.run('add', 'files', '--env', 'ROOT=/data', '--deny', 'delete,move', '--', 'fake-mcp', '--root', '/data'), 0);
  assert.deepEqual((await f.config()).files, { command: join(f.bin, 'fake-mcp'), args: ['--root', '/data'],
    env: { PATH: f.bin + ':/usr/bin', ROOT: '/data' }, tools: { deny: ['delete', 'move'] } });
  assert.equal((await stat(join(f.root, 'mcp.json'))).mode & 0o777, 0o600);
  assert.equal(await f.run('add', 'api', '--url', 'http://127.0.0.1:3000/mcp', '--header', 'Authorization: Bearer x'), 0);
  assert.deepEqual((await f.config()).api, { url: 'http://127.0.0.1:3000/mcp', headers: { Authorization: 'Bearer x' } });
  await assert.rejects(f.run('add', 'files', '--', 'fake-mcp'), /已存在/);
  await assert.rejects(f.run('add', 'missing', '--', 'not-installed-anywhere'), /找不到命令/);
  await assert.rejects(f.run('add', 'remote', '--url', 'https://mcp.example.com/mcp'), /本机地址/);
  await assert.rejects(f.run('add', 'Bad', '--', 'fake-mcp'), /名称/);

  await writeFile(join(f.root, 'connection-status.json'), JSON.stringify({ status: 'active',
    servers: [{ name: 'api', status: 'registered' }, { name: 'files', status: 'pending', reason: 'http_error' }] }));
  f.lines.length = 0;
  await f.run('list');
  assert.match(f.lines.join('\n'), /api\s+http\s+已注册到 Portal/);
  assert.match(f.lines.join('\n'), /files\s+stdio\s+等待注册（http_error）/);

  await f.run('disable', 'api');
  assert.equal((await f.config()).api.disabled, true);
  await f.run('enable', 'api');
  assert.equal((await f.config()).api.disabled, undefined);
  await f.run('remove', 'files');
  assert.deepEqual(Object.keys(await f.config()), ['api']);
  await assert.rejects(f.run('remove', 'files'), /没有名为/);
});

test('import takes valid Claude Desktop entries and explains the ones it skips', { skip }, async t => {
  const f = await fixture(t);
  const source = join(f.root, 'claude_desktop_config.json');
  await writeFile(source, JSON.stringify({ mcpServers: {
    github: { command: 'fake-mcp', args: ['github'], env: { GITHUB_TOKEN: 't' } },
    My_Notes: { command: 'fake-mcp' },
    remote: { url: 'https://example.com/mcp' },
  } }));
  await f.run('import', source);
  assert.deepEqual(Object.keys(await f.config()), ['github']);
  assert.equal((await f.config()).github.env.GITHUB_TOKEN, 't');
  assert.match(f.lines.join('\n'), /跳过 My_Notes：MCP 名称/);
  assert.match(f.lines.join('\n'), /跳过 remote：.*本机地址/);
  f.lines.length = 0;
  await f.run('import', source, '--only', 'github');
  assert.match(f.lines.join('\n'), /跳过 github：已存在/);
  await f.run('import', source, '--only', 'github', '--replace');
  assert.match(f.lines.join('\n'), /已导入 1 个/);
});

test('the installed launcher runs the CLI for its own instance', { skip }, async t => {
  const f = await fixture(t);
  const cli = fileURLToPath(new URL('../src/mcp-cli.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [cli, f.root, 'mcp', 'path'], { encoding: 'utf8' });
  assert.equal(result.stdout.trim(), join(f.root, 'mcp.json'));
  const failed = spawnSync(process.execPath, [cli, f.root, 'mcp', 'remove', 'nothing'], { encoding: 'utf8' });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /没有名为/);
});

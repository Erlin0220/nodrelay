import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, readFile, rename, rm, stat } from 'node:fs/promises';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { McpConfigError, mcpNamePattern, parseMcpConfig, serializeServer } from './mcp-config.mjs';
import { readPrivateFile, writePrivateFile } from './private-directory.mjs';

const usage = `用法：
  nodrelay mcp list
  nodrelay mcp add <名称> [--env 名=值]… [--cwd 目录] [--allow 工具,…] [--deny 工具,…] -- <命令> [参数…]
  nodrelay mcp add <名称> --url http://127.0.0.1:<端口>/mcp [--header '名: 值']… [--sse] [--allow …] [--deny …]
  nodrelay mcp import <claude_desktop_config.json 或 .vscode/mcp.json> [--only 名称,…] [--replace]
  nodrelay mcp enable|disable|remove <名称>
  nodrelay mcp path`;

const stateText = { registered: '已注册到 Portal', pending: '等待注册' };

async function load(file) {
  const text = await readPrivateFile(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  return text === null ? [] : parseMcpConfig(text);
}

async function save(file, entries) {
  const value = { mcpServers: Object.fromEntries(entries.map(entry => [entry.name, serializeServer(entry)])) };
  const text = JSON.stringify(value, null, 2) + '\n';
  parseMcpConfig(text);
  const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    await writePrivateFile(temporary, text);
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

// A service starts with a minimal PATH. Record where the command and its own
// helpers (for example node for npx) live, as seen from this shell.
async function resolveCommand(command, env, platform) {
  if (isAbsolute(command) || command.includes('/') || command.includes('\\')) return resolve(command);
  const extensions = platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean) : [];
  for (const directory of (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : delimiter).filter(Boolean)) {
    for (const extension of ['', ...extensions]) {
      const candidate = join(directory, command + extension);
      try {
        if ((await stat(candidate)).isFile()) {
          if (platform !== 'win32') await access(candidate, constants.X_OK);
          return candidate;
        }
      } catch { /* not in this directory */ }
    }
  }
  throw new McpConfigError(`在当前 PATH 里找不到命令「${command}」。请先在这台电脑上安装它，或写出它的绝对路径。`);
}

function pairs(values, separator, label) {
  return Object.fromEntries(values.map(value => {
    const index = value.indexOf(separator);
    if (index < 1) throw new McpConfigError(`${label} 的格式应为 名${separator}值：${value}`);
    return [value.slice(0, index).trim(), value.slice(index + separator.length).trim()];
  }));
}

const list = value => value.split(',').map(item => item.trim()).filter(Boolean);

function parseAdd(args) {
  const split = args.indexOf('--');
  const options = split === -1 ? args : args.slice(0, split);
  const command = split === -1 ? [] : args.slice(split + 1);
  const [name, ...rest] = options;
  const result = { name, env: [], headers: [], command };
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    const value = () => {
      if (i + 1 >= rest.length) throw new McpConfigError(`${flag} 需要一个值。`);
      return rest[++i];
    };
    if (flag === '--env') result.env.push(value());
    else if (flag === '--header') result.headers.push(value());
    else if (flag === '--cwd') result.cwd = value();
    else if (flag === '--url') result.url = value();
    else if (flag === '--allow') result.allow = list(value());
    else if (flag === '--deny') result.deny = list(value());
    else if (flag === '--sse') result.sse = true;
    else throw new McpConfigError(`不认识的选项：${flag}\n${usage}`);
  }
  return result;
}

const describe = entry => entry.kind === 'stdio' ? [entry.command, ...entry.args].join(' ') : entry.url;

export async function runMcpCli(argv, { root, out = console.log, env = process.env, platform = process.platform } = {}) {
  const [area, action, ...args] = argv;
  if (area !== 'mcp' || !action) { out(usage); return area === 'mcp' ? 0 : 2; }
  const file = join(root, 'mcp.json');
  const entries = await load(file);
  const find = name => entries.findIndex(entry => entry.name === name);

  if (action === 'path') { out(file); return 0; }
  if (action === 'list') {
    let sync = {};
    try {
      const status = JSON.parse(await readFile(join(root, 'connection-status.json'), 'utf8'));
      for (const item of status.servers ?? []) sync[item.name] = item;
      if (status.mcpConfigError) out(`配置有误，Portal 仍使用上次的有效配置：${status.mcpConfigError}`);
    } catch { sync = {}; }
    if (!entries.length) {
      out(`这台设备还没有配置本机 MCP（${file}）。\n用 nodrelay mcp add 或 nodrelay mcp import 添加。`);
      return 0;
    }
    out(`本机 MCP（${file}）`);
    for (const entry of entries) {
      const known = sync[entry.name];
      const state = entry.disabled ? '已停用' : known ? stateText[known.status] + (known.reason ? `（${known.reason}）` : '') : '等待同步';
      out(`  ${entry.name.padEnd(16)} ${entry.kind.padEnd(5)} ${state.padEnd(10)} ${describe(entry)}`);
    }
    return 0;
  }

  if (action === 'add') {
    const input = parseAdd(args);
    if (!mcpNamePattern.test(input.name ?? '')) throw new McpConfigError('请给 MCP 起一个 2–24 字符的名称：小写字母、数字或连字符，以字母开头。');
    if (find(input.name) !== -1) throw new McpConfigError(`「${input.name}」已存在。先运行 nodrelay mcp remove ${input.name}。`);
    let raw;
    if (input.url !== undefined) {
      if (input.command.length || input.env.length || input.cwd) throw new McpConfigError('--url 不能和命令、--env、--cwd 一起使用。');
      raw = { ...(input.sse && { type: 'sse' }), url: input.url, ...(input.headers.length && { headers: pairs(input.headers, ':', '--header') }) };
    } else {
      if (!input.command.length) throw new McpConfigError(`请在 -- 之后写出启动 MCP 的命令。\n${usage}`);
      if (input.headers.length || input.sse) throw new McpConfigError('--header 和 --sse 只能和 --url 一起使用。');
      const variables = pairs(input.env, '=', '--env');
      raw = { command: await resolveCommand(input.command[0], env, platform), ...(input.command.length > 1 && { args: input.command.slice(1) }),
        env: { ...(env.PATH && !variables.PATH && { PATH: env.PATH }), ...variables }, ...(input.cwd && { cwd: resolve(input.cwd) }) };
    }
    if (input.allow || input.deny) raw.tools = { ...(input.allow && { allow: input.allow }), ...(input.deny && { deny: input.deny }) };
    const [entry] = parseMcpConfig(JSON.stringify({ mcpServers: { [input.name]: raw } }));
    await save(file, [...entries, entry]);
    out(`已添加 ${input.name}：${describe(entry)}\n设备服务会在几秒内把它注册到 MCP Portal。用 nodrelay mcp list 查看状态。`);
    return 0;
  }

  if (action === 'import') {
    const [source, ...rest] = args;
    if (!source) throw new McpConfigError(usage);
    let only;
    let replace = false;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--only' && i + 1 < rest.length) only = list(rest[++i]);
      else if (rest[i] === '--replace') replace = true;
      else throw new McpConfigError(`不认识的选项：${rest[i]}`);
    }
    if ((await stat(source)).size > 1024 * 1024) throw new McpConfigError('要导入的文件太大。');
    let value;
    try { value = JSON.parse(await readFile(source, 'utf8')); } catch { throw new McpConfigError('要导入的文件不是有效的 JSON。'); }
    const servers = value?.mcpServers ?? value?.servers;
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) throw new McpConfigError('文件里没有 mcpServers 或 servers。');
    const next = [...entries];
    let added = 0;
    for (const [name, item] of Object.entries(servers)) {
      if (only && !only.includes(name)) continue;
      try {
        const copy = { ...item };
        if (typeof copy.command === 'string') {
          copy.command = await resolveCommand(copy.command, env, platform);
          copy.env = { ...(env.PATH && { PATH: env.PATH }), ...(copy.env ?? {}) };
        }
        const [entry] = parseMcpConfig(JSON.stringify({ mcpServers: { [name]: copy } }));
        const index = next.findIndex(existing => existing.name === name);
        if (index !== -1 && !replace) { out(`跳过 ${name}：已存在（加 --replace 覆盖）。`); continue; }
        if (index !== -1) next.splice(index, 1, entry); else next.push(entry);
        added++;
        out(`导入 ${name}：${describe(entry)}`);
      } catch (error) {
        if (!(error instanceof McpConfigError)) throw error;
        out(`跳过 ${name}：${error.message}`);
      }
    }
    if (added) await save(file, next);
    out(added ? `已导入 ${added} 个 MCP，设备服务会在几秒内同步到 Portal。` : '没有导入任何 MCP。');
    return 0;
  }

  if (['enable', 'disable', 'remove'].includes(action)) {
    const [name] = args;
    const index = find(name);
    if (index === -1) throw new McpConfigError(`没有名为「${name ?? ''}」的 MCP。`);
    const next = [...entries];
    if (action === 'remove') next.splice(index, 1);
    else next[index] = { ...next[index], disabled: action === 'disable' };
    await save(file, next);
    out({ enable: `已启用 ${name}。`, disable: `已停用 ${name}，它会从 Portal 移除。`, remove: `已删除 ${name}，它会从 Portal 移除。` }[action]);
    return 0;
  }
  out(usage);
  return 2;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [root, ...argv] = process.argv.slice(2);
  try { process.exitCode = await runMcpCli(argv, { root }); }
  catch (error) {
    console.error(error instanceof McpConfigError ? error.message : `操作失败：${error.message}`);
    process.exitCode = 1;
  }
}

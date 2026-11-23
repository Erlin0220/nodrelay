import { connect, createServer } from 'node:net';
import { readFile } from 'node:fs/promises';
import { setTimeout as wait } from 'node:timers/promises';

const roles = browser => [
  ['development', 7829, 'MCP'],
  ['runtime', 7830, 'Personal DevSpace'],
  ...(browser ? [['browser', 7831, '浏览器 MCP']] : []),
];
const requirements = browser => roles(browser).map(([, port, label]) => [port, label]);

// Fixed ports used by every installation made before port negotiation.
export const legacyPorts = browser => Object.fromEntries(roles(browser).map(([role, port]) => [role, port]));
export const portalPorts = ports => ({ development: ports.development, ...(ports.browser !== undefined && { browser: ports.browser }) });

export class LoopbackConflictError extends Error {
  constructor(ports, { negotiable = true } = {}) {
    super('本机端口已被占用：' + ports.map(([port, role]) => `${port}（${role}）`).join('、') +
      '。安装未领取设备票据，也没有停止占用端口的程序。' +
      (negotiable ? '' : '升级管理台后重新生成安装命令，新实例会自动改用空闲端口，与已有实例共存。'));
    this.ports = ports.map(([port]) => port);
  }
}

async function bind(port) {
  const listener = createServer(socket => socket.destroy());
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen({ host: '127.0.0.1', port, exclusive: true }, resolve);
  });
  return () => new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
}

async function reserve(port) {
  const listener = createServer(socket => socket.destroy());
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen({ host: '127.0.0.1', port, exclusive: true }, resolve);
  });
  return { port: listener.address().port,
    close: () => new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve())) };
}

// Choose this instance's loopback ports before any enrollment command is
// claimed. A fresh instance keeps the legacy ports while they are free. When
// another service owns one of them and the management console negotiates
// ports, take a complete set of kernel-assigned ports instead. Ports persisted
// by an earlier attempt are never replaced: the Tunnel may already route to them.
export async function chooseLoopbackPorts(browser, { negotiable = false, previous, open = reserve } = {}) {
  const wanted = previous ?? legacyPorts(browser);
  const held = [];
  const occupied = [];
  try {
    for (const [role, , label] of roles(browser)) {
      try { held.push(await open(wanted[role])); }
      catch (error) {
        if (error?.code !== 'EADDRINUSE') throw error;
        occupied.push([wanted[role], label]);
      }
    }
    if (!occupied.length) return { ...wanted };
    if (!negotiable || previous) throw new LoopbackConflictError(occupied, { negotiable });
    const chosen = {};
    // Keep every probe open until the whole set is chosen so no port repeats.
    for (const [role] of roles(browser)) {
      const reserved = await open(0);
      held.push(reserved);
      chosen[role] = reserved.port;
    }
    return chosen;
  } finally {
    await Promise.all(held.map(reserved => reserved.close()));
  }
}

export async function checkLegacyLoopback(browser, { open = bind, ports = requirements(browser) } = {}) {
  const available = [];
  const occupied = [];
  try {
    for (const [port, role] of ports) {
      try { available.push(await open(port)); }
      catch (error) {
        if (error?.code !== 'EADDRINUSE') throw error;
        occupied.push([port, role]);
      }
    }
    if (occupied.length) throw new LoopbackConflictError(occupied);
  } finally {
    await Promise.all(available.map(close => close()));
  }
}

export class LocalServiceError extends Error {
  constructor(missing, log) {
    super('本机后台服务已安装，但这些端口尚未开始监听：' + missing.map(([port, role]) => `${port}（${role}）`).join('、') +
      `。Cloudflare 与 Portal 尚未检查。服务会继续自动重试；启动错误记录在 ${log}。`);
    this.ports = missing.map(([port]) => port);
  }
}

const reachable = (port, timeout) => new Promise(resolve => {
  const socket = connect({ host: '127.0.0.1', port });
  const done = ok => { socket.destroy(); resolve(ok); };
  socket.setTimeout(timeout, () => done(false));
  socket.once('connect', () => done(true));
  socket.once('error', () => done(false));
});

// Confirm the local half of an installation before any Tunnel or Portal
// result is reported, so "not started here" is never mistaken for "not
// reachable through Cloudflare".
export async function waitForLocalServices(ports, { timeout = 45000, probe = reachable, sleep = wait, now = Date.now } = {}) {
  const expected = roles(ports.browser !== undefined).map(([role, , label]) => [ports[role], label]);
  const deadline = now() + timeout;
  let missing = expected;
  for (;;) {
    const results = await Promise.all(missing.map(([port]) => probe(port, 1000)));
    missing = missing.filter((_, index) => !results[index]);
    if (!missing.length || now() >= deadline) return missing;
    await sleep(Math.min(500, Math.max(0, deadline - now())));
  }
}

export async function waitForDeviceRegistration(file, startedAt, {
  timeout = 8000,
  load = async () => JSON.parse(await readFile(file, 'utf8')),
  sleep = wait,
  now = Date.now,
} = {}) {
  const deadline = now() + timeout;
  let last;
  do {
    const current = await load().catch(() => null);
    if (Date.parse(current?.observedAt) >= startedAt) {
      if (current.status === 'active' || current.status === 'revoked') return current;
      if (current.status === 'unconfirmed') last = current;
    }
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await sleep(Math.min(250, remaining));
  } while (now() <= deadline);
  return last ?? { status: 'unconfirmed' };
}

export function deviceRegistrationText(status) {
  if (status.status === 'active') return '设备已接入：管理台已确认 Portal 注册。';
  if (status.status === 'revoked') return '设备接入未完成：管理台已撤销此设备。';
  const reason = {
    route_unavailable: 'Cloudflare 尚未连通设备的 MCP 路由',
    unexpected_mcp: '设备 MCP 没有返回预期的协议或工具',
    tool_catalog_pending: 'Cloudflare 尚未同步设备工具',
    tunnel_pending: 'Cloudflare 隧道尚未完成注册',
  };
  const detail = Object.hasOwn(reason, status.reason) ? reason[status.reason] + '；' : '';
  const diagnostic = Number.isInteger(status.httpStatus) && status.httpStatus >= 400 && status.httpStatus <= 599
    ? `（HTTP ${status.httpStatus}）` : '';
  return `已请求启动本机后台服务，Portal 接入尚未确认${diagnostic}。${detail}后台服务会继续尝试；不用重新生成安装命令。`;
}

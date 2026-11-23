import { spawn } from 'node:child_process';
import { closeSync, openSync, unwatchFile, watchFile } from 'node:fs';
import { rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { checkConnection, monitorConnection } from './device-connection.mjs';
import { enabledMcpNames } from './mcp-proxy.mjs';
import { assertPrivateFile, readPrivateFile } from './private-directory.mjs';
import { validateCredentials } from '../cloud/tickets.mjs';

const config = JSON.parse(await readPrivateFile(process.argv[2]));
const dir = dirname(process.argv[2]);
const credentials = validateCredentials(JSON.parse(await readPrivateFile(join(dir, 'credentials.private.json'))));
const tunnelToken = join(dir, 'tunnel.token');
await assertPrivateFile(tunnelToken);
const children = [];
const stopped = new AbortController();
let verifyingExit = false;
function stop(fault = false) {
  if (stopped.signal.aborted) return;
  if (fault) process.exitCode = 1;
  stopped.abort();
  for (const child of children) child.kill();
}
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => stop());
async function checkChildExit() {
  if (stopped.signal.aborted || verifyingExit) return;
  verifyingExit = true;
  // Tunnel rotation can close cloudflared before its regular heartbeat runs.
  // Give an explicit revocation one bounded chance to reach this process.
  const status = await checkConnection(config, credentials.activationToken, stopped.signal, { timeout: 5000 });
  if (stopped.signal.aborted) return;
  if (status.status === 'revoked') await reportConnection(status);
  stop(!recordedRevocation);
}

// Adapter start-up failures go to a private log, so an installer that sees a
// port not listening can name the reason. cloudflared stays quiet: its routine
// connection logging would grow without bound.
const log = openSync(join(dir, 'service.log'), 'a', 0o600);
process.once('exit', () => { try { closeSync(log); } catch { /* already closed */ } });

function run(executable, args, { logged = false } = {}) {
  const child = spawn(executable, args, { stdio: ['ignore', logged ? log : 'ignore', logged ? log : 'ignore'], windowsHide: true });
  children.push(child);
  const check = () => void checkChildExit().catch(() => stop(true));
  child.once('error', check);
  child.once('exit', check);
}

let recordedRevocation = false;
let writes = Promise.resolve();
function reportConnection(status) {
  if (recordedRevocation) return writes;
  recordedRevocation = status.status === 'revoked';
  writes = writes.then(() => saveConnectionStatus(status));
  return writes;
}

async function saveConnectionStatus(status) {
  const file = join(dir, 'connection-status.json');
  const staged = file + '.' + crypto.randomUUID();
  try {
    await writeFile(staged, JSON.stringify({ ...status, observedAt: new Date().toISOString() }) + '\n', {
      flag: 'wx', mode: 0o600,
    });
    await rename(staged, file);
  } catch {
    await rm(staged, { force: true }).catch(() => {});
    console.error('Nodrelay connection status could not be saved.');
  }
  if (status.status === 'active') console.log('Cloudflare Portal registration is active.');
  else if (status.status === 'revoked') console.log('Nodrelay confirmed this device was revoked.');
  else console.error(`Nodrelay cannot confirm registration (${status.httpStatus ?? status.reason}); retrying.`);
}

if (config.deviceId !== credentials.deviceId) throw new Error('Device identity changed');
for (const profile of ['development', ...(credentials.browserToken ? ['browser'] : [])]) {
  run(process.execPath, [join(config.release, 'fleet', 'src', 'device.mjs'),
    join(dir, profile + '.private.json')], { logged: true });
}
run(config.cloudflared, ['tunnel', '--no-autoupdate', 'run', '--token-file', tunnelToken]);

// The adapter serves the device's mcp.json; this process tells the console
// which servers it offers. An edit wakes the next check instead of waiting
// for the regular interval.
const mcpFile = join(dir, 'mcp.json');
let wake = () => {};
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const abort = () => { clearTimeout(timer); reject(Object.assign(new Error('Stopped'), { name: 'AbortError' })); };
  const done = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); wake = () => {}; resolve(); };
  const timer = setTimeout(done, ms);
  wake = done;
  signal.addEventListener('abort', abort, { once: true });
});
watchFile(mcpFile, { interval: 2000, persistent: false }, () => wake());
stopped.signal.addEventListener('abort', () => unwatchFile(mcpFile), { once: true });

try {
  const state = await monitorConnection(config, credentials.activationToken, stopped.signal, {
    report: reportConnection, sleep, servers: () => enabledMcpNames(mcpFile),
  });
  if (state === 'revoked') stop();
} catch {
  stop(true);
}

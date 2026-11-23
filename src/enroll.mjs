import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { promisify } from 'node:util';
import { writePrivateFile } from './private-directory.mjs';
import { tokenPattern, validateCredentials } from '../cloud/tickets.mjs';

const exec = promisify(execFile);
const userMessage = message => process.stderr.write(message + '\n');

async function prepareDirectory(output) {
  await mkdir(output, { mode: 0o700 });
  if (process.platform !== 'win32') return;
  const system = join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  const { stdout } = await exec(join(system, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { windowsHide: true });
  const sid = /"(S-1-[0-9-]+)"\s*$/.exec(stdout)?.[1];
  if (!sid) throw new Error('Unable to verify the Windows account');
  await exec(join(system, 'icacls.exe'), [output, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`], { windowsHide: true });
}

let requested = false;
try {
  const manager = new URL(process.argv[2]);
  if (manager.protocol !== 'https:' || manager.href !== manager.origin + '/' || !process.argv[3]) throw new Error();
  const output = resolve(process.argv[3]);
  userMessage('Paste the single-use ticket, then press Enter.');
  const muted = new Writable({ write(_chunk, _encoding, done) { done(); } });
  const input = createInterface({ input: process.stdin, output: muted, terminal: process.stdin.isTTY ?? false });
  const ticket = await input.question('').finally(() => input.close());
  if (!tokenPattern.test(ticket)) throw new Error();
  await prepareDirectory(output);
  requested = true;
  const response = await fetch(new URL('/enroll', manager), {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket }),
  });
  if (!response.ok) {
    if (response.status === 404) requested = false;
    throw new Error();
  }
  const credentials = validateCredentials(await response.json());
  await writePrivateFile(join(output, 'tunnel.token'), credentials.tunnelToken + '\n');
  await writePrivateFile(join(output, 'portal.token'), credentials.portalToken + '\n');
  await writePrivateFile(join(output, 'device.json'), JSON.stringify({ deviceId: credentials.deviceId }) + '\n');
  console.log('Device credentials saved to a new private directory.');
} catch {
  userMessage(requested
    ? 'Enrollment outcome is uncertain. Review the target device and rotate credentials before reissuing.'
    : 'Enrollment refused. Check the ticket, management origin and the new output directory.');
  process.exitCode = 1;
}

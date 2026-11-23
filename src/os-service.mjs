import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { readPrivateFile } from './private-directory.mjs';

const exec = promisify(execFile);
const native = (command, args) => exec(command, args, { windowsHide: true, timeout: 30000, maxBuffer: 32768 });
const xml = value => String(value).replace(/[<>&"']/g, char => `&#${char.charCodeAt(0)};`);
const quote = value => '"' + value.replace(/([\\"])/g, '\\$1').replaceAll('%', '%%') + '"';
const osSystem = (...parts) => join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', ...parts);

export class LinuxUserServiceUnavailable extends Error {
  constructor() {
    super('The systemd user service is unavailable. Rerun the same install command while signed in to a Linux session with systemd user services enabled.');
  }
}

export async function verifyServiceManager() {
  if (process.platform !== 'linux') return;
  try {
    await exec('systemctl', ['--user', 'show', '--property=Version', '--value'], {
      timeout: 5000, maxBuffer: 8192,
    });
  } catch {
    throw new LinuxUserServiceUnavailable();
  }
}

async function writeUnit(path, contents, legacy) {
  await mkdir(dirname(path), { recursive: true });
  const read = () => legacy ? readPrivateFile(path) : readFile(path, 'utf8');
  const existing = await read().catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (existing === contents) return;
  if (legacy && existing === legacy) {
    const stage = path + '.tmp-' + randomUUID();
    await writeFile(stage, contents, { mode: 0o600, flag: 'wx' });
    try {
      if (await read() !== legacy) throw new Error('The local background service changed during repair');
      await rename(stage, path);
    } finally { await rm(stage, { force: true }); }
    return true;
  }
  if (existing !== undefined) throw new Error('An unrelated local background service already has this name');
  await writeFile(path, contents, { mode: 0o600, flag: 'wx' });
}

export function launchAgent(id, executable, args, root) {
  const contents = [executable, ...args].map(part => `<string>${xml(part)}</string>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>Label</key><string>${id}</string>
  <key>ProgramArguments</key><array>${contents}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer><key>WorkingDirectory</key><string>${xml(root)}</string></dict></plist>\n`;
}

function renderSystemdUnit(id, executable, args, root, literal = false) {
  return `[Unit]\nDescription=${id}\nAfter=network-online.target\n[Service]\nType=simple\nWorkingDirectory=${root.replaceAll('%', '%%')}
ExecStart=${literal ? ':' : ''}${[executable, ...args].map(quote).join(' ')}\nRestart=on-failure\nRestartSec=10\nKillMode=control-group
[Install]\nWantedBy=default.target\n`;
}

export function systemdUnit(id, executable, args, root) {
  // Quoting doesn't disable systemd's argv environment substitution.
  // Leave existing units without dollars byte-for-byte unchanged.
  return renderSystemdUnit(id, executable, args, root, [executable, ...args].some(value => value.includes('$')));
}

async function windows(id, executable, args, root) {
  const { stdout } = await native(osSystem('whoami.exe'), ['/user', '/fo', 'csv', '/nh']);
  const sid = /"(S-1-[0-9-]+)"\s*$/.exec(stdout)?.[1];
  if (!sid) throw new Error('Windows could not verify the interactive user');
  const launchArgs = args.map(value => `"${value.replaceAll('"', '\\"')}"`).join(' ');
  const content = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
<RegistrationInfo><Description>${id}</Description></RegistrationInfo>
<Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${sid}</UserId></LogonTrigger></Triggers>
<Principals><Principal id="User"><UserId>${sid}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
<Settings><Hidden>true</Hidden><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>true</StartWhenAvailable><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure></Settings>
<Actions Context="User"><Exec><Command>${xml(executable)}</Command><Arguments>${xml(launchArgs)}</Arguments><WorkingDirectory>${xml(root)}</WorkingDirectory></Exec></Actions></Task>`;
  const task = osSystem('schtasks.exe');
  const found = await native(task, ['/Query', '/TN', id, '/XML']).catch(() => undefined);
  if (found) {
    const element = name => new RegExp(`<${name}>([^<]*)</${name}>`).exec(found.stdout)?.[1]
      .replace(/&(?:amp|lt|gt|quot|apos|#[0-9]+);/g, entity => entity.startsWith('&#')
        ? String.fromCharCode(Number(entity.slice(2, -1)))
        : { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" }[entity]);
    if (element('Description') !== id || element('Command') !== executable || element('Arguments') !== launchArgs ||
        !found.stdout.includes(`<UserId>${sid}</UserId>`)) throw new Error('Unexpected Windows task ownership');
  } else {
    const file = join(root, 'fleet-service.xml');
    await writeFile(file, '\ufeff' + content, { encoding: 'utf16le', mode: 0o600 });
    await native(task, ['/Create', '/TN', id, '/XML', file]);
  }
  await native(task, ['/Run', '/TN', id]);
}

export async function installService(id, executable, args, root) {
  if (!/^devspace-fleet-[a-f0-9]{12}$/.test(id) ||
      [executable, root, ...args].some(value => /[\r\n\0]/.test(value))) throw new Error('Invalid service identity');
  if (process.platform === 'win32') return windows(id, executable, args, root);
  if (process.platform === 'darwin') {
    const domain = `gui/${process.getuid()}`;
    const file = join(homedir(), 'Library', 'LaunchAgents', id + '.plist');
    await writeUnit(file, launchAgent(id, executable, args, root));
    const active = await native('/bin/launchctl', ['print', domain + '/' + id]).then(() => true, () => false);
    if (!active) await native('/bin/launchctl', ['bootstrap', domain, file]);
    return;
  }
  if (process.platform === 'linux') {
    const unit = id + '.service';
    const desired = systemdUnit(id, executable, args, root);
    const legacy = renderSystemdUnit(id, executable, args, root);
    const migrated = await writeUnit(join(homedir(), '.config', 'systemd', 'user', unit), desired,
      desired !== legacy ? legacy : undefined);
    await native('systemctl', ['--user', 'daemon-reload']);
    if (migrated) await native('systemctl', ['--user', 'try-restart', unit]);
    await native('systemctl', ['--user', 'enable', '--now', unit]);
    return;
  }
  throw new Error('Unsupported local service manager');
}

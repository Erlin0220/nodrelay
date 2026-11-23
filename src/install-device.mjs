import { enrollPath } from '../cloud/device-paths.mjs';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { access, cp, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { devicePattern, tokenPattern, validateCredentials, validateDevicePorts } from '../cloud/tickets.mjs';
import { installService, LinuxUserServiceUnavailable, verifyServiceManager } from './os-service.mjs';
import { chooseLoopbackPorts, deviceRegistrationText, legacyPorts, LocalServiceError, LoopbackConflictError, portalPorts,
  waitForDeviceRegistration, waitForLocalServices } from './device-install-status.mjs';
import { claimDeviceEnrollment, EnrollmentClaimError } from './enrollment-claim-client.mjs';
import { assertPrivateFile, ensurePrivateDirectory, readPrivateFile, writePrivateFile } from './private-directory.mjs';

const exec = promisify(execFile);
const knownPlatforms = { darwin: 'macos', win32: 'windows', linux: 'linux' };
const windows = process.platform === 'win32';
const program = name => name + (windows ? '.exe' : '');
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const privateJson = async path => JSON.parse(await readPrivateFile(path));
const secretJson = (path, value) => writePrivateFile(path, JSON.stringify(value));
const repairRequired = 'Same-version repair requires the existing local installation and credentials.';
const replacementRequired = 'A different Nodrelay release or device is installed. Follow the manual replacement procedure.';

async function saveOnce(path, data) {
  try { await writePrivateFile(path, data); }
  catch (error) {
    if (error.code !== 'EEXIST' || (await readPrivateFile(path)) !== data) throw error;
  }
}
const saveJsonOnce = (path, value) => saveOnce(path, JSON.stringify(value));

function savedPorts(value, browser) {
  const { schema, runtime, ...portal } = value ?? {};
  let checked;
  try { checked = validateDevicePorts(portal, browser); } catch { /* reported below */ }
  if (schema !== 1 || !checked || !Number.isInteger(runtime) || runtime < 1024 || runtime > 65535 ||
      Object.values(checked).includes(runtime)) throw new Error('The Nodrelay state has invalid local ports. Follow the manual replacement procedure.');
  return { ...checked, runtime };
}

async function redeem(manager, ticket) {
  const response = await fetch(manager + enrollPath, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket }),
  });
  if (!response.ok) throw new Error('Enrollment did not return credentials. Issue a fresh ticket if the first response was lost.');
  return validateCredentials(await response.json());
}

export async function stageDeviceRelease(source, release, manifest) {
  const versionMarker = join(release, 'bundle.json');
  const installed = await json(versionMarker).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return undefined;
  });
  if (installed !== undefined) {
    if (JSON.stringify(installed) !== JSON.stringify(manifest)) throw new Error('A different local payload uses this release version');
    return;
  }
  const staged = await mkdtemp(release + '.stage-');
  const payload = join(staged, 'payload');
  try {
    // Preserve npm bin links as links within the release, not paths back
    // into the bootstrap extraction directory, which is removed on exit.
    await cp(source, payload, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
    await rename(payload, release);
  } finally {
    await rm(staged, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
  }
}

async function main() {
  const [archive, option, ...extra] = process.argv.slice(2);
  if (!archive || (option !== undefined && option !== '--repair') || extra.length) throw new Error('Invalid installer arguments');
  const repair = option === '--repair';
  const managerValue = new URL(process.env.DEVSPACE_FLEET_MANAGER ?? '');
  const ticket = process.env.DEVSPACE_FLEET_TICKET;
  const deviceId = process.env.DEVSPACE_FLEET_DEVICE;
  const protocol = process.env.DEVSPACE_FLEET_ENROLLMENT_PROTOCOL;
  const archiveSha256 = process.env.DEVSPACE_FLEET_ASSET_SHA256;
  const portProtocol = process.env.DEVSPACE_FLEET_PORT_PROTOCOL;
  delete process.env.DEVSPACE_FLEET_ENROLLMENT_PROTOCOL;
  delete process.env.DEVSPACE_FLEET_ASSET_SHA256;
  delete process.env.DEVSPACE_FLEET_PORT_PROTOCOL;
  if (protocol !== undefined && (protocol !== 'intent-v1' || !/^[a-f0-9]{64}$/.test(archiveSha256 ?? ''))) {
    throw new EnrollmentClaimError('invalid_claim', 'The pinned installer did not pass validated enrollment parameters');
  }
  if (portProtocol !== undefined && (portProtocol !== 'v1' || protocol !== 'intent-v1')) {
    throw new EnrollmentClaimError('invalid_claim', 'The pinned installer passed an unsupported port protocol');
  }
  // Only a management console that routes Tunnels to device-chosen ports sets this.
  const negotiable = portProtocol === 'v1';
  delete process.env.DEVSPACE_FLEET_DEVICE;
  delete process.env.DEVSPACE_FLEET_TICKET;
  delete process.env.DEVSPACE_FLEET_MANAGER;
  if (managerValue.protocol !== 'https:' || managerValue.href !== managerValue.origin + '/' ||
      (!repair && !tokenPattern.test(ticket ?? '')) || !devicePattern.test(deviceId ?? '')) throw new Error('Invalid Nodrelay connection command');
  const manager = managerValue.origin;
  const source = resolve(archive);
  const manifest = await json(join(source, 'bundle.json'));
  const platform = knownPlatforms[process.platform] + '-' + process.arch;
  if (manifest.schema !== 1 || platform !== manifest.platform ||
      !/^[0-9][A-Za-z0-9._-]{0,39}$/.test(manifest.version ?? '')) throw new Error('Installer is incompatible with this operating system or CPU');
  const browser = manifest.browser === true;
  const base = join(homedir(), '.devspace-fleet');
  const fingerprint = createHash('sha256').update(manager).digest('hex').slice(0, 12);
  const root = join(base, fingerprint);
  const rootExists = await access(root).then(() => true, error => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
  if (repair && !rootExists) throw new Error(repairRequired);
  console.log('1/5 检查系统、安装包和本机端口…');
  await verifyServiceManager();
  // A fresh instance chooses its ports before it creates any local state.
  let ports = rootExists ? undefined : await chooseLoopbackPorts(browser, { negotiable });
  await ensurePrivateDirectory(base);
  await ensurePrivateDirectory(root);
  for (const file of ['tunnel.token', 'development.token', 'browser.token',
    'development.private.json', 'browser.private.json', 'browser-backend.private.json', 'personal/auth.json', 'ports.private.json']) {
    await assertPrivateFile(join(root, file)).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
  const release = join(root, 'release-' + manifest.version);
  const serviceConfig = join(root, 'service.private.json');
  const existingService = await privateJson(serviceConfig).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (repair && !existingService) throw new Error(repairRequired);
  if (existingService && (existingService.manager !== manager || existingService.release !== release || existingService.deviceId !== deviceId)) {
    throw new Error(replacementRequired);
  }
  const state = join(root, 'credentials.private.json');
  let credentials = await privateJson(state).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (repair && !credentials) throw new Error(repairRequired);
  const portsFile = join(root, 'ports.private.json');
  const saved = await privateJson(portsFile).catch(error => { if (error.code !== 'ENOENT') throw error; });
  // Installations made before port negotiation always used the legacy ports.
  if (saved !== undefined) ports = savedPorts(saved, browser);
  else if (existingService || credentials) ports = legacyPorts(browser);
  // An established same-instance service already owns its ports. Never stop it
  // merely to test availability. Any other instance checks before claiming, and
  // never changes ports an earlier attempt may already have routed.
  if (rootExists && !existingService) ports = await chooseLoopbackPorts(browser, { negotiable, previous: ports });
  if (saved === undefined && !existingService) await saveJsonOnce(portsFile, { schema: 1, ...ports });
  if (browser) {
    const preflight = join(source, 'browser', 'preflight.mjs');
    const hasPreflight = await access(preflight).then(() => true, error => {
      if (error.code !== 'ENOENT') throw error;
      return false;
    });
    if (hasPreflight) {
      await exec(join(source, 'bin', program('node')), [preflight], { windowsHide: true, timeout: 55000 })
        .catch(() => { throw new Error('The Nodrelay browser backend is unavailable. Check its private configuration and browser-only tool catalog.'); });
    }
  }
  console.log('2/5 确认设备授权…');
  if (!credentials) {
    await access(join(source, 'personal', 'dist', 'server.js'));
    await access(join(source, 'bin', program('cloudflared')));
    credentials = protocol === 'intent-v1' ? await claimDeviceEnrollment({
      manager, root, code: ticket, deviceId, platform: knownPlatforms[process.platform],
      architecture: process.arch, version: manifest.version, sha256: archiveSha256, browser,
      ...(negotiable && { ports: portalPorts(ports) }),
    }) : await redeem(manager, ticket);
    if (credentials.deviceId !== deviceId) throw new Error('The ticket belongs to a different device');
    await secretJson(state, credentials);
  }
  credentials = validateCredentials(credentials);
  if (credentials.deviceId !== deviceId) throw new Error('The local installation belongs to a different device');
  if (Boolean(credentials.browserToken) !== browser) throw new Error('The approved bundle and device browser authorization differ');
  if (JSON.stringify(credentials.ports ?? portalPorts(legacyPorts(browser))) !== JSON.stringify(portalPorts(ports))) {
    throw new Error('The Nodrelay state ports differ from the management console route. Follow the manual replacement procedure.');
  }
  console.log('3/5 安装并配置本机运行组件…');
  await stageDeviceRelease(source, release, manifest);

  const node = join(release, 'bin', program('node'));
  const app = (...parts) => join(release, 'fleet', 'src', ...parts);
  const tunnel = join(release, 'bin', program('cloudflared'));
  await exec(node, [app('prepare-personal.mjs'), join(release, 'personal'), root, String(ports.runtime)], { windowsHide: true, timeout: 90000 });
  await saveOnce(join(root, 'tunnel.token'), credentials.tunnelToken + '\n');
  await saveOnce(join(root, 'development.token'), credentials.portalToken + '\n');
  await saveJsonOnce(join(root, 'development.private.json'), {
    schema: 1, deviceId: credentials.deviceId, profile: 'development', port: ports.development,
    portalTokenFile: join(root, 'development.token'),
    backend: { url: `http://127.0.0.1:${ports.runtime}/mcp`, tokenFile: join(root, 'personal', 'auth.json'), tokenKey: 'apiToken' },
  });
  if (credentials.browserToken) {
    const bootstrap = join(release, 'browser', 'setup.mjs');
    await exec(node, [bootstrap, root], { windowsHide: true, timeout: 90000 });
    await saveOnce(join(root, 'browser.token'), credentials.browserToken + '\n');
    await saveJsonOnce(join(root, 'browser.private.json'), {
      schema: 1, deviceId: credentials.deviceId, profile: 'browser', port: ports.browser,
      portalTokenFile: join(root, 'browser.token'), backend: await privateJson(join(root, 'browser-backend.private.json')),
    });
  }
  await saveJsonOnce(serviceConfig, { manager, release, cloudflared: tunnel, deviceId: credentials.deviceId });
  console.log('4/5 启动本机后台服务…');
  const requestedAt = Date.now();
  await installService('devspace-fleet-' + fingerprint, node, [app('device-service.mjs'), serviceConfig], root);
  const missing = await waitForLocalServices(ports);
  if (missing.length) throw new LocalServiceError(missing, join(root, 'service.log'));
  console.log(`本机服务已启动：MCP ${ports.development}、Runtime ${ports.runtime}${ports.browser ? `、浏览器 MCP ${ports.browser}` : ''}。`);
  console.log('5/5 等待管理台确认设备接入…');
  const status = await waitForDeviceRegistration(join(root, 'connection-status.json'), requestedAt);
  console.log(deviceRegistrationText(status));
  if (status.status === 'revoked') process.exitCode = 1;
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try { await main(); }
  catch (error) {
    if (error instanceof EnrollmentClaimError || error instanceof LinuxUserServiceUnavailable || error instanceof LoopbackConflictError ||
        error instanceof LocalServiceError ||
        error.message === repairRequired || error.message === replacementRequired ||
        error.message?.startsWith('The Nodrelay state ') || error.message?.startsWith('The Nodrelay browser backend ')) console.error(error.message);
    else console.error('Nodrelay installation stopped. Verify the release, local service manager and enrollment state.');
    if (error.exitCode) console.error('The platform installer did not complete.');
    process.exitCode = 1;
  }
}

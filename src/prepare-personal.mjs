import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { assertPrivateFile, ensurePrivateDirectory, readPrivateFile, writePrivateFile } from './private-directory.mjs';
import { pathToFileURL } from 'node:url';

export async function preparePersonal(runtime, privateRoot, { platform = process.platform, env = process.env, port = 7830 } = {}) {
  if (!runtime || !privateRoot) throw new Error('Personal Runtime payload is required');
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid Personal Runtime port');
  const asset = file => import(pathToFileURL(join(runtime, 'personal', file)).href);
  const { atomicJson, secureStateDirectory } = await asset('state.mjs');
  const { jobAction, registerJobs, registerDesktopEntries, taskXml } = await asset('desktop/platform.mjs');
  const personalHome = join(privateRoot, 'personal');
  if (platform === 'win32' && (typeof taskXml !== 'function' || !taskXml({
    home: personalHome, component: 'runtime', root: runtime, node: process.execPath,
    sid: 'S-1-5-0', runLevel: 'LeastPrivilege',
  }).includes('<RunLevel>LeastPrivilege</RunLevel>'))) {
    throw new Error('The Windows Runtime payload must support least-privilege tasks');
  }
  await ensurePrivateDirectory(privateRoot);
  await ensurePrivateDirectory(personalHome, { allowSystem: true });
  for (const file of ['personal.json', 'auth.json']) {
    await assertPrivateFile(join(personalHome, file)).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
  await secureStateDirectory(personalHome);
  const runtimeConfigDir = join(personalHome, 'runtime');
  const projectRoot = join(personalHome, 'projects');
  await ensurePrivateDirectory(runtimeConfigDir, { allowSystem: true });
  await mkdir(projectRoot, { recursive: true, mode: 0o700 });

  const ensure = async (file, defaults) => {
    const previous = await readPrivateFile(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (previous) return JSON.parse(previous);
    if (process.platform === 'win32') await writePrivateFile(file, JSON.stringify(defaults) + '\n');
    else await atomicJson(file, defaults, { createOnly: true });
    return defaults;
  };
  const settings = await ensure(join(personalHome, 'personal.json'), { schema: 1, runtimeConfigDir, projectRoot });
  if (settings.runtimeConfigDir !== runtimeConfigDir) throw new Error('The existing Personal Runtime owner differs');
  await ensure(join(personalHome, 'auth.json'), { apiToken: randomBytes(32).toString('base64url') });
  const runtimeSettings = await ensure(join(runtimeConfigDir, 'config.json'), {
    host: '127.0.0.1', port,
    stateDir: join(personalHome, 'runtime-state'), worktreeRoot: join(personalHome, 'worktrees'),
  });
  if (runtimeSettings.host !== '127.0.0.1' || runtimeSettings.port !== port) throw new Error('The Nodrelay Runtime must use its dedicated loopback endpoint');
  const { ownerToken } = await ensure(join(runtimeConfigDir, 'auth.json'), { ownerToken: randomBytes(32).toString('base64url') });
  if (typeof ownerToken !== 'string' || ownerToken.trim().length < 16) throw new Error('The Nodrelay Runtime owner credential is invalid');
  const hasDesktop = platform !== 'linux' || Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
  await registerJobs(personalHome, runtime, hasDesktop ? ['runtime', 'desktop'] : ['runtime'],
    platform === 'win32' ? { runLevel: 'LeastPrivilege', desktopEntries: false } : {});
  await jobAction(personalHome, 'runtime', 'start');
  if (hasDesktop) {
    await jobAction(personalHome, 'desktop', 'start');
    // Windows' upstream shortcut has a fixed Personal DevSpace name. Do not
    // replace a separately installed owner's entry with this Fleet runtime.
    if (platform !== 'win32') await registerDesktopEntries(personalHome, runtime).catch(() => {});
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [runtime, privateRoot, port] = process.argv.slice(2, 5);
  await preparePersonal(runtime, privateRoot, port === undefined ? {} : { port: Number(port) });
}

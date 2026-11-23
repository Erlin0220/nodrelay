import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { findPackageJSON } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { managementRelease } from '../src/management-release.mjs';
import { managementLauncherUrl } from './management-launcher-url.mjs';
import { tarOwnership } from './release-archive.mjs';

const [manifest, publisherKey, download, output, publicLauncher, ...extra] = process.argv.slice(2);
if (!output || extra.length) {
  throw new Error('Usage: node packaging/pack-management.mjs SIGNED_MANIFEST TRUSTED_PUBLISHER_KEY HTTPS_ARCHIVE_URL NEW_DIRECTORY [HTTPS_LAUNCHER_URL]');
}
const url = new URL(download);
const name = basename(url.pathname);
if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
    !/^nodrelay-management-[0-9][A-Za-z0-9._-]{0,39}-macos\.tgz$/.test(name)) {
  throw new Error('Use a versioned HTTPS archive URL ending in nodrelay-management-VERSION-macos.tgz.');
}

const launcherUrl = managementLauncherUrl(url, publicLauncher);
const release = await managementRelease(manifest, publisherKey);
// A legacy kit has no signed management version. For versioned kits, keep
// the archive (and consequently the public launcher's URL) tied to that version.
if (release.webUpgrade && name !== `nodrelay-management-${release.webUpgrade.version}-macos.tgz`) {
  throw new Error('Management archive filename does not match the signed management version.');
}
const project = fileURLToPath(new URL('..', import.meta.url));
const stage = await mkdtemp(join(tmpdir(), 'nodrelay-management-kit-'));
const kit = join(stage, 'kit');
const files = [
  'packaging/setup-macos.sh', 'packaging/pinned-node.sh',
  'src/management-setup.mjs', 'src/management-terminal.mjs', 'src/management-lock.mjs',
  'src/portal-readiness.mjs', 'src/management-release.mjs', 'src/management-onboarding.mjs', 'src/cloudflare-oauth.mjs', 'src/management-sso.mjs',
  'src/management-upgrade-baseline.mjs', 'cloud/upgrade-baseline-plan.mjs', 'cloud/upgrade-plan.mjs', 'cloud/upgrade-cloudflare.mjs', 'cloud/enrollment-bootstrap.mjs', 'cloud/upgrade-enrollment-release.mjs',
  'src/management-command-upgrade.mjs', 'src/upgrade-d1-rest.mjs', 'cloud/upgrade-artifacts.mjs',
  'cloud/upgrade-operation.mjs', 'cloud/upgrade-journal.mjs', 'cloud/upgrade-enrollment-readiness.mjs',
  'src/private-directory.mjs', 'src/setup-core.mjs', 'cloud/cloudflare.mjs', 'cloud/oauth-grant.mjs',
  'cloud/device-paths.mjs', 'cloud/install-command.mjs', 'cloud/zone-access.mjs', 'cloud/portal-client-callbacks.mjs',
  'cloud/0001_tickets.sql', 'cloud/0002_devices.sql', 'cloud/0003_portal_callback_labels.sql', 'cloud/0004_enrollment_intents.sql', 'cloud/0005_upgrade_journal.sql', 'LICENSE',
  'licenses/jose.txt',
];

// The launcher uses the verified Node binary directly. Include the installed
// Clack and JOSE with their license notices so npm is only needed to build the kit.
const includedPackages = new Set();
async function includePackage(name, importer) {
  const manifest = findPackageJSON(name, importer);
  const source = dirname(manifest);
  const path = relative(project, source);
  if (!path.startsWith('node_modules' + sep)) {
    throw new Error(`Run npm ci in the Nodrelay checkout before packaging ${name}.`);
  }
  if (includedPackages.has(path)) return;
  includedPackages.add(path);
  const target = join(kit, path);
  await mkdir(dirname(target), { recursive: true });
  await cp(source, target, { recursive: true, filter: path => path !== join(source, 'node_modules') });
  const { dependencies } = JSON.parse(await readFile(manifest, 'utf8'));
  for (const dependency of Object.keys(dependencies ?? {})) {
    await includePackage(dependency, pathToFileURL(manifest));
  }
}

try {
  await mkdir(kit);
  for (const file of files) {
    await mkdir(dirname(join(kit, file)), { recursive: true });
    await cp(join(project, file), join(kit, file));
  }
  await includePackage('@clack/prompts', import.meta.url);
  await includePackage('jose', import.meta.url);
  await cp(manifest, join(kit, 'management-release.json'));
  await cp(manifest + '.sig', join(kit, 'management-release.json.sig'));
  await cp(publisherKey, join(kit, 'publisher.pub.pem'));
  await writeFile(join(kit, 'worker.js'), release.bundle);
  await managementRelease(join(kit, 'management-release.json'), join(kit, 'publisher.pub.pem'));

  const exec = promisify(execFile);
  const archive = join(stage, name);
  await exec('tar', ['-czf', archive, ...tarOwnership, '-C', kit, '.'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  const destination = resolve(output);
  const archivePath = join(destination, name);
  await mkdir(destination);
  await rename(archive, archivePath).catch(async error => {
    if (error.code !== 'EXDEV') throw error;
    await cp(archive, archivePath, { errorOnExist: true, force: false });
  });
  await exec(process.execPath, [fileURLToPath(new URL('./pack-management-launcher.mjs', import.meta.url)),
    archivePath, url.href, destination, launcherUrl.href]);
  console.log(join(destination, 'install-macos-command.txt'));
} finally {
  await rm(stage, { recursive: true, force: true });
}

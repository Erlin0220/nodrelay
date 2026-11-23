import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { targetPlatforms } from '../src/setup-core.mjs';

export function localInstallerName(platform, archive) {
  const extension = platform === 'windows-x64' ? '.zip' : '.tgz';
  if (!targetPlatforms.includes(platform) || typeof archive !== 'string' || !archive.endsWith(extension) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(archive)) {
    throw new Error('Local installer requires a supported platform and a portable archive filename');
  }
  return 'install-' + archive.slice(0, -extension.length) + (extension === '.zip' ? '.ps1' : '.sh');
}

export async function renderLocalInstaller(platform, archive, sha256) {
  const name = localInstallerName(platform, archive);
  if (!/^[a-f0-9]{64}$/.test(sha256 ?? '')) throw new Error('Local installer requires a SHA-256 digest');
  const template = platform === 'windows-x64' ? './install-local.ps1' : './install-local.sh';
  const body = (await readFile(new URL(template, import.meta.url), 'utf8'))
    .replaceAll('@ARCHIVE@', archive).replaceAll('@SHA256@', sha256);
  return { name, body };
}

export async function writeLocalInstaller(platform, archive, sha256) {
  const { name, body } = await renderLocalInstaller(platform, basename(archive), sha256);
  await writeFile(join(dirname(archive), name), body, { flag: 'wx', mode: 0o755 });
  return { installer: name, installerSha256: createHash('sha256').update(body).digest('hex') };
}

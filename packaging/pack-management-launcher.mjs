import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { managementLauncherUrl } from './management-launcher-url.mjs';

const [archive, download, output, publicLauncher, ...extra] = process.argv.slice(2);
if (!output || extra.length) {
  throw new Error('Usage: node packaging/pack-management-launcher.mjs ARCHIVE HTTPS_ARCHIVE_URL EXISTING_DIRECTORY [HTTPS_LAUNCHER_URL]');
}
const url = new URL(download);
if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
    basename(url.pathname) !== basename(archive)) {
  throw new Error('Use the versioned HTTPS download URL for the management archive.');
}

const sh = value => "'" + value.replaceAll("'", "'\\''") + "'";
const sha256 = value => createHash('sha256').update(value).digest('hex');
const archiveDigest = sha256(await readFile(archive));
const steps = [
  'set -eu',
  '[ "$(uname -s)" = Darwin ] || { echo "Run this command on macOS." >&2; exit 2; }',
  'umask 077',
  'd=$(mktemp -d "${TMPDIR:-/tmp}/nodrelay-download.XXXXXXXX")',
  'trap \'rm -rf -- "$d"\' EXIT',
  'echo "诺联 Nodrelay · 正在下载安装包…" >&2',
  `curl --disable -fsSL --max-redirs 5 --connect-timeout 15 --max-time 300 --proto '=https' --proto-redir '=https' ${sh(url.href)} -o "$d/setup.tgz"`,
  'actual=$(shasum -a 256 "$d/setup.tgz")',
  `[ "\${actual%% *}" = ${sh(archiveDigest)} ] || { echo "Nodrelay download checksum mismatch." >&2; exit 1; }`,
  'tar -xzf "$d/setup.tgz" -C "$d"',
  'sh "$d/packaging/setup-macos.sh" "$d/management-release.json" "$d/publisher.pub.pem" "$@"',
];

const launcherName = 'install-macos.sh';
const launcher = `#!/bin/sh\n${steps.join('\n')}\n`;
const launcherUrl = managementLauncherUrl(url, publicLauncher);
const shortCommand = [
  'f=$(mktemp) || exit; cleanup(){ rm -f -- "$f"; }; trap cleanup EXIT;',
  'curl -q -fsSL --max-redirs 5 --connect-timeout 15 -m 60 --proto =https --proto-redir =https "$1" -o "$f" &&',
  'actual=$(shasum -a 256 "$f") &&',
  '[ "${actual%% *}" = "$2" ] || { echo "Nodrelay launcher checksum mismatch or download failed." >&2; exit 1; };',
  'shift 2 &&',
  'sh "$f" "$@"',
].join(' ');

await writeFile(join(output, 'install-command.txt'), `sh -c ${sh(steps.join('; '))} --\n`, { flag: 'wx' });
await writeFile(join(output, launcherName), launcher, { flag: 'wx' });
await writeFile(join(output, 'install-macos-command.txt'),
  `sh -c ${sh(shortCommand)} -- ${sh(launcherUrl.href)} ${sha256(launcher)}\n`, { flag: 'wx' });

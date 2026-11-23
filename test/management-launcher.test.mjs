import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const exec = promisify(execFile);

test('management launcher can be published outside the archive directory without changing its bytes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nodrelay-launcher-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const name = 'nodrelay-management-1.0.0-preview.1-macos.tgz';
  const archive = join(root, name);
  const archiveUrl = 'https://release.example.test/macos-preview/archives/' + name;
  const publicUrl = 'https://release.example.test/macos-preview/install-macos.sh';
  await writeFile(archive, 'simulated archive');
  const tool = fileURLToPath(new URL('../packaging/pack-management-launcher.mjs', import.meta.url));
  const output = await Promise.all(['stable', 'split', 'invalid'].map(async name => {
    const dir = join(root, name);
    await mkdir(dir);
    return dir;
  }));
  const run = (dir, ...args) => exec(process.execPath, [tool, archive, archiveUrl, dir, ...args]);
  await run(output[0]);
  await run(output[1], publicUrl);
  const launcher = await readFile(join(output[1], 'install-macos.sh'), 'utf8');
  assert.equal(launcher, await readFile(join(output[0], 'install-macos.sh'), 'utf8'));
  assert.ok(launcher.includes(archiveUrl));
  const checksum = createHash('sha256').update(launcher).digest('hex');
  for (const [dir, url] of [[output[0], new URL('install-macos.sh', archiveUrl).href], [output[1], publicUrl]]) {
    const command = await readFile(join(dir, 'install-macos-command.txt'), 'utf8');
    assert.ok(command.endsWith(` -- '${url}' ${checksum}\n`));
  }
  for (const invalid of [publicUrl.replace('https:', 'http:'), publicUrl + '?token=fixture',
    publicUrl + '#fragment', publicUrl.replace('https://', 'https://fixture@'), publicUrl + '/other']) {
    await assert.rejects(run(output[2], invalid), /Use a public HTTPS launcher URL/);
    assert.deepEqual(await readdir(output[2]), []);
  }
});

test('the pinned command checks both downloads before forwarding installer arguments', {
  skip: process.platform === 'win32',
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'nodrelay-launcher-check-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const kit = join(root, 'kit');
  const bin = join(root, 'bin');
  const output = join(root, 'output');
  await Promise.all([mkdir(bin), mkdir(output), mkdir(join(kit, 'packaging'), { recursive: true })]);
  await writeFile(join(kit, 'packaging', 'setup-macos.sh'), 'shift 2\nprintf "%s\\n" "$@"\n');
  const archive = join(root, 'nodrelay-management-1.0.0-macos.tgz');
  await exec('tar', ['-czf', archive, '-C', kit, '.']);
  const archiveUrl = 'https://release.example.test/archives/' + archive.split('/').at(-1);
  const launcherUrl = 'https://release.example.test/install-macos.sh';
  const launcher = join(output, 'install-macos.sh');
  const tool = fileURLToPath(new URL('../packaging/pack-management-launcher.mjs', import.meta.url));
  await exec(process.execPath, [tool, archive, archiveUrl, output, launcherUrl]);
  await Promise.all([
    writeFile(join(bin, 'uname'), '#!/bin/sh\necho Darwin\n', { mode: 0o755 }),
    writeFile(join(bin, 'curl'), `#!/bin/sh
while [ "$#" -gt 1 ]; do
  case "$1" in
    "$LAUNCHER_URL") source="$LAUNCHER_FILE";;
    "$ARCHIVE_URL") source="$ARCHIVE_FILE";;
    -o) cp "${'$'}{source:?unexpected download}" "$2"; exit $?;;
  esac
  shift
done
exit 1
`, { mode: 0o755 }),
  ]);
  const command = (await readFile(join(output, 'install-macos-command.txt'), 'utf8')).trim();
  const run = (overrides = {}) => exec('/bin/sh', ['-c', command + ' --plan'], {
    cwd: root,
    env: { ...process.env, PATH: bin + ':' + process.env.PATH, LAUNCHER_URL: launcherUrl, LAUNCHER_FILE: launcher,
      ARCHIVE_URL: archiveUrl, ARCHIVE_FILE: archive, ...overrides },
  });
  assert.equal((await run()).stdout, '--plan\n');
  const corrupt = join(root, 'corrupt');
  await writeFile(corrupt, '#!/bin/sh\necho BAD\n');
  await assert.rejects(run({ LAUNCHER_FILE: corrupt }), error => error.stdout === '' &&
    /launcher checksum mismatch/.test(error.stderr) && !/正在下载安装包/.test(error.stderr));
  await assert.rejects(run({ ARCHIVE_FILE: corrupt }), error => error.stdout === '' &&
    /download checksum mismatch/.test(error.stderr));
});

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { bootstrapInstaller, publicInstallCommand } from '../cloud/install-command.mjs';

const entry = fileURLToPath(new URL('../install.sh', import.meta.url));
const code = 'Ab-_' + 'c'.repeat(39);
const origin = 'https://console.example.test';
const os = process.platform === 'darwin' ? 'macos' : 'linux';
const shells = ['sh', 'bash', 'zsh'].filter(shell => spawnSync(shell, ['-c', 'exit 0']).status === 0);
const skip = process.platform === 'win32' ? 'POSIX shells only' : false;

// Fake curl: the entry's POST returns a bound installer; the installer's
// bundle download records what it was given and fails, so nothing installs.
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'nodrelay-entry-'));
  const asset = { url: 'https://downloads.example.test/fleet.tgz', sha256: 'af'.repeat(32) };
  writeFileSync(join(dir, 'bound.sh'), bootstrapInstaller(origin, os, { version: '1.0.0', assets: { x64: asset, arm64: asset } },
    { enrollmentIntent: true, deviceId: 'dev-0123456789abcdef' }));
  writeFileSync(join(dir, 'curl'), `#!/bin/sh
printf '%s\\n' "$*" >> "${dir}/calls"
case "$*" in
  *--data*) cat "${dir}/bound.sh" ;;
  *) printf '%s %s\\n' "$DEVSPACE_FLEET_DEVICE" "$DEVSPACE_FLEET_TICKET" >> "${dir}/installer"; exit 22 ;;
esac
`);
  chmodSync(join(dir, 'curl'), 0o755);
  const read = name => { try { return readFileSync(join(dir, name), 'utf8'); } catch { return ''; } };
  const run = (args, { shell = 'sh', text } = {}) => spawnSync(shell, text === undefined ? [entry, ...args] : ['-c', text, '--', ...args], {
    encoding: 'utf8', env: { ...process.env, PATH: dir + ':' + process.env.PATH } });
  return { dir, read, run, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('the public entry rejects malformed arguments before any request', { skip }, () => {
  const f = fixture();
  try {
    for (const args of [[], ['-e', origin], ['-t', code], ['-e', 'http://console.example.test', '-t', code],
      ['-e', origin + '/path', '-t', code], ['-e', origin, '-t', code.slice(1)], ['-e', origin, '-t', code + '$'],
      ['-e', origin, '-t', code, '-x'], ['-e']]) {
      for (const shell of shells) assert.equal(f.run(args, { shell }).status, 2, `${shell} ${args.join(' ')}`);
    }
    assert.equal(f.read('calls'), '');
  } finally { f.done(); }
});

test('the public entry posts the code to the console and hands the bound installer the device and code', { skip }, () => {
  for (const shell of shells) {
    const f = fixture();
    try {
      const result = f.run(['-e', origin + '/', '-t', code], { shell });
      assert.notEqual(result.status, 0, 'the faked download fails, so nothing installs');
      const [post] = f.read('calls').split('\n');
      assert.ok(post.includes(`--data {"code":"${code}"} ${origin}/device/install/${os}`), post);
      assert.ok(!post.includes(`device/install/${os}?`), 'the code never travels in the URL');
      assert.equal(f.read('installer'), `dev-0123456789abcdef ${code}\n`, shell);
    } finally { f.done(); }
  }
});

test('a truncated public entry runs nothing', { skip }, () => {
  const f = fixture();
  try {
    const text = readFileSync(entry, 'utf8');
    const cut = text.slice(0, text.lastIndexOf('nodrelay_entry "$@"'));
    for (const shell of shells) assert.equal(f.run(['-e', origin, '-t', code], { shell, text: cut }).status, 0);
    assert.equal(f.read('calls'), '');
  } finally { f.done(); }
});

test('the copied command runs the public entry through process substitution', { skip: skip || !shells.includes('zsh') && 'zsh missing' }, () => {
  const f = fixture();
  try {
    const command = publicInstallCommand(origin, 'macos', code).replace(/curl -fsSL [^)\s]+/, `cat ${entry}`);
    assert.equal(command, `zsh <(cat ${entry}) -e ${origin} -t ${code}`);
    f.run([], { shell: 'zsh', text: command });
    assert.equal(f.read('installer'), `dev-0123456789abcdef ${code}\n`);
  } finally { f.done(); }
});

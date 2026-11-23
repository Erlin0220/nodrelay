import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { verifyNativeTarget } from '../packaging/native-target.mjs';

test('release binaries must match the declared platform and CPU', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'fleet-native-headers-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const binary = join(folder, 'binary');

  const pe = Buffer.alloc(128);
  pe.write('MZ');
  pe.writeUInt32LE(96, 60);
  pe.writeUInt32BE(0x50450000, 96);
  pe.writeUInt16LE(0x8664, 100);
  await writeFile(binary, pe);
  await verifyNativeTarget(binary, 'windows-x64', 'node');
  await assert.rejects(verifyNativeTarget(binary, 'linux-x64', 'node'), /not a native linux-x64/);

  const elf = Buffer.alloc(64);
  elf.writeUInt32BE(0x7f454c46, 0);
  elf[4] = 2;
  elf[5] = 1;
  elf.writeUInt16LE(183, 18);
  await writeFile(binary, elf);
  await verifyNativeTarget(binary, 'linux-arm64', 'cloudflared');
  await assert.rejects(verifyNativeTarget(binary, 'linux-x64', 'cloudflared'), /not a native linux-x64/);
  elf.writeUInt16LE(62, 18);
  await writeFile(binary, elf);
  await verifyNativeTarget(binary, 'linux-x64', 'cloudflared');

  const mach = Buffer.alloc(64);
  mach.writeUInt32BE(0xcffaedfe, 0);
  mach.writeUInt32LE(0x0100000c, 4);
  await writeFile(binary, mach);
  await verifyNativeTarget(binary, 'macos-arm64', 'node');
  await assert.rejects(verifyNativeTarget(binary, 'macos-x64', 'node'), /not a native macos-x64/);
});

import { open } from 'node:fs/promises';

const machine = {
  linux: { x64: 62, arm64: 183 },
  windows: { x64: 0x8664 },
  macos: { x64: 0x01000007, arm64: 0x0100000c },
};

export async function verifyNativeTarget(path, platform, label) {
  const [os, arch] = platform.split('-');
  const input = await open(path, 'r');
  const header = Buffer.alloc(64);
  let matches = false;
  try {
    const { bytesRead } = await input.read(header, 0, header.length, 0);
    if (bytesRead !== header.length) throw new Error(`${label} is too short for a native ${platform} executable`);
    if (os === 'linux') {
      matches = header.readUInt32BE(0) === 0x7f454c46 && header[4] === 2 && header[5] === 1 &&
        header.readUInt16LE(18) === machine.linux[arch];
    }
    if (os === 'windows' && header.toString('ascii', 0, 2) === 'MZ') {
      const pe = Buffer.alloc(6);
      const { bytesRead } = await input.read(pe, 0, pe.length, header.readUInt32LE(60));
      matches = bytesRead === pe.length && pe.readUInt32BE(0) === 0x50450000 && pe.readUInt16LE(4) === machine.windows[arch];
    }
    if (os === 'macos') {
      const magic = header.readUInt32BE(0);
      if (magic === 0xcffaedfe) matches = header.readUInt32LE(4) === machine.macos[arch];
      if (magic === 0xcafebabe || magic === 0xcafebabf) {
        const count = header.readUInt32BE(4);
        if (count >= 1 && count <= 32) {
          const stride = magic === 0xcafebabe ? 20 : 32;
          const table = Buffer.alloc(count * stride);
          const { bytesRead } = await input.read(table, 0, table.length, 8);
          if (bytesRead === table.length) {
            for (let offset = 0; offset < table.length; offset += stride) {
              if (table.readUInt32BE(offset) === machine.macos[arch]) matches = true;
            }
          }
        }
      }
    }
  } finally {
    await input.close();
  }
  if (!matches) throw new Error(`${label} is not a native ${platform} executable`);
}

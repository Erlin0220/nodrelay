import { randomBytes } from 'node:crypto';
import { link, lstat, rm, unlink } from 'node:fs/promises';
import { readPrivateFile, writePrivateFile } from './private-directory.mjs';

export class ManagementLockError extends Error {
  constructor(kind, path, owner) {
    const messages = {
      active: `该安装目标的锁记录进程 PID ${owner?.pid} 仍存在。请等它退出，再重试。`,
      interrupted: `检测到上次安装中断（PID ${owner?.pid} 已退出）。请在同一台 Mac 上用原命令加 --resume，选择相同账户、域名、邮箱和部署名称。`,
      unknown: '无法安全确认这把锁的状态。请先关闭同一台 Mac 上的其他安装器，无法确认时重启 Mac。按安装文档仅归档下面这把锁，保留同名 .json 回执，再用 --resume。',
    };
    super(`${messages[kind]}\n锁文件：${path}`);
    this.kind = kind;
    this.path = path;
    this.owner = owner;
  }
}

async function readLock(path) {
  let value;
  try { value = JSON.parse(await readPrivateFile(path)); }
  catch (error) {
    if (error.code === 'ENOENT') throw error;
    throw new ManagementLockError('unknown', path);
  }
  if (value?.version !== 1 || !/^[0-9a-f]{32}$/.test(value.id ?? '') ||
      !Number.isInteger(value.pid) || value.pid < 1 || value.pid > 0x7fffffff) {
    throw new ManagementLockError('unknown', path);
  }
  return value;
}

function ownerIsLive(owner, path) {
  try { process.kill(owner.pid, 0); }
  catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code !== 'EPERM') throw new ManagementLockError('unknown', path);
  }
  return true;
}

async function hasLockLink(path, sidecar) {
  const linked = await lstat(sidecar, { bigint: true }).catch(error => {
    if (error.code !== 'ENOENT') throw error;
  });
  if (!linked) return false;
  const source = await lstat(path, { bigint: true }).catch(error => {
    if (error.code !== 'ENOENT') throw error;
  });
  if (!source?.isFile() || !linked.isFile() || source.dev !== linked.dev || source.ino !== linked.ino) {
    throw new ManagementLockError('unknown', path);
  }
  return true;
}

async function activeLockPath(root) {
  let generation = 0;
  let path = root;
  while (await hasLockLink(path, path + '.retired')) {
    path = root + '.generation-' + (++generation);
  }
  return path;
}

function lockChanged() {
  return new Error('安装锁已变更。请从原命令重新检查当前状态。');
}

export async function takeManagementLock(path) {
  const owner = { version: 1, pid: process.pid, id: randomBytes(16).toString('hex') };
  const temporary = path + '.' + owner.id + '.tmp';
  await writePrivateFile(temporary, JSON.stringify(owner));
  try {
    // Publish complete metadata and acquire the name in one operation.
    for (let attempt = 0; attempt < 2; attempt++) {
      const active = await activeLockPath(path);
      try { await link(temporary, active); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        let current;
        try { current = await readLock(active); }
        catch (inspectError) {
          if (inspectError.code === 'ENOENT') continue;
          throw inspectError;
        }
        if (await hasLockLink(active, active + '.retired')) continue;
        throw new ManagementLockError(ownerIsLive(current, active) ? 'active' : 'interrupted', active, current);
      }
      return async () => {
        const current = await readLock(active);
        if (current.id !== owner.id) throw new ManagementLockError('unknown', active);
        await unlink(active);
      };
    }
    throw lockChanged();
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function archiveInterruptedManagementLock(root, expected) {
  const path = await activeLockPath(root);
  const checkOwner = async () => {
    const current = await readLock(path).catch(error => {
      if (error.code === 'ENOENT') throw lockChanged();
      throw error;
    });
    if (current.id !== expected.id || current.pid !== expected.pid) throw lockChanged();
    if (ownerIsLive(current, path)) throw new ManagementLockError('active', path, current);
  };
  await checkOwner();
  const archive = path + '.interrupted-' + expected.id;
  try { await link(path, archive); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (!await hasLockLink(path, archive)) throw lockChanged();
  }
  await checkOwner();
  // Retire this generation without deleting it. A resumed or concurrent
  // recovery cannot unlink a lock another installer acquired in the meantime.
  try { await link(path, path + '.retired'); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (await hasLockLink(path, path + '.retired')) throw lockChanged();
    throw new ManagementLockError('unknown', path);
  }
}

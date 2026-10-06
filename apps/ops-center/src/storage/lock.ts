/**
 * 运行锁：保证同一时刻只有一个中心实例在跑（cron 重叠/误开第二个守护进程时直接退出）。
 * 锁文件写 PID 与启动时间；进程退出（含被 kill -9，下次启动会检测到 PID 不存活）自动释放。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { config } from '../config/index.js';

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface LockHandle {
  release: () => void;
}

export function acquireLock(file: string = config.lockFile): LockHandle {
  mkdirSync(path.dirname(file), { recursive: true });
  if (existsSync(file)) {
    try {
      const held = JSON.parse(readFileSync(file, 'utf8')) as { pid: number; since: string };
      if (pidAlive(held.pid)) {
        throw new Error(`备份中心已在运行（PID ${held.pid}，自 ${held.since} 起持有锁 ${file}）`);
      }
    } catch (err) {
      if (err instanceof SyntaxError) {
        // 锁文件损坏，可能是上次写盘中断，接管它
      } else {
        throw err;
      }
    }
  }
  writeFileSync(file, JSON.stringify({ pid: process.pid, since: new Date().toISOString() }));
  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      try {
        rmSync(file, { force: true });
      } catch {
        /* ignore */
      }
    },
  };
}

/** 通用工具：哈希、规范序列化、重试、时间、文件遍历。无外部依赖。 */
import { createHash } from 'node:crypto';
import { createReadStream, type Stats } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

export function nowIso(): string {
  return new Date().toISOString();
}

export function sha256Text(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** 流式计算文件 sha256，避免把大备份/媒体整个读进内存 */
export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * 稳定 JSON：键排序 + 无空白。所有需要签名/比对的结构都走这里，
 * 保证同内容永远得到同字节串。
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function hashJson(value: unknown): string {
  return sha256Text(canonicalize(value));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 带退避的重试；最后一次失败抛出最后一个错误 */
export async function retry<T>(fn: () => Promise<T>, times: number, baseDelayMs = 200): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= times; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === times) break;
      await sleep(baseDelayMs * 2 ** (attempt - 1));
    }
  }
  throw lastErr;
}

/** 递归列出目录下全部普通文件（不跟随符号链接，避免逃出备份根） */
export async function walkFiles(root: string): Promise<Array<{ abs: string; rel: string; stat: Stats }>> {
  const out: Array<{ abs: string; rel: string; stat: Stats }> = [];
  async function visit(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const abs = join(dir, ent.name);
      if (ent.isDirectory()) {
        await visit(abs);
      } else if (ent.isFile()) {
        const stat = await lstat(abs);
        out.push({ abs, rel: relative(root, abs), stat });
      }
      // 符号链接与其他类型故意跳过：备份只收真实文件
    }
  }
  await visit(root);
  out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return out;
}

export function bytesLabel(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = -1;
  do {
    v /= 1024;
    i++;
  } while (v >= 1024 && i < units.length - 1);
  return `${v.toFixed(1)} ${units[i]}`;
}

export function msLabel(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m} 分 ${s} 秒`;
}

/**
 * 保留策略回收：按「份数 + 天数」双约束清理**成功且带 DONE** 的旧备份。
 * - 永远不会删除正在写入的目录（没有 DONE）和最近一份成功备份（哪怕它超出天数/份数）。
 * - 每次删除都进账本，报告里可追溯「什么时候、删掉了哪份、为什么」。
 */
import { existsSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { config } from '../config/index.js';
import type { Run } from '../storage/run.js';
import { findBackups } from './verify.js';

export interface RetentionResult {
  deleted: Array<{ dir: string; reason: string; bytes: number }>;
  kept: Array<{ dir: string; reason: string }>;
}

function dirSize(dir: string): number {
  // 备份目录扁平（4 个文件），直接求和即可，避免递归遍历大媒体目录
  let total = 0;
  for (const name of ['db.dump', 'uploads.tar.gz', 'manifest.json', 'DONE']) {
    const f = path.join(dir, name);
    if (existsSync(f)) total += statSync(f).size;
  }
  return total;
}

export async function runRetention(run: Run): Promise<RetentionResult> {
  const all = findBackups();
  const completed = all.filter((d) => existsSync(path.join(d, 'DONE')));
  const incomplete = all.filter((d) => !existsSync(path.join(d, 'DONE')));

  const deleted: RetentionResult['deleted'] = [];
  const kept: RetentionResult['kept'] = [];
  const now = Date.now();
  const ageMs = config.retentionDays * 24 * 60 * 60 * 1000;

  completed.forEach((dir, idx) =>
    kept.push({ dir, reason: idx === 0 ? '最新一份成功备份，始终保留' : '在保留窗口内' }),
  );

  // idx=0 永远保留；其余同时超出「份数」与「天数」才删（取交集，保守回收）
  for (let idx = 1; idx < completed.length; idx += 1) {
    const dir = completed[idx]!;
    const overCount = idx >= config.retentionCount;
    const mtime = statSync(path.join(dir, 'DONE')).mtimeMs;
    const overAge = now - mtime > ageMs;
    if (overCount && overAge) {
      const bytes = dirSize(dir);
      rmSync(dir, { recursive: true, force: true });
      deleted.push({ dir, reason: `超过保留份数 ${config.retentionCount} 且超过 ${config.retentionDays} 天`, bytes });
      run.log(`回收旧备份：${dir}（${(bytes / 1024 / 1024).toFixed(1)} MiB）`);
    } else {
      const reasons: string[] = [];
      if (!overCount) reasons.push(`份数未超（第 ${idx + 1} 份 / 上限 ${config.retentionCount}）`);
      if (!overAge) reasons.push(`天数未超（${config.retentionDays} 天）`);
      kept.push({ dir, reason: reasons.join('；') });
    }
  }

  for (const dir of incomplete) {
    // 没有 DONE 的目录可能是正在写的备份；超过 1 天还没 DONE 才算失败残骸
    const age = now - statSync(dir).mtimeMs;
    if (age > 24 * 60 * 60 * 1000) {
      const bytes = dirSize(dir);
      rmSync(dir, { recursive: true, force: true });
      deleted.push({
        dir,
        reason: `无 DONE 标记且超过 24 小时（约 ${Math.round(age / 3600000)}h），判定为失败残骸`,
        bytes,
      });
      run.log(`回收失败备份残骸（无 DONE）：${dir}`);
    } else {
      kept.push({ dir, reason: '无 DONE 但写入时间在 24h 内，可能正在备份' });
    }
  }

  run.check(
    '保留策略执行完成',
    true,
    `保留 ${kept.length} 份，回收 ${deleted.length} 份（份数上限 ${config.retentionCount} / 天数 ${config.retentionDays}）`,
    { deleted, keptCount: kept.length },
  );
  return { deleted, kept };
}


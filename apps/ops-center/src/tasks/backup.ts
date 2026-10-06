/**
 * 备份任务：数据库 pg_dump -Fc + 媒体目录 tar.gz（边打包边算 sha256）+ 清单 + DONE 标记。
 * 与 scripts/backup.sh 产物完全兼容（同目录结构、同名文件、同样的 DONE 约定），
 * 清单额外记录更全的条数、媒体统计与工具版本，供演练和审计追溯。
 */
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';
import { config, pgEnv } from '../config/index.js';
import type { Run } from '../storage/run.js';
import { log } from '../util/logger.js';
import { sha256File } from '../util/hash.js';
import { dumpCustom, queryScalar, describeTarget } from '../util/pg.js';

export interface BackupResult {
  dir: string;
  manifest: BackupManifest;
}

export interface BackupManifest {
  app: string;
  /** 清单格式版本：1=旧脚本写入，2=演练中心写入；校验时两者都接受。 */
  formatVersion: number;
  createdAt: string;
  host: string;
  database: string;
  migration: string | null;
  counts: Record<string, number>;
  media: { rows: number; totalBytes: number };
  files: Record<string, { sha256: string; bytes: number }>;
  tool: { name: string; version: string };
}

export const TOOL_NAME = '@heirloom/ops-center';
export const TOOL_VERSION = '1.0.0';

const TABLE_COUNTS: Array<{ key: string; sql: string }> = [
  { key: 'users', sql: 'select count(*) from users' },
  { key: 'families', sql: 'select count(*) from families where deleted_at is null' },
  { key: 'items', sql: 'select count(*) from items' },
  { key: 'media', sql: 'select count(*) from item_media' },
  { key: 'people', sql: 'select count(*) from people' },
  { key: 'notes', sql: 'select count(*) from item_notes' },
  { key: 'shareLinks', sql: 'select count(*) from share_links' },
  { key: 'auditLogs', sql: 'select count(*) from audit_logs' },
];

async function mediaStats(): Promise<{ rows: number; totalBytes: number }> {
  const rows = Number(
    await queryScalar('select count(*) from item_media where storage_key is not null'),
  );
  const totalBytes = Number(
    await queryScalar('select coalesce(sum(byte_size),0) from item_media where storage_key is not null'),
  );
  return { rows, totalBytes };
}

/** 系统 tar 打包并 gzip；输出 tee 一份给 sha256，边写文件边得哈希。 */
function archiveUploads(outFile: string, run: Run): Promise<{ sha256: string; bytes: number }> {
  return new Promise((resolve, reject) => {
    // tar -czf - uploads  —— 输出到 stdout，由 Node 落盘 + 哈希，保证哈希与字节同源
    const child = spawn(
      'tar',
      ['-czf', '-', '--format=posix', path.basename(config.uploadsDir)],
      {
        cwd: path.dirname(config.uploadsDir),
        env: pgEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const hash = createHash('sha256');
    let bytes = 0;
    let nextMark = 16 * 1024 * 1024;
    let stderr = '';
    const out = createWriteStream(outFile);
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString();
      for (const line of c.toString().split('\n').filter(Boolean)) run.log(`tar: ${line}`);
    });
    child.stdout.on('data', (chunk: Buffer) => {
      hash.update(chunk);
      bytes += chunk.length;
      if (bytes >= nextMark) {
        run.log(`媒体已写入 ${(bytes / 1024 / 1024).toFixed(0)} MiB`);
        nextMark += 16 * 1024 * 1024;
      }
    });
    child.stdout.pipe(out);
    child.on('error', reject);
    out.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`tar 失败（退出码 ${code}）：${stderr.trim()}`));
        return;
      }
      out.end(() => resolve({ sha256: hash.digest('hex'), bytes }));
    });
  });
}

export async function runBackup(
  run: Run,
  options: { targetDir?: string } = {},
): Promise<BackupResult> {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:T]/g, '')
    .slice(0, 14);
  const dir = options.targetDir ?? path.join(config.backupRoot, stamp);
  mkdirSync(dir, { recursive: true });
  // 重跑同一目录时先摘掉旧 DONE，避免半成品被当成好备份
  rmSync(path.join(dir, 'DONE'), { force: true });
  run.note({ backupDir: dir });
  run.log(`备份目录：${dir}`);
  run.log(`目标数据库：${describeTarget()}`);

  // 1. 数据库
  run.log('导出数据库（pg_dump -Fc）→ db.dump');
  const dumpFile = path.join(dir, 'db.dump');
  const t0 = Date.now();
  await dumpCustom(dumpFile, {
    onOutput: (_s, line) => run.log(`pg_dump: ${line}`),
  });
  const dumpStat = statSync(dumpFile);
  run.check('数据库转储非空', dumpStat.size > 0, `db.dump ${dumpStat.size} 字节`);
  run.log(`数据库导出完成，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // 2. 媒体（边打包边哈希，避免二次读 GB 级文件）
  mkdirSync(config.uploadsDir, { recursive: true });
  const tarFile = path.join(dir, 'uploads.tar.gz');
  run.log('打包媒体目录 → uploads.tar.gz（流式 sha256）');
  const t1 = Date.now();
  const tarInfo = await archiveUploads(tarFile, run);
  const tarStat = statSync(tarFile);
  run.check(
    '媒体归档非空',
    tarStat.size > 0,
    `uploads.tar.gz ${tarStat.size} 字节，sha256 ${tarInfo.sha256.slice(0, 16)}…`,
  );
  run.log(`媒体打包完成，用时 ${((Date.now() - t1) / 1000).toFixed(1)}s`);

  // 3. 条数与迁移版本
  const counts: Record<string, number> = {};
  for (const { key, sql } of TABLE_COUNTS) {
    counts[key] = Number(await queryScalar(sql));
  }
  let migration: string | null = null;
  try {
    migration = await queryScalar(
      'select migration_name from _prisma_migrations order by finished_at desc nulls last limit 1',
    );
  } catch {
    migration = null;
  }
  const media = await mediaStats();

  // 4. db.dump 再做一次落盘哈希（tar.gz 已在管线里算过）
  const dumpHash = await sha256File(dumpFile);

  const manifest: BackupManifest = {
    app: config.appName,
    formatVersion: 2,
    createdAt: new Date().toISOString(),
    host: hostname(),
    database: describeTarget(),
    migration,
    counts,
    media,
    files: {
      'db.dump': { sha256: dumpHash, bytes: dumpStat.size },
      'uploads.tar.gz': { sha256: tarInfo.sha256, bytes: tarInfo.bytes },
    },
    tool: { name: TOOL_NAME, version: TOOL_VERSION },
  };

  // 5. DONE 最后写；它的存在 = 这份备份完整
  const manifestFile = path.join(dir, 'manifest.json');
  writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(path.join(dir, 'DONE'), `${new Date().toISOString()}\n`);

  run.artifact({ name: 'db.dump', path: dumpFile, sha256: dumpHash, bytes: dumpStat.size });
  run.artifact({ name: 'uploads.tar.gz', path: tarFile, sha256: tarInfo.sha256, bytes: tarInfo.bytes });
  run.artifact({ name: 'manifest.json', path: manifestFile });
  run.artifact({ name: 'DONE', path: path.join(dir, 'DONE') });
  run.check(
    '备份完整标记 DONE',
    existsSync(path.join(dir, 'DONE')),
    'DONE 最后写入；恢复与演练只认带 DONE 的目录',
  );
  run.log(
    `备份完成：条目 ${counts.items} / 媒体 ${counts.media} / 家庭 ${counts.families} / ` +
      `总大小 ${(((dumpStat.size + tarStat.size) / 1024 / 1024).toFixed(1))} MiB`,
  );
  log.info(`备份完成：${dir}`);
  return { dir, manifest };
}

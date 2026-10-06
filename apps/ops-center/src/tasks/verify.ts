/**
 * 校验任务：不做还原，只证明「备份文件本身没坏、且与库/磁盘对得上」。
 * 检查项：
 *   1. DONE 标记存在且目录结构完整
 *   2. manifest 可解析、formatVersion 兼容
 *   3. db.dump / uploads.tar.gz 的 sha256 与清单一致（静默损坏/位腐检测）
 *   4. db.dump 能被 pg_restore --list 读出目录（转储可解析，不是半截文件）
 *   5. uploads.tar.gz 能通过 tar -tz 完整性测试（gzip CRC + tar 结构）
 *   6. 抽样媒体：数据库记录的 sha256 == 生产磁盘文件 sha256（及时发现存储侧损坏）
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { config, pgEnv } from '../config/index.js';
import type { Run } from '../storage/run.js';
import { sha256File } from '../util/hash.js';
import { execFile } from '../util/exec.js';
import { queryDelimited } from '../util/pg.js';
import { log } from '../util/logger.js';
import type { BackupManifest } from './backup.js';

export function findBackups(root: string = config.backupRoot): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(root, d.name))
    .sort()
    .reverse();
}

export function findLatestCompletedBackup(root: string = config.backupRoot): string | undefined {
  return findBackups(root).find((d) => existsSync(path.join(d, 'DONE')));
}

function readManifest(dir: string): BackupManifest {
  return JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as BackupManifest;
}

async function hashMatches(
  run: Run,
  file: string,
  expected: string,
  label: string,
): Promise<boolean> {
  const actual = await sha256File(file);
  const ok = actual === expected;
  run.check(`${label} sha256`, ok, ok ? `${label} 与清单一致` : `${label} 损坏：清单 ${expected.slice(0, 16)}… 实际 ${actual.slice(0, 16)}…`);
  return ok;
}

export async function runVerify(
  run: Run,
  options: { backupDir?: string } = {},
): Promise<{ backupDir: string; manifest: BackupManifest }> {
  const dir = options.backupDir ?? findLatestCompletedBackup();
  if (!dir) throw new Error('找不到任何带 DONE 标记的备份，请先执行备份');
  run.note({ backupDir: dir });
  run.log(`校验备份：${dir}`);

  // 1. DONE + 文件齐全
  const doneExists = existsSync(path.join(dir, 'DONE'));
  run.check('DONE 完整标记', doneExists, doneDirText(dir, doneExists));
  const required = ['db.dump', 'uploads.tar.gz', 'manifest.json'];
  for (const name of required) {
    const f = path.join(dir, name);
    const ok = existsSync(f) && statSync(f).size > 0;
    run.check(`产物存在：${name}`, ok, ok ? `${name} ${statSync(f).size} 字节` : `${name} 缺失或为空`);
  }
  if (!doneExists) throw new Error('备份缺少 DONE 标记，中止深度校验');

  const manifest = readManifest(dir);
  // 旧脚本写的清单没有 formatVersion 字段，按 v1 处理
  const formatVersion = manifest.formatVersion ?? 1;
  run.check(
    '清单格式版本',
    formatVersion === 1 || formatVersion === 2,
    `formatVersion=${formatVersion}（兼容 1/2）`,
  );

  // 2. 哈希比对
  const dumpOk = await hashMatches(run, path.join(dir, 'db.dump'), manifest.files['db.dump']!.sha256, 'db.dump');
  const tarOk = await hashMatches(
    run,
    path.join(dir, 'uploads.tar.gz'),
    manifest.files['uploads.tar.gz']!.sha256,
    'uploads.tar.gz',
  );

  // 3. pg_restore --list：dump 目录可读
  if (dumpOk) {
    const r = await execFile(
      'pg_restore',
      ['--list', path.join(dir, 'db.dump')],
      { env: pgEnv(), timeoutMs: 60_000 },
    );
    const tableCount = (r.stdout.match(/TABLE DATA /g) ?? []).length;
    const ok = r.code === 0 && tableCount > 0;
    run.check(
      'db.dump 可解析（pg_restore --list）',
      ok,
      ok ? `读出 ${tableCount} 个 TABLE DATA 段` : `pg_restore --list 失败：${r.stderr.trim().slice(0, 300)}`,
    );
  }

  // 4. tar 完整性（gzip CRC + 归档结构）
  if (tarOk) {
    const r = await execFile('tar', ['-tzf', path.join(dir, 'uploads.tar.gz')], {
      env: pgEnv(),
      timeoutMs: 1000 * 60 * 10,
    });
    const entries = r.stdout.split('\n').filter(Boolean).length;
    const ok = r.code === 0 && entries > 0;
    run.check(
      'uploads.tar.gz 归档完整（tar -tzf）',
      ok,
      ok ? `归档内 ${entries} 个条目，gzip CRC 通过` : `tar 校验失败：${r.stderr.trim().slice(0, 300)}`,
      { entries },
    );
  }

  // 5. 抽样媒体：库内 sha256 与生产磁盘一致（针对「活数据」的腐蚀检测）
  const sampleSize = config.verifySampleSize;
  run.log(`抽样校验生产媒体文件（样本 ${sampleSize <= 0 ? '全量' : sampleSize}）`);
  const order = sampleSize <= 0 ? 'order by m.created_at' : 'order by random()';
  const limit = sampleSize <= 0 ? '' : `limit ${sampleSize}`;
  const rows = await queryDelimited(
    `select coalesce(m.storage_key,'') || chr(31) || coalesce(m.sha256,'')
     from item_media m
     where m.storage_key is not null and m.deleted_at is null
     ${order} ${limit}`,
  );
  let checked = 0;
  let missing = 0;
  let mismatch = 0;
  const badKeys: string[] = [];
  for (const [key, sha] of rows) {
    if (!key) continue;
    const file = path.join(config.uploadsDir, key);
    if (!existsSync(file)) {
      missing += 1;
      if (badKeys.length < 20) badKeys.push(`缺失 ${key}`);
      continue;
    }
    checked += 1;
    const actual = await sha256File(file);
    if (actual !== sha) {
      mismatch += 1;
      if (badKeys.length < 20) badKeys.push(`不一致 ${key}`);
    }
  }
  run.check(
    '生产媒体抽样：文件存在',
    missing === 0,
    missing === 0 ? `${rows.length} 个样本全部在盘` : `${missing} 个文件缺失`,
    { sample: rows.length, missing, badKeys: badKeys.slice(0, 20) },
  );
  run.check(
    '生产媒体抽样：sha256 一致',
    mismatch === 0,
    mismatch === 0 ? `实算 ${checked} 个文件全部一致` : `${mismatch} 个文件哈希不一致`,
    { checked, mismatch },
  );

  log.info(
    `校验完成：${run.failCount === 0 ? '全部通过' : `${run.failCount} 项失败`}（备份 ${path.basename(dir)}）`,
  );
  return { backupDir: dir, manifest };
}

function doneDirText(dir: string, ok: boolean): string {
  if (ok) return `DONE 存在：${dir}`;
  return `DONE 缺失，该目录不是完整备份：${dir}`;
}

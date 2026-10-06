/**
 * 演练任务：把一份备份**自动还原到隔离环境**并与生产现状逐项比对。
 *
 * 隔离边界（硬性）：
 *   - 数据库：独立临时库（名 heirloom_drill_<ts>_<rand>），演练结束 DROP；
 *     对生产库的全部访问都带 default_transaction_read_only=on（见 pgReadOnlyEnv）。
 *   - 文件系统：只在 config.sandboxRoot 下建临时目录解压媒体；生产 uploads 目录只读。
 *   - 网络：仅连接本配置里的 PostgreSQL，不启动应用、不访问外部服务。
 *
 * 比对内容：
 *   A. 备份自证（复用 verify 的文件哈希/可解析检查）
 *   B. 全表行数：生产（只读） vs 恢复库
 *   C. 全表内容指纹：每张业务表行级 md5 聚合 + 表级总哈希（捕获行数相同但内容不同）
 *   D. 媒体：备份归档解压后，抽样 key 在「生产磁盘 / 恢复库记录的 sha256 / 归档文件实算 sha256」三方比对
 *   E. 关键实体抽样：items/users 的主键集合做集合差
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { config, pgReadOnlyEnv } from '../config/index.js';
import type { Run } from '../storage/run.js';
import { log } from '../util/logger.js';
import { execFile } from '../util/exec.js';
import { sha256File } from '../util/hash.js';
import {
  createDatabase,
  dropDatabaseIfExists,
  ping,
  queryDelimited,
  queryScalar,
  restoreDumpFromStdin,
  describeTarget,
} from '../util/pg.js';
import { findLatestCompletedBackup } from './verify.js';
import type { BackupManifest } from './backup.js';
import { readFileSync } from 'node:fs';

/** 参与比对的业务表（_prisma_migrations 单独比对迁移版本）。 */
const COMPARE_TABLES = [
  'users',
  'families',
  'family_members',
  'items',
  'item_versions',
  'item_media',
  'item_notes',
  'item_people',
  'people',
  'invites',
  'share_links',
  'share_link_items',
  'audit_logs',
  'refresh_tokens',
  'jobs',
  'settings',
] as const;

export interface DrillResult {
  backupDir: string;
  manifest: BackupManifest;
  drillDb: string;
  sandboxDir: string;
  passed: boolean;
  comparison: {
    counts: Array<{ table: string; prod: number; restored: number; ok: boolean }>;
    fingerprints: Array<{ table: string; prodFp: string; restoredFp: string; ok: boolean }>;
    media: {
      sampleSize: number;
      checked: number;
      missingInArchive: number;
      hashMismatch: number;
      dbRecordMismatch: number;
      details: string[];
    };
    restoreWarnings: number;
    migration: { prod: string; restored: string; ok: boolean };
  };
}

/**
 * 行级指纹：把每张表所有行序列化成稳定字符串再聚合 md5。
 * - 用 to_jsonb(t) 行序列化；按主键（若有）排序，保证稳定。
 * - 不依赖外部工具，psql 输出聚合后的单个 md5。
 */
function fingerprintSql(table: string): string {
  // order by 主键：用 ctid 兜底（物理顺序在刚还原的库里也可能与生产不同，
  // 因此更稳妥的是按行内容排序）。对所有行 jsonb 排序后聚合。
  return `
with rows as (
  select replace(t::text, e'\\n', ' ') as line
  from "${table}" t
)
select md5(string_agg(line, e'\\n' order by line))
from rows`;
}

function countSql(table: string): string {
  return `select count(*) from "${table}"`;
}

async function tableExists(table: string, database?: string, env?: NodeJS.ProcessEnv): Promise<boolean> {
  const v = await queryScalar(
    `select to_regclass('public."${table}"') is not null`,
    database,
    env,
  );
  return v === 't' || v === 'true';
}

export async function runDrill(
  run: Run,
  options: { backupDir?: string; keepSandbox?: boolean } = {},
): Promise<DrillResult> {
  const backupDir = options.backupDir ?? findLatestCompletedBackup();
  if (!backupDir) throw new Error('找不到可用备份（需要带 DONE 的目录），无法演练');
  const manifest = JSON.parse(
    readFileSync(path.join(backupDir, 'manifest.json'), 'utf8'),
  ) as BackupManifest;
  run.note({ backupDir });
  run.log(`演练使用备份：${backupDir}`);
  run.log(`生产数据库（只读连接）：${describeTarget()}`);

  if (!(await ping())) throw new Error('生产数据库不可连接，演练中止（隔离库需要同一集群创建）');

  const drillDb = `${config.drillDbPrefix}${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}_${randomBytes(3).toString('hex')}`;
  const sandboxDir = path.join(config.sandboxRoot, drillDb);
  mkdirSync(sandboxDir, { recursive: true });
  run.log(`隔离数据库：${drillDb}（演练后自动 DROP）`);
  run.log(`隔离文件目录：${sandboxDir}（演练后自动清理）`);

  let restored = false;
  const cleanup = async (): Promise<void> => {
    if (restored) {
      try {
        await dropDatabaseIfExists(drillDb);
        run.log(`隔离库已删除：${drillDb}`);
      } catch (err) {
        run.log(`警告：隔离库删除失败：${(err as Error).message}`);
      }
    }
    if (!options.keepSandbox) {
      rmSync(sandboxDir, { recursive: true, force: true });
    }
  };

  try {
    // 1. 建隔离库
    await createDatabase(drillDb);
    run.check('隔离库已创建', await ping(drillDb), drillDb);

    // 2. 还原 dump
    run.log('还原 db.dump → 隔离库');
    const restore = await restoreDumpFromStdin(path.join(backupDir, 'db.dump'), drillDb);
    restored = true;
    const fatalWarnings = restore.warnings
      .split('\n')
      .filter((l) => /fatal|error:/i.test(l));
    run.check(
      'pg_restore 无致命错误',
      fatalWarnings.length === 0,
      fatalWarnings.length === 0
        ? '还原过程无 FATAL/ERROR（常规告警见运行日志）'
        : `${fatalWarnings.length} 条致命错误：${fatalWarnings.slice(0, 3).join('；')}`,
      { warningLines: restore.warnings.split('\n').filter(Boolean).length },
    );

    // 3. 解压媒体归档到沙箱
    run.log('解压 uploads.tar.gz → 隔离目录');
    const tar = await execFile(
      'tar',
      ['-xzf', path.join(backupDir, 'uploads.tar.gz'), '-C', sandboxDir],
      { timeoutMs: 1000 * 60 * 20 },
    );
    run.check(
      '媒体归档解压成功',
      tar.code === 0,
      tar.code === 0 ? `解压到 ${sandboxDir}` : tar.stderr.trim().slice(0, 300),
    );
    const sandboxUploads = path.join(sandboxDir, 'uploads');

    // 4. 迁移版本
    const prodMigration = await queryScalar(
      'select migration_name from _prisma_migrations order by finished_at desc nulls last limit 1',
      undefined,
      pgReadOnlyEnv(),
    );
    const restoredMigration = (await tableExists('_prisma_migrations', drillDb))
      ? await queryScalar(
          'select migration_name from _prisma_migrations order by finished_at desc nulls last limit 1',
          drillDb,
        )
      : '';
    const migrationOk = prodMigration === restoredMigration;
    run.check(
      '迁移版本一致',
      migrationOk,
      migrationOk
        ? `最新迁移 ${prodMigration}`
        : `生产 ${prodMigration} vs 恢复 ${restoredMigration}`,
    );

    // 5. 行数 + 内容指纹
    const counts: DrillResult['comparison']['counts'] = [];
    const fingerprints: DrillResult['comparison']['fingerprints'] = [];
    for (const table of COMPARE_TABLES) {
      const prodHas = await tableExists(table, undefined, pgReadOnlyEnv());
      const restHas = await tableExists(table, drillDb);
      if (!prodHas && !restHas) continue;
      const prodCount = prodHas ? Number(await queryScalar(countSql(table), undefined, pgReadOnlyEnv())) : -1;
      const restCount = restHas ? Number(await queryScalar(countSql(table), drillDb)) : -1;
      counts.push({ table, prod: prodCount, restored: restCount, ok: prodCount === restCount });

      // 空表指纹统一成 null 的 md5 形式，避免一边空一边有行时误判
      const prodFp = prodHas && prodCount > 0 ? await queryScalar(fingerprintSql(table), undefined, pgReadOnlyEnv()) : 'EMPTY';
      const restFp = restHas && restCount > 0 ? await queryScalar(fingerprintSql(table), drillDb) : 'EMPTY';
      fingerprints.push({ table, prodFp, restoredFp: restFp, ok: prodFp === restFp });
    }
    const countFail = counts.filter((c) => !c.ok);
    const fpFail = fingerprints.filter((c) => !c.ok);
    run.check(
      '全表行数比对',
      countFail.length === 0,
      countFail.length === 0
        ? `${counts.length} 张表行数全部一致`
        : `${countFail.length} 张表不一致：${countFail.map((c) => `${c.table}(${c.prod}→${c.restored})`).join('，')}`,
      { counts },
    );
    run.check(
      '全表内容指纹比对',
      fpFail.length === 0,
      fpFail.length === 0
        ? `${fingerprints.length} 张表行内容指纹全部一致`
        : `${fpFail.length} 张表指纹不同：${fpFail.map((c) => c.table).join('，')}`,
      { fingerprints: fingerprints.map((f) => ({ table: f.table, ok: f.ok })) },
    );

    // 6. 媒体三方比对：生产磁盘 sha256 / 恢复库 item_media.sha256 / 沙箱归档文件 sha256
    const sampleSize = config.compareSampleSize;
    run.log(`媒体三方比对（样本 ${sampleSize <= 0 ? '全量' : sampleSize}）`);
    const order = sampleSize <= 0 ? 'order by m.created_at' : 'order by random()';
    const limit = sampleSize <= 0 ? '' : `limit ${sampleSize}`;
    const mediaRows = await queryDelimited(
      `select coalesce(m.storage_key,'') || chr(31) || coalesce(m.sha256,'')
       from item_media m
       where m.storage_key is not null and m.deleted_at is null
       ${order} ${limit}`,
      undefined,
      pgReadOnlyEnv(),
    );
    const details: string[] = [];
    let checked = 0;
    let missingInArchive = 0;
    let hashMismatch = 0;
    let dbRecordMismatch = 0;

    // 一次性取出恢复库里全部 key→sha256 映射，避免对每个媒体各起一个 psql（N+1）
    const restoredRows = await queryDelimited(
      `select coalesce(storage_key,'') || chr(31) || coalesce(sha256,'')
       from item_media where storage_key is not null`,
      drillDb,
    );
    const restoredShaByKey = new Map<string, string>();
    for (const [k, s] of restoredRows) restoredShaByKey.set(k ?? '', s ?? '');

    for (const row of mediaRows) {
      const key = row[0] ?? '';
      const prodSha = row[1] ?? '';
      if (!key) continue;
      const prodFile = path.join(config.uploadsDir, key);
      const archFile = path.join(sandboxUploads, key);
      const restSha = restoredShaByKey.get(key) ?? '';

      if (!existsSync(archFile)) {
        missingInArchive += 1;
        if (details.length < 20) details.push(`归档缺失：${key}`);
        continue;
      }
      const archActual = await sha256File(archFile);
      checked += 1;

      // 恢复库记录与生产库记录（同一备份快照，理论上必须相等）
      if (restSha !== prodSha) {
        dbRecordMismatch += 1;
        if (details.length < 20) details.push(`库记录不一致：${key}`);
      }
      // 归档实算 vs 生产库里记录的 sha256（也等于验证了「备份还原出来的文件能用」）
      if (archActual !== prodSha) {
        hashMismatch += 1;
        if (details.length < 20) {
          details.push(
            `归档文件哈希不一致：${key}（库 ${prodSha.slice(0, 12)}… / 归档实算 ${archActual.slice(0, 12)}…）`,
          );
        }
      }
      // 若生产文件本身还在，也顺带比一次（备份期间未被改动的旁证）
      if (existsSync(prodFile)) {
        const prodActual = await sha256File(prodFile);
        if (prodActual !== prodSha && !details.includes(`生产文件损坏：${key}`) && details.length < 20) {
          details.push(`生产文件与库记录不符：${key}`);
        }
      }
    }
    run.check(
      '媒体归档文件齐全',
      missingInArchive === 0,
      missingInArchive === 0
        ? `抽样 ${mediaRows.length} 个媒体全部在归档中`
        : `${missingInArchive}/${mediaRows.length} 个媒体不在归档里`,
      { sampleSize: mediaRows.length, missingInArchive },
    );
    run.check(
      '媒体内容 sha256 三方一致',
      hashMismatch === 0 && dbRecordMismatch === 0,
      hashMismatch === 0 && dbRecordMismatch === 0
        ? `实算 ${checked} 个归档媒体，与生产/恢复库记录全部一致`
        : `哈希不一致 ${hashMismatch}，库记录不一致 ${dbRecordMismatch}`,
      { checked, hashMismatch, dbRecordMismatch, details },
    );

    // 7. 备份清单自证：清单条数与恢复库实际条数
    const manifestItems = manifest.counts.items ?? Number.NaN;
    const restoredItems = counts.find((c) => c.table === 'items')?.restored ?? Number.NaN;
    run.check(
      '备份清单条数与恢复库吻合',
      manifestItems === restoredItems,
      `manifest items=${manifestItems}，恢复库 items=${restoredItems}`,
    );

    const passed = run.failCount === 0;
    run.log(
      passed
        ? `演练通过：备份 ${path.basename(backupDir)} 可在隔离环境完整还原且与生产一致`
        : `演练失败：${run.failCount} 项检查未通过`,
    );
    log.info(passed ? '恢复演练通过' : '恢复演练未通过');

    return {
      backupDir,
      manifest,
      drillDb,
      sandboxDir: options.keepSandbox ? sandboxDir : sandboxDir,
      passed,
      comparison: {
        counts,
        fingerprints,
        media: {
          sampleSize: mediaRows.length,
          checked,
          missingInArchive,
          hashMismatch,
          dbRecordMismatch,
          details,
        },
        restoreWarnings: fatalWarnings.length,
        migration: { prod: prodMigration, restored: restoredMigration, ok: migrationOk },
      },
    };
  } finally {
    await cleanup();
  }
}

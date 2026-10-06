/**
 * PostgreSQL 备份目标适配器。
 *
 * backup：pg_dump -Fc 自定义格式（默认；自带 DDL/数据，可选择性还原）
 *         或 plain（.sql 文本，可直接审阅）。
 *         备份时同时记录每张用户表的「行数 + 内容 sha256」作为源端指纹。
 * drill ：在隔离沙箱里起一个全新的嵌入式 PostgreSQL 集群 → pg_restore 还原
 *         → 重算沙箱内各表指纹，与备份指纹逐表比对；
 *         另外再连一次源库，标注「备份后发生的正常数据漂移」，避免把漂移误报成损坏。
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ArtifactFile, CheckResult, Target } from '../types';
import type { BackupContext, BackupOutcome, DrillContext, DrillOutcome, TargetAdapter } from './adapter';
import { findPgToolchain, pgEnv, pgToolPath } from '../toolchain';
import { runProc } from '../engine/proc';
import { allStats, serverVersion, type TableStats } from '../engine/pglogical';
import { startPgSandbox } from '../engine/sandbox';
import { bytesLabel, hashJson, sha256File } from '../util';

const check = (id: string, label: string, verdict: CheckResult['verdict'], detail: string, rest?: Partial<CheckResult>): CheckResult =>
  ({ id, label, verdict, detail, ...rest });

export class PostgresAdapter implements TargetAdapter {
  kind = 'postgres' as const;

  private requireTools() {
    const tc = findPgToolchain();
    if (!tc) {
      throw new Error('找不到 pg_dump/pg_restore。请安装 postgresql-client，或设置 PG_BIN_DIR，或把免安装客户端解压到 tools/pg。');
    }
    return tc;
  }

  async ping(target: Target): Promise<CheckResult> {
    try {
      const cfg = target.config as { url: string };
      const v = await serverVersion(cfg.url);
      return check('pg.ping', '数据库连通性', 'pass', v.slice(0, 90));
    } catch (err) {
      return check('pg.ping', '数据库连通性', 'fail', err instanceof Error ? err.message : String(err));
    }
  }

  async backup(target: Target, ctx: BackupContext): Promise<BackupOutcome> {
    const tc = this.requireTools();
    const cfg = target.config as { url: string; format?: 'custom' | 'plain'; tables?: string[] };
    const format = cfg.format ?? 'custom';
    await mkdir(ctx.dir, { recursive: true });

    const checks: CheckResult[] = [];
    const sourceVersion = await serverVersion(cfg.url).catch(() => 'unknown');
    const dumpName = format === 'plain' ? 'db.sql' : 'db.dump';
    const dumpPath = join(ctx.dir, dumpName);
    const args = ['--no-owner', '--no-privileges'];
    if (format === 'custom') args.push('--format=custom');
    else args.push('--format=plain');
    if (cfg.tables?.length) {
      // pg_dump 的 -t 可多次出现
      cfg.tables.forEach((t) => args.push('--table', t));
    }
    args.push('--file', dumpPath, cfg.url);

    ctx.events.append({
      runId: ctx.runId,
      targetId: target.id,
      stage: 'backup',
      event: 'pg_dump.start',
      data: { format, tables: cfg.tables ?? 'all' },
    });
    const t0 = Date.now();
    const res = await runProc(pgToolPath(tc, 'pg_dump'), args, { env: pgEnv(tc), timeoutMs: 30 * 60_000 });
    const ms = Date.now() - t0;
    if (res.code !== 0 || !existsSync(dumpPath)) {
      throw new Error(`pg_dump 失败（exit ${res.code}）：${res.stderr.slice(-2000)}`);
    }
    const stat = await (await import('node:fs/promises')).stat(dumpPath);
    checks.push(check('pg.dump', 'pg_dump 导出', 'pass', `${format === 'custom' ? '自定义格式' : 'SQL 文本'} · ${bytesLabel(stat.size)} · ${ms} ms`));

    // 源端指纹（行数 + 内容哈希）。备份失败不致命：记录为警告。
    let fingerprint: Record<string, unknown> = {};
    try {
      const stats = await allStats(cfg.url, cfg.tables);
      fingerprint = {
        tables: stats,
        tableCount: stats.length,
        totalRows: stats.reduce((s, t) => s + t.rows, 0),
        fingerprintSha256: hashJson(stats),
      };
      checks.push(
        check(
          'pg.fingerprint',
          '源端表指纹采集',
          'pass',
          `${stats.length} 张表 / 共 ${fingerprint.totalRows} 行 · 指纹 ${String(fingerprint.fingerprintSha256).slice(0, 16)}…`,
        ),
      );
    } catch (err) {
      checks.push(check('pg.fingerprint', '源端表指纹采集', 'warn', `未采到指纹（行级比对将跳过）：${msg(err)}`));
      fingerprint = { tables: [], warning: msg(err) };
    }

    // dump 自身可读性校验：custom 用 pg_restore --list，plain 检查是否含 SQL 标记
    if (format === 'custom') {
      const list = await runProc(pgToolPath(tc, 'pg_restore'), ['--list', dumpPath], { env: pgEnv(tc) });
      if (list.code === 0 && list.stdout.includes(';')) {
        checks.push(check('pg.dump.readable', '备份文件可读（pg_restore --list）', 'pass', '归档目录可解析'));
      } else {
        checks.push(check('pg.dump.readable', '备份文件可读（pg_restore --list）', 'fail', list.stderr.slice(-500) || '归档无法解析'));
      }
    } else {
      const head = (await readFile(dumpPath, 'utf8')).slice(0, 400);
      if (head.includes('PostgreSQL database dump')) {
        checks.push(check('pg.dump.readable', '备份文件可读（SQL 头）', 'pass', '含 pg_dump 标准头注释'));
      } else {
        checks.push(check('pg.dump.readable', '备份文件可读（SQL 头）', 'warn', '未找到标准头注释，请人工确认'));
      }
    }

    const artifacts: ArtifactFile[] = [
      { name: dumpName, path: dumpName, bytes: stat.size, sha256: await sha256File(dumpPath) },
    ];

    return {
      sourceFingerprint: fingerprint,
      artifacts,
      checks,
      toolchain: {
        pg_dump: tc.version,
        sourceServer: sourceVersion,
      },
    };
  }

  async drill(target: Target, ctx: DrillContext): Promise<DrillOutcome> {
    const tc = this.requireTools();
    const cfg = target.config as { url: string; tables?: string[] };
    const dumpArtifact = ctx.manifest.artifacts.find((a) => a.name === 'db.dump' || a.name === 'db.sql');
    if (!dumpArtifact) throw new Error('备份产物中缺少 db.dump/db.sql');

    const dumpPath = join(ctx.backupDir, dumpArtifact.name);
    const checks: CheckResult[] = [];
    const sbDataDir = join(ctx.sandboxRoot, 'pgdata');
    const dbName = 'drill';

    ctx.events.append({ runId: ctx.runId, targetId: target.id, stage: 'drill', event: 'sandbox.start' });
    const sandbox = await startPgSandbox({ dataDir: sbDataDir, database: dbName, user: 'drill', password: 'drill' });
    checks.push(check('pg.sandbox', '隔离沙箱启动', 'pass', `嵌入式 PostgreSQL · 127.0.0.1:${sandbox.port}/${dbName}`));

    let restoreWarn = '';
    try {
      // 1. 还原备份
      const isCustom = dumpArtifact.name.endsWith('.dump');
      const args = ['--no-owner', '--no-privileges', '--dbname', sandbox.url];
      if (isCustom) args.push('--exit-on-error');
      const proc = isCustom
        ? await runProc(pgToolPath(tc, 'pg_restore'), [...args, dumpPath], { env: pgEnv(tc), timeoutMs: 30 * 60_000 })
        : await runProc(pgToolPath(tc, 'psql'), ['--dbname', sandbox.url, '--quiet', '--variable=ON_ERROR_STOP=1', '--file', dumpPath], {
            env: pgEnv(tc),
            timeoutMs: 30 * 60_000,
          });
      if (proc.code !== 0) {
        restoreWarn = proc.stderr.slice(-1500);
        checks.push(check('pg.restore', '还原到沙箱', 'fail', `退出码 ${proc.code}：${restoreWarn.slice(-400)}`));
      } else {
        checks.push(check('pg.restore', '还原到沙箱', 'pass', isCustom ? 'pg_restore 完成（无错误）' : 'psql 回放完成（ON_ERROR_STOP）'));
      }

      // 2. 沙箱指纹
      const sandboxStats = await allStats(sandbox.url, cfg.tables);
      const sourceStats = (ctx.manifest.sourceFingerprint.tables ?? []) as TableStats[];

      // 3. 比对：备份指纹 ↔ 沙箱（这是「备份可恢复且一致」的核心证据）
      const byKey = new Map(sandboxStats.map((s) => [`${s.schema}.${s.table}`, s]));
      let failTables = 0;
      let passTables = 0;
      let rowTotalDrift = 0;
      const detailRows: string[] = [];
      for (const fp of sourceStats) {
        const key = `${fp.schema}.${fp.table}`;
        const sb = byKey.get(key);
        if (!sb) {
          failTables += 1;
          detailRows.push(`- ❌ 缺少表 ${key}（备份记录 ${fp.rows} 行）`);
          continue;
        }
        if (sb.rows !== fp.rows) {
          failTables += 1;
          rowTotalDrift += Math.abs(sb.rows - fp.rows);
          detailRows.push(`- ❌ ${key} 行数不一致：备份 ${fp.rows} → 沙箱 ${sb.rows}`);
        } else if (sb.hash !== fp.hash) {
          failTables += 1;
          detailRows.push(`- ❌ ${key} 内容哈希不一致（行数同为 ${fp.rows}，但行内容有差异）`);
        } else {
          passTables += 1;
        }
      }
      const extraTables = sandboxStats.filter((s) => !sourceStats.some((f) => `${f.schema}.${f.table}` === `${s.schema}.${s.table}`));
      const verdict: CheckResult['verdict'] = failTables === 0 && restoreWarn === '' ? 'pass' : 'fail';
      checks.push(
        check(
          'pg.compare.content',
          '逐表内容比对（行数 + sha256）',
          verdict,
          [
            `一致 ${passTables}/${sourceStats.length} 张表`,
            extraTables.length ? `；沙箱多出 ${extraTables.length} 张表` : '',
            detailRows.length ? '\n' + detailRows.slice(0, 20).join('\n') : '',
          ].join(''),
          { expected: sourceStats.length, actual: passTables },
        ),
      );

      // 4. 源库漂移：当前源库 vs 备份时指纹。数据自备份以来正常变化会被标注为 warn 而非 fail。
      try {
        const liveStats = await allStats(cfg.url, cfg.tables);
        const liveBy = new Map(liveStats.map((s) => [`${s.schema}.${s.table}`, s]));
        let drifted = 0;
        const driftRows: string[] = [];
        for (const fp of sourceStats) {
          const live = liveBy.get(`${fp.schema}.${fp.table}`);
          if (!live) {
            drifted += 1;
            driftRows.push(`- ⚠️ 源表现已删除：${fp.schema}.${fp.table}`);
          } else if (live.rows !== fp.rows || live.hash !== fp.hash) {
            drifted += 1;
            driftRows.push(`- ⚠️ ${fp.schema}.${fp.table}：备份时 ${fp.rows} 行 → 现在 ${live.rows} 行`);
          }
        }
        checks.push(
          check(
            'pg.compare.drift',
            '源库自备份以来的漂移（仅供参考）',
            drifted === 0 ? 'pass' : 'warn',
            drifted === 0 ? '无漂移：源库与备份时刻完全一致' : `${drifted} 张表发生变化（备份后正常写入会导致此项变化）\n${driftRows.slice(0, 15).join('\n')}`,
          ),
        );
      } catch (err) {
        checks.push(check('pg.compare.drift', '源库漂移检查', 'skip', `源库当前不可连，跳过：${msg(err)}`));
      }

      // 5. 基础冒烟：能在沙箱执行简单查询
      const { connect } = await import('../engine/pglogical');
      const c = await connect(sandbox.url);
      try {
        const r = await c.query('select 1 as ok');
        checks.push(check('pg.smoke', '沙箱查询冒烟', r.rows[0]?.ok === 1 ? 'pass' : 'fail', 'select 1'));
      } finally {
        await c.end().catch(() => undefined);
      }
    } finally {
      if (!ctx.keep) {
        await sandbox.stop();
      } else {
        checks.push(check('pg.sandbox.kept', '沙箱已保留', 'warn', `数据目录保留在 ${sandbox.dataDir}（端口 ${sandbox.port}），请手工清理`));
      }
    }

    return {
      checks,
      sandbox: { kind: 'postgres', location: `embedded-pg:127.0.0.1:${sandbox.port}/${dbName}`, kept: ctx.keep },
      toolchain: {
        pg_restore: tc.version,
        sandbox: 'embedded-postgres',
      },
    };
  }
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

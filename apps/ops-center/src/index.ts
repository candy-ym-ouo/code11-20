#!/usr/bin/env node
/**
 * 备份编排与演练中心 —— 命令行入口。
 *
 * 守护模式（定时执行）：
 *   ops-center daemon
 *
 * 单次执行（手工 / 外部 cron）：
 *   ops-center backup [目录]      立即备份
 *   ops-center verify [目录]      校验指定（或最新）备份
 *   ops-center drill  [--keep-sandbox] [目录]
 *                                 还原到隔离环境并比对
 *   ops-center retention          按保留策略回收
 *
 * 可观测：
 *   ops-center status             打印最近运行与计划（JSON）
 *   ops-center list               列出磁盘上的备份
 *   ops-center runs [N]           最近 N 次运行
 *   ops-center audit              校验账本哈希链
 *   ops-center report <runId>     重新生成某次运行的 Markdown/JSON 报告
 *   ops-center serve              只开状态面板（不调度）
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { config } from './config/index.js';
import { Ledger } from './storage/ledger.js';
import { acquireLock } from './storage/lock.js';
import { TaskService, defaultOpsRootsReady } from './tasks/service.js';
import { Scheduler } from './scheduler/index.js';
import type { JobName } from './scheduler/index.js';
import { createServer } from './server/http.js';
import { describeCron, nextMatch } from './scheduler/cron.js';
import { findBackups } from './tasks/verify.js';
import { writeReports } from './report/index.js';
import type { DrillResult } from './tasks/drill.js';
import type { BackupManifest } from './tasks/backup.js';
import { log } from './util/logger.js';

interface CliContext {
  ledger: Ledger;
  service: TaskService;
}

function init(): CliContext {
  defaultOpsRootsReady();
  const ledger = new Ledger();
  return { ledger, service: new TaskService(ledger) };
}

function printUsage(): void {
  process.stdout.write(`${'备份编排与演练中心'}

用法：ops-center <命令> [参数]

守护与调度
  daemon                    常驻进程，按 cron 定时备份/校验/演练，并启动只读状态面板
  serve                     只启动状态面板（不调度）
  schedule                  打印三条 cron 计划与下一次执行时间

单次任务
  backup [目录]             立即执行一次完整备份（数据库 + 媒体 + 清单 + DONE）
  verify [备份目录]         校验备份文件哈希/可解析性，并抽样核对生产媒体
  drill [备份目录]          还原到隔离临时库 + 解压到隔离目录，全量比对
        --keep-sandbox      演练后保留临时库与沙箱目录（排障用，需手工清理）
  retention                 按 BACKUP_RETENTION_DAYS/COUNT 回收旧备份

追溯与审计
  status                    汇总状态（JSON）
  list                      列出备份目录
  runs [N]                  最近 N 次运行（默认 10）
  run <runId>               单次运行的完整事件聚合（JSON）
  audit                     校验账本哈希链是否被篡改
  report <runId>            为历史运行重新生成报告文件

环境变量（.env 与应用共享）
  BACKUP_CRON / VERIFY_CRON / DRILL_CRON
  BACKUP_RETENTION_DAYS(30) / BACKUP_RETENTION_COUNT(30)
  VERIFY_SAMPLE_SIZE(50) / DRILL_COMPARE_SAMPLE_SIZE(50)（0=全量）
  OPS_HTTP_PORT(4097) / OPS_HTTP_HOST(127.0.0.1)
  PG_BIN_PATH               pg 客户端二进制目录（不在 PATH 时设置）
`);
}

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);

  switch (cmd) {
    case undefined:
    case '-h':
    case '--help':
    case 'help':
      printUsage();
      return 0;

    case 'backup': {
      const ctx = init();
      const withLock = acquireLock();
      try {
        const targetDir = rest[0] && !rest[0].startsWith('--') ? path.resolve(rest[0]) : undefined;
        const { outcome, reports } = await ctx.service.backup('cli', targetDir);
        if (reports) log.info(`报告：${reports.md}`);
        return outcome.status === 'success' ? 0 : 1;
      } finally {
        withLock.release();
      }
    }

    case 'verify': {
      const ctx = init();
      const withLock = acquireLock();
      try {
        const dir = rest[0] && !rest[0].startsWith('--') ? path.resolve(rest[0]) : undefined;
        const { outcome, reports } = await ctx.service.verify('cli', dir);
        if (reports) log.info(`报告：${reports.md}`);
        return outcome.status === 'success' ? 0 : 1;
      } finally {
        withLock.release();
      }
    }

    case 'drill': {
      const ctx = init();
      const withLock = acquireLock();
      try {
        const keep = rest.includes('--keep-sandbox');
        const dir = rest.find((a) => !a.startsWith('--'));
        const { outcome, reports } = await ctx.service.drill('cli', {
          backupDir: dir ? path.resolve(dir) : undefined,
          keepSandbox: keep,
        });
        if (reports) log.info(`报告：${reports.md}`);
        return outcome.status === 'success' ? 0 : 1;
      } finally {
        withLock.release();
      }
    }

    case 'retention': {
      const ctx = init();
      const withLock = acquireLock();
      try {
        const { outcome } = await ctx.service.retention('cli');
        return outcome.status === 'success' ? 0 : 1;
      } finally {
        withLock.release();
      }
    }

    case 'daemon': {
      const ctx = init();
      const withLock = acquireLock();
      const audit = ctx.ledger.integrity();
      if (audit.corrupted.length > 0) {
        log.error(`账本完整性校验失败：${JSON.stringify(audit.corrupted)}，拒绝启动守护进程`);
        withLock.release();
        return 2;
      }
      const scheduler = new Scheduler([
        { name: 'backup' as JobName, cron: config.backupCron, run: () => ctx.service.backup('schedule').then(() => undefined) },
        { name: 'verify' as JobName, cron: config.verifyCron, run: () => ctx.service.verify('schedule').then(() => undefined) },
        { name: 'drill' as JobName, cron: config.drillCron, run: () => ctx.service.drill('schedule').then(() => undefined) },
      ]);
      scheduler.start();

      if (config.httpPort > 0) {
        const server = createServer({ ledger: ctx.ledger, scheduler });
        server.listen(config.httpPort, config.httpHost, () => {
          log.info(`状态面板：http://${config.httpHost}:${config.httpPort}/`);
        });
        server.on('error', (err) => log.error(`状态面板启动失败：${(err as Error).message}`));
      } else {
        log.info('状态面板已禁用（OPS_HTTP_PORT<=0）');
      }

      const shutdown = (sig: string) => {
        log.info(`收到 ${sig}，停止调度并退出`);
        scheduler.stop();
        withLock.release();
        process.exit(0);
      };
      process.on('SIGTERM', () => shutdown('SIGTERM'));
      process.on('SIGINT', () => shutdown('SIGINT'));
      // 常驻
      await new Promise<void>(() => undefined);
      return 0;
    }

    case 'serve': {
      const ctx = init();
      const server = createServer({ ledger: ctx.ledger });
      server.listen(config.httpPort, config.httpHost, () => {
        log.info(`状态面板（无调度）：http://${config.httpHost}:${config.httpPort}/`);
      });
      await new Promise<void>(() => undefined);
      return 0;
    }

    case 'schedule': {
      for (const [job, cron] of [
        ['备份', config.backupCron],
        ['校验', config.verifyCron],
        ['演练', config.drillCron],
      ] as const) {
        process.stdout.write(`${job}：${describeCron(cron, config.timezone)}\n`);
      }
      return 0;
    }

    case 'status': {
      const ctx = init();
      const runs = ctx.ledger.runs();
      const latest = (k: string) => runs.find((r) => r.kind === k);
      process.stdout.write(
        `${JSON.stringify(
          {
            time: new Date().toISOString(),
            backupRoot: config.backupRoot,
            opsRoot: config.opsRoot,
            reportDir: config.reportDir,
            schedules: {
              backup: { cron: config.backupCron, next: nextMatch(config.backupCron, new Date(), config.timezone).toISOString() },
              verify: { cron: config.verifyCron, next: nextMatch(config.verifyCron, new Date(), config.timezone).toISOString() },
              drill: { cron: config.drillCron, next: nextMatch(config.drillCron, new Date(), config.timezone).toISOString() },
            },
            latest: {
              backup: latest('backup')?.status ?? null,
              verify: latest('verify')?.status ?? null,
              drill: latest('drill')?.status ?? null,
            },
            backups: findBackups().map((d) => ({
              dir: d,
              done: existsSync(path.join(d, 'DONE')),
            })),
            ledgerAudit: ctx.ledger.integrity(),
          },
          null,
          2,
        )}\n`,
      );
      return 0;
    }

    case 'list': {
      const dirs = findBackups();
      if (dirs.length === 0) {
        process.stdout.write('（暂无备份）\n');
        return 0;
      }
      for (const d of dirs) {
        const done = existsSync(path.join(d, 'DONE'));
        const mtime = statSync(d).mtime.toISOString();
        process.stdout.write(`${done ? '✅' : '⬜'} ${d}  ${mtime}\n`);
      }
      return 0;
    }

    case 'runs': {
      const ctx = init();
      const n = Number(rest[0] ?? 10);
      for (const r of ctx.ledger.runs().slice(0, n)) {
        process.stdout.write(
          `${r.status.padEnd(7)} ${r.kind.padEnd(9)} ${r.runId}  ${r.startedAt}  ` +
            `${r.checks.filter((c) => c.ok).length}/${r.checks.length} 检查通过` +
            `${r.backupDir ? `  ${path.basename(r.backupDir)}` : ''}\n`,
        );
      }
      return 0;
    }

    case 'run': {
      const ctx = init();
      const run = ctx.ledger.runs().find((r) => r.runId === rest[0]);
      if (!run) {
        process.stderr.write(`找不到运行：${rest[0]}\n`);
        return 1;
      }
      process.stdout.write(`${JSON.stringify(run, null, 2)}\n`);
      return 0;
    }

    case 'audit': {
      const ctx = init();
      const result = ctx.ledger.integrity();
      if (result.corrupted.length === 0) {
        process.stdout.write(`✅ 账本哈希链完整：${config.ledgerFile}\n`);
        return 0;
      }
      process.stderr.write(`❌ 账本异常：${JSON.stringify(result.corrupted, null, 2)}\n`);
      return 1;
    }

    case 'report': {
      const ctx = init();
      const run = ctx.ledger.runs().find((r) => r.runId === rest[0]);
      if (!run) {
        process.stderr.write(`找不到运行：${rest[0]}\n`);
        return 1;
      }
      let drill: DrillResult | undefined;
      let manifest: BackupManifest | undefined;
      // 历史 drill 的明细已经在 check.data 里；若备份目录还在，顺带读 manifest
      if (run.backupDir && existsSync(path.join(run.backupDir, 'manifest.json'))) {
        manifest = JSON.parse(
          readFileSync(path.join(run.backupDir, 'manifest.json'), 'utf8'),
        ) as BackupManifest;
      }
      const files = writeReports({
        run,
        drill,
        manifest,
        ledgerIntegrity: ctx.ledger.integrity(),
      });
      process.stdout.write(`报告已生成：\n  ${files.md}\n  ${files.json}\n`);
      return 0;
    }

    default:
      process.stderr.write(`未知命令：${cmd}\n\n`);
      printUsage();
      return 2;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    log.error(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exit(1);
  });

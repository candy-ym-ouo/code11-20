#!/usr/bin/env node
/**
 * 备份编排与演练中心 —— CLI 入口
 *
 * 命令：
 *   run [--target ID]... [--backup] [--drill] [--reason TXT] [--keep-sandbox]
 *                        立即执行一轮（默认 backup+drill）
 *   daemon               常驻：按 config.json 里的 cron 定时执行 + 起看板 HTTP
 *   serve                只起看板 HTTP（不调度），便于查看历史与手动触发
 *   target list
 *   target add <kind> <name> --url ... | --dir ... [--no-enable]
 *   target rm <id>
 *   plan set <targetId> [--backup "cron"] [--drill "cron"] [--off]
 *   plan rm <targetId>
 *   runs [--limit N]
 *   report <runId> [--name summary.md]      打印报告到 stdout
 *   verify <runId>                          校验事件哈希链
 *   prune --keep N                          只保留最近 N 次 run
 */
import 'dotenv/config';
import { resolve } from 'node:path';
import { Orchestrator } from './orchestrator';
import { ConfigService } from './configService';
import { StateStore } from './state';
import { Scheduler } from './scheduler';
import { startServer } from './server/http';
import type { TargetKind } from './types';

function argValue(flag: string, argv: string[]): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}
function hasFlag(flag: string, argv: string[]): boolean {
  return argv.includes(flag);
}

const STATE_ROOT = resolve(process.env.BACKUP_CENTER_STATE ?? 'data/backup-center');
const HTTP_PORT = parseInt(process.env.BACKUP_CENTER_PORT ?? '4090', 10);

function services() {
  const store = new StateStore(STATE_ROOT);
  return { store, config: new ConfigService(store), orchestrator: new Orchestrator(store) };
}

function printUsage(): void {
  process.stdout.write(
    [
      '备份编排与演练中心',
      `状态目录：${STATE_ROOT}`,
      '',
      '用法：backup-center <命令> [参数]',
      '  run        立即执行备份+演练（--backup / --drill 可限定阶段）',
      '  onboard    从 .env 一键注册数据库/媒体目标与默认每日/每周计划',
      '  daemon     常驻调度（cron）+ 看板 HTTP',
      '  serve      只起看板 HTTP',
      '  target     list | add | rm',
      '  plan       set <targetId> --backup "30 2 * * *" --drill "0 4 * * 1"',
      '  runs       最近运行',
      '  report     <runId> 打印 Markdown 报告',
      '  verify     <runId> 校验事件哈希链',
      '  prune      --keep N',
      '',
    ].join('\n'),
  );
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const { store, config, orchestrator } = services();

  switch (cmd) {
    case undefined:
    case '-h':
    case '--help':
      printUsage();
      return;

    case 'run': {
      const targetIds = collectValues(rest, '--target');
      const stages = [hasFlag('--backup', rest) ? 'backup' : null, hasFlag('--drill', rest) ? 'drill' : null].filter(
        Boolean,
      ) as Array<'backup' | 'drill'>;
      const run = await orchestrator.execute({
        trigger: 'cli',
        reason: argValue('--reason', rest) ?? 'CLI 立即执行',
        targetIds: targetIds.length ? targetIds : undefined,
        stages: stages.length ? stages : undefined,
        keepSandbox: hasFlag('--keep-sandbox', rest),
      });
      printRunSummary(run);
      process.exitCode = run.status === 'failed' ? 1 : 0;
      return;
    }

    case 'daemon':
    case 'serve': {
      const server = startServer({ orchestrator, config, store, port: HTTP_PORT });
      process.stdout.write(`看板：http://127.0.0.1:${HTTP_PORT}\n`);
      if (cmd === 'daemon') {
        const scheduler = new Scheduler(
          store.loadConfig().plans.filter((p) => p.enabled).flatMap((p) => [
            { targetId: p.targetId, kind: 'backup' as const, cron: p.backupCron },
            { targetId: p.targetId, kind: 'drill' as const, cron: p.drillCron },
          ]),
          async (targetId, kind) => {
            process.stdout.write(`[scheduler] ${new Date().toISOString()} 触发 ${targetId} ${kind}\n`);
            try {
              const run = await orchestrator.execute({
                trigger: 'schedule',
                reason: `定时 ${kind}`,
                targetIds: [targetId],
                stages: [kind],
              });
              process.stdout.write(`[scheduler] 完成 ${run.id} → ${run.status}\n`);
            } catch (err) {
              process.stderr.write(`[scheduler] 失败：${err instanceof Error ? err.message : String(err)}\n`);
            }
          },
        );
        scheduler.start();
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        process.stdout.write(`调度时区：${tz}（cron 按该时区的墙上时间触发；受 .env 的 TZ 影响）\n`);
        process.stdout.write('已启用的定时计划：\n');
        for (const u of scheduler.upcoming()) {
          process.stdout.write(`  ${u.key}  "${u.cron}"  下次：${u.next.toLocaleString()}\n`);
        }
      }
      // 常驻
      await new Promise<void>(() => undefined);
      void server;
      return;
    }

    case 'onboard': {
      const { onboard } = await import('./scripts/onboard');
      await onboard();
      return;
    }

    case 'target': {
      const sub = rest[0];
      if (sub === 'list') {
        const targets = config.listTargets();
        if (targets.length === 0) process.stdout.write('（无目标）\n');
        for (const t of targets) {
          process.stdout.write(`${t.enabled ? '●' : '○'} ${t.id}  [${t.kind}]  ${t.name}\n`);
          process.stdout.write(`    ${JSON.stringify(t.config)}\n`);
        }
        return;
      }
      if (sub === 'add') {
        const kind = rest[1] as TargetKind;
        const name = rest[2];
        if (!kind || !name) throw new Error('用法：target add <postgres|media|tablefile> <name> --url/--dir');
        const targetConfig =
          kind === 'postgres'
            ? {
                url: required('--url', rest),
                format: (argValue('--format', rest) as 'custom' | 'plain' | undefined) ?? 'custom',
                ...(collectValues(rest, '--table').length ? { tables: collectValues(rest, '--table') } : {}),
              }
            : kind === 'media'
              ? { dir: required('--dir', rest), ...(argValue('--sample', rest) ? { sampleRatio: parseFloat(required('--sample', rest)) } : {}) }
              : { dir: required('--dir', rest), ...(collectValues(rest, '--table').length ? { tables: collectValues(rest, '--table') } : {}) };
        const t = config.upsertTarget({ name, kind, enabled: !hasFlag('--no-enable', rest), config: targetConfig });
        process.stdout.write(`已添加目标：${t.id}\n`);
        return;
      }
      if (sub === 'rm') {
        config.removeTarget(requiredId(rest[1]));
        process.stdout.write('已删除\n');
        return;
      }
      throw new Error('用法：target list | add | rm');
    }

    case 'plan': {
      const sub = rest[0];
      if (sub === 'set') {
        const targetId = requiredId(rest[1]);
        const existing = config.listPlans().find((p) => p.targetId === targetId);
        const off = hasFlag('--off', rest);
        config.setPlan({
          targetId,
          backupCron: off ? '' : argValue('--backup', rest) ?? existing?.backupCron ?? '',
          drillCron: off ? '' : argValue('--drill', rest) ?? existing?.drillCron ?? '',
          enabled: !off,
        });
        process.stdout.write('计划已保存（daemon 重启后生效；下一次调度按新计划）\n');
        return;
      }
      if (sub === 'rm') {
        config.removePlan(requiredId(rest[1]));
        process.stdout.write('已删除计划\n');
        return;
      }
      for (const p of config.listPlans()) {
        process.stdout.write(`${p.targetId}  backup="${p.backupCron || '-'}"  drill="${p.drillCron || '-'}"  ${p.enabled ? '启用' : '停用'}\n`);
      }
      return;
    }

    case 'runs': {
      const limit = parseInt(argValue('--limit', rest) ?? '20', 10);
      const runs = await store.listRuns();
      for (const r of runs.slice(0, limit)) {
        const stages = Object.entries(r.stages)
          .map(([k, s]) => `${k.replace(/^[^:]+:/, '')}:${s.status}`)
          .join(' ');
        process.stdout.write(`${r.id}  ${r.status.padEnd(8)} ${r.trigger.padEnd(8)} ${r.startedAt}  ${stages}\n`);
      }
      return;
    }

    case 'report': {
      const runId = requiredId(rest[0]);
      const name = argValue('--name', rest) ?? 'summary.md';
      const run = await store.loadRun(runId);
      if (!run) throw new Error(`找不到运行：${runId}`);
      const rel = run.reports.find((r) => r.endsWith(name)) ?? run.reports[0];
      if (!rel) throw new Error('该运行没有报告');
      const { readFile } = await import('node:fs/promises');
      process.stdout.write((await readFile(resolve(STATE_ROOT, rel), 'utf8')) + '\n');
      return;
    }

    case 'verify': {
      const runId = requiredId(rest[0]);
      const v = orchestrator.verifyChain(runId);
      process.stdout.write(`事件 ${v.events} 条，哈希链 ${v.ok ? '完整 ✅' : `断裂于 #${v.brokenAt} ❌`}\n`);
      process.exitCode = v.ok ? 0 : 1;
      return;
    }

    case 'prune': {
      const keep = parseInt(required('--keep', rest), 10);
      const removed = await store.pruneRuns(keep);
      process.stdout.write(`已清理 ${removed.length} 次历史运行：${removed.join(', ') || '（无）'}\n`);
      return;
    }

    default:
      printUsage();
      process.exitCode = 1;
  }
}

function collectValues(argv: string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === flag && argv[i + 1]) out.push(argv[i + 1]!);
  return out;
}
function required(flag: string, argv: string[]): string {
  const v = argValue(flag, argv);
  if (!v) throw new Error(`缺少参数 ${flag}`);
  return v;
}
function requiredId(v: string | undefined): string {
  if (!v) throw new Error('缺少 targetId/runId');
  return v;
}

function printRunSummary(run: { id: string; status: string; stages: Record<string, { status: string; checks: { verdict: string }[] }>; reports: string[] }): void {
  process.stdout.write(`\n运行 ${run.id} → ${run.status}\n`);
  for (const [k, s] of Object.entries(run.stages)) {
    const fails = s.checks.filter((c) => c.verdict === 'fail').length;
    const warns = s.checks.filter((c) => c.verdict === 'warn').length;
    process.stdout.write(`  ${k}: ${s.status}（${s.checks.length} 项检查，失败 ${fails}，警告 ${warns}）\n`);
  }
  for (const r of run.reports) process.stdout.write(`  报告：${resolve(STATE_ROOT, r)}\n`);
}

main().catch((err) => {
  process.stderr.write(`错误：${err instanceof Error ? err.stack || err.message : String(err)}\n`);
  process.exit(1);
});

/**
 * 可追溯报告：每次运行落两份文件：
 *   - 报告-<runId>.md   人读（打印/存档/发群里都行）
 *   - 报告-<runId>.json 机读（供监控/大屏消费）
 * 报告开头是「追溯头」：runId、触发方式、时间、目标、账本序号与哈希链位置，
 * 凭 runId 可以在 ledger.ndjson 里重放出完全相同的检查过程。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { config } from '../config/index.js';
import type { RunSummary } from '../storage/ledger.js';
import { describeTarget } from '../util/pg.js';
import type { DrillResult } from '../tasks/drill.js';
import type { BackupManifest } from '../tasks/backup.js';
import { sha256Text } from '../util/hash.js';

export interface ReportContext {
  run: RunSummary;
  drill?: DrillResult;
  manifest?: BackupManifest;
  /** 账本校验结果（启动时算一次）。 */
  ledgerIntegrity?: { ok: boolean; corrupted: Array<{ line: number; reason: string }> };
}

const KIND_LABEL: Record<string, string> = {
  backup: '定时备份',
  verify: '完整性校验',
  drill: '恢复演练',
  retention: '保留策略回收',
  manual: '手工任务',
};

const STATUS_EMOJI: Record<string, string> = {
  success: '✅ 通过',
  failed: '❌ 失败',
  partial: '⚠️ 部分通过',
  running: '⏳ 进行中',
};

export function renderMarkdown(ctx: ReportContext): string {
  const { run } = ctx;
  const lines: string[] = [];
  const title = KIND_LABEL[run.kind] ?? run.kind;
  const started = new Date(run.startedAt);
  const finished = run.finishedAt ? new Date(run.finishedAt) : undefined;
  const duration = run.durationMs ? `${(run.durationMs / 1000).toFixed(1)}s` : '-';

  lines.push(`# 备份编排与演练中心 · ${title}报告`);
  lines.push('');
  lines.push('## 追溯信息');
  lines.push('');
  lines.push('| 项 | 值 |');
  lines.push('| --- | --- |');
  lines.push(`| 运行 ID | \`${run.runId}\` |`);
  lines.push(`| 结论 | **${STATUS_EMOJI[run.status] ?? run.status}** |`);
  lines.push(`| 触发方式 | ${triggerLabel(run.trigger)} |`);
  lines.push(`| 开始时间 | ${formatTime(started)} |`);
  lines.push(`| 结束时间 | ${finished ? formatTime(finished) : '-'} |`);
  lines.push(`| 耗时 | ${duration} |`);
  lines.push(`| 目标数据库 | \`${describeTarget()}\` |`);
  if (run.backupDir) lines.push(`| 关联备份 | \`${run.backupDir}\` |`);
  lines.push(`| 账本 | \`${config.ledgerFile}\`（按 runId 过滤即可重放全过程） |`);
  if (ctx.ledgerIntegrity) {
    lines.push(
      `| 账本完整性 | ${ctx.ledgerIntegrity.ok ? '✅ 哈希链校验通过' : `❌ 检测到 ${ctx.ledgerIntegrity.corrupted.length} 处异常`} |`,
    );
  }
  lines.push('');

  if (ctx.manifest) {
    lines.push('## 备份清单');
    lines.push('');
    lines.push('| 项 | 值 |');
    lines.push('| --- | --- |');
    lines.push(`| 创建时间（UTC） | ${ctx.manifest.createdAt} |`);
    lines.push(`| 来源主机 | ${ctx.manifest.host} |`);
    lines.push(`| 迁移版本 | ${ctx.manifest.migration ?? '-'} |`);
    lines.push(`| 清单版本 | v${ctx.manifest.formatVersion} |`);
    lines.push('');
    lines.push('### 条数');
    lines.push('');
    lines.push('| 对象 | 数量 |');
    lines.push('| --- | --- |');
    for (const [k, v] of Object.entries(ctx.manifest.counts)) {
      lines.push(`| ${k} | ${v} |`);
    }
    lines.push('');
    lines.push('### 文件');
    lines.push('');
    lines.push('| 文件 | 字节 | sha256 |');
    lines.push('| --- | --- | --- |');
    for (const [name, meta] of Object.entries(ctx.manifest.files)) {
      lines.push(`| ${name} | ${meta.bytes} | \`${meta.sha256}\` |`);
    }
    lines.push('');
  }

  if (ctx.drill) {
    appendDrillSection(lines, ctx.drill);
  }

  lines.push('## 检查项');
  lines.push('');
  lines.push('| # | 结果 | 检查 | 详情 |');
  lines.push('| --- | --- | --- | --- |');
  run.checks.forEach((c, i) => {
    lines.push(
      `| ${i + 1} | ${c.ok ? '✅' : '❌'} | ${escapeCell(c.name)} | ${escapeCell(c.detail)} |`,
    );
  });
  const passCount = run.checks.filter((c) => c.ok).length;
  const failCount = run.checks.filter((c) => !c.ok).length;
  lines.push('');
  lines.push(`合计：${passCount} 项通过 / ${failCount} 项失败`);
  lines.push('');

  if (run.artifacts.length > 0) {
    lines.push('## 产物');
    lines.push('');
    for (const a of run.artifacts) {
      const hash = a.sha256 ? ` · \`${a.sha256.slice(0, 16)}…\`` : '';
      const size = a.bytes ? ` · ${formatBytes(a.bytes)}` : '';
      lines.push(`- \`${a.path}\`${hash}${size}`);
    }
    lines.push('');
  }

  if (run.error) {
    lines.push('## 异常');
    lines.push('');
    lines.push('```');
    lines.push(run.error.slice(0, 4000));
    lines.push('```');
    lines.push('');
  }

  lines.push('---');
  lines.push(
    `本报告由备份编排与演练中心自动生成。账本为 append-only 且逐行哈希链，任何事后篡改均可通过 \`ops-center audit\` 检出。`,
  );
  return lines.join('\n');
}

function appendDrillSection(out: string[], d: DrillResult): void {
  out.push('## 隔离环境还原比对');
  out.push('');
  out.push(`- 隔离数据库：\`${d.drillDb}\`（演练结束已自动删除）`);
  out.push(`- 隔离文件目录：\`${d.sandboxDir}\`（演练结束已自动清理）`);
  out.push(`- pg_restore 致命错误数：${d.comparison.restoreWarnings}`);
  out.push(
    `- 迁移版本：生产 \`${d.comparison.migration.prod}\` ↔ 恢复 \`${d.comparison.migration.restored}\` ${d.comparison.migration.ok ? '✅' : '❌'}`,
  );
  out.push('');

  out.push('### 行数比对');
  out.push('');
  out.push('| 表 | 生产库 | 恢复库 | 一致 |');
  out.push('| --- | --- | --- | --- |');
  for (const c of d.comparison.counts) {
    out.push(`| ${c.table} | ${c.prod} | ${c.restored} | ${c.ok ? '✅' : '❌'} |`);
  }
  out.push('');

  const fpShown = d.comparison.fingerprints;
  out.push('### 内容指纹比对（全行 md5 聚合）');
  out.push('');
  out.push('| 表 | 生产指纹 | 恢复指纹 | 一致 |');
  out.push('| --- | --- | --- | --- |');
  for (const f of fpShown) {
    out.push(
      `| ${f.table} | \`${f.prodFp.slice(0, 20)}\` | \`${f.restoredFp.slice(0, 20)}\` | ${f.ok ? '✅' : '❌'} |`,
    );
  }
  out.push('');

  const m = d.comparison.media;
  out.push('### 媒体三方比对（生产磁盘 / 恢复库记录 / 归档解压文件）');
  out.push('');
  out.push(`- 抽样：${m.sampleSize} 个；实算：${m.checked} 个`);
  out.push(`- 归档缺失：${m.missingInArchive}`);
  out.push(`- 归档文件哈希不一致：${m.hashMismatch}`);
  out.push(`- 恢复库记录不一致：${m.dbRecordMismatch}`);
  if (m.details.length > 0) {
    out.push('');
    out.push('异常明细（最多 20 条）：');
    for (const detail of m.details) out.push(`- ${detail}`);
  }
  out.push('');
}

export interface MachineReport {
  reportVersion: 1;
  generatedAt: string;
  run: RunSummary;
  drill?: DrillResult;
  manifest?: BackupManifest;
  ledgerIntegrity?: ReportContext['ledgerIntegrity'];
}

export function renderJson(ctx: ReportContext): string {
  const payload: MachineReport = {
    reportVersion: 1,
    generatedAt: new Date().toISOString(),
    run: ctx.run,
    drill: ctx.drill,
    manifest: ctx.manifest,
    ledgerIntegrity: ctx.ledgerIntegrity,
  };
  return JSON.stringify(payload, null, 2);
}

export function writeReports(ctx: ReportContext): { md: string; json: string } {
  mkdirSync(config.reportDir, { recursive: true });
  const base = path.join(config.reportDir, `${ctx.run.kind}-${ctx.run.runId}`);
  const md = `${base}.md`;
  const json = `${base}.json`;
  const mdText = renderMarkdown(ctx);
  writeFileSync(md, mdText);
  const jsonText = renderJson(ctx);
  writeFileSync(json, jsonText);
  // 报告本身也留指纹，便于确认报告文件未被替换
  writeFileSync(
    `${base}.sha256`,
    `${sha256Text(mdText)}  ${path.basename(md)}\n${sha256Text(jsonText)}  ${path.basename(json)}\n`,
  );
  return { md, json };
}

function triggerLabel(t: string): string {
  return t === 'schedule' ? '定时调度（cron）' : t === 'cli' ? '命令行手工触发' : '手工触发';
}

function formatTime(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function pad(n: number): string {
  return n.toString().padStart(2, '0');
}
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MiB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}
function escapeCell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 500);
}

/**
 * 可追溯 Markdown 报告。
 * 每次 run 产出：
 *  - summary.md：所有目标的总览（含结论、阶段、校验通过率、产物哈希）
 *  - <targetId>.md：单目标详细报告（逐条 check、工具链、沙箱、事件哈希链摘要）
 *
 * 报告自带「溯源信息」：runId、触发方式、起止时间、主机、manifest sha256、
 * 事件链首尾哈希 —— 拿着这一份文件就能回到 run 目录核对原始证据。
 */
import type { Run, StageResult, Target } from '../types';
import { bytesLabel, msLabel } from '../util';
import { EventLog } from '../state';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

export interface SingleReportInput {
  run: Run;
  target: Target;
  stages: StageResult[];
  /** 该 run 的绝对目录，用于读取事件哈希链 */
  runDir?: string;
}

export interface SummaryReportInput {
  run: Run;
  targets: Target[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  stages: Array<[string, StageResult]>;
  runDir?: string;
}

interface ChainInfo {
  events: number;
  headHash?: string;
  tailHash?: string;
  ok: boolean;
}

function verdictIcon(v: string): string {
  switch (v) {
    case 'pass':
      return '✅';
    case 'fail':
      return '❌';
    case 'warn':
      return '⚠️';
    default:
      return '⏭️';
  }
}

function stageNameZh(key: string): string {
  return key.endsWith(':backup') ? '备份' : key.endsWith(':drill') ? '隔离演练' : '编排';
}

function readChain(runDir: string): ChainInfo | undefined {
  const file = join(runDir, 'events.jsonl');
  if (!existsSync(file)) return undefined;
  const v = EventLog.verify(file);
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const head = lines[0] ? (JSON.parse(lines[0]) as { hash: string }).hash : undefined;
  const tail = lines[lines.length - 1] ? (JSON.parse(lines[lines.length - 1]!) as { hash: string }).hash : undefined;
  return { events: v.events.length, headHash: head, tailHash: tail, ok: v.ok };
}

function checksTable(s: StageResult): string {
  if (s.checks.length === 0) return '_无校验记录_\n';
  const rows = s.checks.map((c) => {
    const detail = c.detail.replace(/\|/g, '\\|').replace(/\n/g, '<br>');
    return `| ${verdictIcon(c.verdict)} | ${c.label} | ${detail} |`;
  });
  return ['| 结果 | 检查项 | 详情 |', '| --- | --- | --- |', ...rows].join('\n') + '\n';
}

function artifactsTable(s: StageResult): string {
  if (s.artifacts.length === 0) return '_无产物文件_\n';
  const rows = s.artifacts.map(
    (a) => `| \`${a.name}\` | ${bytesLabel(a.bytes)} | \`${a.sha256.slice(0, 24)}…\` |`,
  );
  return ['| 文件 | 大小 | sha256 |', '| --- | --- | --- |', ...rows].join('\n') + '\n';
}

function toolchainLine(s: StageResult): string {
  const entries = Object.entries(s.toolchain);
  if (entries.length === 0) return '_未记录_';
  return entries.map(([k, v]) => `**${k}**: ${v}`).join(' · ');
}

function overall(stages: StageResult[]): { icon: string; text: string } {
  if (stages.some((s) => s.status === 'failed')) return { icon: '❌', text: '未通过' };
  if (stages.every((s) => s.status === 'skipped')) return { icon: '⏭️', text: '跳过' };
  if (stages.some((s) => s.checks.some((c) => c.verdict === 'warn'))) return { icon: '🟡', text: '通过（有警告）' };
  return { icon: '✅', text: '通过' };
}

export function renderMarkdownReport(input: SingleReportInput): string;
export function renderMarkdownReport(input: SummaryReportInput): string;
export function renderMarkdownReport(input: SingleReportInput | SummaryReportInput): string {
  if ('target' in input) return renderSingle(input);
  return renderSummary(input);
}

function header(run: Run, title: string, runDir?: string): string {
  const chain = runDir && isAbsolute(runDir) ? readChain(runDir) : undefined;
  const lines = [
    `# ${title}`,
    '',
    `- 运行编号：\`${run.id}\``,
    `- 触发方式：${triggerZh(run.trigger)}${run.reason ? `（${run.reason}）` : ''}`,
    `- 开始：${run.startedAt}`,
    `- 结束：${run.finishedAt ?? '_进行中_'}`,
  ];
  if (chain) {
    lines.push(
      `- 事件链：${chain.events} 条事件 · 链校验 ${chain.ok ? '✅ 完整' : '❌ 断裂'}`,
      `- 链首哈希：\`${chain.headHash ?? '-'}\``,
      `- 链尾哈希：\`${chain.tailHash ?? '-'}\``,
    );
  }
  lines.push('');
  return lines.join('\n');
}

function triggerZh(t: Run['trigger']): string {
  return ({ schedule: '定时调度', manual: '手动', cli: '命令行', drill: '演练触发' } as const)[t] ?? t;
}

function renderSingle(input: SingleReportInput): string {
  const { run, target, stages } = input;
  const o = overall(stages);
  const parts: string[] = [
    header(run, `备份/演练报告 · ${target.name}`, input.runDir),
    `## 结论：${o.icon} ${o.text}`,
    '',
    `- 目标：**${target.name}**（\`${target.id}\`，类型 ${target.kind}）`,
    `- 阶段：${stages
      .map((s) => `${s.stage === 'backup' ? '备份' : '隔离演练'} ${s.status === 'success' ? '✅' : s.status === 'failed' ? '❌' : '⏭️'}`)
      .join(' → ')}`,
    '',
  ];

  stages.forEach((s) => {
    const label =
      stages.length > 1
        ? s.stage === 'backup'
          ? '阶段一：备份'
          : '阶段二：隔离还原演练'
        : s.stage === 'backup'
          ? '阶段：备份'
          : '阶段：隔离还原演练';
    parts.push(`## ${label}`);
    parts.push('');
    parts.push(`- 状态：**${s.status}** · 耗时 ${msLabel(s.durationMs)}${s.error ? ` · 错误：${s.error}` : ''}`);
    if (s.sandbox) {
      parts.push(`- 沙箱：\`${s.sandbox.location}\`${s.sandbox.kept ? '（已保留）' : '（已清理）'}`);
    }
    parts.push(`- 工具链：${toolchainLine(s)}`);
    parts.push('');
    parts.push('### 校验明细');
    parts.push('');
    parts.push(checksTable(s));
    parts.push('### 产物');
    parts.push('');
    parts.push(artifactsTable(s));
  });

  parts.push('## 溯源');
  parts.push('');
  parts.push('- 原始证据目录：`runs/' + run.id + '/`');
  parts.push('- 完整性凭证：备份目录下 `DONE` = 完成时间 + manifest.json 的 sha256');
  parts.push('- 防篡改：`events.jsonl` 为哈希链，任何事件改动都会在链校验中断裂');
  return parts.join('\n');
}

function renderSummary(input: SummaryReportInput): string {
  const { run, targets, stages } = input;
  const byTarget = new Map<string, { target?: Target; list: StageResult[] }>();
  for (const t of targets) byTarget.set(t.id, { target: t, list: [] });
  for (const [key, s] of stages) {
    const tid = key.split(':')[0]!;
    if (!byTarget.has(tid)) byTarget.set(tid, { list: [] });
    byTarget.get(tid)!.list.push(s);
  }

  const totalChecks = stages.reduce((n, [, s]) => n + s.checks.length, 0);
  const failedChecks = stages.reduce((n, [, s]) => n + s.checks.filter((c) => c.verdict === 'fail').length, 0);
  const warnChecks = stages.reduce((n, [, s]) => n + s.checks.filter((c) => c.verdict === 'warn').length, 0);
  const passChecks = totalChecks - failedChecks - warnChecks;

  const parts: string[] = [
    header(run, '备份编排与演练 · 总报告', input.runDir),
    '## 总览',
    '',
    `| 指标 | 值 |`,
    `| --- | --- |`,
    `| 目标数 | ${targets.length} |`,
    `| 阶段数 | ${stages.length} |`,
    `| 校验项 | ${totalChecks}（✅ ${passChecks} / ⚠️ ${warnChecks} / ❌ ${failedChecks}） |`,
    `| 总状态 | **${run.status}** |`,
    '',
    '## 目标结果',
    '',
    '| 目标 | 类型 | 备份 | 演练 | 校验通过/失败 | 耗时 |',
    '| --- | --- | --- | --- | --- | --- |',
  ];

  for (const [tid, { target, list }] of byTarget) {
    const backup = list.find((_, i) => i === 0) ?? stages.find(([k]) => k === `${tid}:backup`)?.[1];
    const drill = list.length > 1 ? list[1] : stages.find(([k]) => k === `${tid}:drill`)?.[1];
    const checks = list.flatMap((s) => s.checks);
    const fails = checks.filter((c) => c.verdict === 'fail').length;
    const pass = checks.filter((c) => c.verdict === 'pass').length;
    const dur = list.reduce((s, x) => s + x.durationMs, 0);
    parts.push(
      `| ${target ? target.name : tid} | ${target?.kind ?? '-'} | ${backup ? statusIcon(backup.status) : '—'} | ${drill ? statusIcon(drill.status) : '—'} | ${pass}/${fails} | ${msLabel(dur)} |`,
    );
  }

  parts.push('', '## 各阶段检查摘要', '');
  for (const [key, s] of stages) {
    const tid = key.split(':')[0]!;
    const t = targets.find((x) => x.id === tid);
    parts.push(`### ${t ? t.name : tid} · ${stageNameZh(key)}（${s.status}）`);
    parts.push('');
    parts.push(checksTable(s));
    if (s.artifacts.length > 0) {
      parts.push('产物：');
      parts.push('');
      parts.push(artifactsTable(s));
    }
    if (s.sandbox) parts.push(`沙箱：\`${s.sandbox.location}\`${s.sandbox.kept ? '（已保留）' : '（已清理）'}`);
    parts.push('');
  }

  parts.push('## 报告文件');
  parts.push('');
  for (const r of run.reports) parts.push(`- \`${r}\``);
  return parts.join('\n');
}

function statusIcon(s: StageResult['status']): string {
  return s === 'success' ? '✅ 成功' : s === 'failed' ? '❌ 失败' : s === 'skipped' ? '⏭️ 跳过' : '🏃 进行中';
}

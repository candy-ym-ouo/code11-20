/**
 * 一次运行的上下文：把「开始/日志/检查项/产物/结束」全部写进账本，
 * 任务代码只需要 run.check(...) / run.succeed(...)，不用关心持久化。
 */
import { randomUUID } from 'node:crypto';
import type { Ledger, RunKind, RunStatus } from './ledger.js';
import type { CheckResult, Artifact } from './ledger.js';

export interface RunOptions {
  kind: RunKind;
  trigger: 'schedule' | 'manual' | 'cli';
  backupDir?: string;
  /** 额外的开始事件元数据。 */
  meta?: Record<string, unknown>;
}

export class Run {
  readonly id: string;
  readonly startedAt = new Date();
  private checksAll: CheckResult[] = [];

  constructor(
    private readonly ledger: Ledger,
    private readonly options: RunOptions,
  ) {
    this.id = `run_${this.startedAt.toISOString().replace(/[-:T]/g, '').slice(0, 15)}_${randomUUID().slice(0, 8)}`;
    this.ledger.append(this.id, options.kind, 'run_started', {
      trigger: options.trigger,
      backupDir: options.backupDir,
      ...options.meta,
    });
  }

  log(line: string): void {
    this.ledger.append(this.id, this.options.kind, 'log', { line });
  }

  note(note: Record<string, unknown>): void {
    this.ledger.append(this.id, this.options.kind, 'note', note);
  }

  artifact(a: Artifact): void {
    this.ledger.append(this.id, this.options.kind, 'artifact', a);
  }

  check(name: string, ok: boolean, detail: string, data?: unknown): CheckResult {
    const result: CheckResult = { name, ok, detail, data };
    this.checksAll.push(result);
    this.ledger.append(this.id, this.options.kind, 'check', result);
    return result;
  }

  get checks(): CheckResult[] {
    return this.checksAll;
  }

  get okCount(): number {
    return this.checksAll.filter((c) => c.ok).length;
  }

  get failCount(): number {
    return this.checksAll.filter((c) => !c.ok).length;
  }

  /** 检查项全过才算 success；有失败但产物已生成算 partial（备份场景）。 */
  finish(status: RunStatus, error?: string): void {
    this.ledger.append(this.id, this.options.kind, 'run_finished', {
      status,
      error,
      durationMs: Date.now() - this.startedAt.getTime(),
      okChecks: this.okCount,
      failChecks: this.failCount,
    });
  }
}

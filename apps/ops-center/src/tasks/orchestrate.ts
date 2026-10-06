/**
 * 编排器：把「一次任务」包装成账本里的一个 Run，统一异常处理与状态判定。
 * 任务函数只抛异常或写 check；这里决定 success / partial / failed。
 */
import type { Ledger, RunKind } from '../storage/ledger.js';
import { Run } from '../storage/run.js';
import { log } from '../util/logger.js';

export type Trigger = 'schedule' | 'manual' | 'cli';

export interface RunOutcome {
  runId: string;
  status: 'success' | 'failed' | 'partial';
  failCount: number;
  okCount: number;
  error?: string;
}

export async function orchestrate(
  ledger: Ledger,
  kind: RunKind,
  trigger: Trigger,
  fn: (run: Run) => Promise<void>,
  meta?: Record<string, unknown>,
): Promise<RunOutcome> {
  const run = new Run(ledger, { kind, trigger, ...(meta ? { meta } : {}) });
  try {
    await fn(run);
    const status = run.failCount === 0 ? 'success' : run.okCount > 0 ? 'partial' : 'failed';
    run.finish(status);
    log.info(`运行 ${run.id} 结束：${status}（${run.okCount} 项通过 / ${run.failCount} 项失败）`);
    return {
      runId: run.id,
      status,
      failCount: run.failCount,
      okCount: run.okCount,
    };
  } catch (err) {
    const message = err instanceof Error ? err.stack ?? err.message : String(err);
    run.log(`任务异常：${message}`);
    log.error(`运行 ${run.id} 异常：${message}`);
    run.finish('failed', message);
    return {
      runId: run.id,
      status: 'failed',
      failCount: run.failCount,
      okCount: run.okCount,
      error: message,
    };
  }
}

/**
 * 任务服务：编排器 + 报告生成的组合入口，CLI 与调度器共用。
 * 任何任务入口都保证：账本有记录、报告落盘、异常不外泄到调度循环。
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Ledger } from '../storage/ledger.js';
import { orchestrate } from './orchestrate.js';
import { runBackup } from './backup.js';
import { runVerify } from './verify.js';
import { runDrill } from './drill.js';
import { runRetention } from './retention.js';
import { writeReports } from '../report/index.js';
import { config } from '../config/index.js';
import type { BackupManifest } from './backup.js';
import type { DrillResult } from './drill.js';
import type { Trigger } from './orchestrate.js';

export class TaskService {
  constructor(private readonly ledger: Ledger) {}

  private integrity() {
    const { corrupted } = this.ledger.integrity();
    return { ok: corrupted.length === 0, corrupted };
  }

  private runSummary(runId: string) {
    return this.ledger.runs().find((r) => r.runId === runId);
  }

  async backup(trigger: Trigger, targetDir?: string) {
    const outcome = await orchestrate(this.ledger, 'backup', trigger, async (run) => {
      const result = await runBackup(run, { targetDir });
      // 备份成功后顺手执行一次保留回收（作为同一计划周期的一部分）
      await runRetention(run);
      void result;
    });
    const run = this.runSummary(outcome.runId);
    let manifest: BackupManifest | undefined;
    if (run?.backupDir && existsSync(path.join(run.backupDir, 'manifest.json'))) {
      manifest = JSON.parse(
        readFileSync(path.join(run.backupDir, 'manifest.json'), 'utf8'),
      ) as BackupManifest;
    }
    const files = run ? writeReports({ run, manifest, ledgerIntegrity: this.integrity() }) : undefined;
    return { outcome, reports: files };
  }

  async verify(trigger: Trigger, backupDir?: string) {
    let manifest: BackupManifest | undefined;
    const outcome = await orchestrate(this.ledger, 'verify', trigger, async (run) => {
      const result = await runVerify(run, { backupDir });
      manifest = result.manifest;
    });
    const run = this.runSummary(outcome.runId);
    const files = run ? writeReports({ run, manifest, ledgerIntegrity: this.integrity() }) : undefined;
    return { outcome, reports: files };
  }

  async drill(
    trigger: Trigger,
    options: { backupDir?: string; keepSandbox?: boolean } = {},
  ) {
    let drill: DrillResult | undefined;
    let manifest: BackupManifest | undefined;
    const outcome = await orchestrate(this.ledger, 'drill', trigger, async (run) => {
      const result = await runDrill(run, options);
      drill = result;
      manifest = result.manifest;
    });
    const run = this.runSummary(outcome.runId);
    const files = run
      ? writeReports({ run, drill, manifest, ledgerIntegrity: this.integrity() })
      : undefined;
    return { outcome, reports: files };
  }

  async retention(trigger: Trigger) {
    const outcome = await orchestrate(this.ledger, 'retention', trigger, async (run) => {
      await runRetention(run);
    });
    const run = this.runSummary(outcome.runId);
    const files = run ? writeReports({ run, ledgerIntegrity: this.integrity() }) : undefined;
    return { outcome, reports: files };
  }
}

export function defaultOpsRootsReady(): void {
  // 集中确保目录存在，便于 CLI 子命令复用
  for (const d of [config.opsRoot, config.backupRoot, config.sandboxRoot, config.reportDir]) {
    mkdirSync(d, { recursive: true });
  }
}

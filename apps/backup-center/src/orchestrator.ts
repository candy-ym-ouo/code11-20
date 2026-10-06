/**
 * 编排器：把 Target 适配器、状态存储、报告串成一次 Run。
 *
 * 阶段执行规则：
 * - backup：ping → adapter.backup → 写 manifest.json（自身哈希）→ 写 DONE。
 *   任一检查 verdict=fail 或抛异常 → 阶段失败（不写 DONE）。
 * - drill ：只接受「带 DONE 的最近成功备份」→ adapter.drill → 写 compare.json。
 * - 每次阶段执行都在 events.jsonl 里留开始/结束事件，哈希链贯穿全 run。
 * - 同 target 的阶段串行；run 之间互斥锁防并发（同进程 + 文件锁双保险）。
 */
import { hostname } from 'node:os';
import { existsSync } from 'node:fs';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  BackupManifest,
  CheckResult,
  Run,
  StageResult,
  Target,
} from './types';
import { EventLog, StateStore } from './state';
import { hashJson, nowIso, sha256File } from './util';
import { MediaAdapter } from './targets/media';
import { PostgresAdapter } from './targets/postgres';
import { TableFileAdapter } from './targets/tablefile';
import type { TargetAdapter } from './targets/adapter';
import { renderMarkdownReport } from './report/markdown';

const APP = '备份编排与演练中心';

export class AdapterRegistry {
  private readonly adapters = new Map<string, TargetAdapter>();
  constructor() {
    this.register(new PostgresAdapter());
    this.register(new MediaAdapter());
    this.register(new TableFileAdapter());
  }
  register(a: TargetAdapter): void {
    this.adapters.set(a.kind, a);
  }
  get(kind: string): TargetAdapter {
    const a = this.adapters.get(kind);
    if (!a) throw new Error(`不支持的目标类型：${kind}`);
    return a;
  }
}

export interface RunOptions {
  trigger?: Run['trigger'];
  reason?: string;
  /** 限定目标；不传则跑全部 enabled 目标 */
  targetIds?: string[];
  /** 执行哪些阶段；默认 ['backup','drill']。drill 会使用最近成功备份 */
  stages?: Array<'backup' | 'drill'>;
  /** 本次只演练指定备份目录（覆盖「最近成功备份」选择），key=targetId */
  backupDirs?: Record<string, string>;
  keepSandbox?: boolean;
  keepRuns?: number;
}

export class Orchestrator {
  readonly registry = new AdapterRegistry();
  constructor(private readonly store: StateStore) {}

  private targetMap(): Map<string, Target> {
    return new Map(this.store.loadConfig().targets.map((t) => [t.id, t]));
  }

  private async writeDone(dir: string, manifest: BackupManifest): Promise<void> {
    // manifest 先落盘（不含 manifestSha256），算哈希后改写一次，DONE 记录该哈希。
    await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    const digest = await sha256File(join(dir, 'manifest.json'));
    manifest.manifestSha256 = digest;
    await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    await writeFile(join(dir, 'DONE'), `${nowIso()}\n${digest}\n`);
  }

  private aggregate(checks: CheckResult[]): { ok: boolean; failures: number; warnings: number } {
    const failures = checks.filter((c) => c.verdict === 'fail').length;
    const warnings = checks.filter((c) => c.verdict === 'warn').length;
    return { ok: failures === 0, failures, warnings };
  }

  async runBackup(target: Target, runId: string, events: EventLog): Promise<StageResult> {
    const startedAt = nowIso();
    const t0 = Date.now();
    const dir = this.store.stageDir(runId, 'backup', target.id);
    await mkdir(dir, { recursive: true });
    const adapter = this.registry.get(target.kind);

    const checks: CheckResult[] = [];
    let artifacts = [] as StageResult['artifacts'];
    let toolchain: Record<string, string> = {};
    let status: StageResult['status'] = 'success';
    let error: string | undefined;
    let fingerprint: Record<string, unknown> = {};

    try {
      events.append({ runId, targetId: target.id, stage: 'backup', event: 'stage.begin' });
      const ping = await adapter.ping(target);
      checks.push(ping);
      if (ping.verdict === 'fail') throw new Error(`目标不可用：${ping.detail}`);

      const outcome = await adapter.backup(target, { runId, dir, events });
      checks.push(...outcome.checks);
      artifacts = outcome.artifacts;
      toolchain = outcome.toolchain;
      fingerprint = outcome.sourceFingerprint;

      const { ok, failures } = this.aggregate(checks);
      if (!ok) {
        status = 'failed';
        error = `${failures} 项校验失败`;
      } else {
        const manifest: BackupManifest = {
          app: APP,
          runId,
          targetId: target.id,
          targetName: target.name,
          kind: target.kind,
          createdAt: nowIso(),
          host: hostname(),
          toolchain,
          sourceFingerprint: fingerprint,
          artifacts,
        };
        await this.writeDone(dir, manifest);
        events.append({ runId, targetId: target.id, stage: 'backup', event: 'stage.done', data: { checks: checks.length } });
      }
    } catch (err) {
      status = 'failed';
      error = err instanceof Error ? err.message : String(err);
      events.append({ runId, targetId: target.id, stage: 'backup', event: 'stage.error', data: { error } });
    }

    return { stage: 'backup', status, startedAt, finishedAt: nowIso(), durationMs: Date.now() - t0, toolchain, checks, artifacts, error };
  }

  async runDrill(target: Target, runId: string, events: EventLog, opts: RunOptions): Promise<StageResult> {
    const startedAt = nowIso();
    const t0 = Date.now();
    const outDir = this.store.stageDir(runId, 'drill', target.id);
    await mkdir(outDir, { recursive: true });
    const sandboxRoot = join(outDir, 'sandbox');
    await mkdir(sandboxRoot, { recursive: true });

    const adapter = this.registry.get(target.kind);
    const checks: CheckResult[] = [];
    let status: StageResult['status'] = 'success';
    let error: string | undefined;
    let toolchain: Record<string, string> = {};
    let sandbox: StageResult['sandbox'];

    const backupDir = opts.backupDirs?.[target.id] ?? this.store.latestSuccessfulBackup(target.id) ?? undefined;
    if (!backupDir || !existsSync(join(backupDir, 'DONE'))) {
      events.append({ runId, targetId: target.id, stage: 'drill', event: 'stage.skip', data: { reason: 'no-backup' } });
      return {
        stage: 'drill',
        status: 'skipped',
        startedAt,
        finishedAt: nowIso(),
        durationMs: Date.now() - t0,
        toolchain: {},
        checks: [
          {
            id: 'drill.input',
            label: '可用备份',
            verdict: 'skip',
            detail: '没有带 DONE 的成功备份，演练跳过（先跑一次备份）',
          },
        ],
        artifacts: [],
      };
    }

    const manifest = JSON.parse(await (await import('node:fs/promises')).readFile(join(backupDir, 'manifest.json'), 'utf8')) as BackupManifest;

    try {
      events.append({ runId, targetId: target.id, stage: 'drill', event: 'stage.begin', data: { backupDir } });
      const outcome = await adapter.drill(target, {
        runId,
        sandboxRoot,
        backupDir,
        manifest,
        events,
        keep: opts.keepSandbox ?? false,
      });
      checks.push(...outcome.checks);
      toolchain = outcome.toolchain;
      sandbox = outcome.sandbox;

      await writeFile(
        join(outDir, 'compare.json'),
        JSON.stringify(
          {
            backupDir,
            backupCreatedAt: manifest.createdAt,
            backupManifestSha256: manifest.manifestSha256,
            comparedAt: nowIso(),
            checks,
          },
          null,
          2,
        ) + '\n',
      );
      const { ok, failures } = this.aggregate(checks);
      if (!ok) {
        status = 'failed';
        error = `${failures} 项比对失败`;
      }
      events.append({ runId, targetId: target.id, stage: 'drill', event: 'stage.done', data: { failures } });
    } catch (err) {
      status = 'failed';
      error = err instanceof Error ? err.message : String(err);
      events.append({ runId, targetId: target.id, stage: 'drill', event: 'stage.error', data: { error } });
      sandbox = { kind: target.kind, location: sandboxRoot };
    } finally {
      if (!opts.keepSandbox) {
        // 适配器负责清理自己的数据库目录；空 sandbox 根目录顺手删掉
        await rm(sandboxRoot, { recursive: true, force: true }).catch(() => undefined);
      }
    }

    return { stage: 'drill', status, startedAt, finishedAt: nowIso(), durationMs: Date.now() - t0, toolchain, checks, artifacts: [], sandbox, error };
  }

  async execute(opts: RunOptions = {}): Promise<Run> {
    const cfg = this.store.loadConfig();
    const targets = cfg.targets.filter(
      (t) => t.enabled && (!opts.targetIds || opts.targetIds.includes(t.id)),
    );
    const stages = opts.stages ?? ['backup', 'drill'];
    const runId = `run-${new Date().toISOString().replace(/[:.]/g, '').replace(/T/, '-').slice(0, 15)}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;

    await mkdir(this.store.runDir(runId), { recursive: true });
    const events = new EventLog(this.store.eventLogFile(runId));
    events.append({ runId, targetId: '*', stage: 'orchestrate', event: 'run.begin', data: { targets: targets.map((t) => t.id), stages } });

    const run: Run = {
      id: runId,
      trigger: opts.trigger ?? 'manual',
      reason: opts.reason ?? '',
      startedAt: nowIso(),
      status: 'running',
      stages: {},
      reports: [],
    };

    try {
      for (const target of targets) {
        if (stages.includes('backup')) {
          const res = await this.runBackup(target, runId, events);
          run.stages[`${target.id}:backup`] = res;
          await this.store.saveRun(run);
        }
        if (stages.includes('drill')) {
          const res = await this.runDrill(target, runId, events, opts);
          run.stages[`${target.id}:drill`] = res;
          await this.store.saveRun(run);
        }
      }

      // 汇总状态：有 failed → failed；全部 skipped → skipped；否则 success
      const statuses = Object.values(run.stages).map((s) => s.status);
      if (statuses.some((s) => s === 'failed')) run.status = 'failed';
      else if (statuses.length > 0 && statuses.every((s) => s === 'skipped')) run.status = 'skipped';
      else run.status = 'success';
      run.finishedAt = nowIso();

      // 先落定状态事件，再生成报告 —— 报告里的哈希链才包含完整运行轨迹
      events.append({ runId, targetId: '*', stage: 'orchestrate', event: 'run.done', data: { status: run.status, digest: hashJson(run.stages) } });

      // 报告（每目标一份 + 总览）
      const byTarget = new Map<Target, StageResult[]>();
      for (const target of targets) {
        const list = [run.stages[`${target.id}:backup`], run.stages[`${target.id}:drill`]].filter(Boolean) as StageResult[];
        byTarget.set(target, list);
      }
      const reportDir = join(this.store.runDir(runId), 'reports');
      await mkdir(reportDir, { recursive: true });
      for (const [target, list] of byTarget) {
        const md = renderMarkdownReport({ run, target, stages: list, runDir: this.store.runDir(runId) });
        const file = join(reportDir, `${target.id}.md`);
        await writeFile(file, md);
        run.reports.push(join('runs', runId, 'reports', `${target.id}.md`));
      }
      const summaryMd = renderMarkdownReport({ run, targets, stages: Object.entries(run.stages), runDir: this.store.runDir(runId) });
      await writeFile(join(reportDir, 'summary.md'), summaryMd);
      run.reports.unshift(join('runs', runId, 'reports', 'summary.md'));

      await this.store.saveRun(run);
      this.store.markLatest(runId);

      if (opts.keepRuns) {
        await this.store.pruneRuns(opts.keepRuns);
      }
      return run;
    } catch (err) {
      run.status = 'failed';
      run.finishedAt = nowIso();
      const fatal: StageResult = {
        stage: 'backup',
        status: 'failed',
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        durationMs: Date.now() - new Date(run.startedAt).getTime(),
        toolchain: {},
        checks: [{ id: 'fatal', label: '编排异常', verdict: 'fail', detail: err instanceof Error ? err.message : String(err) }],
        artifacts: [],
      };
      run.stages['__fatal__'] = fatal;
      events.append({ runId, targetId: '*', stage: 'orchestrate', event: 'run.fatal', data: { error: fatal.checks[0]!.detail } });
      await this.store.saveRun(run);
      throw err;
    }
  }

  /** 校验全部历史 run 的哈希链（审计用） */
  verifyChain(runId: string): { ok: boolean; brokenAt: number | null; events: number } {
    const r = EventLog.verify(this.store.eventLogFile(runId));
    return { ok: r.ok, brokenAt: r.brokenAt, events: r.events.length };
  }
}

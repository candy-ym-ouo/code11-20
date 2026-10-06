/**
 * 状态存储：目录布局、配置读写、哈希链事件日志、运行记录。
 *
 * <stateRoot>/
 *   config.json          targets + plans（改动保留最近 N 份历史副本）
 *   runs.jsonl           只追加的运行索引（每行一次 run 摘要）
 *   config-history/      config.json 的每次落盘副本，便于追溯「当时按什么计划跑的」
 *   runs/<runId>/
 *     events.jsonl       哈希链时间线（防篡改、可独立验真）
 *     run.json           该次运行的完整结果
 *     backup/<targetId>/ 备份产物 + manifest.json + DONE
 *     drill/<targetId>/  沙箱还原 + compare.json
 *     reports/           本次生成的 Markdown 报告
 *   latest -> runs/<runId>（POSIX 软链；不支持软链的平台写 latest.txt）
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalize, hashJson, nowIso, sha256Text } from './util';
import type { Plan, Run, RunEvent, Target } from './types';

export interface CenterConfig {
  version: 1;
  targets: Target[];
  plans: Plan[];
  updatedAt: string;
}

const GENESIS = sha256Text('heirloom-backup-center-genesis');

export class EventLog {
  seq = 0;
  private prevHash = GENESIS;

  constructor(private readonly file: string) {
    if (existsSync(file)) {
      const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
      const last = lines[lines.length - 1];
      if (last) {
        const evt = JSON.parse(last) as RunEvent;
        this.seq = evt.seq;
        this.prevHash = evt.hash;
      }
    } else {
      mkdirSync(join(file, '..'), { recursive: true });
      writeFileSync(file, '');
    }
  }

  append(
    part: { runId: string; targetId: string; stage: RunEvent['stage']; event: string; data?: Record<string, unknown> },
  ): RunEvent {
    this.seq += 1;
    const body = {
      seq: this.seq,
      ts: nowIso(),
      targetId: part.targetId,
      runId: part.runId,
      stage: part.stage,
      event: part.event,
      data: part.data,
      prevHash: this.prevHash,
    };
    const evt: RunEvent = { ...body, hash: sha256Text(canonicalize(body)) };
    appendFileSync(this.file, JSON.stringify(evt) + '\n');
    this.prevHash = evt.hash;
    return evt;
  }

  /** 读入全部事件并验证哈希链；失败抛出断点位置 */
  static verify(file: string): { events: RunEvent[]; ok: boolean; brokenAt: number | null } {
    if (!existsSync(file)) return { events: [], ok: true, brokenAt: null };
    const events = readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as RunEvent);
    let prev = GENESIS;
    for (const evt of events) {
      const { hash, ...body } = evt;
      if (evt.prevHash !== prev || sha256Text(canonicalize(body)) !== hash) {
        return { events, ok: false, brokenAt: evt.seq };
      }
      prev = hash;
    }
    return { events, ok: true, brokenAt: null };
  }
}

export class StateStore {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
    mkdirSync(root, { recursive: true });
    mkdirSync(join(root, 'runs'), { recursive: true });
    mkdirSync(join(root, 'config-history'), { recursive: true });
  }

  configPath(): string {
    return join(this.root, 'config.json');
  }

  loadConfig(): CenterConfig {
    const p = this.configPath();
    if (!existsSync(p)) {
      return { version: 1, targets: [], plans: [], updatedAt: nowIso() };
    }
    return JSON.parse(readFileSync(p, 'utf8')) as CenterConfig;
  }

  saveConfig(cfg: CenterConfig): void {
    cfg.updatedAt = nowIso();
    const p = this.configPath();
    if (existsSync(p)) {
      // 旧配置先留档，文件名用内容哈希，天然去重
      const oldRaw = readFileSync(p);
      const histName = `${new Date(JSON.parse(oldRaw.toString('utf8')).updatedAt || 0).getTime()}-${sha256Text(
        oldRaw.toString('utf8'),
      ).slice(0, 12)}.json`;
      const hist = join(this.root, 'config-history', histName);
      if (!existsSync(hist)) writeFileSync(hist, oldRaw);
    }
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n');
    renameSync(tmp, p);
  }

  runDir(runId: string): string {
    return join(this.root, 'runs', runId);
  }

  eventLogFile(runId: string): string {
    return join(this.runDir(runId), 'events.jsonl');
  }

  stageDir(runId: string, stage: 'backup' | 'drill', targetId: string): string {
    return join(this.runDir(runId), stage, targetId);
  }

  async saveRun(run: Run): Promise<void> {
    const dir = this.runDir(run.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'run.json'), JSON.stringify(run, null, 2) + '\n');
    appendFileSync(join(this.root, 'runs.jsonl'), JSON.stringify(runSummary(run)) + '\n');
  }

  async loadRun(runId: string): Promise<Run | null> {
    const p = join(this.runDir(runId), 'run.json');
    if (!existsSync(p)) return null;
    return JSON.parse(await readFile(p, 'utf8')) as Run;
  }

  async listRuns(): Promise<Array<Run & { id: string }>> {
    const ids = (await readdir(join(this.root, 'runs'), { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()
      .reverse();
    const out: Array<Run & { id: string }> = [];
    for (const id of ids) {
      const run = await this.loadRun(id);
      if (run) out.push(Object.assign(run, { id: run.id }));
    }
    return out;
  }

  /** 找到某目标最近一次成功的备份 stage 目录（演练输入）。直接验证 DONE 标记。 */
  latestSuccessfulBackup(targetId: string): string | null {
    if (!existsSync(join(this.root, 'runs'))) return null;
    const runs = existsSync(join(this.root, 'runs.jsonl'))
      ? readFileSync(join(this.root, 'runs.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { id: string; stageStatus?: Record<string, string> })
      : [];
    for (const r of runs.reverse()) {
      const dir = this.stageDir(r.id, 'backup', targetId);
      // 以产物 DONE 为准：它是「完整备份」的唯一凭证
      if (existsSync(join(dir, 'DONE'))) return dir;
    }
    return null;
  }

  async pruneRuns(keep: number): Promise<string[]> {
    const removed: string[] = [];
    const dirs = (await readdir(join(this.root, 'runs'), { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()
      .reverse();
    for (const id of dirs.slice(keep)) {
      await rm(this.runDir(id), { recursive: true, force: true });
      removed.push(id);
    }
    return removed;
  }

  markLatest(runId: string): void {
    const link = join(this.root, 'latest');
    try {
      rm(link, { force: true }).then(() => symlinkSync(join('runs', runId), link));
    } catch {
      // 某些平台不允许软链：退化为文本指针
      writeFileSync(join(this.root, 'latest.txt'), runId);
    }
  }
}

/** 写进 runs.jsonl 的轻量摘要 */
function runSummary(run: Run): Record<string, unknown> {
  const stageStatus: Record<string, string> = {};
  for (const [k, v] of Object.entries(run.stages)) stageStatus[k] = v.status;
  return {
    id: run.id,
    trigger: run.trigger,
    reason: run.reason,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    status: run.status,
    stageStatus,
    reports: run.reports,
    digest: hashJson(run.stages),
  };
}

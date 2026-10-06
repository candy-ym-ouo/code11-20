/**
 * 账本：append-only 的 NDJSON 事件流，是整个中心「可追溯」的底座。
 * - 只追加、不改写：每行一个 JSON 事件，行内带 sha256 链（前一行哈希），任何删改都能被 detect 出来。
 * - Run 是事件聚合视图：读取账本重放得到运行列表与最新状态。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { sha256Text } from '../util/hash.js';
import { config } from '../config/index.js';

export type RunKind = 'backup' | 'verify' | 'drill' | 'retention' | 'manual';
export type RunStatus = 'running' | 'success' | 'failed' | 'partial';

export interface LedgerEvent {
  /** 单调递增序号。 */
  seq: number;
  /** 事件 ID。 */
  id: string;
  /** 所属运行 ID。 */
  runId: string;
  kind: RunKind;
  type: 'run_started' | 'log' | 'artifact' | 'check' | 'run_finished' | 'note';
  ts: string;
  payload?: unknown;
  /** 前一事件的 sha256，构成哈希链。 */
  prevHash: string;
  /** 本行（除 hash 字段外）的 sha256。 */
  hash?: string;
}

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
  data?: unknown;
}

export interface Artifact {
  name: string;
  path: string;
  sha256?: string;
  bytes?: number;
}

export interface RunSummary {
  runId: string;
  kind: RunKind;
  startedAt: string;
  finishedAt?: string;
  status: RunStatus;
  trigger: 'schedule' | 'manual' | 'cli';
  checks: CheckResult[];
  artifacts: Artifact[];
  logTail: string[];
  error?: string;
  backupDir?: string;
  durationMs?: number;
}

export class Ledger {
  private seq = 0;
  private lastHash = '0'.repeat(64);
  private readonly file: string;

  constructor(file: string = config.ledgerFile) {
    this.file = file;
    mkdirSync(path.dirname(file), { recursive: true });
    this.replay();
  }

  /** 重放账本：恢复序号与哈希链；返回篡改/损坏检测结果。 */
  replay(): { corrupted: Array<{ line: number; reason: string }> } {
    this.seq = 0;
    this.lastHash = '0'.repeat(64);
    const corrupted: Array<{ line: number; reason: string }> = [];
    if (!existsSync(this.file)) return { corrupted };
    const lines = readFileSync(this.file, 'utf8').split('\n');
    lines.forEach((line, idx) => {
      if (!line.trim()) return;
      let event: LedgerEvent;
      try {
        event = JSON.parse(line) as LedgerEvent;
      } catch {
        corrupted.push({ line: idx + 1, reason: 'JSON 解析失败' });
        return;
      }
      const expectedHash = event.hash;
      const { hash, ...rest } = event;
      const actual = sha256Text(JSON.stringify(rest));
      if (hash !== actual) corrupted.push({ line: idx + 1, reason: '行哈希不匹配' });
      if (event.prevHash !== this.lastHash) {
        corrupted.push({ line: idx + 1, reason: '哈希链断裂' });
      }
      this.lastHash = expectedHash ?? actual;
      this.seq = Math.max(this.seq, event.seq);
    });
    return { corrupted };
  }

  append(
    runId: string,
    kind: RunKind,
    type: LedgerEvent['type'],
    payload?: unknown,
  ): LedgerEvent {
    const seq = this.seq + 1;
    const event: LedgerEvent = {
      seq,
      id: `evt_${seq.toString(10).padStart(8, '0')}`,
      runId,
      kind,
      type,
      ts: new Date().toISOString(),
      payload,
      prevHash: this.lastHash,
    };
    event.hash = sha256Text(JSON.stringify({ ...event, hash: undefined }));
    appendFileSync(this.file, `${JSON.stringify(event)}\n`, 'utf8');
    this.seq = seq;
    this.lastHash = event.hash;
    return event;
  }

  /** 完整性摘要：ok + 异常位置。 */
  integrity(): { ok: boolean; corrupted: Array<{ line: number; reason: string }> } {
    const { corrupted } = this.replay();
    return { ok: corrupted.length === 0, corrupted };
  }

  /** 读全部事件（用于聚合）。 */
  events(): LedgerEvent[] {
    if (!existsSync(this.file)) return [];
    return readFileSync(this.file, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as LedgerEvent);
  }

  /** 聚合出所有运行（按开始时间倒序）。 */
  runs(): RunSummary[] {
    const map = new Map<string, RunSummary>();
    for (const e of this.events()) {
      let run = map.get(e.runId);
      if (!run) {
        run = {
          runId: e.runId,
          kind: e.kind,
          startedAt: e.ts,
          status: 'running',
          trigger: (e.payload as { trigger?: RunSummary['trigger'] })?.trigger ?? 'manual',
          checks: [],
          artifacts: [],
          logTail: [],
        };
        map.set(e.runId, run);
      }
      switch (e.type) {
        case 'run_started': {
          const p = e.payload as { trigger?: RunSummary['trigger']; backupDir?: string };
          if (p.trigger) run.trigger = p.trigger;
          if (p.backupDir) run.backupDir = p.backupDir;
          break;
        }
        case 'log': {
          const line = (e.payload as { line?: string })?.line ?? '';
          run.logTail.push(line);
          if (run.logTail.length > 200) run.logTail.shift();
          break;
        }
        case 'check':
          run.checks.push(e.payload as CheckResult);
          break;
        case 'artifact':
          run.artifacts.push(e.payload as Artifact);
          break;
        case 'note': {
          const p = e.payload as { backupDir?: string; error?: string };
          if (p.backupDir) run.backupDir = p.backupDir;
          if (p.error) run.error = p.error;
          break;
        }
        case 'run_finished': {
          const p = e.payload as { status: RunStatus; error?: string; durationMs: number };
          run.status = p.status;
          run.finishedAt = e.ts;
          run.durationMs = p.durationMs;
          if (p.error) run.error = p.error;
          break;
        }
      }
    }
    return [...map.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  latest(kind: RunKind): RunSummary | undefined {
    return this.runs().find((r) => r.kind === kind);
  }

  /** 归档当前账本（运维侧手工调用，例如每年），随后开新账本。 */
  rotate(): string {
    if (!existsSync(this.file)) return this.file;
    const archived = `${this.file}.${new Date().toISOString().replace(/[:.]/g, '-')}`;
    renameSync(this.file, archived);
    this.seq = 0;
    this.lastHash = '0'.repeat(64);
    return archived;
  }
}

/**
 * 备份编排与演练中心 —— 核心类型定义
 *
 * 一条主线：Target（备份目标）→ Plan（调度计划）→ Run（一次执行）
 * 一次 Run 分两阶段：backup（备份+完整性校验）→ drill（隔离还原+比对），
 * 每个阶段都产出不可变产物与可追溯事件，最终汇总成 Report。
 */

/** 备份目标类型 */
export type TargetKind = 'postgres' | 'media' | 'tablefile';

/** 阶段 */
export type StageName = 'backup' | 'drill';

/** 执行状态机：running → success / failed / skipped */
export type RunStatus = 'running' | 'success' | 'failed' | 'skipped';

export interface PostgresTargetConfig {
  /** 应用实际使用的连接串，如 postgresql://user:pass@host:5432/dbname */
  url: string;
  /** 备份格式：custom=pg_dump -Fc（单文件、可选择性还原）；plain=SQL 文本；tablefile=导出为 JSONL */
  format?: 'custom' | 'plain' | 'tablefile';
  /** 需要纳入比对的表；为空时自动发现所有用户表（tablefile 格式下可指定子集） */
  tables?: string[];
  /** 演练时是否用表数据做行级比对（默认 true，对大库可关） */
  rowCompare?: boolean;
}

export interface MediaTargetConfig {
  /** 媒体源目录（如 data/uploads），递归备份其下全部文件 */
  dir: string;
  /** 抽样校验比例：0~1，1 表示全量；0 表示只查库内 manifest */
  sampleRatio?: number;
}

/**
 * 内建「表文件」目标：把一组以 JSON Lines 表示的逻辑表当作数据库。
 * 不依赖任何外部二进制，用于无 pg_dump 的环境，以及自检验证。
 * 每行结构：<sourceDir>/<table>.jsonl，每行一个 JSON 对象。
 */
export interface TableFileTargetConfig {
  dir: string;
  tables?: string[];
}

export interface Target {
  id: string;
  name: string;
  kind: TargetKind;
  /** 同一目标内保证串行；不同目标可并行 */
  enabled: boolean;
  config: PostgresTargetConfig | MediaTargetConfig | TableFileTargetConfig;
  createdAt: string;
}

/** 调度表达式：标准 5 段 cron（分 时 日 月 周）；空字符串表示不自动调度 */
export interface Plan {
  targetId: string;
  /** 备份阶段 cron；空 = 不自动备份 */
  backupCron: string;
  /** 演练阶段 cron；空 = 不自动演练（演练总会选最近一份成功备份） */
  drillCron: string;
  /** 演练后是否自动清理沙箱（默认 true） */
  keepSandbox?: boolean;
  enabled: boolean;
}

/** 产物文件（位于备份目录或沙箱内） */
export interface ArtifactFile {
  name: string;
  /** 相对 run 目录的路径 */
  path: string;
  bytes: number;
  sha256: string;
}

/** 单项校验/比对结果 */
export interface CheckResult {
  id: string;
  label: string;
  /** 通过 / 失败 / 跳过 / 警告 */
  verdict: 'pass' | 'fail' | 'skip' | 'warn';
  detail: string;
  /** 比对类检查记录期望值与实际值，便于报告展示 */
  expected?: string | number;
  actual?: string | number;
}

/** 沙箱（隔离还原环境）描述 */
export interface SandboxInfo {
  kind: TargetKind;
  /** 给人看的位置说明，如临时库名 / 沙箱目录 */
  location: string;
  /** 默认演练结束会清理；保留时这里给出保留路径 */
  kept?: boolean;
}

/** 一次执行里的时间线事件（写入 run 目录 events.jsonl，带哈希链防篡改） */
export interface RunEvent {
  seq: number;
  ts: string;
  targetId: string;
  runId: string;
  stage: StageName | 'orchestrate';
  event: string;
  data?: Record<string, unknown>;
  /** 前一条事件的 sha256（首条为 GENESIS 的哈希），构成哈希链 */
  prevHash: string;
  hash: string;
}

export interface StageResult {
  /** 这是备份阶段还是演练阶段（避免渲染时猜测） */
  stage: StageName;
  status: RunStatus;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  /** 使用的工具与版本，保证报告可复现/可归因 */
  toolchain: Record<string, string>;
  checks: CheckResult[];
  artifacts: ArtifactFile[];
  sandbox?: SandboxInfo;
  error?: string;
}

/** 一次编排执行（可能包含多个 target 的 backup/drill） */
export interface Run {
  id: string;
  trigger: 'schedule' | 'manual' | 'cli' | 'drill';
  reason: string;
  startedAt: string;
  finishedAt?: string;
  status: RunStatus;
  stages: Record<string, StageResult>;
  /** 本次产出的报告文件（相对状态根） */
  reports: string[];
}

/** 备份产物 manifest（run/<runId>/backup/<targetId>/manifest.json） */
export interface BackupManifest {
  app: string;
  runId: string;
  targetId: string;
  targetName: string;
  kind: TargetKind;
  createdAt: string;
  host: string;
  toolchain: Record<string, string>;
  /** 源端指纹：行数 / 文件数 / 总字节等，用于恢复后比对 */
  sourceFingerprint: Record<string, unknown>;
  artifacts: ArtifactFile[];
  /** manifest 自身（除该字段外）的规范序列化 sha256，写入 DONE */
  manifestSha256?: string;
}

/** 持久化在状态根下的运行记录索引（runs.jsonl 追加，runs/<id>.json 全量） */
export interface RunRecord {
  run: Run;
}

/**
 * Target 适配器接口：每种备份目标实现同一套「备份 → 完整性校验 → 隔离还原 → 比对」契约。
 * 编排器只依赖这个接口，新增数据源（MySQL、S3……）时实现一个适配器即可。
 */
import type {
  ArtifactFile,
  BackupManifest,
  CheckResult,
  PostgresTargetConfig,
  SandboxInfo,
  Target,
  TargetKind,
} from '../types';
import type { EventLog } from '../state';

export interface BackupContext {
  runId: string;
  /** 本次备份的输出目录（适配器往里写产物） */
  dir: string;
  events: EventLog;
}

export interface BackupOutcome {
  /** 源端指纹：行数、字节数、文件数等，恢复后用于一致性比对 */
  sourceFingerprint: Record<string, unknown>;
  artifacts: ArtifactFile[];
  checks: CheckResult[];
  toolchain: Record<string, string>;
}

export interface DrillContext {
  runId: string;
  /** 沙箱目录：所有临时文件必须落在这里，便于整体清理/保留 */
  sandboxRoot: string;
  /** 待演练的备份目录（有 DONE） */
  backupDir: string;
  manifest: BackupManifest;
  events: EventLog;
  /** 演练完成后是否保留沙箱 */
  keep: boolean;
}

export interface DrillOutcome {
  checks: CheckResult[];
  sandbox: SandboxInfo;
  toolchain: Record<string, string>;
}

export interface TargetAdapter {
  kind: TargetKind;
  /** 快速探活：目标是否可备份 */
  ping(target: Target): Promise<CheckResult>;
  backup(target: Target, ctx: BackupContext): Promise<BackupOutcome>;
  drill(target: Target, ctx: DrillContext): Promise<DrillOutcome>;
}

export function asPostgresConfig(target: Target): PostgresTargetConfig {
  if (target.kind !== 'postgres') throw new Error(`目标 ${target.id} 不是 postgres 类型`);
  return target.config as PostgresTargetConfig;
}

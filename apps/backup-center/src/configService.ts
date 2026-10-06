/**
 * 目标与计划的配置管理：增删改查 + 基本校验。
 * 配置即代码的轻量替代：所有变更落 config.json 并保留历史副本。
 */
import { randomUUID } from 'node:crypto';
import type { Plan, Target, TargetKind } from './types';
import type { StateStore, CenterConfig } from './state';
import { CronExpr } from './scheduler';

export interface UpsertTargetInput {
  id?: string;
  name: string;
  kind: TargetKind;
  enabled?: boolean;
  config: Target['config'];
}

export class ConfigService {
  constructor(private readonly store: StateStore) {}

  private edit(fn: (cfg: CenterConfig) => void): CenterConfig {
    const cfg = this.store.loadConfig();
    fn(cfg);
    this.store.saveConfig(cfg);
    return cfg;
  }

  listTargets(): Target[] {
    return this.store.loadConfig().targets;
  }

  getTarget(id: string): Target | undefined {
    return this.listTargets().find((t) => t.id === id);
  }

  upsertTarget(input: UpsertTargetInput): Target {
    this.validateTargetConfig(input.kind, input.config);
    let saved: Target | undefined;
    this.edit((cfg) => {
      if (input.id) {
        const idx = cfg.targets.findIndex((t) => t.id === input.id);
        if (idx >= 0) {
          saved = {
            ...cfg.targets[idx]!,
            name: input.name,
            kind: input.kind,
            config: input.config,
            ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
          };
          cfg.targets[idx] = saved;
        } else {
          // 指定 id 但尚不存在：作为「固定 id 目标」创建（onboard 幂等依赖这个行为）
          saved = {
            id: input.id,
            name: input.name,
            kind: input.kind,
            enabled: input.enabled ?? true,
            config: input.config,
            createdAt: new Date().toISOString(),
          };
          cfg.targets.push(saved);
        }
      } else {
        saved = {
          id: `tgt_${randomUUID().slice(0, 12)}`,
          name: input.name,
          kind: input.kind,
          enabled: input.enabled ?? true,
          config: input.config,
          createdAt: new Date().toISOString(),
        };
        cfg.targets.push(saved);
      }
    });
    return saved!;
  }

  removeTarget(id: string): void {
    this.edit((cfg) => {
      if (!cfg.targets.some((t) => t.id === id)) throw new Error(`目标不存在：${id}`);
      cfg.targets = cfg.targets.filter((t) => t.id !== id);
      cfg.plans = cfg.plans.filter((p) => p.targetId !== id);
    });
  }

  listPlans(): Plan[] {
    return this.store.loadConfig().plans;
  }

  setPlan(plan: Plan): Plan {
    if (plan.backupCron) new CronExpr(plan.backupCron); // 提前校验语法
    if (plan.drillCron) new CronExpr(plan.drillCron);
    this.edit((cfg) => {
      if (!cfg.targets.some((t) => t.id === plan.targetId)) throw new Error(`目标不存在：${plan.targetId}`);
      const idx = cfg.plans.findIndex((p) => p.targetId === plan.targetId);
      const next: Plan = { ...{ enabled: true }, ...plan };
      if (idx >= 0) cfg.plans[idx] = next;
      else cfg.plans.push(next);
    });
    return plan;
  }

  removePlan(targetId: string): void {
    this.edit((cfg) => {
      cfg.plans = cfg.plans.filter((p) => p.targetId !== targetId);
    });
  }

  private validateTargetConfig(kind: TargetKind, config: Target['config']): void {
    if (kind === 'postgres') {
      const c = config as { url?: string };
      if (!c.url || !/^postgresql(\+srv)?:\/\//.test(c.url)) {
        throw new Error('postgres 目标需要 config.url（postgresql://...）');
      }
    } else if (kind === 'media') {
      const c = config as import('./types').MediaTargetConfig;
      if (!c.dir) throw new Error('media 目标需要 config.dir');
      if (typeof c.sampleRatio === 'number' && (c.sampleRatio < 0 || c.sampleRatio > 1)) {
        throw new Error('sampleRatio 必须在 0~1 之间');
      }
    } else if (kind === 'tablefile') {
      const c = config as { dir?: string };
      if (!c.dir) throw new Error('tablefile 目标需要 config.dir');
    }
  }
}

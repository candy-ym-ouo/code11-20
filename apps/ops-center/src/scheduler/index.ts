/**
 * 调度引擎：进程内常驻，每分钟检查一次 cron（按 config.timezone 解释），到点执行。
 * - 同任务重叠保护：上一次没跑完就跳过本轮（记 warn）。
 * - 错过补跑：守护进程重启时，如果计划时刻落在「上次成功调度之后、现在之前」，补跑一次。
 *   调度状态持久化在 ops-center/scheduler-state.json，防止重启后重复补跑。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { config } from '../config/index.js';
import { log } from '../util/logger.js';
import { cronMatches, describeCron, parseCron } from './cron.js';

export type JobName = 'backup' | 'verify' | 'drill';

export interface JobDef {
  name: JobName;
  cron: string;
  run: () => Promise<void>;
}

interface SchedulerState {
  lastFire: Partial<Record<JobName, string>>;
}

export class Scheduler {
  private timer: NodeJS.Timeout | undefined;
  private running = new Set<JobName>();
  private state: SchedulerState = { lastFire: {} };
  private readonly stateFile: string;
  private readonly zone: string;

  constructor(private readonly jobs: JobDef[], zone: string = config.timezone) {
    this.stateFile = path.join(config.opsRoot, 'scheduler-state.json');
    this.zone = zone;
    mkdirSync(config.opsRoot, { recursive: true });
    if (existsSync(this.stateFile)) {
      try {
        this.state = JSON.parse(readFileSync(this.stateFile, 'utf8')) as SchedulerState;
      } catch {
        this.state = { lastFire: {} };
      }
    }
  }

  start(): void {
    for (const job of this.jobs) {
      parseCron(job.cron); // 启动时就校验，非法表达式立即报错
      log.info(`计划任务 ${job.name}：${describeCron(job.cron, this.zone)}`);
    }
    if (config.catchUp) this.catchUpMissed();
    // 对齐到下一个整分钟再 tick；两个定时器都保持 ref，它们本身就是守护进程的存活句柄
    const now = Date.now();
    const nextMinute = Math.ceil(now / 60_000) * 60_000;
    setTimeout(() => {
      this.tick();
      this.timer = setInterval(() => this.tick(), 60_000);
    }, nextMinute - now);
    log.info(`调度引擎已启动（时区 ${this.zone}）`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** 补跑：找每个任务「上次触发 → 现在」之间是否错过计划时刻。 */
  private catchUpMissed(): void {
    const now = new Date();
    for (const job of this.jobs) {
      const lastIso = this.state.lastFire[job.name];
      if (!lastIso) continue;
      const last = new Date(lastIso);
      const f = parseCron(job.cron);
      let missed = false;
      let probe = new Date(Math.ceil(last.getTime() / 60_000) * 60_000);
      while (probe <= now) {
        if (probe > last && cronMatches(f, probe, this.zone)) {
          missed = true;
          break;
        }
        probe = new Date(probe.getTime() + 60_000);
      }
      if (missed) {
        log.warn(`检测到错过的 ${job.name} 计划窗口（上次 ${last.toISOString()}），立即补跑`);
        void this.fire(job, true);
      }
    }
  }

  private tick(): void {
    const now = new Date();
    for (const job of this.jobs) {
      if (!cronMatches(parseCron(job.cron), now, this.zone)) continue;
      void this.fire(job, false);
    }
  }

  private async fire(job: JobDef, catchUpRun: boolean): Promise<void> {
    if (this.running.has(job.name)) {
      log.warn(`${job.name} 仍在执行，跳过本轮调度`);
      return;
    }
    this.running.add(job.name);
    const fireTime = new Date().toISOString();
    try {
      log.info(`触发计划任务：${job.name}${catchUpRun ? '（补跑）' : ''}`);
      await job.run();
      this.state.lastFire[job.name] = fireTime;
      writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2));
    } catch (err) {
      log.error(`计划任务 ${job.name} 失败：${(err as Error).message}`);
    } finally {
      this.running.delete(job.name);
    }
  }
}

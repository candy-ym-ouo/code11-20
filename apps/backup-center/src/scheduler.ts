/**
 * 极简 cron 调度器（标准 5 段：分 时 日 月 周）。
 * 支持：星号、具体数字、逗号列表、连字符区间、星号斜杠 n 的步长；周字段 0/7 都表示周日。
 * 不引入第三方依赖；触发误差取决于 tick 间隔，默认 30s，对备份场景足够。
 */

export interface CronTick {
  targetId: string;
  kind: 'backup' | 'drill';
  cron: string;
}

interface ParsedField {
  values: Set<number>;
}

function parseField(raw: string, min: number, max: number): ParsedField {
  const values = new Set<number>();
  for (const part of raw.split(',')) {
    const stepSplit = part.split('/');
    const rangePart = stepSplit[0] as string;
    const step = stepSplit[1] ? parseInt(stepSplit[1], 10) : 1;
    if (!Number.isInteger(step) || step < 1) throw new Error(`非法步长：${part}`);

    let lo: number;
    let hi: number;
    if (rangePart === '*') {
      lo = min;
      hi = max;
    } else if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-');
      lo = parseInt(a ?? '', 10);
      hi = parseInt(b ?? '', 10);
    } else {
      lo = parseInt(rangePart, 10);
      hi = stepSplit[1] ? max : lo;
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) {
      throw new Error(`非法 cron 段：${part}（允许 ${min}-${max}）`);
    }
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return { values };
}

export class CronExpr {
  private readonly minute: ParsedField;
  private readonly hour: ParsedField;
  private readonly dom: ParsedField;
  private readonly month: ParsedField;
  private readonly dow: ParsedField;

  constructor(readonly raw: string) {
    const segs = raw.trim().split(/\s+/);
    if (segs.length !== 5) throw new Error(`cron 必须是 5 段："${raw}"`);
    this.minute = parseField(segs[0]!, 0, 59);
    this.hour = parseField(segs[1]!, 0, 23);
    this.dom = parseField(segs[2]!, 1, 31);
    this.month = parseField(segs[3]!, 1, 12);
    // 周：0 与 7 都当周日
    this.dow = parseField(segs[4]!, 0, 7);
    if (this.dow.values.has(7)) {
      this.dow.values.delete(7);
      this.dow.values.add(0);
    }
  }

  matches(d: Date): boolean {
    const min = d.getMinutes();
    const hour = d.getHours();
    const dom = d.getDate();
    const month = d.getMonth() + 1;
    const dow = d.getDay();
    return (
      this.minute.values.has(min) &&
      this.hour.values.has(hour) &&
      this.month.values.has(month) &&
      this.dom.values.has(dom) &&
      this.dow.values.has(dow)
    );
  }

  /** 距下次触发的毫秒数（基于整分钟扫描，最多向后找 366 天） */
  nextAfter(from: Date = new Date()): Date {
    const cand = new Date(from);
    cand.setSeconds(0, 0);
    cand.setMinutes(cand.getMinutes() + 1);
    for (let i = 0; i < 366 * 24 * 60; i++) {
      if (this.matches(cand)) return cand;
      cand.setMinutes(cand.getMinutes() + 1);
    }
    throw new Error(`该 cron 在一年内没有任何触发时刻：${this.raw}`);
  }

  describe(): string {
    return this.raw;
  }
}

/**
 * 调度器：每分钟扫描一次，在「计划分钟」边界触发。
 * 同一 target+kind 的一次运行未结束时不会重入。
 */
export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private readonly running = new Set<string>();
  private readonly crons = new Map<string, CronExpr>();

  constructor(
    private readonly entries: Array<{ targetId: string; kind: 'backup' | 'drill'; cron: string }>,
    private readonly fire: (targetId: string, kind: 'backup' | 'drill') => Promise<void>,
  ) {
    for (const e of entries) {
      if (e.cron.trim()) this.crons.set(`${e.targetId}:${e.kind}`, new CronExpr(e.cron));
    }
  }

  private tick(): void {
    const now = new Date();
    for (const [key, cron] of this.crons) {
      if (!cron.matches(now)) continue;
      if (this.running.has(key)) continue;
      this.running.add(key);
      const [targetId, kind] = key.split(':') as [string, 'backup' | 'drill'];
      this.fire(targetId, kind).finally(() => this.running.delete(key));
    }
  }

  /** 返回所有计划的下一次触发时间 */
  upcoming(): Array<{ key: string; next: Date; cron: string }> {
    return [...this.crons.entries()].map(([key, cron]) => ({ key, cron: cron.raw, next: cron.nextAfter() }));
  }

  start(): void {
    if (this.timer) return;
    // 对齐到下一个整分钟触发，之后严格每 60 秒一次（setInterval 会漂移，所以递归 setTimeout）。
    const scheduleNext = (): void => {
      const delay = 60_000 - (Date.now() % 60_000);
      this.timer = setTimeout(() => {
        this.tick();
        scheduleNext();
      }, delay) as unknown as NodeJS.Timeout;
    };
    scheduleNext();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

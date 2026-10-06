/**
 * 极简 cron 解析器（5 字段：分 时 日 月 周），不引入第三方依赖。
 * 支持：星号、具体数字、逗号列表、连字符区间、星号斜杠 n 的步长写法；周字段 0/7 都表示周日。
 * 不支持非标准扩展（@daily、L、W、#），配置非法时直接抛错而不是静默不跑。
 *
 * 时间一律按调度时区（config.timezone，默认 Asia/Shanghai）解释，
 * 因为 .env 里的 TZ 在 Node 启动后设置不会改变 V8 的本地时区，不能依赖 Date#getHours。
 */
import { partsInZone } from './zone.js';

export type CronFields = {
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number> | null; // null = *
  month: Set<number>;
  dayOfWeek: Set<number> | null; // null = *；内部统一成 0=周日..6=周六
};

const RANGES = {
  minute: [0, 59],
  hour: [0, 23],
  dayOfMonth: [1, 31],
  month: [1, 12],
  // 周字段上界放到 7：cron 里 0 和 7 都表示周日，解析时把 7 归一为 0
  dayOfWeek: [0, 7],
} as const;

type FieldName = keyof typeof RANGES;

function parseField(raw: string, name: FieldName): Set<number> | null {
  const [min, max] = RANGES[name];
  if (raw === '*') return null;
  const out = new Set<number>();
  for (const part of raw.split(',')) {
    const stepMatch = part.match(/^(.+)\/(\d+)$/);
    const step = stepMatch ? Number(stepMatch[2]) : 1;
    const rangePart = stepMatch ? stepMatch[1]! : part;
    if (!Number.isInteger(step) || step < 1) throw new Error(`cron 步长非法：${raw}`);

    let lo: number;
    let hi: number;
    if (rangePart === '*') {
      lo = min;
      hi = max;
    } else if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-');
      lo = Number(a);
      hi = Number(b);
    } else {
      lo = Number(rangePart);
      hi = stepMatch ? max : lo;
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) {
      throw new Error(`cron 字段 ${name} 越界：${raw}`);
    }
    for (let v = lo; v <= hi; v += step) {
      // 周日的 7 归一化成 0
      out.add(name === 'dayOfWeek' && v === 7 ? 0 : v);
    }
  }
  return out;
}

export function parseCron(expr: string): CronFields {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`cron 表达式必须是 5 个字段："${expr}"`);
  const [minute, hour, dom, month, dow] = parts;
  return {
    minute: parseField(minute!, 'minute') ?? new Set(range(0, 59)),
    hour: parseField(hour!, 'hour') ?? new Set(range(0, 23)),
    dayOfMonth: parseField(dom!, 'dayOfMonth'),
    month: parseField(month!, 'month') ?? new Set(range(1, 12)),
    dayOfWeek: parseField(dow!, 'dayOfWeek'),
  };
}

function range(lo: number, hi: number): number[] {
  return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
}

/** cron 是否在给定 UTC 时刻、按 zone 解释后触发。 */
export function cronMatches(f: CronFields, d: Date, zone = 'UTC'): boolean {
  const p = partsInZone(d, zone);
  if (!f.minute.has(p.minute)) return false;
  if (!f.hour.has(p.hour)) return false;
  if (!f.month.has(p.month)) return false;
  const domMatch = f.dayOfMonth === null || f.dayOfMonth.has(p.day);
  const dowMatch = f.dayOfWeek === null || f.dayOfWeek.has(p.weekday);
  // cron 语义：日和周都被限制时取「或」；任一为星号时取「与」
  if (f.dayOfMonth === null || f.dayOfWeek === null) {
    return domMatch && dowMatch;
  }
  return domMatch || dowMatch;
}

/** 返回下一次触发的 UTC 时刻（从 from 的下一分钟整开始，最多向前推 366 天）。 */
export function nextMatch(expr: string | CronFields, from: Date = new Date(), zone = 'UTC'): Date {
  const f = typeof expr === 'string' ? parseCron(expr) : expr;
  let t = new Date(from.getTime() + 60_000);
  t.setUTCSeconds(0, 0);
  const limit = new Date(t.getTime() + 366 * 24 * 60 * 60_000);
  while (t <= limit) {
    if (cronMatches(f, t, zone)) return new Date(t);
    t = new Date(t.getTime() + 60_000);
  }
  throw new Error('366 天内找不到下一次 cron 触发点，请检查表达式（注意 2 月 30 日这类不存在的日期）');
}

/** 人类可读的下一次执行描述（按调度时区显示）。 */
export function describeCron(expr: string, zone = 'UTC'): string {
  const next = nextMatch(expr, new Date(), zone);
  const p = partsInZone(next, zone);
  return `"${expr}"（${zone}），下一次：${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`;
}

function pad(n: number): string {
  return n.toString().padStart(2, '0');
}

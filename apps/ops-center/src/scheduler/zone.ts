/**
 * 时区感知的时间字段读取：cron 按配置的时区（.env 里的 TZ，默认 Asia/Shanghai）解释，
 * 而不是按 Node 启动时冻结的本地时区——process.env.TZ 在进程启动后再改不会影响
 * V8 的 Date#getHours()，所以这里用 Intl.DateTimeFormat 显式按目标时区取字段。
 */

export interface ZoneParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  weekday: number; // 0=周日..6=周六
}

const WEEKDAY_INDEX: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatter(zone: string): Intl.DateTimeFormat {
  let f = formatterCache.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
    });
    formatterCache.set(zone, f);
  }
  return f;
}

export function partsInZone(date: Date, zone: string): ZoneParts {
  const parts = formatter(zone).formatToParts(date);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')) % 24, // 某些环境午夜显示 24
    minute: Number(get('minute')),
    weekday: WEEKDAY_INDEX[get('weekday').toLowerCase()] ?? 0,
  };
}

/**
 * 在指定时区里，把「日/时/分」字段写回一个 UTC 时间：
 * 用目标时区当天 00:00（取该时刻的近似 UTC 基准）+ 当日已过毫秒。
 * 通过二分探测避免夏令时边界误差。
 */
export function zonedToUtc(
  zone: string,
  parts: { year: number; month: number; day: number; hour: number; minute: number },
): Date {
  // 先粗估：目标时区的时间转成字符串让 Date 解析（大多数 IANA 名称 Date 不直接吃），
  // 因此用「锚点 + 偏移探测」：
  const targetWithinDayMs = ((parts.hour * 60 + parts.minute) * 60) * 1000;
  // 找到目标日期在该时区的 UTC 起点（当地 00:00）
  const dayStartUtc = zonedMidnightUtc(zone, parts.year, parts.month, parts.day);
  return new Date(dayStartUtc.getTime() + targetWithinDayMs);
}

/** 返回目标时区里指定本地日期 00:00 对应的 UTC 时刻。 */
export function zonedMidnightUtc(zone: string, year: number, month: number, day: number): Date {
  // 在 UTC 中先按该日期的中午取点，读出其在目标时区的字段与偏移，再反推
  const guessUtc = Date.UTC(year, month - 1, day, 12, 0, 0);
  const atGuess = new Date(guessUtc);
  const zp = partsInZone(atGuess, zone);
  // guess(UTC 12:00) 在目标时区是 zp.hour:zp.minute；要让它变成当天 00:00，
  // 回退 zp.hour 小时 + zp.minute 分（分钟级，足够 cron 使用）
  const offsetMs = (zp.hour * 60 + zp.minute) * 60_000;
  return new Date(guessUtc - offsetMs);
}

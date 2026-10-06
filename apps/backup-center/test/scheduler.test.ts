import { describe, expect, it } from 'vitest';
import { CronExpr } from '../src/scheduler';

describe('cron 表达式', () => {
  it('每天 02:30', () => {
    const c = new CronExpr('30 2 * * *');
    expect(c.matches(new Date('2026-10-06T02:30:00'))).toBe(true);
    expect(c.matches(new Date('2026-10-06T02:31:00'))).toBe(false);
    expect(c.matches(new Date('2026-10-06T03:30:00'))).toBe(false);
  });

  it('每周一 04:00（演练）', () => {
    const c = new CronExpr('0 4 * * 1');
    // 2026-10-05 是周一
    expect(c.matches(new Date('2026-10-05T04:00:00'))).toBe(true);
    expect(c.matches(new Date('2026-10-06T04:00:00'))).toBe(false); // 周二
  });

  it('周日 0 与 7 等价', () => {
    const sun = new CronExpr('0 0 * * 0');
    const sun7 = new CronExpr('0 0 * * 7');
    const d = new Date('2026-10-04T00:00:00'); // 周日
    expect(sun7.matches(d)).toBe(true);
    expect(sun.matches(d)).toBe(sun7.matches(d));
  });

  it('nextAfter 总在未来且匹配自身', () => {
    const c = new CronExpr('0 3 * * *');
    const now = new Date('2026-10-06T10:00:00');
    const next = c.nextAfter(now);
    expect(next.getTime()).toBeGreaterThan(now.getTime());
    expect(c.matches(next)).toBe(true);
  });

  it('非法表达式报错', () => {
    expect(() => new CronExpr('60 * * * *')).toThrow();
    expect(() => new CronExpr('* * *')).toThrow();
    expect(() => new CronExpr('*/0 * * * *')).toThrow();
  });
});

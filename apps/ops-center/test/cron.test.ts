import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCron, cronMatches, nextMatch } from '../src/scheduler/cron.js';

test('parseCron: 星号与列表/区间/步长', () => {
  assert.equal(parseCron('* * * * *').minute.size, 60);
  const f = parseCron('0,30 2-4 */5 * 1-5');
  assert.deepEqual([...f.minute], [0, 30]);
  assert.deepEqual([...f.hour], [2, 3, 4]);
  // 日字段从 1 起，*/5 => 1,6,11,16,21,26
  assert.ok(f.dayOfMonth?.has(1) && f.dayOfMonth.has(6) && f.dayOfMonth.has(26) && !f.dayOfMonth.has(5));
  assert.deepEqual([...f.dayOfWeek!], [1, 2, 3, 4, 5]);
});

test('parseCron: 周日 7 归一为 0', () => {
  assert.deepEqual([...parseCron('0 0 * * 7').dayOfWeek!], [0]);
});

test('parseCron: 非法表达式直接抛错', () => {
  assert.throws(() => parseCron('* * * *'), /5 个字段/);
  assert.throws(() => parseCron('99 * * * *'), /越界/);
  assert.throws(() => parseCron('*/0 * * * *'), /步长/);
});

test('cronMatches: 基本命中', () => {
  const f = parseCron('30 2 * * *');
  assert.equal(cronMatches(f, new Date('2026-10-07T02:30:00Z'), 'UTC'), true);
  assert.equal(cronMatches(f, new Date('2026-10-07T02:31:00Z'), 'UTC'), false);
});

test('cronMatches: 日/周 都受限取「或」', () => {
  // 每月 1 号 或 周一
  const f = parseCron('0 0 1 * 1');
  // 2026-10-01 是周四，命中「日」
  assert.equal(cronMatches(f, new Date('2026-10-01T00:00:00Z'), 'UTC'), true);
  // 2026-10-05 是周一，命中「周」
  assert.equal(cronMatches(f, new Date('2026-10-05T00:00:00Z'), 'UTC'), true);
  // 2026-10-02 周五，都不命中
  assert.equal(cronMatches(f, new Date('2026-10-02T00:00:00Z'), 'UTC'), false);
});

test('nextMatch: 找下一次', () => {
  const next = nextMatch('30 2 * * *', new Date('2026-10-06T11:00:00Z'), 'UTC');
  assert.equal(next.toISOString(), '2026-10-07T02:30:00.000Z');
});

test('nextMatch: 不存在的日期（2 月 30 日）应抛错而非死循环', () => {
  assert.throws(() => nextMatch('0 0 30 2 *', new Date('2026-03-01T00:00:00Z'), 'UTC'), /找不到/);
});

test('时区：19:30 上海 == 11:30 UTC', () => {
  const f = parseCron('30 19 * * *');
  assert.equal(cronMatches(f, new Date('2026-10-06T11:30:00Z'), 'Asia/Shanghai'), true);
  assert.equal(cronMatches(f, new Date('2026-10-06T11:30:00Z'), 'UTC'), false);
});

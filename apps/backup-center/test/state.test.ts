import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventLog, StateStore } from '../src/state';

let roots: string[] = [];
async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'bctr-state-'));
  roots.push(d);
  return d;
}
afterEach(async () => {
  await Promise.all(roots.map((d) => rm(d, { recursive: true, force: true })));
  roots = [];
});

describe('哈希链事件日志', () => {
  it('追加后可独立验真；篡改任意事件即断裂', async () => {
    const root = await tmp();
    const file = join(root, 'events.jsonl');
    const log = new EventLog(file);
    for (let i = 0; i < 5; i++) {
      log.append({ runId: 'r1', targetId: 't1', stage: 'backup', event: `e${i}`, data: { i } });
    }
    expect(EventLog.verify(file).ok).toBe(true);
    expect(EventLog.verify(file).events.length).toBe(5);

    // 篡改第 3 行的 data
    const fs = await import('node:fs/promises');
    const content = (await fs.readFile(file, 'utf8')).split('\n');
    const evil = JSON.parse(content[2]!);
    evil.data = { i: 999 };
    content[2] = JSON.stringify(evil);
    await fs.writeFile(file, content.join('\n'));

    const v = EventLog.verify(file);
    expect(v.ok).toBe(false);
    expect(v.brokenAt).toBe(3);
  });

  it('EventLog 重开文件后从断点续写，链条不断', async () => {
    const root = await tmp();
    const file = join(root, 'events.jsonl');
    new EventLog(file).append({ runId: 'r', targetId: 't', stage: 'backup', event: 'a' });
    const log2 = new EventLog(file);
    log2.append({ runId: 'r', targetId: 't', stage: 'backup', event: 'b' });
    const v = EventLog.verify(file);
    expect(v.ok).toBe(true);
    expect(v.events).toHaveLength(2);
  });
});

describe('StateStore', () => {
  it('保存配置时自动留历史副本', async () => {
    const root = await tmp();
    const store = new StateStore(root);
    const cfg = store.loadConfig();
    cfg.targets.push({ id: 't1', name: 'n', kind: 'tablefile', enabled: true, config: { dir: '/tmp' }, createdAt: new Date().toISOString() });
    store.saveConfig(cfg);
    const cfg2 = store.loadConfig();
    cfg2.targets[0]!.name = 'n2';
    store.saveConfig(cfg2);
    const hist = await import('node:fs/promises').then((fs) => fs.readdir(join(root, 'config-history')));
    expect(hist.length).toBe(1);
  });

  it('pruneRuns 只保留最近 N 次', async () => {
    const root = await tmp();
    const store = new StateStore(root);
    for (let i = 0; i < 5; i++) {
      const id = `run-000${i}`;
      await store.saveRun({
        id,
        trigger: 'cli',
        reason: '',
        startedAt: new Date(2026, 0, i + 1).toISOString(),
        status: 'success',
        stages: {},
        reports: [],
      });
    }
    const removed = await store.pruneRuns(2);
    expect(removed).toHaveLength(3);
    expect((await store.listRuns())).toHaveLength(2);
  });
});

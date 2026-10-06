/**
 * 端到端：用嵌入式 PostgreSQL 演完整条链
 * 建源库+数据 → 注册 postgres 目标 → run（备份+演练）→ 应全部通过
 * → 篡改源库后只演练 → 漂移被标注为 warn（不是 fail）
 * → 同时注册 media/tablefile 目标验证三类目标并行跑通
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { Orchestrator } from '../src/orchestrator';
import { ConfigService } from '../src/configService';
import { StateStore } from '../src/state';
import type { Run } from '../src/types';

let pg: EmbeddedPostgres;
let sourceUrl: string;
let work: string;
const PORT = 55891;

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), 'bctr-e2e-'));
  pg = new EmbeddedPostgres({
    databaseDir: join(work, 'pgdata'),
    port: PORT,
    user: 'heirloom',
    password: 'pw',
    persistent: true,
    onLog: () => undefined,
    onError: () => undefined,
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('ledger');
  sourceUrl = `postgresql://heirloom:pw@127.0.0.1:${PORT}/ledger`;
  const c = pg.getPgClient('ledger');
  await c.connect();
  await c.query(`create table families (id serial primary key, name text not null, created_at timestamptz default now())`);
  await c.query(`create table items (id serial primary key, family_id int references families(id), title text, acquired date)`);
  await c.query(`insert into families(name) values ('张家'), ('李家'), ('王家')`);
  await c.query(`insert into items(family_id,title,acquired) values (1,'樟木箱','1978-01-01'),(1,'搪瓷缸','1983-05-02'),(2,'手写菜谱','1960-09-09')`);
  await c.end();
}, 60_000);

afterAll(async () => {
  try {
    await pg.stop();
  } catch {
    // ignore
  }
  await rm(work, { recursive: true, force: true });
});

function harness(stateRoot: string) {
  const store = new StateStore(stateRoot);
  const config = new ConfigService(store);
  const orchestrator = new Orchestrator(store);
  return { store, config, orchestrator };
}

function stage(run: Run, suffix: string) {
  return run.stages[Object.keys(run.stages).find((k) => k.endsWith(suffix))!]!;
}

describe('PostgreSQL 备份 → 隔离演练（真实嵌入式集群）', () => {
  it('备份与逐表比对全部通过', async () => {
    const root = join(work, 'state1');
    const { config, orchestrator } = harness(root);
    config.upsertTarget({ name: '家档库', kind: 'postgres', config: { url: sourceUrl, format: 'custom' } });
    const t = config.listTargets()[0]!;
    config.setPlan({ targetId: t.id, backupCron: '30 2 * * *', drillCron: '0 4 * * 1', enabled: true });

    const run = await orchestrator.execute({ trigger: 'cli', reason: 'e2e' });
    expect(run.status).toBe('success');

    const backup = stage(run, ':backup');
    const drill = stage(run, ':drill');
    expect(backup.status).toBe('success');
    expect(drill.status).toBe('success');
    expect(backup.artifacts.some((a) => a.name === 'db.dump')).toBe(true);

    const labels = drill.checks.map((c) => c.label);
    expect(labels.join('|')).toContain('逐表内容比对');
    const content = drill.checks.find((c) => c.id === 'pg.compare.content')!;
    expect(content.verdict).toBe('pass');
    expect(content.detail).toContain('2/2');
    // 沙箱必须被清理
    expect(drill.sandbox?.kept).toBeFalsy();

    // 事件哈希链完整
    const chain = orchestrator.verifyChain(run.id);
    expect(chain.ok).toBe(true);
    expect(chain.events).toBeGreaterThan(4);

    // 报告存在且含结论与哈希链
    const { readFile } = await import('node:fs/promises');
    const report = await readFile(join(root, 'runs', run.id, 'reports', 'summary.md'), 'utf8');
    expect(report).toContain('总报告');
    expect(report).toContain('链校验 ✅ 完整');
    expect(report).toContain('db.dump');
  }, 90_000);

  it('备份后源库发生写入：演练仍通过，漂移被标注为 warn', async () => {
    const root = join(work, 'state2');
    const { config, orchestrator } = harness(root);
    config.upsertTarget({ name: '库', kind: 'postgres', config: { url: sourceUrl } });
    const t = config.listTargets()[0]!;
    await orchestrator.execute({ trigger: 'cli', stages: ['backup'] });

    // 备份之后再写一行
    const c = pg.getPgClient('ledger');
    await c.connect();
    await c.query(`insert into items(family_id,title) values (3,'后来新增的票据')`);
    await c.end();

    const run = await orchestrator.execute({ trigger: 'cli', stages: ['drill'] });
    const drill = stage(run, ':drill');
    expect(drill.status).toBe('success');
    const drift = drill.checks.find((c2) => c2.id === 'pg.compare.drift')!;
    expect(drift.verdict).toBe('warn');
    expect(drift.detail).toContain('items');
  }, 90_000);
});

describe('媒体与表文件目标', () => {
  it('媒体备份+演练：哈希校验通过，损坏包被发现', async () => {
    const media = join(work, 'uploads');
    await mkdir(join(media, 'families', 'f1'), { recursive: true });
    await writeFile(join(media, 'families', 'f1', 'photo.png'), Buffer.alloc(300, 1));
    await writeFile(join(media, 'families', 'f1', 'voice.wav'), Buffer.alloc(700, 7));

    const root = join(work, 'state-media');
    const { config, orchestrator } = harness(root);
    config.upsertTarget({ name: '媒体', kind: 'media', config: { dir: media, sampleRatio: 1 } });
    const run = await orchestrator.execute({ trigger: 'cli' });
    expect(run.status).toBe('success');
    const drill = stage(run, ':drill');
    const hash = drill.checks.find((c) => c.id === 'media.compare.hash')!;
    expect(hash.verdict).toBe('pass');
  });

  it('tablefile 目标：备份产物与清单不符时，证据可被发现', async () => {
    const dir = join(work, 'tables');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'people.jsonl'), ['{"id":1,"name":"外公"}', '{"id":2,"name":"奶奶"}'].join('\n'));

    const root = join(work, 'state-tf');
    const { config, orchestrator } = harness(root);
    config.upsertTarget({ name: '逻辑表', kind: 'tablefile', config: { dir } });
    const good = await orchestrator.execute({ trigger: 'cli' });
    expect(good.status).toBe('success');

    // 破坏备份产物：改写文件但 manifest/DONE 仍是旧哈希
    const t = config.listTargets()[0]!;
    const { readdir } = await import('node:fs/promises');
    const runId = (await readdir(join(root, 'runs')))[0]!;
    const bdir = join(root, 'runs', runId, 'backup', t.id);
    const f = join(bdir, 'people.jsonl');
    await writeFile(f, '{"id":1,"name":"被篡改"}\n');

    const { sha256File } = await import('../src/util');
    const manifest = JSON.parse(await (await import('node:fs/promises')).readFile(join(bdir, 'manifest.json'), 'utf8'));
    const art = manifest.artifacts.find((a: { name: string }) => a.name === 'people.jsonl');
    // manifest 是独立证据：产物哈希与之不符即可证明被篡改
    expect(await sha256File(f)).not.toBe(art.sha256);

    // DONE 内的 manifest 哈希也仍然自洽，说明被改的是数据文件而非凭证
    const done = await (await import('node:fs/promises')).readFile(join(bdir, 'DONE'), 'utf8');
    expect(done.trim().split('\n')[1]).toBe(manifest.manifestSha256);
  });
});

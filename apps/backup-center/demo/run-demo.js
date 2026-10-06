#!/usr/bin/env node
/**
 * 一键演示：在本机造一个完全隔离的演示环境，跑通「定时编排中心」的全部能力。
 *
 * 做的事：
 *  1. 启动嵌入式 PostgreSQL（data/backup-center-demo/pgdata，端口自动）
 *  2. 建库建表，写入「家庭/物品/人物/媒体登记」示例数据
 *  3. 准备媒体目录（图片/音频占位文件）
 *  4. 向中心注册：postgres 目标 + media 目标，并设置每天 02:30 备份 / 每周一 04:00 演练
 *  5. 立即执行一轮 backup+drill
 *  6. 模拟「备份后又有新写入」，再跑一次演练，展示漂移警告而非误报损坏
 *  7. 打印 run 列表、报告路径、看板地址（serve 模式）
 *
 * 运行：node apps/backup-center/demo/run-demo.js
 */
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const EmbeddedPostgres = require('embedded-postgres').default ?? require('embedded-postgres');
const { Orchestrator } = require('../dist/orchestrator');
const { ConfigService } = require('../dist/configService');
const { StateStore } = require('../dist/state');
const { startServer } = require('../dist/server/http');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const DEMO_ROOT = path.join(ROOT, 'data', 'backup-center-demo');
const PORT = 55611;

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  await fs.rm(DEMO_ROOT, { recursive: true, force: true });
  await fs.mkdir(path.join(DEMO_ROOT, 'uploads', 'families', 'zhang'), { recursive: true });
  await fs.mkdir(path.join(DEMO_ROOT, 'uploads', 'families', 'li'), { recursive: true });

  // ---- 1. 源数据库 ----
  console.log('① 启动源数据库（嵌入式 PostgreSQL）…');
  const pg = new EmbeddedPostgres({
    databaseDir: path.join(DEMO_ROOT, 'pgdata'),
    port: PORT,
    user: 'heirloom',
    password: 'demo',
    persistent: true,
    onLog: () => {},
    onError: () => {},
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('heirloom');
  const url = `postgresql://heirloom:demo@127.0.0.1:${PORT}/heirloom`;
  const c = pg.getPgClient('heirloom');
  await c.connect();
  await c.query(`create table users (id serial primary key, email text unique, display_name text, created_at timestamptz default now())`);
  await c.query(`create table families (id serial primary key, name text, created_at timestamptz default now())`);
  await c.query(`create table people (id serial primary key, family_id int references families(id), name text, relation text, birth_year int)`);
  await c.query(`create table items (id serial primary key, family_id int references families(id), title text, category text, acquired date, story text)`);
  await c.query(`create table item_media (id serial primary key, item_id int references items(id), kind text, sha256 text, bytes int)`);
  await c.query(`insert into users(email,display_name) values ('dajie@example.com','大姐'), ('xiaomei@example.com','小妹')`);
  await c.query(`insert into families(name) values ('老张家'), ('老李家')`);
  await c.query(`insert into people(family_id,name,relation,birth_year) values (1,'外公','外公',1932),(1,'奶奶','奶奶',1935),(2,'舅公','舅公',1940)`);
  await c.query(`insert into items(family_id,title,category,acquired,story) values
    (1,'外公的樟木箱','furniture','1978-01-01','木器社亲手打的'),
    (1,'结婚时的搪瓷缸','souvenir','1983-05-02','红双喜字样'),
    (1,'自行车发票','receipt','1985-10-03','永久牌'),
    (2,'奶奶的手写菜谱','manuscript','1968-07-07','毛笔小楷')`);
  await c.query(`insert into item_media(item_id,kind,sha256,bytes) values
    (1,'image','a1b2c3',245760),(1,'audio','d4e5f6',4823111),(2,'image','070809',188416),(4,'image','101112',99204)`);

  // ---- 2. 媒体文件 ----
  console.log('② 写入媒体文件（图片/音频占位）…');
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
    'base64',
  );
  await fs.writeFile(path.join(DEMO_ROOT, 'uploads', 'families', 'zhang', '樟木箱.png'), png);
  await fs.writeFile(path.join(DEMO_ROOT, 'uploads', 'families', 'zhang', '搪瓷缸.jpg'), Buffer.alloc(180 * 1024, 0x55));
  // 12 个文件，便于演示抽样/全量
  for (let i = 1; i <= 10; i++) {
    await fs.writeFile(path.join(DEMO_ROOT, 'uploads', 'families', 'li', `录音-${String(i).padStart(2, '0')}.wav`), Buffer.alloc(120 * 1024, i));
  }

  // ---- 3. 注册目标与计划 ----
  console.log('③ 注册目标与定时计划…');
  const store = new StateStore(path.join(DEMO_ROOT, 'center'));
  const config = new ConfigService(store);
  const orchestrator = new Orchestrator(store);
  const dbT = config.upsertTarget({ name: '家档数据库', kind: 'postgres', config: { url, format: 'custom' } });
  const mediaT = config.upsertTarget({ name: '家庭媒体库', kind: 'media', config: { dir: path.join(DEMO_ROOT, 'uploads') } });
  config.setPlan({ targetId: dbT.id, backupCron: '30 2 * * *', drillCron: '0 4 * * 1', enabled: true });
  config.setPlan({ targetId: mediaT.id, backupCron: '30 2 * * *', drillCron: '0 4 * * 1', enabled: true });

  // ---- 4. 立即执行 ----
  console.log('④ 立即执行「备份 + 隔离演练」…');
  const run = await orchestrator.execute({ trigger: 'cli', reason: '演示' });
  printRun(run);

  // ---- 5. 备份后写入，再演练（漂移演示）----
  console.log('⑤ 模拟备份后新写入一条数据，再次演练（应通过，并把漂移标为警告）…');
  await c.query(`insert into items(family_id,title,category,story) values (1,'后来才补录的旧照片','other','演练前刚录入')`);
  await c.end();
  await fs.writeFile(path.join(DEMO_ROOT, 'uploads', 'families', 'zhang', '新增-全家福.jpg'), Buffer.alloc(204 * 1024, 0x33));
  const run2 = await orchestrator.execute({ trigger: 'cli', reason: '演示-漂移', stages: ['drill'] });
  printRun(run2);

  // ---- 6. 校验哈希链 ----
  for (const id of [run.id, run2.id]) {
    const v = orchestrator.verifyChain(id);
    console.log(`⑥ 事件哈希链 ${id}：${v.ok ? '完整 ✅' : '断裂 ❌'}（${v.events} 条事件）`);
  }

  if (process.env.DEMO_SERVE) {
    console.log('\n⑦ 启动只读看板：http://127.0.0.1:4095 （Ctrl+C 退出后演示数据保留在 data/backup-center-demo/）');
    startServer({ orchestrator, config, store, port: 4095 });
    process.on('SIGINT', async () => {
      await pg.stop().catch(() => {});
      process.exit(0);
    });
    await new Promise(() => {});
  } else {
    await pg.stop().catch(() => {});
    console.log('\n⑦ 完成。可用以下命令打开看板：');
    console.log('   BACKUP_CENTER_STATE=data/backup-center-demo/center BACKUP_CENTER_PORT=4095 node apps/backup-center/dist/index.js serve');
  }
}

function printRun(run) {
  console.log(`\n── ${run.id} → ${run.status}`);
  for (const [k, s] of Object.entries(run.stages)) {
    const by = {};
    for (const ch of s.checks) by[ch.verdict] = (by[ch.verdict] ?? 0) + 1;
    console.log(
      `   ${k.padEnd(34)} ${s.status.padEnd(8)} ✅${by.pass ?? 0} ⚠️${by.warn ?? 0} ❌${by.fail ?? 0} ⏭️${by.skip ?? 0}`,
    );
    for (const ch of s.checks) {
      if (ch.verdict === 'fail' || ch.verdict === 'warn') {
        console.log(`      · [${ch.verdict}] ${ch.label}：${ch.detail.split('\n')[0]}`);
      }
    }
  }
  for (const r of run.reports) console.log(`   报告：${path.join(DEMO_ROOT, 'center', r)}`);
}

main().catch((err) => {
  console.error('演示失败：', err);
  process.exit(1);
});

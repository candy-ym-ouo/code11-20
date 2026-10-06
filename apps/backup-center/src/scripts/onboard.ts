/**
 * 一键接入：从仓库 .env 读取连接信息，把本项目的数据库与媒体目录注册进备份中心，
 * 并装上「每天 02:30 备份、每周一 04:00 隔离演练」的默认计划。
 * 幂等：按固定 id upsert，重复执行不会产生重复目标。
 */
import path from 'node:path';
import fs from 'node:fs';
import { ConfigService } from '../configService';
import { StateStore } from '../state';

function loadEnv(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2] as string;
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1] as string] = v;
  }
  return out;
}

export async function onboard(): Promise<void> {
  // 同时兼容 dist/scripts（4 级）与 src/scripts 经 tsx 运行（3 级）
  const repoRoot = fs.existsSync(path.resolve(__dirname, '..', '..', '..', '..', '.env'))
    ? path.resolve(__dirname, '..', '..', '..', '..')
    : path.resolve(__dirname, '..', '..', '..');
  const env = { ...loadEnv(path.join(repoRoot, '.env')), ...process.env };
  const stateRoot = env.BACKUP_CENTER_STATE
    ? path.resolve(repoRoot, env.BACKUP_CENTER_STATE)
    : path.join(repoRoot, 'data', 'backup-center');
  const store = new StateStore(stateRoot);
  const config = new ConfigService(store);

  const DB_ID = 'app-postgres';
  const MEDIA_ID = 'app-media';

  if (env.DATABASE_URL) {
    const t = config.upsertTarget({
      id: DB_ID,
      name: '家中物品来历册 · 数据库',
      kind: 'postgres',
      config: { url: env.DATABASE_URL, format: 'custom' },
    });
    config.setPlan({ targetId: t.id, backupCron: '30 2 * * *', drillCron: '0 4 * * 1', enabled: true });
    console.log(`✔ 数据库目标：${t.id}`);
  } else {
    console.log('! .env 中没有 DATABASE_URL，跳过数据库目标');
  }

  const mediaDir = path.resolve(repoRoot, env.STORAGE_ROOT || 'data/uploads');
  const tm = config.upsertTarget({
    id: MEDIA_ID,
    name: '家中物品来历册 · 媒体库',
    kind: 'media',
    config: { dir: mediaDir, sampleRatio: 1 },
  });
  config.setPlan({ targetId: tm.id, backupCron: '30 2 * * *', drillCron: '0 4 * * 1', enabled: true });
  console.log(`✔ 媒体目标：${tm.id} → ${mediaDir}`);

  console.log(`\n状态目录：${stateRoot}`);
  console.log('立即跑一轮：pnpm center:run');
  console.log('启动定时守护与看板：pnpm center:daemon');
}

// 直接作为脚本运行时执行（被 index.ts import 时不自动跑）
if (require.main === module) {
  onboard().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

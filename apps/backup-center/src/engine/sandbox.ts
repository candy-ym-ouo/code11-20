/**
 * 隔离沙箱：每次演练启动一个独立的嵌入式 PostgreSQL 集群。
 * - 数据目录位于本次 run 的 sandboxRoot 下，与生产数据物理隔离；
 * - 监听随机高端口、只绑定 127.0.0.1；
 * - 演练结束默认整体删除（stop + 删目录），可通过 keep 保留以便排障；
 * - 没有网络/没有系统 postgres 也能跑（二进制由 embedded-postgres 提供）。
 */
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

export interface PgSandbox {
  url: string;
  database: string;
  dataDir: string;
  port: number;
  user: string;
  stop: () => Promise<void>;
}

async function loadEmbeddedPostgres(): Promise<typeof import('embedded-postgres').default> {
  // 动态 import：不使用 postgres 目标的调用方不需要加载这份原生 ESM 二进制
  const mod = (await import('embedded-postgres')) as { default?: typeof import('embedded-postgres').default } & Record<string, unknown>;
  const Ctor = (mod.default ?? (mod as unknown as typeof import('embedded-postgres').default)) as typeof import('embedded-postgres').default;
  return Ctor;
}

function randomPort(): number {
  // 动态端口区间：避开常见服务端口
  return 50_000 + Math.floor(Math.random() * 10_000);
}

export async function startPgSandbox(opts: {
  dataDir: string;
  database: string;
  user?: string;
  password?: string;
}): Promise<PgSandbox> {
  const EmbeddedPostgres = await loadEmbeddedPostgres();
  const user = opts.user ?? 'drill';
  const password = opts.password ?? 'drill';
  const port = randomPort();

  const pg = new EmbeddedPostgres({
    databaseDir: opts.dataDir,
    port,
    user,
    password,
    persistent: true, // 我们自己控制数据目录的删除
    authMethod: 'password',
    onLog: () => undefined,
    onError: () => undefined,
  });

  await pg.initialise();
  await pg.start();
  await pg.createDatabase(opts.database);

  const url = `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:${port}/${opts.database}`;

  return {
    url,
    database: opts.database,
    dataDir: opts.dataDir,
    port,
    user,
    stop: async () => {
      try {
        await pg.stop();
      } catch {
        // 进程可能已退出
      }
      if (existsSync(opts.dataDir) && !process.env.BACKUP_CENTER_KEEP_SANDBOX) {
        await rm(opts.dataDir, { recursive: true, force: true });
      }
    },
  };
}

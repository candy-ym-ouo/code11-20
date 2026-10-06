/**
 * 配置：仓库根目录下的 .env + 进程环境变量。
 * 与 scripts/lib.sh 使用同一份 .env，保证备份/演练与手工脚本看到的是同一套连接信息。
 */
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../../..');

/** 极简 .env 解析（不引入依赖）；不覆盖已存在的环境变量。 */
export function loadDotEnv(file: string): void {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv(path.join(REPO_ROOT, '.env'));

function str(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function int(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`环境变量 ${name} 不是合法数字：${v}`);
  return n;
}

/** Prisma 连接串里的 ?schema=public 是 libpq 不认的参数，psql/pg_dump 前要剥掉。 */
function libpqUrl(url: string): string {
  return url.split('?')[0] ?? url;
}

/** 把连接串里的密码替换成 ***，用于日志与报告展示。 */
export function redactUrl(url: string): string {
  return url.replace(/:\/\/([^:]*):[^@]*@/, '://$1:***@');
}

export interface Config {
  repoRoot: string;
  /** 应用数据库连接串（已去掉 query string，可直接给 psql/pg_dump）。 */
  databaseUrl: string;
  /** 媒体（上传）目录。 */
  uploadsDir: string;
  /** 备份根目录。 */
  backupRoot: string;
  /** 演练中心自己的运行数据（账本/日志/隔离环境）。 */
  opsRoot: string;
  /** 隔离环境（临时库还原 + 媒体解压）的工作目录。 */
  sandboxRoot: string;
  /** 报告目录。 */
  reportDir: string;
  /** 账本（append-only 事件流）。 */
  ledgerFile: string;
  /** 运行锁。 */
  lockFile: string;
  /** 保留份数（按完成时间排序，多于此数的成功备份会被回收）。 */
  retentionCount: number;
  /** 保留天数；早于该天数的成功备份会被回收。 */
  retentionDays: number;
  /** 校验时媒体文件抽样个数；<=0 表示全量。 */
  verifySampleSize: number;
  /** 比对时媒体文件抽样个数；<=0 表示全量。 */
  compareSampleSize: number;
  /** 临时库名前缀。 */
  drillDbPrefix: string;
  /** 调度：备份 cron。 */
  backupCron: string;
  /** 调度：校验 cron（默认每天校验最新一份备份）。 */
  verifyCron: string;
  /** 调度：演练 cron（还原到隔离环境并比对）。 */
  drillCron: string;
  /** 错过时间窗后是否在启动时补跑一次。 */
  catchUp: boolean;
  /** 状态面板 HTTP 端口；<=0 表示不启动。 */
  httpPort: number;
  /** 状态面板绑定地址。 */
  httpHost: string;
  /** pg 客户端二进制所在目录（PATH 前缀）。 */
  pgBinPath: string;
  /** pg 服务端本地集群的 unix socket 目录（仅建隔离库时作为兜底参考）。 */
  pgSocketDir: string;
  /** API 就绪探针（备份前探活用，失败只告警不阻断）。 */
  healthUrl: string;
  /** 备份前是否要求 API 停止写入（false 时只告警；生产应配合低峰窗口）。 */
  requireQuiesce: boolean;
  /** 应用名。 */
  appName: string;
  timezone: string;
}

export const config: Config = {
  repoRoot: REPO_ROOT,
  databaseUrl: libpqUrl(str('DATABASE_URL', 'postgresql://heirloom:change-me-please@127.0.0.1:5432/heirloom')),
  uploadsDir: path.resolve(REPO_ROOT, str('STORAGE_ROOT', './data/uploads')),
  backupRoot: path.resolve(REPO_ROOT, str('BACKUP_ROOT', './data/backups')),
  opsRoot: path.resolve(REPO_ROOT, str('OPS_CENTER_ROOT', './data/ops-center')),
  get sandboxRoot() {
    return path.resolve(config.opsRoot, 'sandbox');
  },
  get reportDir() {
    return path.resolve(config.opsRoot, 'reports');
  },
  get ledgerFile() {
    return path.resolve(config.opsRoot, 'ledger.ndjson');
  },
  get lockFile() {
    return path.resolve(config.opsRoot, 'center.lock');
  },
  retentionCount: int('BACKUP_RETENTION_COUNT', 30),
  retentionDays: int('BACKUP_RETENTION_DAYS', 30),
  verifySampleSize: int('VERIFY_SAMPLE_SIZE', 50),
  compareSampleSize: int('DRILL_COMPARE_SAMPLE_SIZE', 50),
  drillDbPrefix: str('DRILL_DB_PREFIX', 'heirloom_drill_'),
  backupCron: str('BACKUP_CRON', '30 2 * * *'),
  verifyCron: str('VERIFY_CRON', '0 4 * * *'),
  drillCron: str('DRILL_CRON', '0 3 1 * *'),
  catchUp: str('SCHEDULE_CATCHUP', 'true') !== 'false',
  httpPort: int('OPS_HTTP_PORT', 4097),
  httpHost: str('OPS_HTTP_HOST', '127.0.0.1'),
  pgBinPath: str('PG_BIN_PATH', ''),
  pgSocketDir: str('PG_SOCKET_DIR', ''),
  healthUrl: str('HEALTH_URL', `http://127.0.0.1:${str('API_PORT', '4000')}/readyz`),
  requireQuiesce: str('BACKUP_REQUIRE_QUIESCE', 'false') === 'true',
  appName: str('APP_NAME', '家中物品来历册'),
  timezone: str('TZ', 'Asia/Shanghai'),
};

/** 把 PATH 环境变量前置 pgBinPath（如配置了）。 */
export function pgEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (config.pgBinPath) {
    env.PATH = `${config.pgBinPath}${path.delimiter}${env.PATH ?? ''}`;
  }
  if (config.pgSocketDir) {
    env.PGSOCKET = config.pgSocketDir;
  }
  return env;
}

/**
 * 只读连接环境：在 pgEnv 基础上加 default_transaction_read_only=on。
 * 演练中所有针对生产库的查询都走它，从机制上保证隔离环境任务不可能误写生产数据。
 */
export function pgReadOnlyEnv(): NodeJS.ProcessEnv {
  const env = pgEnv();
  // PGOPTIONS 的内容会被当作启动参数；libpq 支持 -c name=value。
  const extra = '-c default_transaction_read_only=on';
  env.PGOPTIONS = env.PGOPTIONS ? `${env.PGOPTIONS} ${extra}` : extra;
  return env;
}

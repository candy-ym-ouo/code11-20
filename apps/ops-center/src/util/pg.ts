/**
 * PostgreSQL 客户端封装：全部走 psql / pg_dump / pg_restore / createdb / dropdb，
 * 不引入数据库驱动，与现有 scripts/*.sh 的行为完全一致。
 */
import { execFile } from '../util/exec.js';
import { pgEnv, config, redactUrl } from '../config/index.js';

/** 把连接串末尾的库名替换成指定库。 */
export function urlForDatabase(database: string): string {
  return config.databaseUrl.replace(/\/[^/]*$/, `/${database}`);
}

function runPsql(
  url: string,
  sql: string,
  flags: string[] = [],
  env: NodeJS.ProcessEnv = pgEnv(),
): Promise<string> {
  // 连接串必须放在选项之前：`-tAc <url>` 会让 -c 把 URL 当成 SQL 吃掉
  return execFile('psql', [url, ...flags, '-v', 'ON_ERROR_STOP=1'], {
    env,
    input: sql,
    timeoutMs: 60_000,
  }).then((r) => {
    if (r.code !== 0) {
      throw new Error(`psql 失败（退出码 ${r.code}）：${r.stderr.trim() || r.stdout.trim()}`);
    }
    return r.stdout;
  });
}

/** 单值查询。 */
export async function queryScalar(
  sql: string,
  database?: string,
  env: NodeJS.ProcessEnv = pgEnv(),
): Promise<string> {
  const out = await runPsql(database ? urlForDatabase(database) : config.databaseUrl, sql, ['-t', '-A'], env);
  return out.trim();
}

/** 多行查询，返回按列切分的字符串行。 */
export async function queryRows(
  sql: string,
  database?: string,
  env: NodeJS.ProcessEnv = pgEnv(),
): Promise<string[][]> {
  const out = await runPsql(database ? urlForDatabase(database) : config.databaseUrl, sql, ['-t', '-A'], env);
  return out
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => l.split('|'));
}

/** 以未对齐的分隔格式查询：用 ASCII 单元分隔符 \x1f 分隔列，调用方自行 split。 */
export async function queryDelimited(
  sql: string,
  database?: string,
  env: NodeJS.ProcessEnv = pgEnv(),
): Promise<string[][]> {
  const out = await runPsql(database ? urlForDatabase(database) : config.databaseUrl, sql, ['-t', '-A'], env);
  return out
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => l.split(String.fromCharCode(31)));
}

export async function ping(database?: string): Promise<boolean> {
  try {
    const r = await execFile(
      'pg_isready',
      ['-d', database ? urlForDatabase(database) : config.databaseUrl],
      { env: pgEnv(), timeoutMs: 10_000 },
    );
    return r.code === 0;
  } catch {
    return false;
  }
}

export async function createDatabase(name: string): Promise<void> {
  const r = await execFile('createdb', ['--maintenance-db', config.databaseUrl, name], {
    env: pgEnv(),
    timeoutMs: 30_000,
  });
  if (r.code !== 0) throw new Error(`createdb ${name} 失败：${r.stderr.trim()}`);
}

export async function dropDatabaseIfExists(name: string): Promise<void> {
  const r = await execFile('dropdb', ['--if-exists', '--maintenance-db', config.databaseUrl, name], {
    env: pgEnv(),
    timeoutMs: 60_000,
  });
  if (r.code !== 0) throw new Error(`dropdb ${name} 失败：${r.stderr.trim()}`);
}

export interface DumpOptions {
  onOutput?: (stream: 'stdout' | 'stderr', line: string) => void;
}

/** pg_dump 自定义格式（-Fc），流式写文件。 */
export async function dumpCustom(outFile: string, options: DumpOptions = {}): Promise<void> {
  const { spawnToFile } = await import('../util/exec.js');
  const r = await spawnToFile('pg_dump', [config.databaseUrl, '-Fc'], outFile, {
    env: pgEnv(),
    timeoutMs: 1000 * 60 * 60,
    onOutput: options.onOutput,
  });
  if (r.code !== 0) throw new Error(`pg_dump 失败（退出码 ${r.code}）：${r.stderr.trim()}`);
}

/** pg_restore：stdin 喂 dump 文件，收集 stderr 告警。用于隔离库还原。 */
export async function restoreDumpFromStdin(
  dumpFile: string,
  database: string,
  clean = false,
): Promise<{ code: number; warnings: string }> {
  const { spawn } = await import('node:child_process');
  const { createReadStream } = await import('node:fs');
  const args = ['-d', urlForDatabase(database), '--no-owner', '--no-privileges'];
  if (clean) args.push('--clean', '--if-exists');
  return await new Promise((resolve, reject) => {
    const child = spawn('pg_restore', args, { env: pgEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, warnings: stderr }));
    createReadStream(dumpFile).pipe(child.stdin);
  });
}

export function describeTarget(): string {
  return redactUrl(config.databaseUrl);
}

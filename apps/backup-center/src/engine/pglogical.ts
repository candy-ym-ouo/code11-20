/**
 * PostgreSQL 只读逻辑层：表发现、表统计（行数 + 内容哈希）。
 * 使用 node-postgres，仅用于「比对」，真正的备份/还原走 pg_dump/pg_restore。
 *
 * 内容哈希：列按列名排序、每行 quote_nullable 后用 '|' 拼接，
 * 按同样的列序排序行，逐行 sha256 聚合。
 * 两个不同实例只要数据一致（与物理存储无关）即得到相同哈希。
 */
import { Client } from 'pg';
import { createHash } from 'node:crypto';

export async function connect(url: string): Promise<Client> {
  const client = new Client({ connectionString: url, statement_timeout: 600_000 });
  await client.connect();
  return client;
}

export interface TableInfo {
  schema: string;
  name: string;
  columns: string[];
}

/** 发现用户表（排除系统 schema） */
export async function discoverTables(client: Client, only?: string[]): Promise<TableInfo[]> {
  const res = await client.query<{ table_schema: string; table_name: string }>(
    `select table_schema, table_name
       from information_schema.tables
      where table_type = 'BASE TABLE'
        and table_schema not in ('pg_catalog','information_schema')
      order by table_schema, table_name`,
  );
  let tables = res.rows.map((r) => ({ schema: r.table_schema, name: r.table_name, columns: [] as string[] }));
  if (only && only.length > 0) {
    const set = new Set(only.map((t) => t.toLowerCase()));
    tables = tables.filter((t) => set.has(`${t.schema}.${t.name}`.toLowerCase()) || set.has(t.name.toLowerCase()));
  }
  for (const t of tables) {
    const cols = await client.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema=$1 and table_name=$2 order by ordinal_position`,
      [t.schema, t.name],
    );
    t.columns = cols.rows.map((c) => c.column_name);
  }
  return tables;
}

export interface TableStats {
  schema: string;
  table: string;
  rows: number;
  hash: string;
}

function quoteId(id: string): string {
  return '"' + id.replace(/"/g, '""') + '"';
}

function qualified(schema: string, table: string): string {
  return `${quoteId(schema)}.${quoteId(table)}`;
}

/**
 * 计算表统计：行数 + 内容哈希。
 * quote_nullable 在服务端把每个值规范化成可解析文本（NULL → NULL），
 * 行按全部列排序，保证跨实例可重复。
 */
export async function tableStats(client: Client, t: TableInfo): Promise<TableStats> {
  const q = qualified(t.schema, t.name);
  const sortedCols = [...t.columns].sort();
  const selectExpr =
    sortedCols.length > 0
      ? sortedCols.map((c) => `quote_nullable(${quoteId(c)})`).join(" || '|' || ")
      : 'NULL::text';

  // 按规范化后的行文本排序：行序与列顺序无关，两个实例得到相同哈希
  const res = await client.query<{ __row: string | null }>(
    `select __row from (select ${selectExpr} as __row from ${q}) __x order by __row`,
  );
  const hash = createHash('sha256');
  for (const r of res.rows) hash.update((r.__row ?? '') + '\n');
  return { schema: t.schema, table: t.name, rows: res.rows.length, hash: hash.digest('hex') };
}

export async function allStats(url: string, only?: string[]): Promise<TableStats[]> {
  const client = await connect(url);
  try {
    const tables = await discoverTables(client, only);
    const out: TableStats[] = [];
    for (const t of tables) out.push(await tableStats(client, t));
    return out.sort((a, b) => (`${a.schema}.${a.table}` < `${b.schema}.${b.table}` ? -1 : 1));
  } finally {
    await client.end().catch(() => undefined);
  }
}

export async function serverVersion(url: string): Promise<string> {
  const client = await connect(url);
  try {
    const r = await client.query<{ v: string }>('select version() as v');
    return r.rows[0]?.v ?? 'unknown';
  } finally {
    await client.end().catch(() => undefined);
  }
}

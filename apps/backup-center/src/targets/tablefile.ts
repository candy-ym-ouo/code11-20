/**
 * 「表文件」适配器：逻辑表 = 目录里的 <table>.jsonl（每行一个 JSON 对象）。
 * 完全不依赖数据库二进制，用于：
 *  1) 备份中心自身的端到端自检测试（在任何机器/CI 上都能跑）；
 *  2) 当机器没有 pg 客户端时，仍可对 JSONL/CSV 导出物做备份+演练；
 *  3) 当作新增数据源适配器的参考实现（契约最小集合）。
 */
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { CheckResult, Target } from '../types';
import type { BackupContext, BackupOutcome, DrillContext, DrillOutcome, TargetAdapter } from './adapter';
import { bytesLabel, sha256File } from '../util';

interface TableFingerprint {
  table: string;
  rows: number;
  hash: string;
  bytes: number;
}

const check = (id: string, label: string, verdict: CheckResult['verdict'], detail: string, rest?: Partial<CheckResult>): CheckResult =>
  ({ id, label, verdict, detail, ...rest });

export class TableFileAdapter implements TargetAdapter {
  kind = 'tablefile' as const;

  private async tablesOf(dir: string, only?: string[]): Promise<string[]> {
    if (!existsSync(dir)) return [];
    const all = (await readdir(dir)).filter((f) => f.endsWith('.jsonl')).sort();
    if (!only?.length) return all;
    const want = new Set(only.map((t) => (t.endsWith('.jsonl') ? t : `${t}.jsonl`).toLowerCase()));
    return all.filter((f) => want.has(f.toLowerCase()));
  }

  private async fingerprint(dir: string, files: string[]): Promise<TableFingerprint[]> {
    const out: TableFingerprint[] = [];
    for (const f of files) {
      const raw = await readFile(join(dir, f), 'utf8');
      const lines = raw.split('\n').filter(Boolean);
      const hash = createHash('sha256');
      for (const line of [...lines].sort()) hash.update(line + '\n');
      out.push({ table: f, rows: lines.length, hash: hash.digest('hex'), bytes: Buffer.byteLength(raw) });
    }
    return out;
  }

  async ping(target: Target): Promise<CheckResult> {
    const cfg = target.config as { dir: string };
    if (existsSync(cfg.dir)) {
      const files = await this.tablesOf(cfg.dir);
      return check('tf.ping', '表文件目录可访问', 'pass', `${files.length} 张逻辑表 · ${cfg.dir}`);
    }
    return check('tf.ping', '表文件目录可访问', 'fail', `目录不存在：${cfg.dir}`);
  }

  async backup(target: Target, ctx: BackupContext): Promise<BackupOutcome> {
    const cfg = target.config as { dir: string; tables?: string[] };
    await mkdir(ctx.dir, { recursive: true });
    const checks: CheckResult[] = [];
    const files = await this.tablesOf(cfg.dir, cfg.tables);
    if (files.length === 0) throw new Error(`目录下没有 *.jsonl 逻辑表：${cfg.dir}`);

    const fps = await this.fingerprint(cfg.dir, files);
    const totalBytes = fps.reduce((s, t) => s + t.bytes, 0);
    const totalRows = fps.reduce((s, t) => s + t.rows, 0);

    // 逐文件复制（原子内容），并校验复制后的哈希
    let copied = 0;
    for (const f of files) {
      const src = join(cfg.dir, f);
      const dst = join(ctx.dir, f);
      await cp(src, dst);
      if ((await sha256File(src)) === (await sha256File(dst))) copied += 1;
    }
    checks.push(check('tf.copy', '逐表复制并立即校验 sha256', copied === files.length ? 'pass' : 'fail', `${copied}/${files.length} 张表一致`, { expected: files.length, actual: copied }));

    // 每行 JSON 合法性
    let badJson = 0;
    for (const f of files) {
      const raw = await readFile(join(cfg.dir, f), 'utf8');
      for (const line of raw.split('\n').filter(Boolean)) {
        try {
          JSON.parse(line);
        } catch {
          badJson += 1;
        }
      }
    }
    checks.push(check('tf.json', '每行 JSON 合法性', badJson === 0 ? 'pass' : 'fail', `非法行 ${badJson} 个`, { expected: 0, actual: badJson }));

    await writeFile(join(ctx.dir, 'fingerprint.json'), JSON.stringify(fps, null, 2));
    const artifacts = [];
    for (const f of [...files, 'fingerprint.json']) {
      artifacts.push({ name: f, path: f, bytes: (await (await import('node:fs/promises')).stat(join(ctx.dir, f))).size, sha256: await sha256File(join(ctx.dir, f)) });
    }

    return {
      sourceFingerprint: { tables: fps, tableCount: fps.length, totalRows, totalBytes },
      artifacts,
      checks,
      toolchain: { format: 'jsonl' },
    };
  }

  async drill(target: Target, ctx: DrillContext): Promise<DrillOutcome> {
    const cfg = target.config as { dir: string; tables?: string[] };
    void cfg;
    const checks: CheckResult[] = [];
    const fps = JSON.parse(await readFile(join(ctx.backupDir, 'fingerprint.json'), 'utf8')) as TableFingerprint[];
    const restoreDir = join(ctx.sandboxRoot, 'restored-tables');
    await mkdir(restoreDir, { recursive: true });

    let restored = 0;
    for (const fp of fps) {
      const from = join(ctx.backupDir, fp.table);
      if (existsSync(from)) {
        await cp(from, join(restoreDir, fp.table));
        restored += 1;
      }
    }
    checks.push(check('tf.restore', '还原到隔离目录', restored === fps.length ? 'pass' : 'fail', `${restored}/${fps.length} 张表`, { expected: fps.length, actual: restored }));

    const now = await this.fingerprint(restoreDir, fps.map((f) => f.table));
    const by = new Map(now.map((t) => [t.table, t]));
    let bad = 0;
    const detail: string[] = [];
    for (const fp of fps) {
      const s = by.get(fp.table);
      if (!s) {
        bad += 1;
        detail.push(`- 缺少表 ${fp.table}`);
      } else if (s.rows !== fp.rows || s.hash !== fp.hash) {
        bad += 1;
        detail.push(`- ${fp.table} 不一致（${fp.rows}→${s.rows} 行）`);
      }
    }
    checks.push(check('tf.compare', '逐表行数 + 内容哈希比对', bad === 0 ? 'pass' : 'fail', bad === 0 ? `${fps.length} 张表全部一致（${bytesLabel(fps.reduce((s, f) => s + f.bytes, 0))}）` : detail.join('\n'), { expected: fps.length, actual: fps.length - bad }));

    return { checks, sandbox: { kind: 'tablefile', location: restoreDir }, toolchain: { format: 'jsonl' } };
  }
}

/**
 * 媒体目录适配器（图片/音频/PDF 等文件备份）。
 *
 * backup：递归遍历源目录 → 逐文件 sha256 → 生成文件清单 files.jsonl
 *         → 纯 Node 打成 uploads.tar.gz（带 gzip CRC 与 tar 结构，
 *           与系统 tar 产出的包格式兼容）。
 * 完整性：tar.gz 解包后逐文件与清单比 sha256 + 大小；抽样比例可配。
 * drill ：解包到沙箱目录（路径穿越防护）→ 清单比对（全量或抽样）
 *         → 再抽样比对当前源目录，标注备份后新增/改动的文件。
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { CheckResult, Target } from '../types';
import type { BackupContext, BackupOutcome, DrillContext, DrillOutcome, TargetAdapter } from './adapter';
import { createTarGz, extractTarGz } from '../engine/tar';
import { bytesLabel, sha256File, walkFiles } from '../util';

const check = (id: string, label: string, verdict: CheckResult['verdict'], detail: string, rest?: Partial<CheckResult>): CheckResult =>
  ({ id, label, verdict, detail, ...rest });

interface FileEntry {
  path: string;
  size: number;
  sha256: string;
}

export class MediaAdapter implements TargetAdapter {
  kind = 'media' as const;

  async ping(target: Target): Promise<CheckResult> {
    const cfg = target.config as { dir: string };
    if (existsSync(cfg.dir)) {
      const files = await walkFiles(cfg.dir);
      const bytes = files.reduce((s, f) => s + f.stat.size, 0);
      return check('media.ping', '媒体目录可访问', 'pass', `${files.length} 个文件 · ${bytesLabel(bytes)} · ${cfg.dir}`);
    }
    return check('media.ping', '媒体目录可访问', 'fail', `目录不存在：${cfg.dir}`);
  }

  async backup(target: Target, ctx: BackupContext): Promise<BackupOutcome> {
    const cfg = target.config as { dir: string };
    await mkdir(ctx.dir, { recursive: true });
    const checks: CheckResult[] = [];

    if (!existsSync(cfg.dir)) throw new Error(`媒体目录不存在：${cfg.dir}`);

    // 1. 清单
    const files = await walkFiles(cfg.dir);
    const entries: FileEntry[] = [];
    for (const f of files) {
      entries.push({ path: f.rel, size: f.stat.size, sha256: await sha256File(f.abs) });
    }
    entries.sort((a, b) => (a.path < b.path ? -1 : 1));
    const manifestFile = join(ctx.dir, 'files.jsonl');
    await writeFile(manifestFile, entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''));

    const totalBytes = entries.reduce((s, e) => s + e.size, 0);
    const listHash = createHash('sha256').update(entries.map((e) => `${e.sha256} ${e.size} ${e.path}`).join('\n')).digest('hex');
    checks.push(
      check('media.manifest', '源目录文件清单', 'pass', `${entries.length} 个文件 · ${bytesLabel(totalBytes)} · 清单哈希 ${listHash.slice(0, 16)}…`),
    );

    // 2. 打包
    ctx.events.append({ runId: ctx.runId, targetId: target.id, stage: 'backup', event: 'media.tar', data: { entries: entries.length } });
    const t0 = Date.now();
    const archive = join(ctx.dir, 'uploads.tar.gz');
    const packed = await createTarGz(cfg.dir, archive);
    const archStat = await (await import('node:fs/promises')).stat(archive);
    checks.push(
      check('media.pack', '打包 uploads.tar.gz', 'pass', `${packed.entries} 个条目 · 压缩包 ${bytesLabel(archStat.size)} · ${Date.now() - t0} ms`),
    );

    // 3. 立刻解包到临时目录，验证 tar.gz 自身结构完整（在备份阶段就抓损坏）
    const selfCheckDir = join(ctx.dir, '.selfcheck');
    const extracted = await extractTarGz(archive, selfCheckDir);
    const selfFiles = await walkFiles(selfCheckDir);
    const okStruct = extracted.length === entries.length && selfFiles.length === entries.length;
    checks.push(
      check(
        'media.archive.structure',
        '备份包结构自校验（立即解包）',
        okStruct ? 'pass' : 'fail',
        `期望 ${entries.length} 个条目，解包得到 ${extracted.length} 个`,
        { expected: entries.length, actual: extracted.length },
      ),
    );
    await (await import('node:fs/promises')).rm(selfCheckDir, { recursive: true, force: true });

    const artifacts = [
      { name: 'uploads.tar.gz', path: 'uploads.tar.gz', bytes: archStat.size, sha256: await sha256File(archive) },
      { name: 'files.jsonl', path: 'files.jsonl', bytes: (await (await import('node:fs/promises')).stat(manifestFile)).size, sha256: await sha256File(manifestFile) },
    ];

    return {
      sourceFingerprint: {
        fileCount: entries.length,
        totalBytes,
        listSha256: listHash,
        files: entries,
      },
      artifacts,
      checks,
      toolchain: { packer: 'node-tar/ustar+gzip' },
    };
  }

  async drill(target: Target, ctx: DrillContext): Promise<DrillOutcome> {
    const cfg = target.config as { dir: string; sampleRatio?: number };
    const archive = join(ctx.backupDir, 'uploads.tar.gz');
    const manifestFile = join(ctx.backupDir, 'files.jsonl');
    const checks: CheckResult[] = [];
    const ratio = cfg.sampleRatio ?? 1;

    if (!existsSync(archive)) throw new Error('备份中缺少 uploads.tar.gz');
    const entries: FileEntry[] = (await readFile(manifestFile, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as FileEntry);
    const byPath = new Map(entries.map((e) => [e.path, e]));

    // 1. 解包到沙箱
    const restoreDir = join(ctx.sandboxRoot, 'restored-media');
    const extracted = await extractTarGz(archive, restoreDir);
    checks.push(
      check('media.restore', '还原到隔离目录', 'pass', `解包 ${extracted.length} 个文件至沙箱（路径穿越防护已启用）`),
    );

    // 2. 清单选择：小目录全量；大目录按比例抽样（至少抽 1 个）
    const want = entries.length === 0 ? 0 : Math.max(1, Math.min(entries.length, Math.ceil(entries.length * ratio)));
    const sample = ratio >= 1 ? entries : deterministicSample(entries, want);
    let missing = 0;
    let hashMismatch = 0;
    let sizeMismatch = 0;
    const bad: string[] = [];
    for (const e of sample) {
      const abs = join(restoreDir, e.path);
      if (!existsSync(abs)) {
        missing += 1;
        bad.push(`- 缺失：${e.path}`);
        continue;
      }
      const st = await (await import('node:fs/promises')).stat(abs);
      if (st.size !== e.size) {
        sizeMismatch += 1;
        bad.push(`- 大小不符：${e.path}（期望 ${e.size}，实际 ${st.size}）`);
      }
      const h = await sha256File(abs);
      if (h !== e.sha256) {
        hashMismatch += 1;
        bad.push(`- 哈希不符：${e.path}`);
      }
    }
    const verdict: CheckResult['verdict'] = missing + hashMismatch + sizeMismatch === 0 ? 'pass' : 'fail';
    checks.push(
      check(
        'media.compare.hash',
        `还原文件完整性（sha256，${ratio >= 1 ? '全量' : `抽样 ${want}/${entries.length}`}）`,
        verdict,
        `校验 ${sample.length} 个：缺失 ${missing} / 哈希不符 ${hashMismatch} / 大小不符 ${sizeMismatch}` +
          (bad.length ? '\n' + bad.slice(0, 20).join('\n') : ''),
        { expected: entries.length, actual: sample.length - missing - hashMismatch },
      ),
    );

    // 3. 沙箱中不应有清单外的文件（多出来通常意味着打包/解包错位）
    const restoredFiles = await walkFiles(restoreDir);
    const extra = restoredFiles.filter((f) => !byPath.has(f.rel)).length;
    checks.push(
      check('media.compare.extra', '还原目录无多余文件', extra === 0 ? 'pass' : 'fail', `清单外文件 ${extra} 个`, {
        expected: 0,
        actual: extra,
      }),
    );

    // 4. 与当前源目录对比，标注备份后漂移（新增/改动），这不是还原失败
    if (existsSync(cfg.dir)) {
      const liveFiles = await walkFiles(cfg.dir);
      let changed = 0;
      let added = 0;
      const drift: string[] = [];
      // 大目录下只对「抽样命中的文件」算源漂移，避免全量重算
      const sampleSet = new Set(sample.map((e) => e.path));
      for (const f of liveFiles) {
        const e = byPath.get(f.rel);
        if (!e) {
          added += 1;
          if (drift.length < 15) drift.push(`- 备份后新增：${f.rel}`);
          continue;
        }
        if (sampleSet.has(f.rel)) {
          const h = await sha256File(f.abs);
          if (h !== e.sha256) {
            changed += 1;
            if (drift.length < 15) drift.push(`- 备份后改动：${f.rel}`);
          }
        }
      }
      checks.push(
        check(
          'media.compare.drift',
          '源目录自备份以来的漂移（仅供参考）',
          added + changed === 0 ? 'pass' : 'warn',
          added + changed === 0
            ? '无漂移'
            : `新增 ${added} / 抽样中改动 ${changed}\n${drift.join('\n')}`,
        ),
      );
    }

    return {
      checks,
      sandbox: { kind: 'media', location: relative(process.cwd(), restoreDir) || restoreDir, kept: false },
      toolchain: { unpacker: 'node-tar/ustar+gunzip' },
    };
  }
}

/** 可重复的抽样：按清单哈希做步长，保证同一份备份每次抽到同一批文件 */
function deterministicSample(entries: FileEntry[], want: number): FileEntry[] {
  if (want >= entries.length) return entries;
  const step = entries.length / want;
  const out: FileEntry[] = [];
  const seen = new Set<number>();
  for (let i = 0; i < want; i++) {
    const idx = Math.floor(i * step) % entries.length;
    if (!seen.has(idx)) {
      seen.add(idx);
      out.push(entries[idx]!);
    }
  }
  return out;
}

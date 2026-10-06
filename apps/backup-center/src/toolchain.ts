/**
 * 工具链定位：统一决定 pg_dump/pg_restore/psql/createdb 与 libpq 的位置。
 * 查找顺序：PG_BIN_DIR 环境变量 → PATH → 项目内 tools/pg（从官方 deb 解压的免安装客户端）。
 * 找不到时不立即报错：tablefile 目标不需要任何 pg 工具。
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface PgToolchain {
  binDir: string;
  libDir?: string;
  version: string;
}

export const PG_TOOLS = ['pg_dump', 'pg_restore', 'psql', 'createdb', 'dropdb', 'pg_isready'] as const;
export type PgToolName = (typeof PG_TOOLS)[number];

const EXE = process.platform === 'win32' ? '.exe' : '';

function onPath(name: string): boolean {
  const dirs = (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':');
  return dirs.some((d) => existsSync(join(d, name + EXE)));
}

function projectLocalBin(): { binDir: string; libDir?: string } | null {
  // dist/（编译）或 src/（tsx）都在 apps/backup-center 下，向上 4 级到仓库根
  const here = __dirname;
  const roots = [
    join(here, '..', '..', '..', '..'), // dist/engine 或 src/engine 等深一层时
    join(here, '..', '..', '..'), // dist/ 或 src/ 直接位于 apps/backup-center
  ];
  const candidatesRoots = [...new Set(roots)];
  const candidates: string[] = [];
  for (const r of candidatesRoots) {
    candidates.push(join(r, 'tools', 'pg', 'usr', 'lib', 'postgresql', '18', 'bin'));
    candidates.push(join(r, 'tools', 'pg', 'usr', 'lib', 'postgresql', '16', 'bin'));
  }
  const binDir = candidates.find((d) => existsSync(join(d, 'pg_dump' + EXE)));
  if (!binDir) return null;
  const libDir = candidatesRoots
    .flatMap((r) => [join(r, 'tools', 'pg', 'usr', 'lib', 'aarch64-linux-gnu'), join(r, 'tools', 'pg', 'usr', 'lib', 'x86_64-linux-gnu')])
    .find((d) => existsSync(join(d, 'libpq.so.5')));
  return { binDir, libDir };
}

let cached: PgToolchain | null | undefined;

export function findPgToolchain(): PgToolchain | null {
  if (cached !== undefined) return cached;
  let binDir: string | undefined;
  let libDir: string | undefined;

  if (process.env.PG_BIN_DIR && existsSync(join(process.env.PG_BIN_DIR, 'pg_dump' + EXE))) {
    binDir = process.env.PG_BIN_DIR;
    libDir = process.env.PG_LIB_DIR;
  } else if (onPath('pg_dump') && onPath('pg_restore')) {
    binDir = ''; // 空串表示直接用 PATH
  } else {
    const local = projectLocalBin();
    if (local) {
      binDir = local.binDir;
      libDir = local.libDir;
    }
  }

  if (!binDir && binDir !== '') {
    cached = null;
    return null;
  }
  const env = { ...process.env };
  if (libDir) env.LD_LIBRARY_PATH = `${libDir}:${env.LD_LIBRARY_PATH ?? ''}`;
  let version = 'unknown';
  try {
    version = execFileSync(binDir ? join(binDir, 'pg_dump') : 'pg_dump', ['--version'], { env })
      .toString()
      .trim();
  } catch {
    cached = null;
    return null;
  }
  const tc: PgToolchain = { binDir, libDir, version };
  cached = tc;
  return tc;
}

export function pgToolPath(tc: PgToolchain, name: PgToolName): string {
  return tc.binDir ? join(tc.binDir, name + EXE) : name + EXE;
}

/** 调用 pg 工具时应使用的环境（主要是把解压版 libpq 加进库搜索路径） */
export function pgEnv(tc: PgToolchain): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (tc.libDir) env.LD_LIBRARY_PATH = `${tc.libDir}:${env.LD_LIBRARY_PATH ?? ''}`;
  return env;
}

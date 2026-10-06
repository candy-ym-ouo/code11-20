/** 子进程执行辅助：统一捕获 stdout/stderr，超时报错，便于记录工具链产物。 */
import { execFile, type ExecFileOptions } from 'node:child_process';

export interface ProcResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function runProc(
  bin: string,
  args: string[],
  options: ExecFileOptions & { timeoutMs?: number } = {},
): Promise<ProcResult> {
  const { timeoutMs, ...opts } = options;
  return new Promise((resolve, reject) => {
    const child = execFile(
      bin,
      args,
      { maxBuffer: 64 * 1024 * 1024, ...opts },
      (err, stdout, stderr) => {
        const out = stdout.toString();
        const serr = stderr.toString();
        // pg_restore 这类工具即使成功也可能以非零码退出并只输出告警，
        // 所以把 code 交回调用方判断，只有「进程起不来」才 reject。
        if (err && (err as NodeJS.ErrnoException).code && (err as NodeJS.ErrnoException).code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            reject(new Error(`找不到可执行文件：${bin}`));
            return;
          }
        }
        if (err && typeof (err as { code?: number }).code === 'number') {
          resolve({ code: (err as { code: number }).code, stdout: out, stderr: serr });
          return;
        }
        if (err) {
          reject(Object.assign(err, { stdout: out, stderr: serr }));
          return;
        }
        resolve({ code: 0, stdout: out, stderr: serr });
      },
    );
    if (timeoutMs) {
      const t = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
      child.on('exit', () => clearTimeout(t));
    }
  });
}

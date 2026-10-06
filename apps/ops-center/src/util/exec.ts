/** 子进程执行：统一 env、超时与输出捕获（输出会进运行日志，便于追溯）。 */
import { spawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import type { Readable, Writable } from 'node:stream';

/** stdio: pipe 三通道时的进程类型。 */
type FullPipeChild = ChildProcessByStdio<Writable, Readable, Readable>;
/** stdio: ignore 入站、pipe 出站时的进程类型。 */
type InIgnoreChild = ChildProcessByStdio<null, Readable, Readable>;

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  command: string;
  durationMs: number;
}

export interface ExecOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  timeoutMs?: number;
  /** 每收到一行输出回调一次（用于实时写运行日志）。 */
  onOutput?: (stream: 'stdout' | 'stderr', line: string) => void;
  input?: string;
}

export function execFile(
  file: string,
  args: readonly string[],
  options: ExecOptions = {},
): Promise<ExecResult> {
  const started = Date.now();
  const command = [file, ...args].join(' ');
  return new Promise((resolve, reject) => {
    let child: FullPipeChild;
    try {
      child = spawn(file, args, {
        env: options.env ?? process.env,
        cwd: options.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
      }) as FullPipeChild;
    } catch (err) {
      reject(err);
      return;
    }

    let stdout = '';
    let stderr = '';
    let timer: NodeJS.Timeout | undefined;
    let timedOut = false;
    let settled = false;

    const pipeLines = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
      const text = chunk.toString();
      if (stream === 'stdout') stdout += text;
      else stderr += text;
      if (options.onOutput) {
        for (const line of text.split(/\r?\n/)) {
          if (line.length > 0) options.onOutput(stream, line);
        }
      }
    };

    child.stdout.on('data', (c: Buffer) => pipeLines('stdout', c));
    child.stderr.on('data', (c: Buffer) => pipeLines('stderr', c));
    child.on('error', (err) => {
      if (!settled) {
        settled = true;
        if (timer) clearTimeout(timer);
        reject(err);
      }
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`命令超时（${options.timeoutMs}ms）被终止：${command}`));
        return;
      }
      resolve({
        code: code ?? -1,
        stdout,
        stderr,
        command,
        durationMs: Date.now() - started,
      });
    });

    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();

    if (options.timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, options.timeoutMs);
      timer.unref?.();
    }
  });
}

/** 流式执行：stdout 直接进文件（用于 pg_dump 这类大输出），不占内存。 */
export function spawnToFile(
  file: string,
  args: readonly string[],
  outFile: string,
  options: ExecOptions = {},
): Promise<ExecResult> {
  const started = Date.now();
  const command = `${[file, ...args].join(' ')} > ${outFile}`;
  return new Promise((resolve, reject) => {
    const out = createWriteStream(outFile);
    let child: InIgnoreChild;
    try {
      child = spawn(file, args, {
        env: options.env ?? process.env,
        cwd: options.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      }) as InIgnoreChild;
    } catch (err) {
      out.close();
      reject(err);
      return;
    }
    let stderr = '';
    let settled = false;
    let exitCode: number | null = null;
    let outFinished = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = () => {
      if (settled || !outFinished || exitCode === null) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code: exitCode, stdout: '', stderr, command, durationMs: Date.now() - started });
    };

    child.stdout.pipe(out);
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString();
      options.onOutput?.('stderr', c.toString().trimEnd());
    });
    child.on('error', (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    out.on('error', (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    out.on('finish', () => {
      outFinished = true;
      finish();
    });
    child.on('close', (code) => {
      exitCode = code ?? -1;
      finish();
    });
    if (options.timeoutMs) {
      timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs);
      timer.unref?.();
    }
  });
}

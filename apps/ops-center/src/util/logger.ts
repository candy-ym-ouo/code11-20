/**
 * 结构化日志：stderr 输出人类可读行，同时通过 emitter 让 Run 可以捕获到报告里。
 * 不引入 pino 等依赖，保持运维工具零依赖、可直接 node 运行。
 */
type Level = 'debug' | 'info' | 'warn' | 'error';

type LogSink = (entry: { ts: string; level: Level; msg: string; meta?: unknown }) => void;

const sinks = new Set<LogSink>();

export function addSink(sink: LogSink): () => void {
  sinks.add(sink);
  return () => sinks.delete(sink);
}

const COLORS: Record<Level, string> = {
  debug: '\x1b[90m',
  info: '\x1b[1m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
};

function emit(level: Level, msg: string, meta?: unknown): void {
  const entry = { ts: new Date().toISOString(), level, msg, meta };
  if (level !== 'debug' || process.env.LOG_LEVEL === 'debug') {
    const tag = level === 'info' ? new Date().toTimeString().slice(0, 8) : level;
    const line = `${COLORS[level]}[${tag}]\x1b[0m ${msg}`;
    if (level === 'error') process.stderr.write(`${line}\n`);
    else process.stderr.write(`${line}\n`);
  }
  for (const sink of sinks) {
    try {
      sink(entry);
    } catch {
      /* sink 失败不影响主流程 */
    }
  }
}

export const log = {
  debug: (msg: string, meta?: unknown) => emit('debug', msg, meta),
  info: (msg: string, meta?: unknown) => emit('info', msg, meta),
  warn: (msg: string, meta?: unknown) => emit('warn', msg, meta),
  error: (msg: string, meta?: unknown) => emit('error', msg, meta),
};

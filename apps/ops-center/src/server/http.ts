/**
 * 状态面板（只读 HTTP）：
 *   GET /healthz        存活探针
 *   GET /readyz         账本可读 + 最近一次调度任务状态
 *   GET /api/status     汇总 JSON（最近运行/计划/账本完整性/磁盘占用）
 *   GET /api/runs       运行列表
 *   GET /api/runs/:id   单次运行详情（聚合账本事件）
 *   GET /api/backups    磁盘上的备份清单
 *   GET /reports/<file> 下载报告（仅允许报告目录内文件）
 * 只绑定 127.0.0.1，不对外暴露；不提供任何写操作。
 */
import http from 'node:http';
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { config } from '../config/index.js';
import type { Ledger } from '../storage/ledger.js';
import type { Scheduler } from '../scheduler/index.js';
import { findBackups } from '../tasks/verify.js';
import { describeCron } from '../scheduler/cron.js';

interface Deps {
  ledger: Ledger;
  scheduler?: Scheduler;
}

function json(res: http.ServerResponse, code: number, body: unknown): void {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(text);
}

function diskSummary(dir: string): { exists: boolean; bytes?: number; backups?: number } {
  if (!existsSync(dir)) return { exists: false };
  let bytes = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    for (const f of readdirSync(path.join(dir, entry.name))) {
      try {
        bytes += statSync(path.join(dir, entry.name, f)).size;
      } catch {
        /* ignore */
      }
    }
  }
  return { exists: true, bytes, backups: readdirSync(dir).length };
}

export function createServer({ ledger, scheduler }: Deps): http.Server {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const p = url.pathname;

    if (req.method !== 'GET') {
      json(res, 405, { error: '只读面板，仅支持 GET' });
      return;
    }

    if (p === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
      return;
    }

    if (p === '/readyz') {
      const integrity = ledger.integrity();
      const ok = integrity.corrupted.length === 0;
      res.writeHead(ok ? 200 : 500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok, ledger: integrity }));
      return;
    }

    if (p === '/api/status') {
      const runs = ledger.runs();
      const latest = (k: string) => runs.find((r) => r.kind === k);
      json(res, 200, {
        service: '@heirloom/ops-center',
        time: new Date().toISOString(),
        schedules: [
          { job: 'backup', ...scheduleInfo(config.backupCron) },
          { job: 'verify', ...scheduleInfo(config.verifyCron) },
          { job: 'drill', ...scheduleInfo(config.drillCron) },
        ],
        schedulerRunning: Boolean(scheduler),
        latest: {
          backup: summarize(latest('backup')),
          verify: summarize(latest('verify')),
          drill: summarize(latest('drill')),
        },
        ledger: {
          file: config.ledgerFile,
          integrity: ledger.integrity(),
          runCount: runs.length,
        },
        backupDisk: diskSummary(config.backupRoot),
        reports: readdirSync(config.reportDir, { withFileTypes: true })
          .flatMap((d) => (d.isDirectory() ? [] : [d.name]))
          .filter((n) => n.endsWith('.md'))
          .sort()
          .reverse()
          .slice(0, 20),
      });
      return;
    }

    if (p === '/api/runs') {
      json(res, 200, ledger.runs().map((r) => summarize(r)));
      return;
    }

    const runMatch = p.match(/^\/api\/runs\/([\w-]+)$/);
    if (runMatch) {
      const run = ledger.runs().find((r) => r.runId === runMatch![1]);
      if (!run) {
        json(res, 404, { error: '运行不存在' });
        return;
      }
      json(res, 200, run);
      return;
    }

    if (p === '/api/backups') {
      json(
        res,
        200,
        findBackups().map((d) => ({
          dir: d,
          done: existsSync(path.join(d, 'DONE')),
          mtime: statSync(d).mtime,
        })),
      );
      return;
    }

    if (p.startsWith('/reports/')) {
      const name = decodeURIComponent(p.slice('/reports/'.length));
      // 先规范化并限定在报告目录内，防止 ../ 路径穿越
      const root = path.resolve(config.reportDir);
      const file = path.resolve(root, name);
      if (!file.startsWith(root + path.sep) || !existsSync(file)) {
        json(res, 404, { error: '报告不存在' });
        return;
      }
      const contentType = file.endsWith('.json')
        ? 'application/json'
        : file.endsWith('.sha256')
          ? 'text/plain'
          : 'text/markdown; charset=utf-8';
      res.writeHead(200, { 'content-type': contentType });
      createReadStream(file).pipe(res);
      return;
    }

    if (p === '/' || p === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(dashboardHtml());
      return;
    }

    json(res, 404, { error: 'not found', paths: ['/api/status', '/api/runs', '/api/backups'] });
  });
  return server;
}

function scheduleInfo(cron: string): { cron: string; next: string | null; error?: string } {
  try {
    return { cron, next: describeCron(cron, config.timezone) };
  } catch (err) {
    return { cron, next: null, error: (err as Error).message };
  }
}

function summarize(run?: ReturnType<Ledger['runs']>[number]) {
  if (!run) return null;
  return {
    runId: run.runId,
    kind: run.kind,
    status: run.status,
    trigger: run.trigger,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    durationMs: run.durationMs,
    checks: run.checks.length,
    failures: run.checks.filter((c) => !c.ok).length,
    backupDir: run.backupDir,
  };
}

function dashboardHtml(): string {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>备份编排与演练中心</title>
<style>
  body{font:14px/1.6 -apple-system,"PingFang SC",sans-serif;margin:24px;color:#1f2328;background:#f6f8fa}
  h1{font-size:20px} .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:16px 0}
  .card{background:#fff;border:1px solid #d0d7de;border-radius:8px;padding:14px}
  .ok{color:#1a7f37}.bad{color:#cf222e}.warn{color:#9a6700}.mut{color:#656d76}
  table{border-collapse:collapse;width:100%;background:#fff;border-radius:8px;overflow:hidden}
  th,td{border-bottom:1px solid #d8dee4;padding:6px 10px;text-align:left;font-size:13px}
  code{background:#eff1f3;padding:1px 5px;border-radius:4px}
</style></head><body>
<h1>备份编排与演练中心</h1>
<p class="mut">只读面板 · 数据来自 append-only 哈希链账本 · 每 10 秒刷新</p>
<div class="grid" id="cards"><p>加载中…</p></div>
<h2>最近运行</h2><table id="runs"><thead><tr><th>运行</th><th>类型</th><th>状态</th><th>触发</th><th>开始</th><th>耗时</th><th>检查</th><th>备份</th></tr></thead><tbody></tbody></table>
<p><a href="/api/status">/api/status</a> · <a href="/api/runs">/api/runs</a> · <a href="/api/backups">/api/backups</a></p>
<script>
const esc=s=>String(s??'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const badge=s=>({'success':'<span class=ok>✅ 通过</span>','failed':'<span class=bad>❌ 失败</span>','partial':'<span class=warn>⚠️ 部分</span>','running':'<span class=mut>⏳ 进行中</span>'}[s]||s);
async function load(){
  const s=await (await fetch('/api/status')).json();
  const kinds=[['backup','备份'],['verify','校验'],['drill','演练']];
  document.getElementById('cards').innerHTML=kinds.map(([k,label])=>{
    const r=s.latest[k];
    return '<div class=card><b>'+label+'</b><br>'+(r?badge(r.status)+' <span class=mut>'+(r.finishedAt||r.startedAt).slice(0,19).replace('T',' ')+'</span><br><span class=mut>检查 '+(r.checks-r.failures)+'/'+r.checks+'</span>':'<span class=mut>尚无记录</span>')+'</div>';
  }).join('');
  const runs=(await (await fetch('/api/runs')).json()).slice(0,20);
  document.querySelector('#runs tbody').innerHTML=runs.map(r=>'<tr><td><code>'+esc(r.runId.slice(-12))+'</code></td><td>'+r.kind+'</td><td>'+badge(r.status)+'</td><td>'+r.trigger+'</td><td class=mut>'+esc(String(r.startedAt).slice(0,19).replace('T',' '))+'</td><td>'+(r.durationMs?(r.durationMs/1000).toFixed(1)+'s':'-')+'</td><td>'+(r.checks-r.failures)+'/'+r.checks+'</td><td class=mut>'+esc(r.backupDir?r.backupDir.split('/').pop():'')+'</td></tr>').join('');
}
load();setInterval(load,10000);
</script></body></html>`;
}

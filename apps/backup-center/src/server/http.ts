/**
 * 内置 HTTP 服务：只读看板 + JSON API + 手动触发。
 * 不引入 express，直接用 node:http（路由少、依赖为零）。
 *
 * 路由：
 *   GET  /                      HTML 看板（单文件，无外部资源）
 *   GET  /healthz               存活
 *   GET  /api/status            目标、计划、最近运行、下一次触发
 *   GET  /api/runs              运行列表
 *   GET  /api/runs/:id          单次运行详情
 *   GET  /api/runs/:id/report/:file  下载 Markdown 报告（路径限定在 run 目录）
 *   GET  /api/runs/:id/verify   校验该 run 的事件哈希链
 *   POST /api/run               手动执行 {targetIds?, stages?}
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, normalize } from 'node:path';
import type { Orchestrator } from '../orchestrator';
import type { ConfigService } from '../configService';
import { CronExpr } from '../scheduler';
import type { StateStore } from '../state';

export interface ServerDeps {
  orchestrator: Orchestrator;
  config: ConfigService;
  store: StateStore;
  port: number;
}

export function startServer(deps: ServerDeps): Server {
  const { orchestrator, config, store, port } = deps;

  const json = (res: ServerResponse, code: number, body: unknown): void => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  };

  const readBody = (req: IncomingMessage): Promise<string> =>
    new Promise((resolve, reject) => {
      let data = '';
      req.on('data', (c) => {
        data += c;
        if (data.length > 1e6) reject(new Error('请求体过大'));
      });
      req.on('end', () => resolve(data));
      req.on('error', reject);
    });

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      const p = url.pathname;

      if (req.method === 'GET' && p === '/healthz') return json(res, 200, { ok: true });

      if (req.method === 'GET' && p === '/api/status') {
        const cfg = store.loadConfig();
        const runs = await store.listRuns();
        const upcoming: unknown[] = [];
        for (const plan of cfg.plans.filter((x) => x.enabled)) {
          if (plan.backupCron) upcoming.push({ targetId: plan.targetId, kind: 'backup', cron: plan.backupCron, next: new CronExpr(plan.backupCron).nextAfter().toISOString() });
          if (plan.drillCron) upcoming.push({ targetId: plan.targetId, kind: 'drill', cron: plan.drillCron, next: new CronExpr(plan.drillCron).nextAfter().toISOString() });
        }
        upcoming.sort((a, b) => String((a as { next: string }).next).localeCompare(String((b as { next: string }).next)));
        return json(res, 200, {
          targets: cfg.targets,
          plans: cfg.plans,
          upcoming,
          latestRuns: runs.slice(0, 10).map((r) => ({
            id: r.id,
            status: r.status,
            startedAt: r.startedAt,
            finishedAt: r.finishedAt,
            trigger: r.trigger,
            reports: r.reports,
          })),
        });
      }

      if (req.method === 'GET' && p === '/api/runs') {
        const runs = await store.listRuns();
        return json(res, 200, runs.slice(0, 100));
      }

      let m = p.match(/^\/api\/runs\/([A-Za-z0-9_-]+)$/);
      if (req.method === 'GET' && m) {
        const run = await store.loadRun(m[1]!);
        return run ? json(res, 200, run) : json(res, 404, { error: 'not found' });
      }

      m = p.match(/^\/api\/runs\/([A-Za-z0-9_-]+)\/verify$/);
      if (req.method === 'GET' && m) {
        return json(res, 200, orchestrator.verifyChain(m[1]!));
      }

      m = p.match(/^\/api\/runs\/([A-Za-z0-9_-]+)\/report\/(.+)$/);
      if (req.method === 'GET' && m) {
        const runId = m[1]!;
        const file = normalize(decodeURIComponent(m[2]!));
        if (file.includes('..')) return json(res, 400, { error: 'bad path' });
        const full = join(store.runDir(runId), 'reports', file);
        if (!full.startsWith(store.runDir(runId)) || !existsSync(full)) return json(res, 404, { error: 'not found' });
        const body = await readFile(full);
        res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' });
        return res.end(body);
      }

      if (req.method === 'POST' && p === '/api/run') {
        const raw = await readBody(req);
        const opts = raw ? JSON.parse(raw) : {};
        const run = await orchestrator.execute({
          trigger: 'manual',
          reason: opts.reason ?? 'HTTP 手动触发',
          targetIds: opts.targetIds,
          stages: opts.stages,
          keepSandbox: !!opts.keepSandbox,
        });
        return json(res, 200, { id: run.id, status: run.status, reports: run.reports });
      }

      if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(DASHBOARD_HTML);
      }

      json(res, 404, { error: 'not found' });
    } catch (err) {
      json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  server.listen(port, '127.0.0.1', () => {
    // 由 CLI 打印；这里只 listen
  });
  return server;
}

const DASHBOARD_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>备份编排与演练中心</title>
<style>
:root{--bg:#0f1115;--card:#181b22;--line:#262b36;--fg:#e6e9ef;--muted:#9aa3b2;--ok:#2ecc71;--warn:#f1c40f;--bad:#e74c3c;--accent:#4f8cff}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.6 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
header{padding:20px 28px;border-bottom:1px solid var(--line);display:flex;align-items:baseline;gap:14px}
h1{font-size:18px;margin:0}.sub{color:var(--muted);font-size:12px}
main{padding:22px 28px;display:grid;gap:18px;grid-template-columns:1fr;max-width:1100px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px 18px}
.card h2{font-size:14px;margin:0 0 12px;color:var(--muted);font-weight:600;letter-spacing:.04em}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--line);font-size:13px}
th{color:var(--muted);font-weight:500}.pill{display:inline-block;padding:1px 8px;border-radius:99px;font-size:12px}
.s-success{background:rgba(46,204,113,.15);color:var(--ok)}.s-failed{background:rgba(231,76,60,.15);color:var(--bad)}
.s-skipped{background:rgba(154,163,178,.15);color:var(--muted)}.s-running{background:rgba(79,140,255,.15);color:var(--accent)}
button{background:var(--accent);color:#fff;border:0;border-radius:7px;padding:7px 14px;cursor:pointer;font-size:13px}
button.ghost{background:transparent;border:1px solid var(--line);color:var(--fg)}
code{color:#c9d4ff}.muted{color:var(--muted)}a{color:var(--accent);text-decoration:none}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
pre{white-space:pre-wrap;word-break:break-all;background:#10131a;border:1px solid var(--line);border-radius:8px;padding:12px;max-height:420px;overflow:auto;font-size:12px}
</style></head><body>
<header><h1>备份编排与演练中心</h1><span class="sub" id="updated"></span></header>
<main>
  <div class="card"><h2>目标与计划</h2><div id="targets"></div></div>
  <div class="card row"><button onclick="runNow(['backup','drill'])">立即备份并演练全部目标</button>
    <button class="ghost" onclick="runNow(['backup'])">只备份</button>
    <button class="ghost" onclick="runNow(['drill'])">只演练最近备份</button>
    <span class="muted" id="runmsg"></span></div>
  <div class="card"><h2>下一次定时触发</h2><div id="upcoming"></div></div>
  <div class="card"><h2>最近运行（可追溯报告）</h2><div id="runs"></div></div>
  <div class="card" id="reportCard" style="display:none"><h2>报告预览</h2><pre id="report"></pre></div>
</main>
<script>
const esc=s=>String(s??'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const pill=s=>'<span class="pill s-'+s+'">'+({success:'成功',failed:'失败',skipped:'跳过',running:'运行中'}[s]||s)+'</span>';
async function load(){
  const st=await (await fetch('/api/status')).json();
  document.getElementById('updated').textContent='更新于 '+new Date().toLocaleTimeString();
  document.getElementById('targets').innerHTML='<table><tr><th>目标</th><th>类型</th><th>启用</th><th>备份计划</th><th>演练计划</th></tr>'+
    st.targets.map(t=>{const p=st.plans.find(x=>x.targetId===t.id)||{};
      return '<tr><td>'+esc(t.name)+'<br><code>'+esc(t.id)+'</code></td><td>'+t.kind+'</td><td>'+(t.enabled?'是':'否')+'</td><td><code>'+esc(p.backupCron||'—')+'</code></td><td><code>'+esc(p.drillCron||'—')+'</code></td></tr>';}).join('')+'</table>'
    + (st.targets.length===0?'<p class="muted">还没有目标。用 CLI 添加：pnpm --filter @heirloom/backup-center start -- target add …</p>':'');
  document.getElementById('upcoming').innerHTML=st.upcoming.length?'<table><tr><th>目标</th><th>阶段</th><th>cron</th><th>下次</th></tr>'+
    st.upcoming.map(u=>'<tr><td>'+esc(u.targetId)+'</td><td>'+(u.kind==='backup'?'备份':'演练')+'</td><td><code>'+esc(u.cron)+'</code></td><td>'+new Date(u.next).toLocaleString()+'</td></tr>').join('')+'</table>':'<p class="muted">无定时计划</p>';
  document.getElementById('runs').innerHTML='<table><tr><th>运行</th><th>状态</th><th>触发</th><th>开始</th><th>报告</th><th>哈希链</th></tr>'+
    st.latestRuns.map(r=>'<tr><td><code>'+esc(r.id)+'</code></td><td>'+pill(r.status)+'</td><td>'+esc(r.trigger)+'</td><td>'+new Date(r.startedAt).toLocaleString()+'</td><td>'+(r.reports||[]).map(x=>'<a href="#" onclick="showReport(\\''+r.id+'\\',\\''+esc(x.split('/').pop())+'\\');return false">'+esc(x.split('/').pop())+'</a>').join(' ')+'</td><td><a href="#" onclick="verify(\\''+r.id+'\\');return false">校验</a></td></tr>').join('')+'</table>';
}
async function showRun(id){const r=await (await fetch('/api/runs/'+id)).json();return r}
async function showReport(id,file){const t=await (await fetch('/api/runs/'+id+'/report/'+file)).text();document.getElementById('reportCard').style.display='block';document.getElementById('report').textContent=t;document.getElementById('reportCard').scrollIntoView({behavior:'smooth'})}
async function verify(id){const r=await (await fetch('/api/runs/'+id+'/verify')).json();alert('事件哈希链：'+(r.ok?'完整 ✅':'断裂 ❌')+'\\n事件数：'+r.events+(r.brokenAt?('\\n断裂位置：'+r.brokenAt):''))}
async function runNow(stages){document.getElementById('runmsg').textContent='执行中，请稍候…';
  const r=await (await fetch('/api/run',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({stages})})).json();
  document.getElementById('runmsg').textContent='完成：'+r.status+'（'+r.id+'）';load()}
load();setInterval(load,10000);
</script></body></html>`;

# 备份编排与演练中心（backup-center）

定时执行**数据库与媒体备份 → 校验完整性 → 自动还原到隔离环境比对 → 输出可追溯报告**。
它是 `scripts/backup.sh` / `drill.sh` 的编排化升级：多目标、可调度、有沙箱、留证据、带看板。

- **零外部服务**：不依赖 cron 守护/容器/系统 PostgreSQL；沙箱用嵌入式 PostgreSQL，二进制随包安装。
- **三类目标**：`postgres`（pg_dump 自定义格式）、`media`（目录打包）、`tablefile`（JSONL 逻辑表，免数据库自测用）。
- **两阶段闭环**：`backup`（探活 → 导出 → 自校验 → manifest+DONE）与 `drill`（起隔离沙箱 → 还原 → 逐表/逐文件哈希比对）。
- **可追溯**：每次 run 一条 **SHA-256 哈希链事件日志**（`events.jsonl`，篡改即断裂）、不可变产物清单（`DONE`=manifest 哈希）、Markdown 报告。
- **不误报**：备份之后源端正常的新增/改动，在演练报告里标为 **漂移警告 ⚠️**，而不是把「备份损坏」和「备份后又写入」混为一谈。

## 快速开始

```bash
pnpm install
pnpm center:build

pnpm center:onboard     # 从 .env 一键注册「数据库 + 媒体」目标，默认每天 02:30 备份、每周一 04:00 演练
pnpm center:run         # 立即执行一轮 backup + drill
pnpm center:daemon      # 常驻：按 cron 调度 + 看板 http://127.0.0.1:4090
```

不想/没有可用的 PostgreSQL？跑自包含演示（自动起一个临时内嵌库 + 假媒体）：

```bash
pnpm center:demo
```

## 目录与证据

状态默认在 `data/backup-center/`（可用 `BACKUP_CENTER_STATE` 覆盖）：

```
data/backup-center/
├── config.json                 # 目标 + 计划（每次改动在 config-history/ 留副本）
├── runs.jsonl                  # 只追加的运行索引（带阶段状态摘要）
└── runs/<runId>/
    ├── events.jsonl            # 哈希链时间线（防篡改，可独立 verify）
    ├── run.json                # 完整运行结果
    ├── backup/<targetId>/
    │   ├── db.dump | uploads.tar.gz | *.jsonl
    │   ├── manifest.json       # 源端指纹 + 每个产物的 sha256/大小
    │   └── DONE                # 完成时间 + manifest.json 的 sha256（无 DONE = 不完整备份，拒绝演练）
    ├── drill/<targetId>/compare.json
    └── reports/summary.md, <targetId>.md
```

报告长这样（节选）：

```
# 备份/演练报告 · 家档数据库
- 运行编号：run-2026-10-06-1120-hvlqc2
- 事件链：13 条事件 · 链校验 ✅ 完整
- 链尾哈希：8f4505e4…
## 结论：✅ 通过
| 结果 | 检查项 | 详情 |
| ✅ | 隔离沙箱启动 | 嵌入式 PostgreSQL · 127.0.0.1:54792/drill |
| ✅ | 还原到沙箱 | pg_restore 完成（无错误） |
| ✅ | 逐表内容比对（行数 + sha256） | 一致 5/5 张表 |
| ⚠️ | 源库自备份以来的漂移 | public.items：备份时 4 行 → 现在 5 行 |
```

## CLI

```bash
# 执行
center run [--target ID]... [--backup] [--drill] [--reason TXT] [--keep-sandbox]
center daemon            # 调度 + 看板（cron 按 .env 的 TZ 时区解释）
center serve             # 只看历史/手动触发，不调度

# 目标与计划
center target list
center target add postgres 家档库 --url postgresql://u:p@host/db --format custom
center target add media    媒体库 --dir ./data/uploads --sample 1
center plan set  <targetId> --backup "30 2 * * *" --drill "0 4 * * 1"
center plan rm   <targetId>

# 追溯
center runs
center report <runId> [--name summary.md]
center verify <runId>     # 校验事件哈希链
center prune --keep 30
```

## 隔离沙箱怎么实现的

- **Postgres 目标**：演练时在 `runs/<id>/drill/<target>/sandbox/` 下用 [`embedded-postgres`](https://www.npmjs.com/package/embedded-postgres) 初始化一个**全新的、独立数据目录、随机高端口、只绑 127.0.0.1** 的 PostgreSQL 集群，`pg_restore` 把备份还进去，再算每张表的「行数 + 规范化行内容 sha256」与备份时刻的源端指纹比对。结束即整体删除（`--keep-sandbox` 可保留排障）。
- **媒体目标**：解包到沙箱目录（带 `..`/绝对路径穿越防护），全量或按比例抽样核对每个文件的 sha256，并检查是否存在清单外多余文件。
- 沙箱**永远不碰生产数据**：不同的集群/数据目录，连还原账号都是独立的。

pg 客户端工具（pg_dump/pg_restore/psql）的查找顺序：`PG_BIN_DIR` → `PATH` → 仓库内 `tools/pg`（本仓库在无 root 的环境里用官方 deb 解压了一份 arm64 客户端，可直接跑）。

## 验证

```bash
pnpm --filter @heirloom/backup-center test
```

16 个测试：cron 解析、tar.gz 往返/中文路径/穿越拒绝、哈希链篡改检测、配置历史、
以及对**真实嵌入式 PostgreSQL** 的端到端：建库建表 → 备份 → 沙箱还原 → 逐表比对通过 →
备份后写入只产生漂移警告而不误报。

## HTTP 看板

`center daemon` / `center serve` 后访问 <http://127.0.0.1:4090>：
目标与计划、下一次触发时间、最近运行、在线查看 Markdown 报告、一键执行、一键校验哈希链。
端口用 `BACKUP_CENTER_PORT` 改。

## 与既有脚本的关系

`scripts/backup.sh`、`restore.sh`、`drill.sh` 保留可用（面向系统已装 PostgreSQL 的人工运维）。
backup-center 面向**编排与常态化演练**：调度、多目标、隔离沙箱、证据链、看板都在这里；
它产出的 `db.dump` 仍是标准 pg_dump 自定义格式，必要时 `scripts/restore.sh` 一样能还。

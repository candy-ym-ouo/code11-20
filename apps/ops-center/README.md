# 备份编排与演练中心

定时执行数据库与媒体备份、校验完整性、**自动还原到隔离环境逐项比对**，并把全过程写进
**append-only 哈希链账本**、输出可追溯报告。它是 `scripts/backup.sh` / `drill.sh` 的编排化升级：
产物格式完全兼容，但多了调度、隔离演练、位腐检测、防篡改账本和只读状态面板。

## 它做什么

| 环节 | 动作 |
| --- | --- |
| 定时备份 `backup` | `pg_dump -Fc` 流式落盘 + `tar.gz` 媒体归档（边写边算 sha256）+ manifest + `DONE` 标记；随后自动执行保留回收 |
| 完整性校验 `verify` | 不改生产数据：重算备份文件 sha256 对清单、`pg_restore --list` 证明 dump 可解析、`tar -tzf` 验 gzip CRC、抽样核对生产磁盘媒体哈希 |
| 隔离演练 `drill` | 建独立临时库还原 + 独立沙箱目录解压媒体；16 张表做行数与全行内容指纹比对；媒体做「生产磁盘 / 恢复库记录 / 归档实算」三方哈希比对；结束自动 DROP 临时库、删沙箱 |
| 回收 `retention` | 同时超过份数与天数的旧成功备份才删；最新一份永不删；无 `DONE` 且超 24h 的残骸才清 |
| 追溯 | 每次运行写账本（`ledger.ndjson`，逐行 sha256 哈希链）并落 `.md` / `.json` / `.sha256` 三份报告；`audit` 可检出任何删改 |

### 隔离边界（硬性）

- **数据库**：演练库是同集群内独立的临时库（`heirloom_drill_<时间>_<随机>`），演练结束 DROP；
  对生产库的所有查询都带 `PGOPTIONS=-c default_transaction_read_only=on`，机制上不可能误写生产。
- **文件系统**：媒体只解压到 `data/ops-center/sandbox/<临时库名>/`；生产 `uploads/` 只读。
- 演练需要建库权限（`CREATEDB`），与 `scripts/drill.sh` 相同。

## 使用

```bash
pnpm ops:build           # 首次先构建（pnpm build 已包含它）

pnpm ops:daemon          # 常驻：按 BACKUP/VERIFY/DRILL_CRON 调度 + 状态面板
pnpm ops:backup          # 立即备份一次
pnpm ops:verify          # 校验最新（或指定）备份
pnpm ops:drill           # 隔离环境还原比对（指定目录：pnpm ops:drill data/backups/<时间戳>）
pnpm ops:audit           # 校验账本哈希链
pnpm ops                 # 查看全部命令（status / runs / run <id> / report <id> / list ...）
```

直接调也行：`node apps/ops-center/dist/index.js <命令>`。守护进程与单次任务共用一把
PID 锁（`data/ops-center/center.lock`），重复启动会直接退出。

> 备份产物仍在 `data/backups/<时间戳>/`，与手工脚本完全互通：`scripts/restore.sh` 可以恢复
> 本中心产出的备份，本中心也能校验/演练旧脚本产出的备份（manifest v1/v2 都认）。

## 状态面板

守护进程默认在 `http://127.0.0.1:4097/` 提供只读页面与 JSON：

- `GET /healthz` / `GET /readyz`（账本完整性异常时 readyz 返回 500）
- `GET /api/status` 最近运行、下一次计划、备份占用、报告列表
- `GET /api/runs` / `GET /api/runs/:id` 运行聚合
- `GET /api/backups` 磁盘备份清单
- `GET /reports/<文件>` 报告下载（已防目录穿越）

## 调度

cron 为标准五字段（分 时 日 月 周），按 `.env` 的 `TZ`（默认 `Asia/Shanghai`）解释；
**不存在的日期（如 2 月 30 日）会在启动时报错**，而不是静默不跑。守护进程重启时若发现
错过窗口（状态记在 `scheduler-state.json`）会立即补跑一次，可用 `SCHEDULE_CATCHUP=false` 关闭。

systemd 托管示例见 `apps/ops-center/deploy/heirloom-ops-center.service`。

## 数据布局

```
data/ops-center/
├── ledger.ndjson          # append-only 事件流（哈希链），可追溯的底座
├── scheduler-state.json   # 各任务上次触发时间（补跑判定）
├── center.lock            # PID 运行锁
├── sandbox/               # 演练沙箱（每次演练后清空）
└── reports/
    ├── backup-<runId>.md / .json / .sha256
    ├── verify-<runId>.md / .json / .sha256
    └── drill-<runId>.md  / .json / .sha256
```

报告开头的「追溯信息」含 runId；用它在账本中过滤即可重放出与报告完全一致的检查过程。

## 配置

全部走根目录 `.env`（见 `.env.example` 的「备份编排与演练中心」段）：
`BACKUP_CRON` / `VERIFY_CRON` / `DRILL_CRON`、`BACKUP_RETENTION_DAYS` / `BACKUP_RETENTION_COUNT`、
`VERIFY_SAMPLE_SIZE` / `DRILL_COMPARE_SAMPLE_SIZE`（0 = 全量）、`OPS_HTTP_PORT` / `OPS_HTTP_HOST`、
`PG_BIN_PATH`、`DRILL_DB_PREFIX`。

## 零依赖说明

运行时只用 Node 内置模块；PostgreSQL 操作全部走本机 `psql` / `pg_dump` / `pg_restore` /
`createdb` / `dropdb`。客户端工具不在 PATH 时用 `PG_BIN_PATH` 指到其 bin 目录。

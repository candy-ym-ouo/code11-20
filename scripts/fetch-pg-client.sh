#!/usr/bin/env bash
# 下载并解压「免安装 PostgreSQL 客户端」到 tools/pg（不需要 root，不改系统）。
# backup-center 会优先使用这里的 pg_dump/pg_restore/psql 与随包 libpq。
#
# 用法：bash scripts/fetch-pg-client.sh [版本]
#   版本默认 18.6（Debian 12 bookworm，arm64/x86_64 自动识别）
#   其它发行版/版本可手工把 deb 解到 tools/pg，目录结构保持 usr/lib/postgresql/<ver>/bin
set -euo pipefail

VERSION="${1:-18.6}"
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT_DIR/tools/pg"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

case "$(uname -m)" in
  aarch64|arm64) ARCH=arm64 ;;
  x86_64|amd64)  ARCH=amd64 ;;
  *) echo "不支持的架构：$(uname -m)" >&2; exit 1 ;;
esac

MAJOR="${VERSION%%.*}"
BASE="https://apt.postgresql.org/pub/repos/apt/pool/main/p/postgresql-${MAJOR}"
PKG_VER="${VERSION}-1.pgdg12+2_${ARCH}"

echo "→ 下载 postgresql-client-${MAJOR} 与 libpq5（${VERSION}, ${ARCH}）到临时目录"
cd "$WORK"
for deb in "postgresql-client-${MAJOR}_${PKG_VER}.deb" "libpq5_${PKG_VER}.deb"; do
  echo "  · $deb"
  curl -fsSLO "$BASE/$deb"
done

echo "→ 解压到 $DEST"
mkdir -p "$DEST"
for deb in *.deb; do
  ar x "$deb"
  tar -xf data.tar.* -C "$DEST"
done

BIN="$DEST/usr/lib/postgresql/$MAJOR/bin"
echo "→ 自检"
if [ -d "$DEST/usr/lib/aarch64-linux-gnu" ]; then
  export LD_LIBRARY_PATH="$DEST/usr/lib/aarch64-linux-gnu:${LD_LIBRARY_PATH:-}"
elif [ -d "$DEST/usr/lib/x86_64-linux-gnu" ]; then
  export LD_LIBRARY_PATH="$DEST/usr/lib/x86_64-linux-gnu:${LD_LIBRARY_PATH:-}"
fi
"$BIN/pg_dump" --version
"$BIN/pg_restore" --version
echo "完成。backup-center 会自动发现 $BIN"

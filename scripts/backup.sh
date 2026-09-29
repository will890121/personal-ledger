#!/usr/bin/env bash
#
# 帳本快照。用 SQLite 的 VACUUM INTO 取一致快照，服務不必停，也不會拷到寫到一半的狀態
# （直接 cp 檔案在寫入中途會拿到撕裂的檔案，見 docs/operations/backup-and-restore.md）。
#
# 用法：
#   scripts/backup.sh                 # 快照到 backups/<時間戳>/
#   KEEP=20 scripts/backup.sh         # 改保留份數（預設 10）
#   VOLUME=other scripts/backup.sh    # 改資料卷
#
# 只用 bash 3.2 有的語法（macOS 內建就是 3.2，沒有 mapfile）。
set -euo pipefail

VOLUME="${VOLUME:-m1-foundation-first-slice_ledger-data}"
DB_NAME="${DB_NAME:-personal-ledger.sqlite}"
KEEP="${KEEP:-10}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_ROOT="${BACKUP_ROOT:-$REPO_ROOT/backups}"
DEST="$BACKUP_ROOT/$(date +%Y-%m-%d-%H%M%S)"

if ! docker volume inspect "$VOLUME" >/dev/null 2>&1; then
  echo "找不到資料卷 $VOLUME" >&2
  exit 1
fi

mkdir -p "$DEST"
# 失敗時不要留下空目錄，否則保留規則會把它當成一份有效備份。
trap 'rmdir "$DEST" 2>/dev/null || true' EXIT

# 快照當場驗一次：備份沒驗證過等於沒有備份。
# VACUUM INTO 的目標路徑在 SQL 裡必須是單引號字串，而這段 sh -c 本身是單引號包起來的，
# 所以整句 SQL 由外層組好用環境變數傳進去，避免引號互相打架。
docker run --rm \
  -e DB_NAME="$DB_NAME" \
  -e SNAPSHOT_SQL="VACUUM INTO '/out/$DB_NAME'" \
  -v "$VOLUME":/data:ro \
  -v "$DEST":/out \
  alpine:3 sh -c '
    apk add --no-cache sqlite >/dev/null 2>&1
    sqlite3 -readonly "/data/$DB_NAME" "$SNAPSHOT_SQL"
    result=$(sqlite3 -readonly "/out/$DB_NAME" "PRAGMA integrity_check")
    if [ "$result" != ok ]; then
      echo "integrity_check 失敗：$result" >&2
      exit 1
    fi
    printf "%s" "$(sqlite3 -readonly "/out/$DB_NAME" "SELECT max(version) FROM schema_migrations")" > /out/.schema
  '

SCHEMA="$(cat "$DEST/.schema")"
rm -f "$DEST/.schema"
trap - EXIT
# 變數後面緊接著全形字元時一律用大括號界定：bash 3.2 在非 UTF-8 locale 下會把多位元組
# 字元的首個位元組併進變數名，變成 unbound variable。
SIZE="$(du -h "$DEST/$DB_NAME" | cut -f1)"
echo "已建立 ${DEST}/${DB_NAME}（schema ${SCHEMA}、${SIZE}、integrity ok）"

# 保留最近 KEEP 份。只刪自己產生的時間戳目錄，手動命名的備份（m3b-upgrade-… 之類）不動。
COUNT=0
find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d \
  -name '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]-[0-9][0-9][0-9][0-9][0-9][0-9]' \
  | sort -r \
  | while IFS= read -r snapshot; do
      COUNT=$((COUNT + 1))
      if [ "$COUNT" -gt "$KEEP" ]; then
        rm -rf "$snapshot"
        echo "已刪除逾期快照 $(basename "$snapshot")"
      fi
    done

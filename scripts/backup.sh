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
#
# 來源卷不能掛 :ro。M4 切到 WAL 之後，即使只是唯讀讀取，SQLite 也要在同一個目錄
# 建立 -shm 共享記憶體索引檔才能組出一致的讀取快照（沒有它連 PRAGMA journal_mode 都會
# 是 "unable to open database file"，2026-09-30 實測踩過）。真正的唯讀保護在下面的
# `sqlite3 -readonly`：那是 SQLite 連線層級的旗標，這支腳本本來就只送 VACUUM INTO 與
# PRAGMA，不會寫回來源卷。
docker run --rm \
  -e DB_NAME="$DB_NAME" \
  -e SNAPSHOT_SQL="VACUUM INTO '/out/$DB_NAME'" \
  -v "$VOLUME":/data \
  -v "$DEST":/out \
  alpine:3 sh -c '
    apk add --no-cache sqlite >/dev/null 2>&1
    sqlite3 -readonly "/data/$DB_NAME" "$SNAPSHOT_SQL"
    result=$(sqlite3 -readonly "/out/$DB_NAME" "PRAGMA integrity_check")
    if [ "$result" != ok ]; then
      echo "integrity_check 失敗：$result" >&2
      exit 1
    fi
    # schema 版本只是成功訊息裡的欄位，讀不到不該讓備份失敗——快照本身已經過上面的
    # integrity_check。但也不能靜靜留白：這個內層 sh -c 沒有 set -e，查詢失敗會被吞掉，
    # 成功訊息就會印出「schema 、」這種空洞而沒人看得出發生了什麼。查不到就明確寫 unknown。
    schema=$(sqlite3 -readonly "/out/$DB_NAME" "SELECT max(version) FROM schema_migrations" 2>/dev/null || true)
    [ -n "$schema" ] || schema=unknown
    printf "%s" "$schema" > /out/.schema
  '

SCHEMA="$(cat "$DEST/.schema")"
rm -f "$DEST/.schema"
trap - EXIT
# 變數後面緊接著全形字元時一律用大括號界定：bash 3.2 在非 UTF-8 locale 下會把多位元組
# 字元的首個位元組併進變數名，變成 unbound variable。
# du -h 會靠右補空白對齊，直接插進訊息會變成「schema 8、 12K」多一個空格。
SIZE="$(du -h "$DEST/$DB_NAME" | cut -f1 | tr -d "[:space:]")"
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

# 明確收尾。上面的 while 在 pipeline 尾端，腳本的離開碼會隱含地變成它的狀態；
# 目前是安全的（if 沒有 else，最後一個指令是成功的 test），但備份腳本的離開碼是
# 呼叫端唯一的判斷依據，不該取決於這種間接推理。
exit 0

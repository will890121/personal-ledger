#!/usr/bin/env bash
#
# scripts/backup.sh 的端到端自我測試：在主機上跑，自己準備資料、自己清理，
# 絕對不碰正式資料卷 m1-foundation-first-slice_ledger-data。
#
# 存在的理由：M4 切到 WAL 之後 scripts/backup.sh 曾經整支壞掉（來源卷掛 :ro，
# 連 PRAGMA journal_mode 都建不起來），而唯一發現這件事的原因是剛好有人手動
# 跑了一次演練。這支腳本把那次演練變成可重跑的斷言：
#
#   1. 建一個臨時資料卷，寫入一列並提交，然後把寫入的連線直接砍斷
#      （SIGKILL，不走正常關閉），再手動刪掉 -shm。WAL 模式下，主檔案本身
#      不會有這一列——它還躺在 -wal 裡；而 -shm 不見了，代表下一個連進來的
#      連線必須重新掃 -wal、重建 wal-index 才能讀到一致的內容，這一步需要
#      對資料目錄的寫入權限。這正是 2026-09-30 實測到、也是唯一能穩定重現
#      「來源卷掛 :ro 就整支壞掉」那個 bug 的條件——只是把連線開著、不砍斷，
#      -shm 會一直在，:ro 掛載照樣讀得到，重現不了那個 bug。
#   2. 對這個臨時卷跑 scripts/backup.sh，斷言：離開碼 0、快照檔存在、
#      integrity_check ok、快照裡查得到那一列。
#   3. 對照組：直接複製主檔案（不透過 backup.sh），斷言查不到那一列——
#      證明這支自我測試真的在測有意義的事，不是恆真。
#
# 這支腳本不在 `pnpm check` 裡：vitest 跑在沒有 docker socket 的容器裡，
# 測不到一支工作內容就是編排 docker 的腳本。改動 scripts/backup.sh 或
# journal mode 之後，請在主機上手動跑一次這支腳本。
#
# 只用 bash 3.2 有的語法（macOS 內建就是 3.2，沒有 mapfile）。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_SH="${REPO_ROOT}/scripts/backup.sh"

STAMP="$(date +%s)-$$"
VOL="pl-selftest-${STAMP}"
DB_NAME="personal-ledger.sqlite"
WRITER="pl-selftest-writer-${STAMP}"
ROW_MARK="wal-only-row-${STAMP}"

TMP_BACKUP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/pl-selftest-backup.XXXXXX")"
TMP_CONTROL_DIR="$(mktemp -d "${TMPDIR:-/tmp}/pl-selftest-control.XXXXXX")"

cleanup() {
  docker rm -f "${WRITER}" >/dev/null 2>&1 || true
  docker volume rm "${VOL}" >/dev/null 2>&1 || true
  rm -rf "${TMP_BACKUP_ROOT}" "${TMP_CONTROL_DIR}"
}
trap cleanup EXIT

fail() {
  echo "自我測試失敗：${1}" >&2
  exit 1
}

echo "== 建立臨時資料卷 ${VOL} =="
docker volume create "${VOL}" >/dev/null

echo "== 寫入一列並提交（WAL 模式）=="
docker run -d --name "${WRITER}" \
  -e DB_NAME="${DB_NAME}" \
  -e ROW_MARK="${ROW_MARK}" \
  -v "${VOL}":/data \
  alpine:3 sh -c '
    apk add --no-cache sqlite >/dev/null 2>&1
    {
      printf "PRAGMA journal_mode=WAL;\n"
      printf "CREATE TABLE selftest_rows (id INTEGER PRIMARY KEY, note TEXT);\n"
      printf "INSERT INTO selftest_rows (note) VALUES ('"'"'%s'"'"');\n" "$ROW_MARK"
      sleep 60
    } | sqlite3 "/data/$DB_NAME"
  ' >/dev/null

# 等到 -wal 檔案真的有內容（不只是切換模式時建立的空殼），確保 CREATE/INSERT
# 已經提交。用 stat 而不是 apk add sqlite，純粹檢查檔案大小不需要 sqlite3。
WAL_READY=""
i=0
while [ "${i}" -lt 30 ]; do
  WAL_SIZE="$(docker run --rm -v "${VOL}":/data alpine:3 \
    sh -c 'stat -c %s "/data/'"${DB_NAME}"'-wal" 2>/dev/null || echo 0')"
  if [ "${WAL_SIZE:-0}" -gt 100 ] 2>/dev/null; then
    WAL_READY=1
    break
  fi
  i=$((i + 1))
  sleep 1
done
[ -n "${WAL_READY}" ] || fail "等不到 -wal 檔案有內容（背景寫入容器可能沒跑起來）"

WRITER_LOG="$(docker logs "${WRITER}" 2>/dev/null | head -n1 | tr -d '[:space:]')"
[ "${WRITER_LOG}" = "wal" ] || fail "journal_mode 不是 wal（實際輸出：${WRITER_LOG}）"

echo "== 砍斷寫入連線、刪掉 -shm，模擬需要 WAL 復原的狀態 =="
# 直接砍掉容器＝SIGKILL，不會走正常關閉流程，不會把 -wal 的資料 checkpoint
# 回主檔案。刪掉 -shm 則是強迫下一個連進來的連線必須重新掃 -wal、重建
# wal-index——這一步需要寫入權限，來源卷掛 :ro 就會在這裡炸掉。只砍連線
# 不刪 -shm 的話，既有的 -shm 還在，之後不管掛不掛 :ro 都讀得到，測不出
# 這個 bug（已經實測驗證過）。
docker kill "${WRITER}" >/dev/null 2>&1 || true
docker run --rm -v "${VOL}":/data alpine:3 sh -c 'rm -f "/data/'"${DB_NAME}"'-shm"'

echo "== 對照組：直接複製主檔案（繞過 -wal）=="
docker run --rm \
  -e DB_NAME="${DB_NAME}" \
  -v "${VOL}":/data:ro \
  -v "${TMP_CONTROL_DIR}":/out \
  alpine:3 sh -c 'cp "/data/$DB_NAME" "/out/$DB_NAME"' >/dev/null

echo "== 執行 scripts/backup.sh =="
BACKUP_RC=0
VOLUME="${VOL}" DB_NAME="${DB_NAME}" BACKUP_ROOT="${TMP_BACKUP_ROOT}" KEEP=10 \
  "${BACKUP_SH}" || BACKUP_RC=$?
[ "${BACKUP_RC}" -eq 0 ] \
  || fail "scripts/backup.sh 離開碼是 ${BACKUP_RC}（不是 0）——備份腳本本身掛了，這就是這支自我測試存在的理由"
echo "scripts/backup.sh 離開碼 0"

SNAPSHOT_DIR="$(find "${TMP_BACKUP_ROOT}" -mindepth 1 -maxdepth 1 -type d | head -n1)"
[ -n "${SNAPSHOT_DIR}" ] || fail "找不到快照目錄（${TMP_BACKUP_ROOT} 底下是空的）"
SNAPSHOT_FILE="${SNAPSHOT_DIR}/${DB_NAME}"
[ -f "${SNAPSHOT_FILE}" ] || fail "快照檔不存在：${SNAPSHOT_FILE}"
echo "快照檔存在：${SNAPSHOT_FILE}"

SNAPSHOT_INTEGRITY="$(docker run --rm \
  -e DB_NAME="${DB_NAME}" \
  -v "${SNAPSHOT_DIR}":/snap \
  alpine:3 sh -c '
    apk add --no-cache sqlite >/dev/null 2>&1
    sqlite3 -readonly "/snap/$DB_NAME" "PRAGMA integrity_check"
  ')"
[ "${SNAPSHOT_INTEGRITY}" = "ok" ] || fail "快照 integrity_check 不是 ok（實際：${SNAPSHOT_INTEGRITY}）"
echo "快照 integrity_check：ok"

SELECT_SQL="SELECT count(*) FROM selftest_rows WHERE note = '${ROW_MARK}'"

SNAPSHOT_COUNT="$(docker run --rm \
  -e DB_NAME="${DB_NAME}" \
  -e SELECT_SQL="${SELECT_SQL}" \
  -v "${SNAPSHOT_DIR}":/snap \
  alpine:3 sh -c '
    apk add --no-cache sqlite >/dev/null 2>&1
    sqlite3 -readonly "/snap/$DB_NAME" "$SELECT_SQL" 2>/dev/null || echo 0
  ')"
[ "${SNAPSHOT_COUNT}" = "1" ] \
  || fail "快照裡查不到那一列（實際筆數：${SNAPSHOT_COUNT}）——WAL 裡已提交的資料沒被收進來"
echo "快照裡查得到那一列（筆數 1）"

CONTROL_COUNT="$(docker run --rm \
  -e DB_NAME="${DB_NAME}" \
  -e SELECT_SQL="${SELECT_SQL}" \
  -v "${TMP_CONTROL_DIR}":/out \
  alpine:3 sh -c '
    apk add --no-cache sqlite >/dev/null 2>&1
    sqlite3 "/out/$DB_NAME" "$SELECT_SQL" 2>/dev/null || echo 0
  ')"
[ "${CONTROL_COUNT}" = "0" ] \
  || fail "對照組（直接複製主檔案）查到了列（筆數 ${CONTROL_COUNT}）——不該看得到才對，這支自我測試不是在測有意義的事"
echo "對照組（直接複製主檔案）查不到那一列（筆數 0）"

echo "自我測試通過：scripts/backup.sh 在 WAL 模式下正確收錄了尚未 checkpoint 的已提交資料，且已證明對照組不是恆真"
exit 0

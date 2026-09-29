# 備份與還原

狀態：第一版，2026-09-29 依實際演練寫成。自動化快照與維護 CLI 屬於 M5，本文描述的是
**目前手動可行且已驗證過的做法**。

## 資料在哪裡

| | |
|---|---|
| Docker volume | `m1-foundation-first-slice_ledger-data` |
| 檔案 | `personal-ledger.sqlite`（容器內 `/app/data/`） |
| 容器內擁有者 | uid 100 / gid 101 |
| `journal_mode` | `delete`（不是 WAL，因此沒有 `-wal`／`-shm` 需要一起備份） |

## 備份

### 建議做法：`VACUUM INTO`（原子）

```bash
DEST=backups/$(date +%Y-%m-%d-%H%M)
mkdir -p "$DEST"
docker run --rm \
  -v m1-foundation-first-slice_ledger-data:/d:ro \
  -v "$PWD/$DEST":/out \
  alpine:3 sh -c "apk add --no-cache sqlite >/dev/null 2>&1 &&
    sqlite3 -readonly /d/personal-ledger.sqlite \"VACUUM INTO '/out/personal-ledger.sqlite'\""
```

`VACUUM INTO` 由 SQLite 自己讀一致的快照，服務不必停，也不會拷到寫到一半的狀態。輸出的
檔案順帶被壓實過。已於 2026-09-29 實測可用。

### 目前實際用過的做法：直接複製檔案

`backups/` 底下五份備份都是這樣來的：

```bash
docker run --rm -v m1-foundation-first-slice_ledger-data:/src:ro \
  -v "$PWD/backups/<名稱>":/dst alpine:3 cp /src/personal-ledger.sqlite /dst/
```

因為 `journal_mode=delete`，在沒有寫入進行中的時候這樣是安全的——五份備份的
`PRAGMA integrity_check` 全部 `ok`。但它**不是原子的**：若剛好在交易寫入中途複製，會拿到
撕裂的檔案。上面的 `VACUUM INTO` 沒有這個問題，之後一律用它。

### 何時備份

- **每次 migration 之前**（目前唯一確實執行的時機）。
- 每週一次例行快照，見下方「尚未補上的缺口」。

## 還原

> 還原需要**短暫停掉線上服務**：Bot token 只有一個，兩個容器同時 long polling 會互搶。
> 2026-09-29 的演練實測停機 **40 秒**，其中還原本身 10 秒。

```bash
# 1. 準備乾淨的 volume 並放入備份
docker volume create ledger-restore
docker run --rm -v "$PWD/backups/<名稱>":/b:ro -v ledger-restore:/d alpine:3 \
  sh -c "cp /b/personal-ledger.sqlite /d/ && chown -R 100:101 /d && chmod 755 /d"

# 2. 停掉線上服務
docker stop personal-ledger

# 3. 用還原的 volume 起服務
docker run -d --name ledger-restored --env-file .env \
  -v ledger-restore:/app/data personal-ledger:m4

# 4. 確認
docker logs ledger-restored | tail -5        # 應出現 "Ledger Bot runtime ready"
```

**`chown -R 100:101` 不能省。** 用 root 複製進去的檔案容器裡的 node 使用者寫不進去，服務會以
`attempt to write a readonly database` 啟動失敗——這是 M3b 之後某次驗收實際踩到的。

還原後的資料庫會被啟動流程自動升級到最新 schema，舊備份因此可以直接還原：演練用的是
schema 6 的備份，起來之後自動變成 7。

### 驗證還原結果

```bash
docker run --rm -v ledger-restore:/d:ro alpine:3 sh -c \
  "apk add --no-cache sqlite >/dev/null 2>&1; D=/d/personal-ledger.sqlite
   sqlite3 -readonly \$D 'PRAGMA integrity_check'
   sqlite3 -readonly \$D 'PRAGMA foreign_key_check'
   sqlite3 -readonly \$D 'SELECT max(version) FROM schema_migrations'
   for t in transactions allocations drafts input_events audit_events; do
     echo -n \"\$t=\"; sqlite3 -readonly \$D \"SELECT count(*) FROM \$t\"
   done"
```

### 收尾

```bash
docker rm -f ledger-restored
docker volume rm ledger-restore
docker start personal-ledger          # 把線上服務接回原本的 volume
```

真的要讓還原的資料上線，就把原 volume 改名保留（別刪），再把還原的 volume 掛上去。

## 2026-09-29 演練紀錄

在 `backups/keywords-0007-2026-09-26`（schema 6）上執行。

| 項目 | 結果 |
|---|---|
| 五份備份 `integrity_check` | 全部 `ok` |
| 還原後啟動 | `Ledger Bot runtime ready` |
| schema | 6 → 7（自動升級） |
| `integrity_check` / `foreign_key_check` | `ok` / 無錯 |
| 交易 / 配置 / 草稿 / 事件 / 稽核 | 7 / 8 / 12 / 14 / 8 |
| 還原耗時 | 10 秒 |
| 線上服務停機 | 40 秒 |
| 線上資料 | 演練前後一致，未受影響 |

## 尚未補上的缺口

1. **沒有自動化**。所有備份都是人工在 migration 前手動執行的。排程快照屬於 M5。
2. **沒有異地副本**。`backups/` 只存在這台機器上，且已被 `.gitignore` 排除。Google Drive
   每日快照屬於 M5。
3. **沒有排程演練**。`docs/roadmap.md` 第 5 節要求每週一次，本次是第一次執行。
4. **還原必須停機**。單一 Bot token 的必然結果。若要零停機驗證，需要第二組測試用 token。
5. **沒有保留政策**。目前五份備份全部留著，沒有輪替或刪除規則。

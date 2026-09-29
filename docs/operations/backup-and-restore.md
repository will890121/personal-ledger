# 備份與還原

狀態：第一版 2026-09-29 依實際演練寫成；2026-09-30 隨 M4 切到 WAL 更正並重新實測。
自動化排程與還原 CLI 屬於 M5，本文描述的是**目前手動可行且已驗證過的做法**。

## 資料在哪裡

| | |
|---|---|
| Docker volume | `m1-foundation-first-slice_ledger-data` |
| 檔案 | `personal-ledger.sqlite`（容器內 `/app/data/`） |
| 容器內擁有者 | uid 100 / gid 101 |
| `journal_mode` | `WAL`（M4 `src/db/database.ts` 開檔時設定）。`-wal`／`-shm` 兩個檔案會與主檔 `personal-ledger.sqlite` 並存在同一個目錄；已提交但還沒 checkpoint 的交易只存在 `-wal` 裡，**不在主檔案裡**。 |

## 備份

### 建議做法：`scripts/backup.sh`

```bash
./scripts/backup.sh              # 快照到 backups/<時間戳>/，保留最近 10 份
KEEP=20 ./scripts/backup.sh      # 改保留份數
```

它做三件事：`VACUUM INTO` 取一致快照、當場跑 `integrity_check`（驗證失敗就不留下檔案）、
刪掉超出保留份數的舊快照。**只刪自己產生的時間戳目錄**，手動命名的備份
（`m3b-upgrade-…` 之類）不動。

排程的話：

```bash
# 每天 03:00，crontab -e
0 3 * * * cd /Users/zhangyuwei/Documents/projects/personal-ledger && ./scripts/backup.sh >> /tmp/ledger-backup.log 2>&1
```

腳本刻意只用 bash 3.2 有的語法（macOS 內建就是 3.2，沒有 `mapfile`），變數後面接全形字元時
一律用 `${}` 界定——非 UTF-8 locale 下 bash 3.2 會把多位元組字元的首個位元組併進變數名。

**2026-09-30 更正：來源卷掛載不能加 `:ro`。** M4 切到 WAL 之後這支腳本一度整支壞掉——
`sqlite3 -readonly` 讀取來源資料庫時，即使只是唯讀查詢，SQLite 也要在同一個目錄建立
`-shm` 共享記憶體索引檔才能組出一致的讀取快照；掛成唯讀卷讓它連 `PRAGMA journal_mode`
都建不起來，直接報 `unable to open database file`。已把來源卷的掛載從
`-v "$VOLUME":/data:ro` 改成不加 `:ro`；真正的唯讀保護在 SQLite 連線層級的
`-readonly` 旗標，腳本本來就只送 `VACUUM INTO` 與 `PRAGMA`，不會寫回來源卷。
這是實測抓到的，不是預先設計好的——見下方「2026-09-30 WAL 演練紀錄」。

### 底層做法：`VACUUM INTO`（原子）

```bash
DEST=backups/$(date +%Y-%m-%d-%H%M)
mkdir -p "$DEST"
docker run --rm \
  -v m1-foundation-first-slice_ledger-data:/d \
  -v "$PWD/$DEST":/out \
  alpine:3 sh -c "apk add --no-cache sqlite >/dev/null 2>&1 &&
    sqlite3 -readonly /d/personal-ledger.sqlite \"VACUUM INTO '/out/personal-ledger.sqlite'\""
```

來源卷**不能**掛 `:ro`——原因見上方「2026-09-30 更正」。`VACUUM INTO` 由 SQLite 自己讀
一致的快照，服務不必停，也不會拷到寫到一半的狀態，在 WAL 下也正確涵蓋還沒 checkpoint
的已提交交易。輸出的檔案順帶被壓實過。已於 2026-09-29（`delete` 模式）及 2026-09-30
（WAL 模式）實測可用。

### 反面教材：直接複製 `.sqlite` 檔案

```bash
# 不要這樣做——見下方原因
docker run --rm -v m1-foundation-first-slice_ledger-data:/src:ro \
  -v "$PWD/backups/<名稱>":/dst alpine:3 cp /src/personal-ledger.sqlite /dst/
```

WAL 模式下這個做法**一律不安全**，而且不是「不夠原子」那種程度問題：即使完全沒有寫入
正在進行、也沒有任何鎖衝突，單獨複製 `.sqlite` 主檔案還是可能漏掉已經提交、但還躺在
`-wal` 裡尚未 checkpoint 的交易——因為那些資料本來就不在主檔案裡，複製主檔案這個動作
從頭到尾都碰不到它們。這不是「運氣不好撞上寫入中途」，而是只要 `-wal` 裡還有未
checkpoint 的已提交資料，複製結果就一定是舊的。2026-09-30 已用一段刻意保持連線、資料
只存在於 `-wal` 的插入來實測驗證：直接複製主檔案讀不到那筆資料，同一份資料用
`scripts/backup.sh` 的 `VACUUM INTO` 卻讀得到（見下方「2026-09-30 WAL 演練紀錄」）。
`-wal`／`-shm` 一起複製理論上可行，但沒有 SQLite 自己協調鎖與 checkpoint 的話仍然有拿到
不一致狀態的風險，不值得冒險——一律用 `scripts/backup.sh`。

**既有的五份手動備份仍然有效，不用重做。** `backups/` 底下 `m2-upgrade-2026-09-18`、
`m3a-upgrade-2026-09-24`、`m3b-upgrade-2026-09-24`、`keywords-upgrade-2026-09-26`、
`keywords-0007-2026-09-26` 這五份都是在 M4 切到 WAL **之前**、`journal_mode=delete` 的
年代拍的：`delete` 模式沒有 `-wal`，主檔案本身就是資料的全貌，上面說的風險不適用。
它們的 `PRAGMA integrity_check` 當時全部 `ok`，這個結論不需要因為之後切到 WAL 而重新
檢討。真正需要小心的只有**切到 WAL 之後**用直接複製拍的備份——目前沒有這樣的備份存在。

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

**還原出來的檔案 `journal_mode` 會是 `delete`，這是正常的，不是還原錯了。**
`scripts/backup.sh` 的 `VACUUM INTO` 產生的是一個全新的資料庫檔案，SQLite 不會把來源的
`journal_mode` 帶過去，新檔案一律從 `delete` 開始。2026-09-30 實測：還原出來的檔案直接用
`sqlite3` 開起來看是 `delete`；一旦被 `src/db/database.ts` 的 `openDatabase()` 開過一次
（也就是服務啟動流程本身），就會被設回 `WAL`——這一步在上面第 3 步「用還原的 volume 起
服務」就會自動發生，不用手動處理。下方「驗證還原結果」的腳本刻意在服務啟動**之前**查
`journal_mode`，看到 `delete` 才是預期結果；想看還原後的 WAL 狀態，要等第 3 步的容器
啟動之後再查。

### 驗證還原結果

```bash
docker run --rm -v ledger-restore:/d alpine:3 sh -c \
  "apk add --no-cache sqlite >/dev/null 2>&1; D=/d/personal-ledger.sqlite
   sqlite3 \$D 'PRAGMA journal_mode'
   sqlite3 \$D 'PRAGMA integrity_check'
   sqlite3 \$D 'PRAGMA foreign_key_check'
   sqlite3 \$D 'SELECT max(version) FROM schema_migrations'
   for t in transactions allocations drafts input_events audit_events; do
     echo -n \"\$t=\"; sqlite3 \$D \"SELECT count(*) FROM \$t\"
   done"
```

（掛載同樣不能加 `:ro`，理由同上；這裡查的是還原出來的獨立卷，跟線上資料無關。）

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

同日另外驗證了 `scripts/backup.sh`：連續執行產生的快照 `integrity_check` 全部 `ok`，
`KEEP=2` 正確刪除逾期的時間戳快照而未動到手動命名的備份，最新一份快照還原後
`integrity_check`、`foreign_key_check` 皆通過，schema 7、資料筆數正確。

## 2026-09-30 WAL 演練紀錄

M4 切到 WAL 之後重新驗證備份與還原全流程。沙盒環境的權限規則禁止用寫入模式掛載共用的
`m1-foundation-first-slice_ledger-data` 卷，所以下列演練是在一份**位元組完全相同的私有
複本卷**（用唯讀掛載從正式卷複製主檔案得到，複製當下正式卷沒有進行中的寫入）上做的，
不影響正式測試資料；複本用完即刪。

1. **先用目前分支的程式把卷升級到最新 schema。** 用現行程式碼建置的 image 以
   `LEDGER_STARTUP_CHECK=1` 開一次，migration 前自動拍照，套用 `0008_outbox.sql`，
   schema 7 → 8；升級後直接查詢（不透過應用程式）確認 `journal_mode` 已是 `wal`。
2. **發現 `scripts/backup.sh` 在 WAL 下整支壞掉**：來源卷掛 `:ro` 讓 `-shm` 建不起來，見
   上方「2026-09-30 更正」。修正掛載後複測通過。
3. **驗證直接複製檔案在 WAL 下確實會漏資料**：在複本卷上啟動一個刻意保持連線的寫入
   （插入一筆 `input_events`、提交後不關閉連線、原地等待），確認資料只存在於 `-wal`
   （主檔案大小不變、`-wal` 從 0 長到有內容）。此時：
   - 直接 `cp` 主檔案 → 用獨立連線查該筆資料，`count = 0`（**證實會漏資料**）。
   - 用修正後的 `scripts/backup.sh` 拍照 → 同一筆資料 `count = 1`，且
     `integrity_check ok`（**證實 `VACUUM INTO` 不受影響**）。
4. **還原演練**：把上一步的快照還原到新建的臨時卷，**在應用程式碰它之前**直接查
   `journal_mode`，結果是 `delete`（印證上方「還原檔案的 journal_mode」段落，`VACUUM INTO`
   產生的新檔案不會帶著來源的 journal_mode）；`integrity_check`／`foreign_key_check`
   皆乾淨，schema 8，交易 7、配置 8、草稿 23、事件 36、稽核 8。接著用目前分支建置的
   image 對這個臨時卷跑一次 `LEDGER_STARTUP_CHECK=1`，之後再查 `journal_mode`，變成
   `wal`——確認是 `src/db/database.ts` 開檔時設定的，不是還原壞了。

| 項目 | 結果 |
|---|---|
| 正式卷（升級後）`journal_mode` | `wal` |
| `scripts/backup.sh`（修正後）在 WAL 下拍照 | 成功、`integrity_check ok` |
| 直接 `cp` 漏掉仍在 `-wal` 的已提交資料 | 證實會漏（`count 0` vs `VACUUM INTO` 的 `count 1`） |
| 還原快照、應用程式開檔前 `journal_mode` | `delete`（預期內） |
| 還原快照、應用程式開檔後 `journal_mode` | `wal` |
| 還原後 `integrity_check` / `foreign_key_check` | `ok` / 無錯 |
| 還原後 schema | `8` |
| 交易 / 配置 / 草稿 / 事件 / 稽核 | 7 / 8 / 23 / 36 / 8 |

## 尚未補上的缺口

1. **沒有排程**。`scripts/backup.sh` 已經可用，但還沒掛上 cron，仍然要人工執行。
2. **沒有異地副本**。`backups/` 只存在這台機器上，且已被 `.gitignore` 排除。Google Drive
   每日快照屬於 M5。
3. **沒有排程演練**。`docs/roadmap.md` 第 5 節要求每週一次，本次是第一次執行。
4. **還原必須停機**。單一 Bot token 的必然結果。若要零停機驗證，需要第二組測試用 token。
5. ~~沒有保留政策~~。`scripts/backup.sh` 保留最近 `KEEP` 份（預設 10）；`backups/` 底下
   手動命名的那五份不受規則管理，要清要自己來。

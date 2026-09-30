# M4 驗收證據：可靠性、工作佇列與可觀測性

日期：2026-09-30

對象：SQLite 持久化 outbox（migration `0008_outbox.sql`）、lease／指數退避／`needs_attention`、
啟動恢復與 crash recovery、`/status`、異常通知、正式環境日誌遮罩、migration 前備份、
`WAL` + `synchronous=FULL`、`/help` 語法範例補齊。共 42 個 commit（`main...m4-reliability`）。

## 關卡一：自動驗證

- `pnpm check` **exit 0**：72 檔 / **496 測試**（M3b 結案時的起點是 384）。以 Docker 內
  `pnpm check` 的**離開碼**確認，不看 grep 過的輸出——`user-category-keywords-acceptance.md`
  記錄過 grep 漏看單數 `1 problem` 導致誤判全綠的教訓，這次全程只看 exit code。
- Docker 建置：`docker build` 通過（Dockerfile 的 `build` 階段本身就跑
  `pnpm typecheck && pnpm test:run && pnpm build`，等於在 image 建置過程裡又跑了一次全量
  測試）。`LEDGER_STARTUP_CHECK=1` 啟動檢查通過，日誌印出
  `Ledger Bot runtime ready`，未套用中的 migration 為 0（schema 已在 8）。
- **AC-20（確認後程式立即重啟，不遺失或重複交易）**：
  `tests/telegram/outbox-confirm.test.ts` 驗證帳本寫入與待送訊息在同一個 transaction 提交，
  程序死掉時「帳記了、人不知道」的視窗被消除；`tests/telegram/outbox-runner.test.ts` 的
  `"delivers a row left behind by a process that died mid-flight"`、
  `"re-sends when the process dies after sending but before marking delivered"`、
  `"does not deliver the same row twice when a drain overlaps the fast path"` 三案例直接針對
  「重啟後恢復、不重複遞送」建模。
- **AC-23（工作超過重試上限，進入 `needs_attention` 並通知）**：
  `tests/telegram/outbox-runner.test.ts` 的 `"stops after the retry cap and asks for attention"`
  驗證超過 `MAX_ATTEMPTS`（`src/domain/outbox.ts`，值為 5）後轉入 `needs_attention`，不再自動
  重試；`tests/telegram/notify-attention.test.ts` 涵蓋首次告警、10 分鐘節流、節流期滿後再告警、
  告警本身失敗不消耗節流窗、告警內容不含財務原文。
- **AC-24（migration 失敗，使用升級前快照，不以半升級狀態啟動）**：
  `tests/db/pre-migration-snapshot.test.ts` 涵蓋「只在真的有待套用 migration 時才拍照」
  （不然每次正常重啟都會留下用不到的快照）、「快照涵蓋還躺在 WAL 裡的資料」
  （`"captures data still sitting in the write-ahead log"`）、「目標版本跨兩位數時仍保留最新
  快照，不被字典序排序騙走」、「只保留最近三份」、「migration 失敗後快照仍在」。
  `src/main.ts` 在有待套用 migration 時才呼叫 `takePreMigrationSnapshot`，失敗即不啟動。
  **接線本身也被守住**：`tests/smoke/runtime.test.ts` 真的跑過 `composeRuntime`，確認快照在
  migration **之前**產生（快照內容仍是 schema 1），且快照失敗會讓啟動中止、資料庫留在
  升級前的版本。這兩條是 2026-09-30 整體審查後補的——在那之前，把快照挪到 `migrate()`
  之後、或把快照失敗吞掉，兩個變異都能存活全部 496 條測試。
- **AC-28（正式環境發生錯誤，log 不含完整財務原文或憑證）**：`src/logger.ts` 是全專案唯一
  允許呼叫 `console.*` 的地方（`eslint.config.mjs` 只對它開例外），其餘一律經過這裡才會被
  遮罩規則管到。`tests/logger.test.ts` 涵蓋：bot token 樣式偵測（即使沒放在拒絕清單的欄位裡也
  抓得到）、owner id／chat id 一律雜湊成短碼、`rawText`／`rawInputSnapshot`／`text`／`note`／
  `token`／`telegramBotToken` 等欄位整值丟棄、遞迴進巢狀物件與陣列元素、自我參照物件不會讓
  遮罩邏輯卡死（cycle guard）、深度超過 `MAX_REDACTION_DEPTH`（8 層）的分支換成明確佔位字串而
  非原樣印出——最後這條在本次任務前一個 commit（`ededc9e`）才補上變異測試釘住，之前的實作
  雖然正確但沒有測試會在「拿掉深度上限」時變紅。
  另外兩處是 2026-09-30 整體審查後補上的：`error` 鍵的值原本繞過遮罩（見關卡二 I4），
  以及背景工作的未捕捉拒絕原本會讓 Node runtime 把 stack trace 直接印到 stderr、
  完全不經過這裡（見關卡二 C1）——後者讓「`src/logger.ts` 是唯一出口」這句話在修好之前
  其實並不成立。
- 既有資料經 migration 0008 後完整保留：2026-09-30 用一份私有複本卷（位元組同於正式測試資料
  卷，做法見下方「額外條件」）從 schema 7 升到 8，`foreign_key_check` 無錯誤，交易 7、配置 8、
  草稿 23、事件 36、稽核 8 筆全部保留。
- `src/domain/ledger-summary.ts` 與 migration `0001`–`0007` 在本分支未被修改：
  `git diff main...m4-reliability --stat -- src/domain/ledger-summary.ts 'src/db/migrations/000[1-7]*.sql'`
  沒有輸出。

### 額外條件：切到 WAL 之後 `scripts/backup.sh` 仍可用

這條驗證中途發現一個真的壞掉的地方，過程與結論都寫在
[`docs/operations/backup-and-restore.md`](../operations/backup-and-restore.md) 的
「2026-09-30 WAL 演練紀錄」，這裡只摘要結論：

1. `scripts/backup.sh` 原本把來源卷掛 `:ro`。M4 切到 WAL 之後，即使只是唯讀讀取，SQLite
   也要建立 `-shm` 共享記憶體索引檔才能組出一致快照，掛成唯讀卷讓它連
   `PRAGMA journal_mode` 都開不起來，直接報 `unable to open database file`。**這支腳本在
   WAL 下曾經整支壞掉，不是文件寫錯而已。** 已修正掛載方式（拿掉 `:ro`，唯讀保護改由
   SQLite 連線層級的 `-readonly` 旗標負責），修正後複測通過。
2. 直接複製 `.sqlite` 主檔案在 WAL 下確實會漏資料——用一段刻意保持連線、資料只存在於
   `-wal` 的插入實測驗證：直接 `cp` 讀不到那筆資料，修正後的 `scripts/backup.sh` 讀得到。
3. 沙盒環境的權限規則不允許對共用的 `m1-foundation-first-slice_ledger-data` 卷做寫入模式
   掛載，因此上述演練是在一份唯讀複製出來、位元組相同的私有卷上做的，正式測試資料本身
   全程只被讀取，未被寫入或修改；正式卷仍照常從 schema 7 升級到 8（這一步是唯讀掛載以外
   的正常應用程式啟動流程，不受此限）。
4. 還原後：`integrity_check`／`foreign_key_check` 通過；快照檔案本身的 `journal_mode` 是
   `delete`（`VACUUM INTO` 產生全新檔案，不會帶著來源的 journal_mode），這是**預期行為**，
   不是還原壞了；應用程式（`src/db/database.ts` 的 `openDatabase()`）開檔一次之後會設回
   `wal`，已實測確認。

## 關卡二：程式審查

**已完成。** 每個任務各有一輪審查與（必要時）修正複審，最後對整個分支再做一次整體審查。

### 整分支最終審查（2026-09-30）

範圍 `3e86d89..73a4a12`，45 個 commit、66 個檔案、+4774／-195。審查員跑了 **35 個變異，
29 個被測試殺死、6 個存活**，外加 6 支拋棄式行為探針。結論是 **changes needed**，
六項必修，全部經實測重現，已於 `53d163b`..`0d3de29` 七個 commit 修完。

必修項與修法：

| # | 問題 | 使用者會遇到什麼 | 修法 |
|---|---|---|---|
| C1 | 背景 drain 的 promise 拒絕沒有 `.catch()`，Node 24 預設會終止行程；stack 由 runtime 直接印到 stderr，**繞過 `src/logger.ts`** | 資料卷寫滿或任何 SQLite I/O 錯誤時，`restart: unless-stopped` 讓 bot 每 5 秒被殺一次，成為 crash loop | 源頭加 `.catch()` 記錄；`main.ts` 再加 `unhandledRejection` 防護，記錄但不結束行程 |
| I1 | `LEASE_MS` 30 秒遠短於 grammY 預設的 500 秒 API timeout | 網路慢但沒斷時，連線恢復後一次收到 3–6 則相同訊息 | 送出傳入 20 秒的 `AbortSignal`（短於 lease）；不動全域 `timeoutSeconds`，那會一併套用到 getUpdates 長輪詢 |
| I2 | 三個 `markOutbox*` 沒有 compare-and-set | 訊息其實已送達，`/status` 仍顯示「待處理 ⚠️」並告警，按「重試全部」會真的再送一次 | 以 claim 當下寫入的 `lease_expires_at` 當樂觀鎖版本值；更新 0 列代表已被接手，記錄後繼續 |
| I3 | `main.ts` 的快照接線零測試 | —（行為本來就正確，風險是日後回歸無人攔阻） | `tests/smoke/runtime.test.ts` 補兩條斷言，真的經過 `composeRuntime` |
| I4 | logger 的 `error` 鍵繞過遮罩 | 目前不可達，但 `error` 正是最可能被未來呼叫端塞進髒東西的鍵名 | `describeError` 的結果再過一次字串遮罩 |
| I5 | 真實 SQL 的 `status = 'pending'` 述詞零覆蓋 | —（「重啟不會自動重設 `needs_attention`」原本只在測試替身上被守住） | 真實 SQLite 上 seed 一列 `needs_attention`，斷言 claim 撈不到 |

另修一項 Minor：「重試全部」原本先跑完整個 drain 才回答 callback query，半通不通時
按鈕會一直轉圈；改成先回答再 drain。

C1、I1、I2 三項都是**跨任務才看得見**的缺陷——每個任務單獨看都正確，要把 lease、
grammY 的預設 timeout、以及「lease 可能在送出途中過期」三件事放在一起才浮現。
單任務審查對這一類問題結構性失明，這也是整體審查存在的理由。

### 不擋 merge、已記入 M5 待辦

runner 對 429 `retry_after` 的消費無測試（只測了 classifier）、`main` 不呼叫
`registerCommandMenu` 不會變紅、`LEASE_MS` 改成 1ms 不會變紅、原子性「反向」那一半
無測試（行為已由探針驗證正確）、`scripts/backup.sh` 現在以可寫模式掛載正式卷
（已文件化的取捨，原因見備份文件）。

### 已知殘餘風險（AC-28）

`describeError` 會保留 `Error.message` 與 `GrammyError.description` 的內容——這是刻意的，
沒有它就查不出任何錯誤原因。遮罩能攔下 bot token（有明確樣式），但**財務原文沒有
值層級的樣式可以偵測**。因此若日後有人寫出 ``new Error(`...${使用者輸入}`)``，那段原文
會進 log。2026-09-30 逐一檢查過 `src/` 所有帶插值的 `new Error`，沒有任何一個帶入
使用者輸入或憑證；非本專案拋出的錯誤只會記下類別名稱。這一點沒有自動測試攔阻，
新增錯誤訊息時請自行留意。

## 關卡三：人工 Telegram 驗收

以下清單由人在真實 Telegram 對話中對照執行，不需要讀程式碼。每一列先做「動作」欄寫的事，
再對照「預期看到的畫面／行為」欄核對是否相符，最後在「結果」欄填 ✅ 或 ❌（❌ 請附截圖或
訊息原文，並在此文件下方補一段「驗收期間發現的缺陷」）。使用的資料是既有的測試／開發資料，
沒有正式帳本，不需要先做資料複本；建議在開始前執行一次 `./scripts/backup.sh` 留一份時間點，
方便萬一要回溯。

| # | 怎麼做 | 應該看到什麼 | 結果 |
|---|---|---|---|
| 1 | 在 Telegram 對 Bot 傳 `午餐 120`，出現預覽後按「確認」 | 立刻收到「已入帳」之類的成功訊息，跟切到 WAL 之前的體驗沒有差別（不會變慢、不會沒反應） | |
| 2 | 傳 `/status` | 訊息裡「待送」顯示 0、「待處理」顯示 0，有「最後成功遞送時間」的欄位且是不久前的時間，schema 版本顯示 8 | |
| 3 | 把手機或執行 Bot 的主機斷開網路連線（讓 Bot 連不上 Telegram），斷網期間傳一筆帳，例如 `咖啡 60` | 帳本這邊要記得住：恢復連線後用 `/recent` 查得到這筆交易；斷網期間傳 `/status`（若還連得上內部服務）應顯示「待送」變成 1 | |
| 4 | 恢復網路連線，等待約 15 秒 | 剛剛卡住沒送出的確認訊息會自動補送出來；再傳一次 `/status`，「待送」應該回到 0 | |
| 5 | 再次斷網，這次維持斷網狀態至少 10 分鐘，期間傳一筆帳並確認 | 系統會嘗試重送多次（指數退避），10 分鐘後仍送不出去的話會收到一則類似「有一則訊息一直送不出去」的通知；`/status` 的「待處理」顯示 1 | |
| 6 | 傳 `/status`，在跳出的訊息上按「重試全部」按鈕 | 之前卡住的訊息應該補送出來，`/status` 的「待處理」歸零 | |
| 7 | 傳一筆帳並按下「確認」，在確認的**當下**立刻對執行 Bot 的容器下 `docker kill`（越接近按下確認的瞬間越好），然後重啟容器 | 容器重啟之後，剛才那筆確認訊息會補送出來；用 `/recent` 檢查，這筆交易**只出現一次**，沒有因為中途被殺掉而重複記帳 | |
| 8 | 傳 `/help` | 訊息內容先講「怎麼打字輸入」（輸入語法與範例），後面才列出各個指令；在 Telegram 輸入框打一個 `/` 會跳出指令選單（不是文字說明，是 Telegram 原生的指令選單 UI） | |
| 9 | 傳 `/status`，在跳出的訊息上按「關閉清單」 | 那則 `/status` 訊息應該被刪除或消失，不會留在對話裡 | |
| 10 | 在執行 Bot 的主機上執行 `docker logs <容器名稱>`，把輸出從頭到尾看過一遍 | 完全找不到：Telegram bot token（一長串數字:英數字的字串）、owner 的 Telegram id（應該是雜湊過的短碼，不是原始數字）、任何一筆帳的財務原文（金額、商家、備註等使用者輸入的文字） | |

### 驗收期間發現的缺陷

（人工驗收執行後在此補上；依完成定義，發現的缺陷一律先補回歸測試再修，不直接改行為。）

## 結論

自動驗證與備份／還原的額外條件已完成並記錄；程式審查與人工 Telegram 驗收待後續執行後
補上結論。

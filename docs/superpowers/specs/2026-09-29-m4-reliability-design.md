# M4 設計：可靠性、工作佇列與可觀測性

日期：2026-09-29
里程碑：`docs/roadmap.md` M4
通過條件：AC-20、AC-23、AC-24、AC-28；在確認後強制終止程序也不遺失或重複交易

## 1. 要解決什麼

交易在資料庫提交之後、Telegram 訊息送出之前，存在一個窗口。行程若在這裡死掉，帳已經記了，
使用者卻什麼都沒看到。這是 M4 當下唯一真實存在的非同步工作，也是 AC-20 描述的情境。

規格 §16.1 說「AI 解析、Sheet 同步與校正、備份、通知及外部服務重試都必須先寫入 `jobs`」，
但那五類工作裡 **Sheet 同步與備份在 M5、AI 在 M7**。因此 M4 **不蓋通用工作佇列**：

> 只做 Telegram 遞送 outbox。lease、指數退避、重試上限、`needs_attention` 都做，但只服務
> 這一種工作。M5 帶來 Sheet 同步這個真正需要重試的消費者時，再抽成多型別。

理由是每一行程式都要有真實消費者在驗證它。沒有消費者的通用機制，設計的是想像中的需求，
等真正的需求到了通常還是要改。代價是 M5 要做一次重構，這個代價是明確且可接受的。

### 探索時發現的三個規格與實作落差

1. **規格說 WAL，實際是 `delete`。** §15.2 要求 WAL，`openDatabase` 只設了 `foreign_keys`。
2. **規格說 migration 前要備份，程式沒做。** §15.2 要求「啟動時先備份，再自動執行尚未套用的
   migration」。AC-24 的另一半（失敗不以半升級狀態啟動）已經成立：migrate 拋錯會中止啟動。
3. **冪等已有基礎。** `input_events` 有 `ON CONFLICT (telegram_update_id) DO NOTHING`，
   `confirmDraft` 也有「確認兩次只產生一筆交易」的測試。

三項都納入本次範圍。

## 2. 遞送保證的邊界

**所有帳本變更**都綁上遞送保證：確認草稿、記錄回收、放棄回收、修改交易、軟刪除交易。

規則要單純到好記：**帳本一旦變了，使用者就一定會收到訊息。** 只保證其中一種會讓帳本出現兩
種可靠度，日後沒有人記得哪些有保證。

純 UI 訊息（分類追問、預覽、清單）**不走 outbox**。崩潰重啟後補送一堆過期的追問，那些訊息
的按鈕指向已經不存在的狀態，反而是誤導。

**outbox 卡住永遠不影響帳本。** 交易在 commit 當下就存在，outbox 只管「有沒有告訴你」。
最壞情況是沒收到確認訊息，`/recent` 仍然查得到。

## 3. 資料表

migration `0008_outbox.sql`：

```sql
CREATE TABLE outbox_messages (
  message_id        TEXT PRIMARY KEY,
  owner_id          TEXT NOT NULL,
  -- 這一則訊息是哪一種帳本變更造成的，供 /status 與事後追查
  cause             TEXT NOT NULL CHECK (cause IN (
                      'transaction_confirmed','recovery_recorded','advance_abandoned',
                      'transaction_updated','transaction_deleted')),
  chat_id           TEXT NOT NULL,
  -- 有值＝編輯既有訊息，NULL＝送新訊息
  target_message_id TEXT,
  text              TEXT NOT NULL,
  reply_markup      TEXT,
  status            TEXT NOT NULL CHECK (status IN ('pending','delivered','needs_attention')),
  attempts          INTEGER NOT NULL DEFAULT 0,
  next_attempt_at   TEXT NOT NULL,
  lease_expires_at  TEXT,
  last_error        TEXT,
  created_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  delivered_at      TEXT
);
CREATE INDEX outbox_pending_idx ON outbox_messages(status, next_attempt_at);
```

## 4. 生命週期

1. 帳本變更與 outbox 列在**同一個 SQLite transaction** 提交（`pending`、`next_attempt_at=now`）。
   兩者不可能只有一半。
2. 提交後立刻嘗試遞送：取 lease → 送出 → 標 `delivered`。使用者體感與現在相同，沒有輪詢延遲。
3. 送失敗：釋放 lease、`attempts+1`、`next_attempt_at` 設為退避後的時間。
4. 背景迴圈每 5 秒撈 `status='pending' AND next_attempt_at<=now AND (lease 為空或已過期)` 來送。

**「啟動恢復」沒有獨立的程式路徑。** 死掉的行程留下過期 lease，迴圈啟動後照常規則就撈得到。
AC-20 因此是這個迴圈的自然行為，不是另一段開機邏輯——少一條只在崩潰後才執行、平常沒人測
的程式路徑。

**單一行程仍然需要 lease**：它同時擋住「快速路徑與背景迴圈同時送同一列」。

**`delivered` 的列保留不刪。** 一天幾筆的量級下，它們是「最後成功遞送時間」的來源，也是
事後追查「這筆交易當初到底有沒有通知到」的唯一依據。真的長到需要清理時再處理，那時會有
實際的筆數可以判斷該留多久——現在訂保留期只是猜。

### 分層：渲染函式

確認後的回覆是 `已入帳：TWD 300\n交易 ID：<id>`，而 `transactionId` 是 `confirmDraft` 在 commit
當下才產生的——telegram 層無法事先把文字渲染好交給 application 層。

因此 application 命令多收一個**渲染函式** `renderDelivery: (result) => OutboxPayload`，在
transaction 內呼叫，把回傳的 `{chatId, targetMessageId?, text, replyMarkup?}` 原樣存進 outbox。
application 與 domain 仍然完全不認得 grammY：它們只是存字串，渲染與傳送都留在 telegram 層。

**存渲染結果，不存參照。** 崩潰重啟後重新渲染可能得到不同輸出（分類被改名、關鍵字被刪），
但使用者該收到的是當初那一則。

## 5. 失敗處理

| 情況 | 處理 |
|---|---|
| 網路錯誤、5xx、逾時 | 重試（退避） |
| 429 Too Many Requests | 重試，遵守 `retry_after`，不套用自己的退避 |
| `message is not modified` | 標 `delivered`。內容相同代表訊息已經在那裡，不是失敗 |
| `message to edit not found` / `can't be edited` | 退回送新訊息，不計入失敗次數 |
| 403 使用者封鎖、400 chat not found | 不重試，直接 `needs_attention` |
| 其他未知錯誤 | 重試到上限 |

**退避**：`min(5s × 3^(attempts-1), 5min)`，上限 **5 次**。各次間隔為
5s／15s／45s／2m15s／5m，從第一次失敗到放棄約 **8 分鐘**。不加 jitter：只有一個行程、
一條佇列，沒有 thundering herd。

**為什麼是 8 分鐘而不是更久。** 撐得過去的是網路抖動與 Telegram 短暫故障，那是秒到分鐘的
量級；超過幾分鐘就不是抖動，而是真的斷了。而真的斷線時 long polling 也收不到訊息，bot 整個
是停擺的——outbox 不是承受長時間斷線的正確層級。與其安靜地重試 40 分鐘，不如早點讓使用者
知道「這則沒送到」。放棄的成本很低：`/status` 上有「重試全部」，連線回來按一下就好。

這滿足規格 §16.2 的兩條禁令：不無限重試（有上限），不在第一次暫時性失敗就通知（只在用盡時）。

### `needs_attention` 與通知（AC-23）

列進入 `needs_attention` 時記下 `last_error`，並嘗試通知使用者。

**正在壞掉的就是 Telegram 這條管道，通知多半也送不出去。** 因此：

- 通知是**盡力而為的直接傳送**，不寫成另一列 outbox——否則管道壞掉會生出無窮無盡的失敗通知。
- 通知本身失敗就記進日誌（遮罩過），不重試。
- **`/status` 是真正的後備管道**：Telegram 恢復後，使用者下次打 `/status` 就看得到積壓。
- **節流**：`settings` 的 `outbox_last_alert_at` 記最後通知時間，10 分鐘內不重複發，避免連環
  失敗洗版。

**重啟不會自動重設 `needs_attention`。** 重啟通常代表連線回來了，看似可以順手重送，但那等於
把「不無限重試」這條規則從後門繞過去，而且使用者可能早就用 `/recent` 確認過那筆交易。要重送
就明確按「重試全部」。

### 回頭路

`/status` 提供「重試全部」，把 `needs_attention` 重設為 `pending`、`attempts=0`。

少了這個，一次暫時性斷線耗盡重試之後那則訊息就永遠卡著。這與本專案在自訂關鍵字上犯過的
「教錯了沒有出路」是同一種錯（見 `docs/quality/user-category-keywords-acceptance.md` 審查
意見 2），不重蹈。

## 6. `/status`

只講 outbox 健康度，不做成儀表板：

```
待送 2 筆（最舊 3 分鐘前）
待處理 1 筆 ⚠️
最後成功遞送：14:32
schema 版本：8

⚠️ 確認交易 · 14:05 · 已重試 5 次
   Telegram 回應 403

[重試全部][關閉清單]
```

關閉鍵與 `/pending`、`/advances`、`/recent`、`/keywords` 一致。

## 6b. 附帶項目：`/help` 與指令選單

**與可靠性無關，不列入 AC-20／23／24／28，也不進通過條件。** 放進 M4 只因為它與 `/status`
同屬「關於 bot 自己」的後設指令，而 M4 本來就要動指令表面，成本又只有一個 handler。

三件事：

**一、`/help` 以輸入語法為主，指令清單為輔。** 這個 bot 的主要介面是自由文字而不是指令；
真正會忘記的是能打什麼句子，不是那七個指令。內容依序為：

```
記一筆
  午餐 120
  薪水 +85000
  昨天 Uber 245 國泰卡
  台新轉國泰 5000 手續費 15

分帳與代墊
  午餐 1260，小明欠 630
  午餐 1000，三個人平分
  小明還 300

一次多筆
  午餐 120，Uber 245

指令
  /pending /advances /recent /today /month /keywords /status
```

**二、啟動時呼叫 `setMyCommands`。** 目前完全沒用這個 API。註冊之後使用者在輸入框打 `/`
就會跳出指令選單——沒有人會自己發現 `/help` 存在，但 `/` 選單是自己冒出來的。

**三、指令清單只有一份定義。** 新增 `src/telegram/commands.ts` 匯出唯一的指令陣列（名稱與
一行說明），`/help` 的文字、`setMyCommands` 的參數、handler 註冊三者都讀它。

第三點是本專案已經重複踩到三次的同一種錯：分類名稱兩份（「午餐／午餐」）、配置渲染兩份
（`/recent` 停在舊版型）、四支清單指令只有三支有關閉鍵。手寫的 `/help` 清單一定會跟實際註冊
的指令漂移，單一來源讓「新增指令時忘記更新 help」不可能發生。

## 7. 耐久度：WAL

`openDatabase` 改為 `journal_mode=WAL` + `synchronous=FULL`。

規格 §15.2 本來就要求 WAL。`synchronous=FULL` 是在其上的加碼：`NORMAL` 在**主機斷電**時可能
丟掉最近幾筆已提交交易，`FULL` 不會。這是帳本，而寫入量是一天幾筆，fsync 成本無關緊要。

**連帶要改文件。** `docs/operations/backup-and-restore.md` 目前寫「`journal_mode=delete`，
沒有 `-wal`／`-shm` 需要一起備份」。改 WAL 之後直接複製 `.sqlite` 會漏掉還在 WAL 裡的已提交
資料。`scripts/backup.sh` 用的 `VACUUM INTO` 本來就 WAL-safe，要改的是文件與「直接複製檔案」
那一段的適用性說明。

## 8. Migration 前備份（AC-24）

啟動時**若有未套用的 migration**（沒有就不拍，免得每次重啟都留一份），先以 `VACUUM INTO`
拍一份到 `<資料目錄>/pre-migration/<目標版本>-<時間戳>.sqlite`，再執行 migration。失敗時啟動
中止（現行行為），並在日誌指出快照位置。保留最近 3 份。

**快照與正本在同一個 volume**，volume 整個損毀兩者都沒了。它的用途是 migration 回滾，不是
災難復原；災難復原是 `scripts/backup.sh` 與 M5 的異地副本。

## 9. 日誌遮罩（AC-28）

目前 log 散在 `main.ts` 與 `create-bot.ts` 四處各寫各的。改為單一 `logger` 模組，所有輸出都過
一次遮罩：

- **Bot token**：比對 token 樣式一律換成 `***`
- **owner id**：只印短雜湊
- **財務原文**：`rawInputSnapshot` 與訊息內容一律不印；需要關聯時印 `draft_ref` 或 `message_id`
- **SQL**：只印錯誤類別，不印語句與參數

## 10. 測試策略

| 層級 | 內容 |
|---|---|
| 單元 | 退避計算、錯誤分類（重試／放棄／不算失敗三類）、lease 取得與過期 |
| Repository | **原子性**：帳本寫入失敗則 outbox 列不存在，反之亦然 |
| 恢復 | 插入一列 lease 已過期的 pending，跑迴圈 → 送出（AC-20 的重啟恢復） |
| 端到端 | 確認草稿但遞送丟例外 → 交易存在且 outbox 為 pending；跑迴圈 → delivered |
| 冪等 | 重複 callback → 一筆交易、一列 outbox |
| 通知 | 用盡重試 → 進 `needs_attention` 並發出一則通知；10 分鐘內第二次不重複發（AC-23） |
| 遮罩 | 餵入同時含 token 與財務原文的真實錯誤，斷言輸出兩者都不存在（AC-28） |
| Migration | 有待套用時產生快照；migration 失敗則啟動中止且快照留著（AC-24） |
| 指令清單 | `/help` 的指令段落與 `setMyCommands` 的參數都由 `commands.ts` 導出，且涵蓋每一支已註冊的指令（附帶項目） |

## 11. 不在本次範圍

- 通用多型別工作佇列（M5 帶 Sheet 同步時再抽）
- Google Sheets 鏡像、異地備份（M5）
- AI 解析工作（M7）
- webhook 模式（規格 §15.1 允許，但本機 long polling 沒有需求）

## 12. 完成定義

沿用 M3b 建立的三道關卡（`docs/superpowers/plans/2026-09-24-m3b-advances-and-recovery.md`）：

1. **自動驗證**：AC-20、AC-23、AC-24、AC-28 的自動測試通過；`pnpm check` exit 0（看結束碼，
   不看 grep 過的輸出）；Docker 建置與啟動檢查通過。
2. **程式審查**：對整個分支的 diff 執行 `superpowers:requesting-code-review`，逐條裁決。
3. **人工 Telegram 驗收**：逐項完成清單並記錄；期間發現的缺陷一律先補回歸測試再修。

額外條件：

- 既有資料經 migration 0008 後完整保留，`foreign_key_check` 無錯誤。
- 切換 WAL 之後，`scripts/backup.sh` 產生的快照仍可還原並通過 `integrity_check`。
- `src/domain/ledger-summary.ts` 與 migrations 0001–0007 不得修改。

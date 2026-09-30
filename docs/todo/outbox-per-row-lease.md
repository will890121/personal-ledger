# 待辦：outbox 改成逐列續租，讓「一列最多送兩次」成為嚴格保證

提出時間：2026-09-30（M4 最終審查修正的第二輪，N2）

## 現況

`src/telegram/outbox-runner.ts` 的 `drainOnce()` 用**同一個** `leaseUntil` 一口氣 claim 最多
`BATCH`（10）列，然後**循序**送出。每個送出呼叫帶一個 `SEND_TIMEOUT_MS`（20 秒）的
`AbortSignal`，而 `LEASE_MS` 是 30 秒。

於是：

- **一次送出**有界（`SEND_TIMEOUT_MS < LEASE_MS`）。
- **一列**不是嚴格有界。整批共用一個 lease，排在後段的列，lease 可能在輪到它送的途中就
  過期，被下一輪 drain（每 5 秒一次）重新 claim。

實測：3 列卡住時，**每列 2 次併發送出**。加上 `SEND_TIMEOUT_MS` 之前是 6 次——也就是說
M4 這一輪把最壞情況從 6 降到 2，拿到了大部分的收益，但沒有把它變成嚴格保證。

**資料狀態不受影響**：遲到的 worker 手上是過期的 lease 值，三個 `markOutbox*` 的
compare-and-set 會擋掉它的寫入，告警也一併被擋（`notifyIfOwned`）。使用者會看見的只有
「同一則訊息送兩次」，而且僅限沒有 `targetMessageId` 的訊息——有 target 的重複會被
Telegram 用 `message is not modified` 擋掉，`delivery-error.ts` 正確地把它當成已送達。
所以這是**使用者體驗上的瑕疵，不是資料正確性問題**，才沒有在 M4 收尾時硬改。

## 要做什麼

在每一列送出**之前**重新續租那一列，而不是整批共用一個 lease。續租必須連 lease token
一起更新，因為那個值同時是三個 `markOutbox*` 的 compare-and-set 版本值——續租之後，
這一次遞送要用新的 token 才寫得進去。

大致形狀（不是定案）：

- repository 加一個 `renewOutboxLease(messageId, currentToken, newLeaseUntil): Promise<boolean>`，
  本身也是 CAS：`WHERE message_id = ? AND lease_expires_at IS ?`。
- runner 在迴圈裡對每一列先續租；續租回傳 false 代表這一列已經被別人接手，直接跳過，
  不要送。
- `FakeLedgerRepository` 同步實作，語意逐字對齊（這個里程碑已經被替身漂移咬過）。

## 為什麼要獨立成一個 task

這是對並發核心的設計變更：多一次每列的資料庫寫入、多一個 CAS 的版本值轉移點，
還要重新想清楚「續租失敗」與「送出途中續租」的交互。它需要自己的測試與審查，
不適合塞在修正輪的尾巴。

## 完成的判準

- 有一條測試釘住「一列在一次 drain 內不會因為批次位置而被重新 claim」。
- `outbox-runner.ts` 檔頭那段「重複的界線」可以把第二條從「不是嚴格有界」改寫成嚴格保證，
  而且那句話有測試在守——不要再出現一句沒有人檢查的斷言。

# M5a 驗收證據：Google Sheets 鏡像

日期：2026-10-01

對象：帳本單向鏡像到一張 Google Sheet 的 `Transactions`／`Allocations`／`MonthlySummary`
三張分頁。收斂式鏡像（以 `transactions.updated_at` 為游標找出變更、以 id 為鍵 upsert）、
20 秒增量同步、每日凌晨 4 點全表校正、失敗分類與連續失敗告警、`/status` 的鏡像區段、
正式日誌遮罩、真實 Sheets 整合測試。migration `0009_sheet_sync_state.sql`（schema 9）。
共 49 個 commit、66 個檔案（`main...m5a-sheets-mirror`）。

設計：[`docs/superpowers/specs/2026-09-30-m5a-sheets-mirror-design.md`](../superpowers/specs/2026-09-30-m5a-sheets-mirror-design.md)  
計畫：[`docs/superpowers/plans/2026-10-01-m5a-sheets-mirror.md`](../superpowers/plans/2026-10-01-m5a-sheets-mirror.md)

三道關卡：自動驗證、程式審查、人工驗收。三道都過才算結案。

---

## 開始之前：把鏡像設定起來（三步）

這三步是人工驗收的前置作業，只做一次。

**第 1 步：GCP 專案與 Sheets API**

1. 開 [Google Cloud Console](https://console.cloud.google.com/)，建一個新專案（名稱隨意，
   例如 `personal-ledger`）。
2. 在該專案裡搜尋「Google Sheets API」，按「啟用」。**只要 Sheets API，不需要 Drive API**
   —— 服務帳號的 scope 只到 `spreadsheets`（由
   `tests/sheets/google-sheets-client.test.ts` 的「服務帳號的 OAuth scope 只到這張試算表，
   不到整個 Drive」釘住）。

**第 2 步：服務帳號與 JSON 金鑰**

1. 「IAM 與管理 → 服務帳號 → 建立服務帳號」。不需要授予任何專案層級角色。
2. 建好之後進去該服務帳號的「金鑰 → 新增金鑰 → 建立新的金鑰 → JSON」，下載檔案。
3. 把下載的檔案放到 repo 根目錄底下：

   ```bash
   mkdir -p secrets
   mv ~/Downloads/<下載的檔名>.json secrets/google-service-account.json
   chmod 600 secrets/google-service-account.json
   ```

   `secrets/` 已列入 `.gitignore`（本次任務補上的；在那之前只有 `.env` 被排除，
   金鑰檔掉進 repo 就會被提交）。**金鑰絕不進版控，也不要貼進任何對話或 issue。**
4. 記下該服務帳號的 email（`....iam.gserviceaccount.com`），第 3 步要用。

**第 3 步：試算表與 `.env`**

1. 新建一張 Google 試算表（或用現有的）。
2. **手動把三張分頁建出來並命名為** `Transactions`、`Allocations`、`MonthlySummary`
   （大小寫一致）。鏡像只會寫格子，不會建分頁 —— 缺分頁時會以
   `no such tab: Transactions` 連續失敗。分頁的欄數保持預設（26 欄）就好，不要縮。
3. 右上角「共用」，把第 2 步的服務帳號 email 加為**編輯者**。沒有這一步，
   所有寫入都會是 403。
4. 從網址列取出試算表 id：`https://docs.google.com/spreadsheets/d/<這一段就是 id>/edit`。
5. 在 `.env` 裡填入（範本見 `.env.example`）：

   ```bash
   GOOGLE_SERVICE_ACCOUNT_KEY_FILE=/app/secrets/google-service-account.json
   SHEET_SPREADSHEET_ID=<第 4 點取到的 id>
   ```

   金鑰路徑寫的是**容器內**的路徑（主機的 `./secrets` 唯讀掛載到容器的 `/app/secrets`）。
   只有直接在主機上 `pnpm dev` 時才用主機路徑。

   兩個變數是一組的：兩個都填才啟用，兩個都不填就整個關閉（bot 照常運作），
   **只填一半會拒絕啟動**（刻意如此，見 `src/config.ts`）。不啟用的話請把兩行
   保持註解狀態，**不要留成空值** —— 空字串會被 compose 與 `docker run --env-file`
   照實傳進容器（兩條路徑都已實測），啟動時會以
   `Invalid configuration: GOOGLE_SERVICE_ACCOUNT_KEY_FILE` 中止。

### 兩條部署路徑

`compose.yaml` 是 repo 的宣告式記錄；**目前線上那個容器不是用 compose 起的**
（是 `docker run --env-file .env` 手動建的，容器名 `personal-ledger`、
image `personal-ledger:m4-reliability`、資料卷 `m1-foundation-first-slice_ledger-data`）。
兩條都要能用，所以兩條都寫在這裡。

**A. compose（宣告式記錄）**

```bash
docker compose build
docker compose up -d
```

本次任務補上的兩件事：`environment:` 加上 `GOOGLE_SERVICE_ACCOUNT_KEY_FILE` 與
`SHEET_SPREADSHEET_ID` 的轉發，以及 `./secrets:/app/secrets:ro` 這個唯讀掛載。
在那之前，使用者可以把兩個變數都設好、重啟、看不到任何錯誤，然後沒有鏡像 ——
因為從容器內部看是**兩個都沒設**，於是判定「鏡像關閉」，而「只設一半就拒絕啟動」
那道守衛根本不會觸發（在容器的視角裡那是零設定，不是半設定）。

> **兩條路徑指向同一份資料，這件事已經釘住了。** `compose.yaml` 明確指定
> `name: m1-foundation-first-slice_ledger-data`，也就是線上容器一直在用的那個卷。
> 名字看起來像歷史殘留，因為它就是（源自舊的 compose 專案名），改名等於把真正的
> 帳本孤立起來，所以刻意不改。
>
> 在釘住之前，compose 會依專案名去找 `personal-ledger_ledger-data` —— 而那個卷
> **根本不存在**，於是 compose 會建一個新的空卷、在空帳本上跑 migration、
> 然後一切正常啟動。使用者會把新的帳記進一個全新的空資料庫，真正的帳本在另一個卷裡
> 沒有被動過，兩邊都沒有任何錯誤訊息。這不是「用到舊資料」，是**資料分裂**。
> 已修，不需要驗收者額外留意；記在這裡是為了說明那個卷名為什麼長這樣。

**B. 手動 `docker run`（目前實際在跑的那條）**

```bash
docker build -t personal-ledger:m5a-sheets-mirror .
docker rm -f personal-ledger
docker run -d --name personal-ledger --restart unless-stopped \
  --env-file .env \
  -v m1-foundation-first-slice_ledger-data:/app/data \
  -v "$PWD/secrets":/app/secrets:ro \
  personal-ledger:m5a-sheets-mirror
```

`--env-file .env` 本來就會把兩個新變數帶進去，所以這條路徑缺的只有金鑰掛載：
**`-v "$PWD/secrets":/app/secrets:ro` 這一行不能忘**。忘了的話兩個變數都有值、
鏡像會啟用，但 GoogleAuth 讀不到金鑰檔，於是每 20 秒失敗一次，第 5 次連續失敗時
Telegram 會收到「⚠️ Sheets 鏡像連續失敗」。

---

## 關卡一：自動驗證

- **`pnpm check` exit 0**：**90 檔 / 667 測試**（M4 結案時的起點是 73 檔 / 510 測試）。
  以 Docker 內 `pnpm check` 的**離開碼**確認，不看 grep 過的輸出 ——
  `user-category-keywords-acceptance.md` 記錄過 grep 漏看單數 `1 problem` 導致誤判
  全綠的教訓，本里程碑全程只看 exit code。
- **整合測試不在 `pnpm check` 範圍內**：`vitest.config.ts` 排除 `tests/integration/**`，
  另有 `vitest.integration.config.ts` 與 `pnpm test:sheets`。理由只有一個：真實網路
  進了單元測試套件，套件就會隨機變紅，而一個會無故紅的套件三週後就沒人看，
  那比沒有套件更糟。
- **`pnpm test:sheets`**：**尚未對真實 Google 執行過。** 實作環境沒有 GCP 憑證，
  也刻意不去取得。缺憑證時它會**大聲失敗**而不是跳過（實測離開碼 1，訊息逐字印出
  缺哪一個變數），另外還會在 `SHEETS_TEST_SPREADSHEET_ID` 等於正式的
  `SHEET_SPREADSHEET_ID` 時拒絕執行 —— 那組測試會清空並重寫三張分頁，
  指向使用者真正在看的那張表不是測試失敗，是資料消失。
  **這一項與 AC 並列，不是選配**：要在完成上面「三步設定」之後，另外開一張
  拋棄式試算表（同樣要有三張分頁、同樣分享給服務帳號），然後**先把 `.env` 載進
  這個 shell**：

  ```bash
  set -a; . ./.env; set +a
  GOOGLE_SERVICE_ACCOUNT_KEY_FILE=./secrets/google-service-account.json \
  SHEETS_TEST_SPREADSHEET_ID=<拋棄式試算表 id> \
    pnpm test:sheets
  ```

  **`set -a; . ./.env; set +a` 這一行不能省。** 專案裡沒有任何東西會載入 `.env`
  （沒有 dotenv）；下面這條測試唯一防止清空正式試算表的保護——
  `SHEETS_TEST_SPREADSHEET_ID` 等於正式的 `SHEET_SPREADSHEET_ID` 時拒絕執行——
  比對的是**這個 shell 裡**的兩個環境變數。少了這一行，`SHEET_SPREADSHEET_ID`
  根本不在這個 shell 裡，守衛看不到正式 id、永遠不會開火：如果為了省事把正式 id
  複製到 `SHEETS_TEST_SPREADSHEET_ID`（例如直接抄第 3 步剛填過的值），流程會直接
  清空並重寫三張真實分頁，中間不會有任何提示，而且無法還原。測試本身在真正動手
  清空之前也會印出它要清空的試算表 id；如果 `SHEET_SPREADSHEET_ID` 這時仍未設定
  （因此測試無法替你比對），它會另外大聲印出「我無法確認這不是你的正式試算表」——
  看到這行就代表上面的載入沒生效，該中止。

  上面這行金鑰路徑用的是**主機**路徑（`./secrets/...`），跟第 3 步 `.env` 裡寫的
  容器內路徑（`/app/secrets/...`）不一樣：那一份 `.env` 給的是**跑在容器裡的 bot**
  用的路徑，這裡假設你是在主機上直接執行 `pnpm test:sheets`，兩者的檔案系統基準點
  不同，各自對才是對的——不要把其中一種路徑抄到另一個情境裡。

  結案前必須看到它 exit 0。
- **AC-21（Sheet 暫時失敗 → 正式入帳成功，Sheet 工作安全重試）**：
  入帳路徑完全不經過 Sheets —— 鏡像是獨立的背景 runner，讀 SQLite、寫 Sheet，
  失敗只影響自己。`tests/sheets/sheet-mirror.test.ts` 的
  `"does not advance the cursor when the write fails"` 與
  `"does not advance the cursor when the read fails"` 釘住「失敗不推進游標」——
  這是安全重試的基礎：下一輪重做同一批，而重寫一列永遠安全（冪等，
  見 `tests/sheets/sheet-mirror-convergence.test.ts` 的
  `"is idempotent: syncing the same batch twice leaves the sheet unchanged"`）。
  失敗分類與升級由 `tests/sheets/sheet-failure.test.ts`（17 條）與
  `tests/sheets/sheet-mirror-failure.test.ts`（12 條）涵蓋：連續四次不吵、
  第五次才通知、成功後計數歸零、通知本身拋錯不會讓 `syncOnce` 跟著拋錯、
  十分鐘節流、節流時間戳持久化（行程重啟不會重置）、
  存進 `lastError` 的只有 `"permanent:403"` 這種「分類:狀態碼」，
  絕不含原始錯誤訊息本文。
- **AC-22（Sheet 恢復 → 通常 1 分鐘內完成鏡像且無重複列）**：
  `SYNC_INTERVAL_MS = 20_000`（`src/sheets/sheet-mirror-runner.ts`），一分鐘內有三次
  機會，`tests/sheets/sheet-mirror-runner.test.ts` 的 `"does call the api when something
  changed"` 與 `"makes no api call when nothing changed"` 釘住 tick 行為。
  「無重複列」由以 id 為鍵的 upsert 保證：`tests/sheets/sheet-mirror.test.ts` 的
  `"updates in place instead of adding a second row for the same id"`、
  `"re-locates a row the user moved instead of writing to the old position"`，
  以及 `sheet-mirror-convergence.test.ts` 整組收斂測試（塵埃落定後，
  Sheet 上「鏡像自己寫的那些列」必須等於直接從 SQLite 算出來的投影，一列不多一列不少，
  含殭屍列與重複列的清理）。
- **正式日誌不含金鑰、試算表 id、財務原文**：`src/logger.ts` 的拒絕清單本里程碑加入了
  `privateKey`／`client_email`／`spreadsheetId`／金鑰檔路徑等欄位，`tests/logger.test.ts`
  逐條釘住。我們自己丟出的錯誤也不夾帶試算表 id
  （`tests/sheets/google-sheets-client.test.ts` 的「分頁不存在就拋錯，而且不提試算表 id」），
  而 `lastError` 只存「分類:狀態碼」。
- **邊界**：`src/sheets/google-sheets-client.ts` 是全專案唯一 import `googleapis` 的檔案；
  `src/sheets/` 不 import grammY；`src/domain/`、`src/application/`、`src/ports/`
  兩者都不 import；`src/logger.ts` 不 import grammY。以 `git grep` 逐條確認。
- **migrations `0001`–`0008` 未被修改**：
  `git diff main...m5a-sheets-mirror --stat -- 'src/db/migrations/000[1-8]*.sql'` 無輸出。
  本里程碑只新增 `0009_sheet_sync_state.sql`。

## 關卡二：程式審查

**待執行。** 依完成定義，對整個分支的 diff（`main...m5a-sheets-mirror`）執行
`superpowers:requesting-code-review` 並逐條裁決，結論與修法補在這一節。
沿用 M4 的標準：宣稱被保護的行為，一律附「把它改壞、對應測試變紅」的證據與失敗訊息
原文，自我宣稱不算數。

### 更正：commit `71a684f` 的訊息有一句不成立

`71a684f`（`fix(sheets): 正式 client 的 factory 一定包上 withHeaderRows，並釘住 OAuth
scope`）的 commit 訊息，以及 Task 10 的修正報告，都聲稱那次修正「順便殺掉」了另一個
審查發現：`src/main.ts` 把 `keyFile` 與 `spreadsheetId` 兩個欄位交給
`createGoogleSheetsClient` 時有沒有交錯。

**那句話是錯的。** 事後複審實測過：把 `src/main.ts` 裡那兩個值互換，整個測試套件
**依然全綠**。原因是每一條會設定 sheets 的 `composeRuntime` 測試都傳了覆寫用的
client（`RuntimeOverrides.sheetsClient`），所以真正的那段接線從來沒有被任何測試執行到。
`71a684f` 釘住的是「正式 factory 一定包上 `withHeaderRows`」與 OAuth scope，那兩件事
成立；它沒有、也無法順便守住欄位有沒有交錯。

這個發現最後仍**以 Nit 結案，不補測試**，理由有兩條：交錯那兩個值必須同時把欄位名稱
寫對而把值寫反，不是手滑打得出來的形狀；而且正式環境會自己喊出來 ——
把 spreadsheet id 當成金鑰檔路徑會讓每一次呼叫都 ENOENT，失敗分類判為 transient、
連續五次之後發出 Telegram 告警，`/status` 上也看得到。它不會是一個安靜的錯誤。

更正寫在這裡而不是改 commit 訊息，是因為分支上還有並行的工作，重寫歷史不安全。
這段錯誤的說法曾經被一路轉抄進其他筆記，所以記錄必須寫明白：**`71a684f` 的
commit 訊息在這一點上不可信，以本節為準。**

## 關卡三：人工驗收

以下清單由**人**在真實 Telegram 對話與真實試算表上對照執行，不需要讀任何程式碼。
每一列先做「怎麼做」欄寫的事，再對照「應該看到什麼」欄核對，最後在「結果」欄填
✅ 或 ❌（❌ 請附截圖，並在下方「驗收期間發現的缺陷」補一段）。

前置：完成上面「三步設定」，並以兩條部署路徑之一重啟 bot。使用的是既有的測試／
開發資料，沒有正式帳本，不需要先做資料複本；建議開始前跑一次 `./scripts/backup.sh`
留一個時間點，方便萬一要回溯。

| # | 怎麼做 | 應該看到什麼 | 結果 |
|---|---|---|---|
| 1 | 設定完成、重啟 bot 之後**先不要記帳**，直接打開試算表看三張分頁 | 三張分頁完全空白 —— 連欄位名稱（標題列）都還沒有。**這是正確的，不是故障**（原因見下方「兩個會被誤讀成故障的現象」第 1 條） | |
| 2 | 在 Telegram 傳 `/status` | 訊息最後多出一段「Sheets 鏡像」，底下五行：最後成功同步、落後、連續失敗、最後錯誤、最後完整校正。第一次應該是「最後成功同步：從未同步過」「最後完整校正：從未完整校正過」。**若看到的是「Sheets 鏡像：未啟用」**，代表兩個變數沒有進到容器裡（compose 少了轉發，或 `docker run` 少了 `--env-file`） | |
| 3 | 傳 `午餐 120` 並按「確認」，等 40 秒，重新載入試算表 | `Transactions` 第 1 列出現中文欄位名稱（transaction_id、日期、時間、金額…），第 2 列是剛才那筆帳；`Allocations` 也出現標題列與一列；`MonthlySummary` 出現當月一列 | |
| 4 | 再傳 `/status` | 「最後成功同步」變成剛剛的時間（幾點幾分），「落後」是 0 筆，「連續失敗」0 次，「最後錯誤」無 | |
| 5 | 在 `Transactions` 分頁點「資料 → 建立篩選器」，然後用「日期」欄排序 | 能排序，而且順序是**真正的日期順序**。若日期被寫成文字，排出來會是 1 月、10 月、11 月、2 月這種字串順序 | |
| 6 | 點日期欄任一格，看上方的資料編輯列；再在任一空格輸入 `=YEAR(` 後點選那一格、按 Enter | 格子內容靠右對齊、顯示成日期（例如 `2026/10/2`）；`=YEAR(...)` 得到 `2026`，不是 `#VALUE!`。（日期欄在 Sheet 裡存的是序列值 + 日期格式，不是文字） | |
| 7 | 選取 `Transactions` 的「金額」整欄，在任一空格輸入 `=SUM(` 後選取該欄範圍、按 Enter | 得到真正的金額合計，**不是 0**。金額若被寫成文字，SUM 一律是 0 —— 那會讓整個鏡像失去意義 | |
| 8 | 在 `Allocations` 分頁點「插入 → 樞紐分析表」，列選「分類」、值選「金額」的 SUM | 樞紐分析表建得起來，並依分類加總出數字（不是空白、不是 0）。`MonthlySummary` 分頁的九個數字欄同樣可以直接 SUM | |
| 9 | 在 Telegram 傳 `=SUM 午餐 120`（**刻意以等號開頭**；這句解析得出來，若 bot 追問就照著補完），按「確認」，等 40 秒後看 `Transactions` 的「原始輸入」欄 | 那一格顯示的是字面文字 `=SUM 午餐 120`。**不是** `#NAME?`、**不是** `#ERROR!`、**不是** 任何計算結果；點那一格，上方資料編輯列顯示的也是同一串文字（而不是一條公式）。這條守的是公式注入：備註或原始輸入以 `=`、`+`、`-`、`@` 開頭時，若寫入用的是 `USER_ENTERED`，它就會變成使用者試算表裡一條活的公式 | |
| 10 | 在試算表上**動手改壞**：把第 2 列的「金額」改成 `999999`，隨便在一個空白列的第一欄打上 `我自己的備註`，然後在 `Transactions` 最下面自己加一列、第一欄貼上一個看起來像 id 的字串（例如把某一列的 transaction_id 複製過來再改幾個字） | 這一步不用看到什麼，下一列檢查 | |
| 11 | 校正每天凌晨 4 點跑一次（容器持續運行就會自己跑，不必重啟）。所以第 10 列改壞之後，**等到隔天早上 4 點過後**再打開試算表。目前沒有手動觸發校正的指令（還原／校正 CLI 排在 M5b／M5c） | 被改成 `999999` 的那一格被寫回正確金額；自己加的那個假 id 列被整列清空；而 `我自己的備註` 那一列**一格都沒有被動過**。（清理的判準是「鍵欄是 UUID 形狀」+「SQLite 裡找不到」；使用者手打的內容過不了第一個條件。每天半夜靜靜地把使用者手打的內容清掉，比它要修的殭屍列嚴重得多） | |
| 12 | 傳 `/status`，確認「最後完整校正」欄 | 顯示的是昨晚／今晨 4 點過後的日期與時間，不再是「從未完整校正過」 | |
| 13 | 改一筆既有的帳（用 `/recent` 找到它、按修改，把金額改掉），等 40 秒 | 試算表上**同一列**的金額被改掉，**不是**多出一列新的。`Allocations` 那一邊舊的配置列被清空、新的出現（改交易是「刪掉全部配置再重建」，舊列若留著，樞紐分析就會把已經不存在的金額算進去） | |
| 14 | 軟刪除一筆帳（`/recent` → 刪除），等 40 秒 | 那一列**還在**，但「狀態」欄變成 `deleted`；`MonthlySummary` 當月的數字跟著變。（鏡像不刪列，只改狀態 —— 刪列會讓列號位移） | |
| 15 | 把一筆帳的日期改到**上個月**（`/recent` → 修改 → 改日期），等 40 秒，看 `MonthlySummary` | **兩個月份的列都被更新**：搬走的那個月與搬進去的那個月。只更新新月份是一個很容易發生、而且完全沒有訊號的錯 —— 舊月份會靜靜停在錯的數字上 | |
| 16 | 到試算表的「共用」把服務帳號的權限從「編輯者」改成「檢視者」，等 2 分鐘 | 大約 100 秒（5 次連續失敗 × 20 秒）之後，Telegram 收到一則「⚠️ Sheets 鏡像連續失敗 / 帳都記在資料庫裡，只是試算表暫時沒有更新。請確認試算表仍分享給服務帳號。錯誤類別：permanent:403」。**期間繼續記帳必須完全正常** —— 傳一筆帳、確認、`/recent` 查得到，一切如常 | |
| 17 | 把權限改回「編輯者」，等 40 秒 | 鏡像自己恢復：剛才 403 期間記的那幾筆帳出現在試算表上，而且**沒有重複列**；`/status` 的「連續失敗」回到 0、「最後錯誤」回到「無」 | |
| 18 | 在主機上執行 `docker logs personal-ledger`，把輸出從頭到尾看過一遍 | 完全找不到：服務帳號金鑰的任何內容（`private_key`、`client_email`）、金鑰檔路徑、**試算表 id**、任何一筆帳的財務原文（金額、商家、備註）、Telegram bot token、owner 的原始 Telegram id。與鏡像有關的行最多只有 `permanent:403` 這種分類字串 | |

### 兩個會被誤讀成故障的現象

這兩件事都是**預期行為**，寫在這裡是因為它們看起來很像壞了：

1. **標題列只在「第一次有資料的寫入」時才出現。** 剛設定好、還沒有任何帳本異動時，
   鏡像一次 API 呼叫都不發（配額有限，空轉也照打是浪費），所以三張分頁會完全空白 ——
   連欄位名稱都沒有。第一筆帳同步進去的那一刻，標題列會和資料列在**同一批**寫入裡
   一起出現。看到三張空分頁不代表設定失敗；傳一筆帳就知道。
   （另一半也是刻意的：如果使用者自己把標題改成看得懂的字，鏡像不會每次啟動都覆寫回去。）
2. **從 `VACUUM INTO` 快照還原出來的資料庫，`journal_mode` 會是 `delete` 而不是 `wal`。**
   `VACUUM INTO` 產生的是一個全新檔案，不會帶著來源的 journal_mode。這**不是還原壞了**：
   應用程式（`src/db/database.ts` 的 `openDatabase()`）開檔一次之後就會設回 `wal`。
   M4 已經實測確認過，記在
   [`docs/operations/backup-and-restore.md`](../operations/backup-and-restore.md)。

### 驗收結果

（人工驗收執行後在此補上。依完成定義，發現的缺陷一律先補回歸測試再修，不直接改行為。）

### 驗收期間發現的缺陷

（人工驗收執行後在此補上。）

## 結論

自動驗證的 `pnpm check` 已 exit 0（90 檔 / 667 測試），部署路徑的三個缺口已修補
（變數轉發、金鑰掛載、資料卷名）。
`pnpm test:sheets` **尚未對真實 Google 執行過**，程式審查與人工驗收待執行 ——
三者都完成之後才能把 M5a 標為結案。

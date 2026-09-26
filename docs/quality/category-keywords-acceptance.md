# 驗收：分類關鍵字對照表與餐飲分類改名

對象：`src/parser/category-keywords.ts`、`src/domain/category-catalog.ts`、
migration `0006_dining_category.sql`，以及 `expenseShell`／`saveCategory`／
`ensureLegacyCategory` 的相應修改。

## 關卡一：自動驗證

- `pnpm check` 全綠：53 檔 / 337 測試（變更前 321），Prettier、typecheck、eslint、build 皆通過。
- 變異驗證（改壞程式確認測試會紅）：
  - 讓帳戶重新暗示分類 → 4 條測試紅（`does not let a mentioned account imply a category`
    與三條語料庫案例）。
  - 移除 `ensureLegacyCategory` 的 key 查詢 → `FOREIGN KEY constraint failed`（第一版測試
    用全新安裝，兩邊組出的 id 相同因此抓不到，已改成 M1 升級後的資料庫才真的咬住）。
  - 移除 migration 0006 的 UPDATE → `migrate-dining-category` 三條紅。
  - 移除 `saveCategory` 的 key 查詢 → `UNIQUE constraint failed: categories.owner_id,
    categories.key`（bootstrap 與 smoke 各一條）。
- 真實資料複本上的升級演練（`ledger-0006-dryrun`，正式帳本未動）：
  - schema 5 → 6。
  - `bootstrapReferenceData` 連跑兩次皆成功，無 UNIQUE 錯誤（這正是 `saveCategory`
    改為按 key 判斷身分要解決的失敗模式）。
  - `foreign_key_check` 無錯誤；分類 19 筆無重複。
  - 餐飲分類沿用舊 id `m2:<owner>:expense_dining_lunch`，key 為 `expense_dining`。
  - 7 筆交易、12 筆草稿完整保留；既有快照 `餐飲／午餐` 未被改寫。

## 與規格書的關係

- 規格書 AC-01 寫的是「產生今日、支出 120、**餐飲**草稿」。M2 把葉分類命名為「午餐」是
  實作偏離規格，這次改名把兩者對回一致。
- 規格書 AC-09 的字面句子 `午餐 120，咖啡 60` 過去因為「咖啡」解不出分類而只能產生一筆
  草稿加一筆追問，M3a 驗收改用 `午餐 120，Uber 245` 替代（見
  `docs/quality/m3a-acceptance.md`）。「咖啡」進入關鍵字表後，字面句子已可產生兩筆獨立
  草稿（`餐飲／午餐` 與 `餐飲／咖啡`），該偏離消除。
- AC-10 的「缺金額改以缺分類驗收」仍然成立，且未知詞現在更明確：`雜支 90` 這類表外詞
  才會落到追問，不再是「任何不含午餐的詞」。

## 關卡二：程式審查

對 `65f3ade..3a16846` 執行 `superpowers:requesting-code-review`。審查員三輪：讀完整 diff、
對 56 個真實輸入與 4 種資料庫升級情境做行為探測、在 `/tmp` 的拋棄式副本上做變異測試。
結論「With fixes」，無 Critical。

裁決（`superpowers:receiving-code-review`：每條都判斷是否成立）：

| # | 意見 | 裁決 |
|---|---|---|
| 1 | 商家會蓋掉使用者明講的關鍵字：`Uber 外送 250` → 交通、不追問 | **接受並修**。已獨立複驗。改成關鍵字優先、商家只在沒有關鍵字時補位。商家是店家層級的粗略訊號（Uber 同時有乘車與外送，商家表因此連 subcategory 都不給），關鍵字才是使用者當下明講的事實 |
| 2 | 「長關鍵字優先」無實效也無測試（把比較子反向排序後 337 測試全綠） | **接受並修**。新增巢狀關鍵字對 `水電`／`水電費` 供行為測試，並匯出 `orderedKeywords` 直接斷言排序單調遞減，另補同長度時依表序的斷言 |
| 3 | 商家與關鍵字的優先順序沒有任何測試（互換後全綠） | **接受並修**。新增 `lets an explicit keyword win over a registered merchant`，同時涵蓋「只有商家」的情形 |
| 4 | 7 個 fixture 仍把 `expense_dining` 命名為「午餐」 | **接受並修**。全部改為「餐飲」。另外自行發現 `format-preview.test.ts` 的三人分帳範例也在模擬一個不可能的帳本，一併改為 `餐飲／午餐`。審查員建議更進一步讓 fixture 直接 import `expenseCategoryLeaves`：**不採納**——分類名稱若變更，斷言會直接紅，漂移抓得到，不值得為此重排 7 個檔案的結構 |
| 5 | 候選按鈕上限 10 < 分類數 13，而這次改動把更多流量導進這個追問 | **接受並修**（上限提高到 24）。這是我先前告知使用者「超出範圍」的另一個缺陷，但本次改動確實讓它變得更熱：所有解不出分類的句子現在都落在這裡，而這則訊息表達不出完整分類表、文字回覆又會被當成金額退回。放著等於自己製造一條死路。已補測試以 `expenseCategoryLeaves` 咬住「每個分類都有按鈕」 |
| 6 | 「手續費」的排除理由（會與轉帳搶同一句話）是事實錯誤 | **接受**。已獨立複驗：`台新轉國泰 1000 手續費 15` 由轉帳分支自己拆出 fee 配置並直接回傳，走不到 `expenseShell`。改正註解並把 `手續費`／`匯費`／`年費` 加進表 |
| 7 | 子字串比對沒有詞界：`幫朋友加油打氣 100` → 交通／加油 | **接受為已知限制**，寫進 `docs/domain/category-model.md`。中文無空白分詞，要收斂需要斷詞，代價遠高於收益 |
| 8 | `bootstrapReferenceData` 仍用樣板組 `parentId`，沒按 key 查根分類 | **不採納為程式修改**。要按 key 解析父分類得改動 port 介面；而失敗模式是 `FOREIGN KEY constraint failed` 整批失敗、不寫入任何東西——壞得很大聲，不會產生半套資料。已寫進已知限制 |
| 9 | `saveCategory` 會靜默改寫另一列 | **接受**（補上契約註解）。目前沒有呼叫端依賴「用自己傳的 id 查得回來」 |
| 10 | 一個帳本同時有兩個 key 時 migration 0006 會中止 | **接受為已知且可接受**。出貨程式走不到；整份 rollback 停在版本 5，不會半途升級 |
| 11 | 文件過時（`preview-layouts.md` 的範例、M3a 驗收的 AC-10 句子） | **接受**。版型範例改為 `餐飲／午餐` 並加更新註記；M3a 驗收紀錄**加註不改寫**，指出重跑時第三段要換成表外的詞 |
| 12 | 驗收文件未納入版控 | **接受**，本次一併提交 |
| 13 | `categoryName(key) ?? key` 不可達 | **接受**（補註解說明留著只為滿足型別） |
| 14 | 少了同樣明確的 `車票`、`電話費`／`網路費`／`手機費` | **接受**。已加入；電話／網路／手機費歸「居住」（現有分類裡最接近水電瓦斯管理費那一組），若使用者認為該另立分類再調整 |

修正後：`pnpm check` 全綠，**53 檔 / 342 測試**。三項新變異驗證皆確認會紅：
比較子反向 → 2 條；商家／關鍵字優先順序互換 → 1 條；候選上限降回 10 → 2 條。

修正後行為複驗：

| 輸入 | 結果 |
|---|---|
| `Uber 外送 250` | 餐飲／外送 |
| `Uber Eats 晚餐 300` | 餐飲／晚餐 |
| `Uber 245` | 交通（無品項） |
| `手續費 15 現金` | 金融費用／手續費 |
| `水電費 1200` | 居住／水電費（長關鍵字勝） |
| `水電 1200` | 居住／水電 |
| `台新轉國泰 1000 手續費 15` | 轉帳 + 金融費用（兩筆配置，未被關鍵字表搶走） |
| `國泰卡刷 1200` | 追問分類 |

## 關卡三：人工 Telegram 驗收

於真實資料的複本（volume `ledger-keywords-acceptance`）上執行，結束後刪除複本。

> 使用者於驗收中說明：目前資料都還是測試開發資料，沒有正式帳本。之後的驗收可以直接在
> 資料卷上跑，不需要先做複本這一層。

| # | 輸入 | 預期 | 結果 |
|---|---|---|---|
| 1 | `晚餐 150` | 直接出預覽，`餐飲／晚餐`，資金流出 | ✅ |
| 2 | `早餐 100 現金` | 直接出預覽，`餐飲／早餐`（帳戶不再讓它變成午餐） | ✅ |
| 3 | `電影 300 國泰卡` | 直接出預覽，`娛樂／電影`，不影響當下可動用資金 | ✅ |
| 4 | `捷運 30` | 直接出預覽，`交通／捷運` | ✅ |
| 5 | `Uber 245` | 直接出預覽，`交通`（無品項）、商家：Uber | ✅ |
| 6 | `國泰卡刷 1200` | 追問分類，候選 13 顆含「旅遊」「待分類」「轉帳」 | ✅（修正缺陷 1 後） |
| 7 | `一蘭拉麵 200` | 追問分類；選「其他支出」後升級為可確認預覽 | ✅（修正缺陷 1 後） |
| 8 | `午餐 1260，小明欠 630` | 代墊路徑不受影響，兩筆配置皆為 `餐飲／午餐` | ✅ |
| 9 | `/recent` | 舊資料快照未被改寫，排版與預覽一致 | ✅（修正缺陷 2、3 後） |
| 10 | 啟動服務 | schema 6、bootstrap 不撞 UNIQUE、資料完整 | ✅ |

### 驗收期間發現的缺陷

**缺陷 1：追問訊息沒有任何出口**（第 6、7 項）

候選追問只給候選按鈕，沒有取消鍵。而分類追問**只收按鈕**——文字回覆會被 `answer-draft`
當成金額並以 `amount_not_numeric` 退回。草稿因此只能一直停在 `awaiting_input`，得另外開
`/pending` 才處理得掉。這是既有行為，但本次改動把所有解不出分類的句子都導進這個追問，
等於把死路變成主要路徑。

修法：所有候選追問最後固定加一列「取消」。callback 走新的 `x:<draftRef>`——既有預覽的
`cancel:<draftId>` 帶的是 UUID（43 bytes，未超過 64 但違反「callback_data 不放 UUID」的
約定），追問手上只有 8 碼 draftRef。未完成草稿不能走 `cancelDraft`（它以
`TransactionDraftSchema` 解析既有 JSON，對 `IncompleteDraft` 必定丟 `draft not found`），
改走 `archiveDraft`——放棄未完成草稿在 M3a 就定義為封存。

回歸測試：`callback-data.test.ts` 往返、`format-prompt.test.ts` 取消鍵固定在最後一列、
`draft-routing.test.ts` 端到端按下後狀態與待處理清單。變異驗證：拿掉取消鍵 → 4 條紅。

**缺陷 2：`/recent` 停在 M2 的舊排版**（第 9 項）

`/recent` 顯示 `配置 N：用途・分類 · 金額`，與預覽的版型 D 是兩套。成因與「午餐／午餐」
同類：`format-preview.ts` 與 `handlers/transactions.ts` 各寫了一份渲染（連 `purposeLabels`
都是逐字重複的兩份），M3b 只改了預覽那一份。

修法：抽出 `src/telegram/format-allocations.ts`，預覽、`/recent`、`/pending` 重繪共用同一份
`formatAllocationLines`。

**缺陷 3：版型靠空白縮排，在 Telegram 上對不齊**（第 8、9 項）

先是「▸」——East Asian Ambiguous 寬度，與全形空格不等寬，整個區塊跑版。改成純全形空格
縮排後，使用者回報實機仍以**半形**寬度描繪：純文字訊息沒有辦法要求 Telegram 把空白算成
特定寬度（已確認送出的確實是 U+3000，且未設 `parse_mode`）。要保證等寬只能整塊改用
`<pre>`，那得換成 HTML parse_mode 並跳脫使用者輸入的分類與交易對象名稱。

修法：層級改用可見前綴「└」。可見字元不會被壓縮也不會被折疊，每一行都從同一個位置開始。
決策與理由記在 `docs/design/preview-layouts.md`。

最終排版：

```
日期：2026-09-26
總金額：TWD 1000

資金流出 · 支出
└ 餐飲／午餐 · TWD 332
資金流出 · 代墊 (小明)
└ 餐飲／午餐 · TWD 334
資金流出 · 代墊 (小華)
└ 餐飲／午餐 · TWD 334
```

三個缺陷都先補回歸測試再修。修正後 `pnpm check` 全綠：53 檔 / **345 測試**（起點 321）。

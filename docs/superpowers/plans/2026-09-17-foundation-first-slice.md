# 工程基線與第一條垂直切片實作計畫

> **給執行此計畫的代理：** 必須使用 `superpowers:subagent-driven-development`（建議）或 `superpowers:executing-plans`，逐項執行並以核取方塊追蹤進度。

**目標：** 建立最小但具有正式產品形狀的 Ledger Bot 流程：解析 `午餐 120`、在 Telegram 顯示草稿、只確認入帳一次至 SQLite，並可由 `/recent` 查回。

**架構：** 帳務規則放在不依賴外部框架的領域模組。應用服務透過儲存庫連接埠協調流程，SQLite 與 grammY 只存在於邊界轉接器。第一個切片使用長輪詢單程序執行，但介面保留未來切換 webhook 與持久化工作佇列的空間。

**技術基線：** Node.js 24 LTS、TypeScript 6.x strict ESM、pnpm 10.x、grammY 1.x、Zod 4.x、`better-sqlite3`、`decimal.js`、Vitest、ESLint flat config、Docker。

**需求規格：** `docs/spec/personal-ledger-spec.md`

## 全域限制

- Bot 顯示名稱為 Ledger Bot；程式庫名稱為 `personal-ledger`。
- 預設幣別為 TWD；預設時區為 Asia/Taipei。
- 每筆正式交易都必須由使用者確認。
- 金額使用正規化十進位字串，不得用 IEEE 浮點數計算。
- SQLite 是唯一真相來源；本計畫不實作 Google Sheets。
- 每筆交易都必須連回不可變的 InputEvent。
- Telegram 重送與重複 callback 不得產生重複交易。
- 正式環境日誌不得包含完整財務原文、Token 或憑證。
- AI、多筆輸入、代墊、退款、Drive 備份與自然語言查詢不在本切片範圍。

---

## 預計檔案結構

```text
.
├── src/
│   ├── application/
│   │   ├── confirm-draft.ts
│   │   ├── create-draft.ts
│   │   └── list-recent.ts
│   ├── config.ts
│   ├── db/
│   │   ├── database.ts
│   │   ├── migrate.ts
│   │   ├── migrations/0001_initial.sql
│   │   └── sqlite-ledger-repository.ts
│   ├── domain/
│   │   ├── ledger.ts
│   │   └── money.ts
│   ├── parser/rule-parser.ts
│   ├── ports/ledger-repository.ts
│   ├── telegram/
│   │   ├── create-bot.ts
│   │   └── format-preview.ts
│   └── main.ts
├── tests/
│   ├── application/
│   ├── db/
│   ├── domain/
│   ├── parser/
│   ├── support/
│   └── telegram/
├── Dockerfile
├── compose.yaml
├── eslint.config.mjs
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

### 任務 1：建立程式庫與品質基線

**檔案：**
- 建立：`.gitignore`、`.env.example`、`package.json`
- 建立：`tsconfig.json`、`eslint.config.mjs`、`vitest.config.ts`
- 建立：`src/config.ts`、`README.md`
- 測試：`tests/config.test.ts`

**介面：**
- 產出：`loadConfig(env: NodeJS.ProcessEnv): AppConfig`
- 產出：`test:run`、`typecheck`、`lint`、`dev`、`start` 指令

- [ ] **步驟 1：初始化 Git 與 pnpm**

```bash
git init
pnpm init
```

`package.json` 使用 ESM、Node 24，並定義所有品質檢查指令。

- [ ] **步驟 2：安裝依賴**

```bash
pnpm add grammy zod better-sqlite3 decimal.js
pnpm add -D typescript tsx vitest eslint @eslint/js typescript-eslint @types/node @types/better-sqlite3
```

- [ ] **步驟 3：先寫設定失敗測試**

```ts
it("缺少 Telegram token 時拒絕啟動", () => {
  expect(() => loadConfig({ LEDGER_OWNER_ID: "123" })).toThrow(
    "TELEGRAM_BOT_TOKEN",
  );
});

it("載入第一階段預設值", () => {
  expect(loadConfig({
    TELEGRAM_BOT_TOKEN: "test-token",
    LEDGER_OWNER_ID: "123",
  })).toMatchObject({
    ownerId: "123",
    databasePath: "./data/personal-ledger.sqlite",
    timezone: "Asia/Taipei",
    currency: "TWD",
  });
});
```

- [ ] **步驟 4：執行測試並確認失敗**

執行：`pnpm test:run tests/config.test.ts`  
預期：因 `src/config.ts` 尚不存在而失敗。

- [ ] **步驟 5：實作 Zod 設定驗證**

驗證 `TELEGRAM_BOT_TOKEN`、數字格式的 `LEDGER_OWNER_ID`，並提供 database path、Asia/Taipei、TWD 預設值。錯誤訊息不得輸出 Token 值。

- [ ] **步驟 6：建立 strict compiler、Vitest 與 ESLint 設定**

TypeScript 必須啟用 `strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`，使用 `NodeNext` 與 `ES2024`。

- [ ] **步驟 7：執行品質檢查並提交**

```bash
pnpm test:run
pnpm typecheck
pnpm lint
git add .
git commit -m "chore: initialize personal ledger service"
```

### 任務 2：建立 Money 與帳務領域模型

**檔案：**
- 建立：`src/domain/money.ts`、`src/domain/ledger.ts`
- 測試：`tests/domain/money.test.ts`、`tests/domain/ledger.test.ts`

**介面：**
- 產出：`MoneySchema`、`Money`、`money()`、`addMoney()`
- 產出：`TransactionDraft`、`ConfirmedTransaction`、`Allocation`

- [ ] **步驟 1：先寫 Money 失敗測試**

測試 `00120.00` 正規化為 `120`、零與負數被拒絕，以及 `0.1 + 0.2 = 0.3`。

- [ ] **步驟 2：實作 Decimal Money**

```ts
export function money(value: string, currency: "TWD"): Money {
  const decimal = new Decimal(value);
  if (!decimal.isFinite() || !decimal.isPositive()) {
    throw new Error("money amount must be positive");
  }
  return { amount: decimal.toString(), currency };
}
```

- [ ] **步驟 3：先寫 allocation invariant 測試**

建立總額 120、allocation 100 的 draft，預期 `TransactionDraftSchema` 拒絕並回報 allocation total 不一致。

- [ ] **步驟 4：實作領域資料結構**

建立 `FundsEffectSchema`、`PurposeSchema`、`AllocationSchema` 與 `TransactionDraftSchema`。所有 allocation 必須同幣別，且 Decimal 加總必須等於 transaction amount。

- [ ] **步驟 5：執行品質檢查並提交**

```bash
pnpm test:run tests/domain
pnpm typecheck
pnpm lint
git add src/domain tests/domain
git commit -m "feat: define ledger money and draft model"
```

### 任務 3：建立 SQLite 資料結構與儲存庫

**檔案：**
- 建立：`src/db/migrations/0001_initial.sql`
- 建立：`src/db/database.ts`、`src/db/migrate.ts`
- 建立：`src/ports/ledger-repository.ts`
- 建立：`src/db/sqlite-ledger-repository.ts`
- 測試：`tests/db/sqlite-ledger-repository.test.ts`

**介面：**
- 產出：`openDatabase()`、`migrate()`
- 產出：`recordInputEvent()`、`saveDraft()`、`getDraft()`
- 產出：`confirmDraft()`、`listRecent()`

- [ ] **步驟 1：定義 LedgerRepository port**

```ts
export interface LedgerRepository {
  recordInputEvent(input: InputEventInput): Promise<{
    created: boolean;
    eventId: string;
  }>;
  saveDraft(draft: TransactionDraft): Promise<void>;
  getDraft(draftId: string): Promise<TransactionDraft | null>;
  confirmDraft(draftId: string, confirmedAt: string):
    Promise<ConfirmedTransaction>;
  listRecent(ownerId: string, limit: number):
    Promise<ConfirmedTransaction[]>;
}
```

- [ ] **步驟 2：先寫 in-memory SQLite 失敗測試**

Migration 後儲存 draft，連續確認兩次，驗證 transaction ID 相同且資料庫只有一筆 transaction。

- [ ] **步驟 3：建立 migration**

建立 `schema_migrations`、`input_events`、`drafts`、`transactions`、`allocations`。金額使用 TEXT；`telegram_update_id` 與 `request_id` 使用 UNIQUE；啟用 foreign keys。

- [ ] **步驟 4：實作原子確認**

`confirmDraft` 必須在單一 immediate transaction 中讀 draft、依 request ID 查重、新增 transaction 與 allocations、標記 draft confirmed，任何錯誤全部 rollback。

- [ ] **步驟 5：執行測試並提交**

```bash
pnpm test:run tests/db tests/domain
git add src/db src/ports tests/db
git commit -m "feat: persist drafts and confirmed transactions"
```

### 任務 4：實作第一個確定性 parser

**檔案：**
- 建立：`src/parser/rule-parser.ts`
- 測試：`tests/parser/rule-parser.test.ts`

**介面：**
- 產出：`parseTransaction(text, context): ParseResult`

- [ ] **步驟 1：先寫 parser 失敗測試**

驗證 `午餐 120` 產生今日、TWD 120、outflow、expense、餐飲／午餐草稿；`午餐` 回傳缺少 amount。

- [ ] **步驟 2：確認測試失敗**

執行：`pnpm test:run tests/parser/rule-parser.test.ts`。

- [ ] **步驟 3：實作窄範圍 parser**

只辨識一個正十進位金額與 `午餐` 關鍵字。沒有金額或有多個候選時回傳 missing fields。本任務不得加入一般 NLP、多筆輸入、AI 或猜測分類。

- [ ] **步驟 4：執行測試並提交**

```bash
pnpm test:run tests/parser tests/domain
git add src/parser tests/parser
git commit -m "feat: parse first deterministic expense input"
```

### 任務 5：建立 application services

**檔案：**
- 建立：`src/application/create-draft.ts`
- 建立：`src/application/confirm-draft.ts`
- 建立：`src/application/list-recent.ts`
- 建立：`tests/support/fake-ledger-repository.ts`
- 測試：`tests/application/*.test.ts`

- [ ] **步驟 1：建立測試用儲存庫**

Fake 必須實作完整 LedgerRepository contract，並強制 request ID 冪等。

- [ ] **步驟 2：先寫 create-draft 失敗測試**

驗證 command 先建立 InputEvent，再儲存 awaiting-confirmation draft。相同 Telegram update ID 重送不得建立第二筆 draft。

- [ ] **步驟 3：實作 createDraft**

流程固定為保存 InputEvent、處理 duplicate、呼叫 parser、保存合法 draft、回傳 typed result。缺少欄位不得建立正式 transaction。

- [ ] **步驟 4：實作 confirmDraft 與 listRecent**

確認服務只委派儲存庫的原子操作。最近交易預設 10 筆、最多 50 筆，依確認時間由新到舊排序。

- [ ] **步驟 5：執行測試並提交**

```bash
pnpm test:run tests/application
git add src/application tests/application tests/support
git commit -m "feat: add draft confirmation application flow"
```

### 任務 6：建立 Telegram 轉接器

**檔案：**
- 建立：`src/telegram/format-preview.ts`、`src/telegram/create-bot.ts`
- 測試：`tests/telegram/format-preview.test.ts`、`tests/telegram/create-bot.test.ts`

- [ ] **步驟 1：先寫 preview 失敗測試**

預覽必須包含日期、支出、TWD 120、餐飲／午餐，以及確認與取消按鈕。

- [ ] **步驟 2：實作 formatter**

只使用已驗證的領域值，不在 callback data 或一般日誌放入原始輸入。

- [ ] **步驟 3：寫 handler 測試**

涵蓋非白名單、群組、合法文字、`confirm:<draftId>`、`cancel:<draftId>`、重複確認及空的 `/recent`。

- [ ] **步驟 4：實作 handlers**

所有 handler 先驗證 private chat 與 owner ID。Callback 只保存 draft ID。已確認 draft 再次 callback 時，回傳既有 transaction。

- [ ] **步驟 5：執行測試並提交**

```bash
pnpm test:run tests/telegram tests/application
git add src/telegram tests/telegram
git commit -m "feat: expose ledger flow through telegram"
```

### 任務 7：組合執行環境與 Docker

**檔案：**
- 建立：`src/main.ts`、`Dockerfile`、`compose.yaml`
- 修改：`.env.example`、`README.md`
- 測試：`tests/smoke/runtime.test.ts`

- [ ] **步驟 1：先寫 composition smoke test**

使用暫存 SQLite 路徑與測試 Token 建立相依關係，但不啟動長輪詢。驗證 migration 已執行且儲存庫可讀寫。

- [ ] **步驟 2：實作 main composition**

順序固定為載入設定、建立資料目錄、開啟 SQLite、執行 migration、建立儲存庫、服務與 Bot、註冊 SIGINT／SIGTERM、開始長輪詢。

- [ ] **步驟 3：加入 Docker**

使用 Node 24 LTS image、非 root user、`/app/data` volume 與 `restart: unless-stopped`。秘密資料只由環境變數注入。

- [ ] **步驟 4：補 README 並完整驗證**

```bash
pnpm test:run
pnpm typecheck
pnpm lint
docker compose config
docker build -t personal-ledger:test .
```

- [ ] **步驟 5：提交**

```bash
git add src/main.ts Dockerfile compose.yaml .env.example README.md tests/smoke
git commit -m "feat: package first ledger bot vertical slice"
```

### 任務 8：人工驗收與計畫結案

**檔案：**
- 建立：`docs/quality/m1-acceptance.md`
- 修改：`README.md`

- [ ] **步驟 1：建立 BotFather 開發 Bot 與本機 .env**

不得提交 `.env` 或 Token，只設定允許的 Telegram user ID。

- [ ] **步驟 2：執行人工驗收**

```text
1. 未授權使用者無法取得財務資料。
2. 群組訊息被拒絕。
3. 「午餐 120」產生正確預覽。
4. 取消不建立正式 transaction。
5. 確認建立一筆 transaction。
6. 連點確認仍只有一筆 transaction。
7. 重啟 container 後 /recent 仍查得到。
8. transaction 可連回原始 InputEvent。
```

- [ ] **步驟 3：執行最終自動驗證**

```bash
pnpm test:run
pnpm typecheck
pnpm lint
docker compose config
docker build -t personal-ledger:m1 .
```

- [ ] **步驟 4：記錄證據並提交**

記錄工具版本、測試數量、image ID、驗收日期與結果，不得記錄 Token、chat ID、完整私人財務原文或本機絕對路徑。

```bash
git add docs/quality/m1-acceptance.md README.md
git commit -m "docs: record m1 acceptance evidence"
```

## 計畫完成條件

八個任務全部勾選、自動品質檢查通過、Telegram 人工流程通過，且 M1 驗收證據已提交，才算完成本計畫。完成後應從已驗證的程式碼撰寫 M2 實作計畫，不在現在預先擴張本計畫。

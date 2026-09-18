# M2 帳務核心完整化實作計畫

> **給 agentic workers：** 必須使用 `superpowers:subagent-driven-development`（建議）或 `superpowers:executing-plans`，逐項執行本計畫。所有步驟使用 checkbox（`- [ ]`）追蹤。

**目標：** 將 M1 的單一支出流程擴充為可處理收入、一般與信用卡支出、內部轉帳、信用卡繳款、退款、手續費、正式交易異動及雙口徑統計的完整 TWD 帳務核心。

**架構：** `Transaction` 維持聚合根，所有帳務不變條件與統計計算位於純領域模組。應用服務只協調 repository port；SQLite adapter 負責 migration、參照資料與原子持久化；Telegram adapter 只負責授權、輸入轉換與結果呈現。M2 沿用 M1 的 draft JSON 邊界，但正式帳本改為正規化資料與不可變 AuditEvent。

**技術棧：** Node.js 24、TypeScript strict ESM、Zod 4、Decimal.js、better-sqlite3、grammY、Vitest、ESLint、Docker。

**設計規格：** `docs/domain/accounting-model.md`

## 全域限制

- 所有專案文件預設使用繁體中文；程式識別字、schema 欄位、enum、指令與必要技術名詞保留英文。
- 只實作 AC-01 至 AC-08、AC-15、AC-16、AC-18、AC-19；不得提前加入 M3 的多筆、追問與代墊，或 M4 的 jobs。
- 金額一律使用正規化十進位字串與 Decimal.js，不得使用 IEEE 浮點數運算。
- `0001_initial.sql` 不得修改；所有 schema 演進放在 `0002_accounting_core.sql`。
- 每次正式帳本異動必須連回 InputEvent，並在同一 SQLite transaction 寫入 AuditEvent。
- 既有 M1 transaction、allocation、request ID 與 source event 必須無損遷移。
- 每筆正式交易仍須經使用者確認；parser 不得直接建立正式交易。
- 正式環境日誌與錯誤不得包含 token、owner ID、完整財務原文或 SQL 細節。
- 每個任務遵循 red-green-refactor，且只提交該任務相關檔案。

---

## 預計檔案結構

```text
src/
├── application/
│   ├── confirm-draft.ts
│   ├── create-draft.ts
│   ├── ledger-summary.ts
│   ├── mutate-transaction.ts
│   └── reference-data.ts
├── db/
│   ├── bootstrap-reference-data.ts
│   ├── migrate.ts
│   ├── migrations/
│   │   └── 0002_accounting_core.sql
│   ├── sqlite-ledger-repository.ts
│   ├── sqlite-reference-repository.ts
│   └── sqlite-summary-repository.ts
├── domain/
│   ├── ledger.ts
│   ├── ledger-summary.ts
│   ├── money.ts
│   └── reference-data.ts
├── parser/
│   └── rule-parser.ts
├── ports/
│   ├── ledger-repository.ts
│   ├── reference-repository.ts
│   └── summary-repository.ts
└── telegram/
    ├── create-bot.ts
    ├── format-preview.ts
    └── format-summary.ts
tests/
├── application/
├── db/
├── domain/
├── fixtures/
├── parser/
├── smoke/
└── telegram/
```

### 任務 1：擴充帳務領域模型與合法形狀

**檔案：**
- 修改：`src/domain/ledger.ts`
- 建立：`src/domain/reference-data.ts`
- 修改：`tests/domain/ledger.test.ts`
- 建立：`tests/domain/reference-data.test.ts`

**介面：**
- 產出：`AccountSchema`、`CategorySchema`、`MerchantSchema`、`CounterpartySchema`、`TagSchema`
- 產出：擴充後的 `AllocationSchema`、`TransactionDraftSchema`、`ConfirmedTransactionSchema`
- 產出：`validateAccountingShape(entry): void`，由 Zod `superRefine` 使用

- [x] **步驟 1：先寫參照資料 schema 失敗測試**

```ts
it("拒絕非 TWD 帳戶與超過兩層的分類", () => {
  expect(() => AccountSchema.parse({
    accountId: "account-1",
    ownerId: "owner-1",
    name: "國泰卡",
    type: "credit_card",
    currency: "USD",
    active: true,
  })).toThrow();

  expect(() => CategorySchema.parse({
    categoryId: "category-3",
    ownerId: "owner-1",
    name: "午餐",
    kind: "expense",
    parentId: "category-2",
    depth: 3,
    active: true,
  })).toThrow();
});
```

- [x] **步驟 2：執行測試並確認因 module 不存在而失敗**

執行：`pnpm test:run tests/domain/reference-data.test.ts`  
預期：FAIL，無法匯入 `src/domain/reference-data.ts`。

- [x] **步驟 3：實作參照資料 schema**

```ts
export const AccountTypeSchema = z.enum(["cash", "bank", "credit_card", "e_wallet"]);
export const AccountSchema = z.object({
  accountId: z.string().min(1),
  ownerId: z.string().min(1),
  name: z.string().trim().min(1),
  type: AccountTypeSchema,
  currency: z.literal("TWD"),
  active: z.boolean(),
});

export const CategorySchema = z.object({
  categoryId: z.string().min(1),
  ownerId: z.string().min(1),
  key: z.string().regex(/^[a-z0-9_]+$/),
  name: z.string().trim().min(1),
  kind: z.enum(["income", "expense"]),
  parentId: z.string().min(1).optional(),
  depth: z.union([z.literal(1), z.literal(2)]),
  active: z.boolean(),
});
```

Merchant、Counterparty 與 Tag 使用相同的 owner-scoped identity、非空名稱及 active 狀態；Tag 另保存 `normalizedName`。

- [x] **步驟 4：先寫合法帳務形狀表格測試**

```ts
it.each([
  ["inflow", "income"],
  ["outflow", "expense"],
  ["none", "expense"],
  ["internal", "transfer"],
  ["outflow", "transfer"],
  ["inflow", "refund"],
  ["none", "refund"],
  ["outflow", "fee"],
] as const)("接受 %s + %s", (fundsEffect, purpose) => {
  expect(() => makeDraft({ fundsEffect, purpose })).not.toThrow();
});

it.each([
  ["inflow", "expense"],
  ["internal", "income"],
  ["none", "fee"],
] as const)("拒絕 %s + %s", (fundsEffect, purpose) => {
  expect(() => makeDraft({ fundsEffect, purpose })).toThrow("unsupported accounting shape");
});
```

- [x] **步驟 5：擴充交易與配置 schema**

新增 `categoryId`、`counterpartyId`、`note` 至 allocation；新增 `occurredTime`、帳戶、商家、交易對象、tag IDs、note、source type/ref 與 lifecycle timestamps 至 ledger entry。保留 M1 parser 需要的 `category` 與 `subcategory` 相容讀取只到 migration 完成；新的 domain object 一律輸出 ID。

帳務形狀驗證以明確 `Set` 實作：

```ts
const supportedShapes = new Set([
  "inflow:income",
  "outflow:expense",
  "none:expense",
  "internal:transfer",
  "outflow:transfer",
  "inflow:refund",
  "none:refund",
  "outflow:fee",
]);
```

另驗證 internal transfer 兩個帳戶必填且不同、信用卡消費不得有目的帳戶、所有配置幣別一致及總額精確相等。

- [x] **步驟 6：執行領域品質檢查**

執行：

```bash
pnpm test:run tests/domain
pnpm typecheck
pnpm lint
```

預期：全部通過。

- [x] **步驟 7：提交領域模型**

```bash
git add src/domain/ledger.ts src/domain/reference-data.ts tests/domain
git commit -m "feat: define m2 accounting domain model"
```

### 任務 2：建立 M2 migration 與 M1 資料升級

**檔案：**
- 建立：`src/db/migrations/0002_accounting_core.sql`
- 修改：`src/db/migrate.ts`
- 建立：`tests/db/migrate-accounting-core.test.ts`
- 建立：`tests/fixtures/m1-ledger.ts`

**介面：**
- 修改：`migrate(database: Database.Database): void`，依版本順序套用所有 migration
- 產出：schema version 2 與 M1 compatibility fixture

- [x] **步驟 1：建立含真實 M1 資料的 fixture helper**

```ts
export function seedM1Ledger(database: Database.Database): {
  transactionId: string;
  sourceEventId: string;
} {
  database.exec(readFileSync(new URL("../../src/db/migrations/0001_initial.sql", import.meta.url), "utf8"));
  // 寫入一筆已確認 food / meal 支出及一筆待確認 draft。
  return { transactionId: "m1-transaction", sourceEventId: "m1-event" };
}
```

- [x] **步驟 2：先寫 migration 失敗測試**

測試必須驗證：

```ts
expect(schemaVersions(database)).toEqual([1, 2]);
expect(loadTransaction("m1-transaction")).toMatchObject({
  transactionId: "m1-transaction",
  sourceEventId: "m1-event",
  categoryKey: "expense_dining_lunch",
});
expect(loadDraftStatus("m1-draft")).toBe("archived");
expect(database.pragma("foreign_key_check")).toEqual([]);
```

再次呼叫 `migrate(database)` 後，所有 table row counts 必須不變。

- [x] **步驟 3：執行測試並確認缺少 version 2 而失敗**

執行：`pnpm test:run tests/db/migrate-accounting-core.test.ts`  
預期：FAIL，schema version 只有 1。

- [x] **步驟 4：建立 version 2 schema**

SQL 建立：

- `accounts`、`categories`、`merchants`、`counterparties`、`tags`；
- `transaction_tags`、`transaction_links`、`audit_events`；
- 含 M2 欄位與 `confirmed|deleted` 約束的新 transactions/allocations tables；
- owner/date/status、category、link target 與 audit transaction 索引。

以 rename-copy-drop 方式重建 M1 tables。先建立 canonical 餐飲／午餐 category，再將 `food / meal` 映射至其 ID；其他舊分類依 normalized key 建立 owner-scoped legacy category。未完成 draft 改為 `archived`，但保留 JSON。

- [x] **步驟 5：將 migrate 改為有序 registry**

```ts
const migrations = [
  { version: 1, url: new URL("./migrations/0001_initial.sql", import.meta.url) },
  { version: 2, url: new URL("./migrations/0002_accounting_core.sql", import.meta.url) },
] as const;
```

每一版使用 immediate transaction，成功後才寫 `schema_migrations`。套用所有版本後執行 `foreign_key_check`，若有資料則拋錯並停止啟動。

- [x] **步驟 6：更新 build 資產測試並執行 DB 檢查**

現有 build glob 已複製所有 `.sql`，新增 assertion 驗證 `dist/src/db/migrations/0002_accounting_core.sql` 存在。

執行：

```bash
pnpm test:run tests/db tests/startup.test.ts
pnpm typecheck
pnpm lint
```

- [x] **步驟 7：提交 migration**

```bash
git add src/db/migrate.ts src/db/migrations/0002_accounting_core.sql tests/db/migrate-accounting-core.test.ts tests/fixtures/m1-ledger.ts tests/startup.test.ts
git commit -m "feat: migrate m1 ledger data to accounting core"
```

### 任務 3：建立參照資料 repository 與預設資料

**檔案：**
- 建立：`src/ports/reference-repository.ts`
- 建立：`src/db/sqlite-reference-repository.ts`
- 建立：`src/db/bootstrap-reference-data.ts`
- 建立：`tests/db/sqlite-reference-repository.test.ts`
- 建立：`tests/db/bootstrap-reference-data.test.ts`

**介面：**
- 產出：`ReferenceRepository`
- 產出：`bootstrapReferenceData(repository, ownerId): Promise<void>`
- 產出：owner-scoped `getAccount`、`findAccountByName`、`getCategory`、`findCategoryByKey`、`upsertMerchant`、`upsertCounterparty`、`upsertTag`

- [x] **步驟 1：先定義 port 與失敗 contract tests**

```ts
export interface ReferenceRepository {
  getAccount(ownerId: string, accountId: string): Promise<Account | null>;
  findAccountByName(ownerId: string, name: string): Promise<Account[]>;
  getCategory(ownerId: string, categoryId: string): Promise<Category | null>;
  findCategoryByKey(ownerId: string, key: string): Promise<Category | null>;
  saveAccount(account: Account): Promise<void>;
  saveCategory(category: Category): Promise<void>;
  upsertMerchant(input: NamedReferenceInput): Promise<Merchant>;
  upsertCounterparty(input: NamedReferenceInput): Promise<Counterparty>;
  upsertTag(input: NamedReferenceInput): Promise<Tag>;
}
```

測試相同名稱在不同 owner 可共存、停用資料仍可依 ID 讀取、模糊名稱回傳多候選、tag Unicode normalization 冪等。

- [x] **步驟 2：執行測試並確認 adapter 不存在**

執行：`pnpm test:run tests/db/sqlite-reference-repository.test.ts`  
預期：FAIL，無法匯入 SQLite adapter。

- [x] **步驟 3：實作 SQLite reference adapter**

所有查詢同時使用 `owner_id` 與 entity ID。名稱查詢使用持久化的 `normalized_name`，不得以 application-side 全表掃描比對。

- [x] **步驟 4：先寫 bootstrap 冪等測試**

連續執行兩次 bootstrap 後，預設 category 與 account row counts 必須相同。至少建立：

- 支出根分類與餐飲／午餐、交通、購物、居住、娛樂、醫療、學習、人情、旅遊、金融費用、其他支出、待分類；
- 收入根分類與薪資、獎金、投資收入、其他收入；
- 預設現金帳戶。

- [x] **步驟 5：實作 bootstrap 並接入 runtime composition**

在 `composeRuntime` 完成 migration 後、建立 Bot 前呼叫 bootstrap。由 `LEDGER_OWNER_ID` 作為 owner ID；使用 stable keys，不使用顯示名稱作識別。

- [x] **步驟 6：執行參照與 smoke 測試**

```bash
pnpm test:run tests/db/sqlite-reference-repository.test.ts tests/db/bootstrap-reference-data.test.ts tests/smoke/runtime.test.ts
pnpm typecheck
pnpm lint
```

- [x] **步驟 7：提交參照資料能力**

```bash
git add src/ports/reference-repository.ts src/db/sqlite-reference-repository.ts src/db/bootstrap-reference-data.ts src/main.ts tests/db tests/smoke/runtime.test.ts
git commit -m "feat: persist accounting reference data"
```

### 任務 4：正規化正式帳本、稽核與交易異動

**檔案：**
- 修改：`src/ports/ledger-repository.ts`
- 修改：`src/db/sqlite-ledger-repository.ts`
- 修改：`src/application/confirm-draft.ts`
- 建立：`src/application/mutate-transaction.ts`
- 修改：`tests/db/sqlite-ledger-repository.test.ts`
- 建立：`tests/application/mutate-transaction.test.ts`

**介面：**
- 擴充：`confirmDraft(draftId, confirmedAt, auditEventId)`
- 產出：`getTransaction(ownerId, transactionId)`、`updateTransaction(command)`、`softDeleteTransaction(command)`
- 產出：`linkTransaction(command)`、`unlinkTransaction(command)`、`listAuditEvents(ownerId, transactionId)`

- [ ] **步驟 1：先寫建立交易與 AuditEvent 原子性測試**

確認 draft 後必須同時存在 transaction、allocations 與一筆 `transaction_created` audit。以 trigger 人為讓 audit insert 失敗時，三者都不得寫入。

- [ ] **步驟 2：先寫更新與刪除失敗測試**

```ts
await repository.updateTransaction({
  ownerId: "owner-1",
  transactionId,
  sourceEventId: "edit-event",
  auditEventId: "audit-update",
  expectedUpdatedAt: original.updatedAt,
  replacement: changedAggregate,
  changedAt: "2026-09-18T05:00:00.000Z",
});

expect(await repository.listAuditEvents("owner-1", transactionId)).toMatchObject([
  { action: "transaction_created" },
  { action: "transaction_updated", before: original, after: changedAggregate },
]);
```

另一 owner、過期 `expectedUpdatedAt`、已刪除交易、重複刪除都必須回傳明確 domain error 且不新增 audit。

- [ ] **步驟 3：實作正規化 row mapper 與原子 mutation**

停止從 transaction JSON 還原正式交易；由 transactions、allocations、tags、links 正規化資料組裝 aggregate。draft 仍可使用 JSON。

更新配置使用 delete-and-insert，但只在同一 immediate transaction 中進行。使用 `updated_at = expectedUpdatedAt` optimistic check 防止 stale mutation。

- [ ] **步驟 4：先寫退款關聯測試**

驗證 `refund_of` 只能從 refund 指向同 owner、未刪除的 expense；允許多筆 refund 指向同一原交易；解除關聯產生 `transaction_unlinked` audit。

- [ ] **步驟 5：實作 application mutation services**

```ts
export async function updateConfirmedTransaction(
  command: UpdateTransactionCommand,
  dependencies: MutationDependencies,
): Promise<ConfirmedTransaction>;

export async function softDeleteConfirmedTransaction(
  command: DeleteTransactionCommand,
  dependencies: MutationDependencies,
): Promise<ConfirmedTransaction>;
```

服務先記錄不可變 InputEvent，再呼叫 repository mutation。repository 以 owner scope 驗證 ownership。

- [ ] **步驟 6：執行 ledger 與 application 測試**

```bash
pnpm test:run tests/db/sqlite-ledger-repository.test.ts tests/application
pnpm typecheck
pnpm lint
```

- [ ] **步驟 7：提交正式帳本異動能力**

```bash
git add src/ports/ledger-repository.ts src/db/sqlite-ledger-repository.ts src/application tests/db/sqlite-ledger-repository.test.ts tests/application
git commit -m "feat: audit confirmed ledger mutations"
```

### 任務 5：建立雙口徑摘要與分類統計

**檔案：**
- 建立：`src/domain/ledger-summary.ts`
- 建立：`src/ports/summary-repository.ts`
- 建立：`src/db/sqlite-summary-repository.ts`
- 建立：`src/application/ledger-summary.ts`
- 建立：`tests/domain/ledger-summary.test.ts`
- 建立：`tests/db/sqlite-summary-repository.test.ts`
- 建立：`tests/fixtures/accounting-scenarios.ts`

**介面：**
- 產出：`LedgerSummarySchema`、`summarizeAllocations()`
- 產出：`SummaryRepository.summarize(ownerId, range)`
- 產出：`getTodaySummary()`、`getMonthSummary()`

- [ ] **步驟 1：建立固定帳務 fixture**

Fixture 至少包含：收入 85,000、現金支出 120、信用卡支出 1,200、內部轉帳 5,000、卡費 18,000、轉帳費 15、現金退款 990、已刪除支出 500。每筆配置明確指定 category。

- [ ] **步驟 2：先寫純領域統計失敗測試**

```ts
expect(summarizeAllocations(fixture.effectiveAllocations)).toMatchObject({
  actualInflow: { amount: "85990", currency: "TWD" },
  actualOutflow: { amount: "18135", currency: "TWD" },
  netCashFlow: { amount: "67855", currency: "TWD" },
  personalIncome: { amount: "85000", currency: "TWD" },
  grossPersonalExpense: { amount: "1335", currency: "TWD" },
  refunds: { amount: "990", currency: "TWD" },
  netPersonalExpense: { amount: "345", currency: "TWD" },
  personalBalance: { amount: "84655", currency: "TWD" },
});
```

另寫退款大於當期支出時淨支出為負數、零值仍以 `0` 表示、Decimal `0.1 + 0.2` 精確等於 `0.3`。

- [ ] **步驟 3：實作純領域摘要**

使用 Decimal reduce，最後才轉回 canonical string。分類結果依淨支出遞減、category key 遞增穩定排序。

- [ ] **步驟 4：先寫 SQLite summary integration test**

驗證 date range inclusive、owner 隔離、deleted 排除、internal/none 對資金口徑無影響、refund 沖減分類。

- [ ] **步驟 5：實作 summary repository 與日期 application service**

Repository 只載入範圍內的有效 allocation projection，再交給 domain summarize；不得用 SQLite 浮點 `SUM`。Application service 注入 `today(): string`，month 起日以字串安全計算為 `YYYY-MM-01`。

- [ ] **步驟 6：執行摘要測試**

```bash
pnpm test:run tests/domain/ledger-summary.test.ts tests/db/sqlite-summary-repository.test.ts
pnpm typecheck
pnpm lint
```

- [ ] **步驟 7：提交摘要能力**

```bash
git add src/domain/ledger-summary.ts src/ports/summary-repository.ts src/db/sqlite-summary-repository.ts src/application/ledger-summary.ts tests/domain tests/db tests/fixtures/accounting-scenarios.ts
git commit -m "feat: calculate exact ledger summaries"
```

### 任務 6：擴充確定性 M2 parser

**檔案：**
- 修改：`src/parser/rule-parser.ts`
- 修改：`tests/parser/rule-parser.test.ts`
- 建立：`tests/parser/accounting-flows.test.ts`

**介面：**
- 擴充：`parseTransaction(text, context): ParseResult`
- Context 新增：已啟用 account/category/merchant candidates
- 產出：`missing_fields` 與 `ambiguous` issue paths，不進行對話追問

- [ ] **步驟 1：先寫 AC parser table tests**

```ts
it.each([
  ["薪水 +85000", { purpose: "income", fundsEffect: "inflow", amount: "85000" }],
  ["昨天 Uber 245 國泰卡", { merchant: "Uber", account: "國泰卡", amount: "245" }],
  ["台新轉國泰 5000", { purpose: "transfer", fundsEffect: "internal", amount: "5000" }],
  ["國泰卡刷 1200", { purpose: "expense", fundsEffect: "none", amount: "1200" }],
  ["繳國泰卡 18000 從台新", { purpose: "transfer", fundsEffect: "outflow", amount: "18000" }],
  ["台新轉國泰 1000 手續費 15", { amount: "1015", allocations: ["1000", "15"] }],
] as const)("解析 %s", (text, expected) => {
  expect(parseWithReferences(text)).toMatchObject({ kind: "draft", draft: expected });
});
```

- [ ] **步驟 2：先寫歧義與未知參照測試**

兩個同名帳戶回傳 `ambiguous` 且列出 candidate IDs；未知信用卡、缺退款分類、多個未指定用途金額都不得建立 draft。

- [ ] **步驟 3：執行測試並確認新形式失敗**

執行：`pnpm test:run tests/parser`  
預期：M1 案例通過，新增 M2 案例失敗。

- [ ] **步驟 4：以小型規則函式實作，不建立通用 NLP engine**

拆分 `parseAmountCandidates`、`parseRelativeDate`、`matchReferenceByName`、`classifyAccountingIntent`。規則順序為明確 transfer/fee、income、refund、card payment、card expense、ordinary expense。所有輸出最後通過 `TransactionDraftSchema`。

- [ ] **步驟 5：執行 parser 與領域回歸**

```bash
pnpm test:run tests/parser tests/domain
pnpm typecheck
pnpm lint
```

- [ ] **步驟 6：提交 parser**

```bash
git add src/parser/rule-parser.ts tests/parser
git commit -m "feat: parse deterministic accounting flows"
```

### 任務 7：整合應用服務與參照解析

**檔案：**
- 修改：`src/application/create-draft.ts`
- 修改：`src/application/confirm-draft.ts`
- 建立：`src/application/reference-data.ts`
- 修改：`tests/application/create-draft.test.ts`
- 修改：`tests/application/ledger-actions.test.ts`
- 建立：`tests/application/reference-data.test.ts`

**介面：**
- `createDraft` 先載入 owner 的有效 reference snapshot，再呼叫 parser
- `confirmDraft` 同時建立 transaction 與 creation audit
- 產出：查詢 reference candidates 與退款目標的 application functions

- [ ] **步驟 1：先寫 application orchestration 測試**

驗證相同 Telegram update 仍只建立一個 InputEvent；reference repository 回傳兩個同名帳戶時不保存 draft；合法 draft 保存 ID 而非顯示名稱。

- [ ] **步驟 2：先寫 confirm audit 與退款目標測試**

確認建立 transaction creation audit；退款候選只包含同 owner、未刪除、purpose=expense 的交易，依日期近、商家相同、金額相同排序。

- [ ] **步驟 3：實作 reference snapshot 與 services**

`createDraft` dependencies 增加 `referenceRepository`。Snapshot 只包含有效資料及 parser 所需欄位，不讓 parser 存取 database。

- [ ] **步驟 4：執行 application 測試**

```bash
pnpm test:run tests/application
pnpm typecheck
pnpm lint
```

- [ ] **步驟 5：提交 application integration**

```bash
git add src/application tests/application
git commit -m "feat: orchestrate accounting draft workflows"
```

### 任務 8：擴充 Telegram 預覽、異動與統計指令

**檔案：**
- 修改：`src/telegram/create-bot.ts`
- 修改：`src/telegram/format-preview.ts`
- 建立：`src/telegram/format-summary.ts`
- 修改：`tests/telegram/create-bot.test.ts`
- 修改：`tests/telegram/format-preview.test.ts`
- 建立：`tests/telegram/format-summary.test.ts`

**介面：**
- 新增 `/today`、`/month`
- 新增 `delete:<transactionId>`、`refund:<transactionId>` callbacks
- 預覽完整顯示每筆 allocation 的 funds effect、purpose、category 與 amount

- [ ] **步驟 1：先寫完整預覽失敗測試**

轉帳加手續費預覽必須分兩列顯示，信用卡支出明確標示「不影響當下可動用資金」，退款顯示目標 transaction 的安全摘要，不顯示原始輸入。

- [ ] **步驟 2：先寫 `/today` 與 `/month` handler 測試**

驗證 owner/private gate、正確日期範圍、雙口徑數值、負數淨支出、空帳本及分類穩定排序。

- [ ] **步驟 3：先寫 mutation callback 測試**

刪除 callback 建立新的 InputEvent 並軟刪除；重複 callback 不產生第二次 audit；另一 owner 與群組 callback 無回覆。修改流程使用明確欄位 callback，不實作自由文字追問。

- [ ] **步驟 4：實作 formatter 與 handlers**

Callback data 只放 action 與 opaque ID，不放金額、分類、owner ID 或原文。所有 repository error 映射為固定安全訊息，詳細錯誤只以不含資料的 error code 記錄。

- [ ] **步驟 5：執行 Telegram 與 application 回歸**

```bash
pnpm test:run tests/telegram tests/application
pnpm typecheck
pnpm lint
```

- [ ] **步驟 6：提交 Telegram 能力**

```bash
git add src/telegram tests/telegram
git commit -m "feat: expose m2 accounting workflows in telegram"
```

### 任務 9：Runtime、Docker、驗收與文件結案

**檔案：**
- 修改：`src/main.ts`
- 修改：`tests/smoke/runtime.test.ts`
- 修改：`README.md`
- 建立：`docs/quality/m2-acceptance.md`
- 修改：`docs/roadmap.md`

**介面：**
- Runtime 組合 reference、ledger、summary repositories
- M2 acceptance 文件記錄自動與人工證據，不含秘密及識別資訊

- [ ] **步驟 1：擴充 runtime smoke test**

使用 M1 fixture database 啟動 composition，驗證自動升級至 version 2、bootstrap 冪等、原交易可讀、summary 正確，且不啟動 polling。

- [ ] **步驟 2：更新 runtime composition**

固定順序：載入設定、建立目錄、開 DB、套用 migration、bootstrap reference data、建立 repositories、建立 Bot。任何 migration 或 bootstrap 失敗都關閉 DB 並拒絕啟動。

- [ ] **步驟 3：補 README 中文操作說明**

記錄 M2 支援語句、`/today`、`/month`、修改／刪除限制、Docker 升級方式與 migration 前自行備份提醒。不得在文件放 token、owner ID 或本機絕對路徑。

- [ ] **步驟 4：執行完整自動驗證**

```bash
pnpm check
docker compose --env-file .env config --quiet
docker build -t personal-ledger:m2 .
docker run --rm \
  -e TELEGRAM_BOT_TOKEN=test-token \
  -e LEDGER_OWNER_ID=1 \
  -e DATABASE_PATH=/tmp/ledger.sqlite \
  -e LEDGER_STARTUP_CHECK=1 \
  personal-ledger:m2
```

預期：所有 tests、format、typecheck、lint、build、Compose 與 image startup check 通過。

- [ ] **步驟 5：執行人工 Telegram 驗收**

依序驗證且不在文件記錄私人原文：

1. AC-01 至 AC-08；
2. AC-15、AC-16、AC-18、AC-19；
3. `/today` 與 `/month` 雙口徑數值；
4. 另一使用者與群組無法取得資料；
5. container 重啟後 migration、交易、audit 與摘要仍正確。

- [ ] **步驟 6：建立驗收證據並更新 roadmap**

`docs/quality/m2-acceptance.md` 記錄日期、工具版本、test 數量、image ID、各 AC 結果與資料升級結果。`docs/roadmap.md` 只將 M2 標記完成，不改變後續里程碑範圍。

- [ ] **步驟 7：提交 M2 結案文件**

```bash
git add src/main.ts tests/smoke/runtime.test.ts README.md docs/quality/m2-acceptance.md docs/roadmap.md
git commit -m "docs: record m2 acceptance evidence"
```

## 完成條件

- 九個任務全部勾選且各自通過指定測試。
- AC-01 至 AC-08、AC-15、AC-16、AC-18、AC-19 自動與人工驗收通過。
- M1 database 無損升級至 schema version 2，foreign key 完整且 migration 冪等。
- 固定 fixture 的資金口徑、個人財務口徑及分類統計 100% 精確。
- 每次 create、update、delete、link、unlink 都有來源事件與 AuditEvent。
- `pnpm check`、Compose、Docker build 與 container startup check 全數通過。
- 驗收證據完成提交後，才可進入 M3 規劃。

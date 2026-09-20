# M3a 批次與對話狀態實作計畫

> **給 agentic workers：** 必須使用 `superpowers:subagent-driven-development`（建議）或 `superpowers:executing-plans`，逐項執行本計畫。所有步驟使用 checkbox（`- [ ]`）追蹤。

**目標：** 讓一則 Telegram 訊息可以產生最多 10 筆草稿，讓解析不完整的草稿以 `awaiting_input` 留存並可經追問補齊，並提供永久保存的 `/pending` 清單與封存。

**架構：** 對話狀態全部長在 `drafts` 列上，不引入會話實體。輸入切分、callback 編解碼與草稿升級都是純函式；應用層只協調 repository port；Telegram adapter 只負責授權、事件轉換與呈現。不完整草稿以獨立領域型別表示，唯一的升級入口是補欄位後重新驗證，因此不完整草稿在型別層面沒有確認路徑。

**技術棧：** Node.js 24、TypeScript strict ESM、Zod 4、Decimal.js、better-sqlite3、grammY、Vitest、ESLint、Docker。

**設計規格：** `docs/domain/conversation-model.md`

## 全域限制

- 所有專案文件預設使用繁體中文；程式識別字、schema 欄位、enum、指令與必要技術名詞保留英文。
- 只實作 AC-09 與 AC-10；不得提前加入 M3b 的代墊與回收（`advance`、`advance_recovery`、`/advances`），也不得加入 M4 的 jobs 或 M5 的 Sheet 同步。
- `supportedAccountingShapes` 白名單不得改動。M3a 不新增任何帳務形狀。
- 金額一律使用正規化十進位字串與 Decimal.js，不得使用 IEEE 浮點數運算。
- `0001_initial.sql` 與 `0002_accounting_core.sql` 不得修改；所有 schema 演進放在 `0003_conversation_state.sql`。
- `drafts.status` 不得新增值，只使用 M1 已定義的八個狀態。
- Telegram `callback_data` 上限 64 bytes；所有產生的 payload 必須經測試斷言不超過此上限。
- 領域層與應用層不得 import grammy 或其型別。
- 每筆正式交易仍須經使用者確認；parser 與追問流程都不得直接建立正式交易。
- 既有 M2 草稿、交易、audit 與 request ID 必須無損遷移，`pnpm check` 必須全綠。
- 正式環境日誌與錯誤不得包含 token、owner ID、完整財務原文或 SQL 細節。
- 每個任務遵循 red-green-refactor，且只提交該任務相關檔案。

---

## 預計檔案結構

```text
src/
├── application/
│   ├── answer-draft.ts          # 新增：補欄位與升級
│   ├── create-batch.ts          # 新增：一則訊息 → 批次草稿
│   ├── create-draft.ts          # 保留：退款草稿仍使用
│   ├── list-pending.ts          # 新增：待處理查詢
│   └── ...既有檔案
├── db/
│   ├── migrations/
│   │   └── 0003_conversation_state.sql   # 新增
│   ├── migrate.ts               # 修改：外鍵開關處理
│   └── sqlite-ledger-repository.ts       # 修改：批次、短碼、待處理
├── domain/
│   ├── draft.ts                 # 新增：IncompleteDraft 與升級
│   └── ledger.ts                # 不動
├── parser/
│   ├── split-input.ts           # 新增：輸入切分
│   └── rule-parser.ts           # 修改：回傳部分解析結果
├── ports/
│   └── ledger-repository.ts     # 修改：新增草稿與批次介面
└── telegram/
    ├── callback-data.ts         # 新增：callback 編解碼
    ├── create-bot.ts            # 修改：只保留組裝與白名單
    ├── format-prompt.ts         # 新增：追問訊息與候選鍵盤
    └── handlers/
        ├── drafts.ts            # 新增：批次輸入、追問、確認、過期
        ├── pending.ts           # 新增：/pending 與封存
        ├── summaries.ts         # 新增：/today、/month（搬移）
        └── transactions.ts      # 新增：/recent、退款、刪除（搬移）
```

---

### Task 1：輸入切分

**Files:**

- Create: `src/parser/split-input.ts`
- Test: `tests/parser/split-input.test.ts`

**Interfaces:**

- Consumes: 無。
- Produces: `splitInput(text: string): string[]`。回傳已去除空白的段落；無有效內容時回傳空陣列。

- [ ] **Step 1：寫失敗測試**

```ts
import { describe, expect, it } from "vitest";

import { splitInput } from "../../src/parser/split-input.js";

describe("splitInput", () => {
  it("splits on separators when each segment carries an amount", () => {
    expect(splitInput("午餐 120，咖啡 60")).toEqual(["午餐 120", "咖啡 60"]);
  });

  it("merges segments without an amount into the previous segment", () => {
    expect(splitInput("聚餐 1260，我先付，朋友欠一半")).toEqual(["聚餐 1260，我先付，朋友欠一半"]);
  });

  it("merges a leading segment without an amount into the next segment", () => {
    expect(splitInput("我先付，聚餐 1260")).toEqual(["我先付，聚餐 1260"]);
  });

  it("keeps existing transfer syntax as a single segment", () => {
    expect(splitInput("台新轉國泰 1000 手續費 15")).toEqual(["台新轉國泰 1000 手續費 15"]);
  });

  it("splits on newlines and ideographic commas", () => {
    expect(splitInput("午餐 120\n咖啡 60、晚餐 300")).toEqual(["午餐 120", "咖啡 60", "晚餐 300"]);
  });

  it("ignores empty segments and whitespace", () => {
    expect(splitInput("  午餐 120，，  ")).toEqual(["午餐 120"]);
    expect(splitInput("   ")).toEqual([]);
  });
});
```

- [ ] **Step 2：執行測試確認失敗**

Run: `pnpm vitest run tests/parser/split-input.test.ts`
Expected: FAIL，找不到模組 `src/parser/split-input.js`。

- [ ] **Step 3：寫最小實作**

```ts
const SEPARATORS = /[,，、\n]/;
const HAS_AMOUNT = /\d/;

export function splitInput(text: string): string[] {
  const segments = text
    .split(SEPARATORS)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

  const merged: string[] = [];
  for (const segment of segments) {
    const previous = merged.at(-1);
    if (!HAS_AMOUNT.test(segment) && previous !== undefined) {
      merged[merged.length - 1] = `${previous}，${segment}`;
      continue;
    }
    merged.push(segment);
  }

  const [first, second, ...rest] = merged;
  if (first !== undefined && second !== undefined && !HAS_AMOUNT.test(first)) {
    return [`${first}，${second}`, ...rest];
  }
  return merged;
}
```

- [ ] **Step 4：執行測試確認通過**

Run: `pnpm vitest run tests/parser/split-input.test.ts`
Expected: PASS，6 個測試。

- [ ] **Step 5：提交**

```bash
git add src/parser/split-input.ts tests/parser/split-input.test.ts
git commit -m "feat: split telegram input into transaction segments"
```

---

### Task 2：不完整草稿領域型別

**Files:**

- Create: `src/domain/draft.ts`
- Create: `tests/fixtures/drafts.ts`
- Test: `tests/domain/draft.test.ts`

`tests/fixtures/drafts.ts` 是後續 Task 5、7、9 共用的測試資料來源，必須匯出：

- `incompleteLunchDraft(overrides?: Partial<IncompleteDraft>): IncompleteDraft` — 缺金額的「午餐」草稿，`pendingFields` 為 `[{ field: "amount", candidateIds: [] }]`，`partial.allocations` 含一筆已解析出餐飲／午餐分類、但沒有 `amount` 的 allocation。
- `incompleteDraftWithPendingCategory(candidateIds: string[]): IncompleteDraft` — 金額已知（TWD 60）但缺分類的「咖啡」草稿。
- `completeLunchDraft(overrides?: Partial<TransactionDraft>): TransactionDraft` — 可確認的「午餐 120」草稿。
- `expenseCategories(ids: string[]): Category[]` — 依 ID 產生啟用中的支出分類，名稱為 `分類 N`。

**Interfaces:**

- Consumes: `AllocationSchema`、`MoneySchema`、`TransactionDraftSchema`（`src/domain/ledger.ts`）。
- Produces:
  - `ParseField = "amount" | "category" | "account" | "refundTarget" | "purpose"`（由本檔定義並由 `rule-parser.ts` 重新匯出）。
  - `PendingField = { field: ParseField; candidateIds: string[] }`
  - `PartialDraft`：`occurredDate`、`rawSegment`、`allocations: PartialAllocation[]`，以及可選的 `accountFromId`、`accountToId`、`merchantId`。
  - `IncompleteDraft`：`draftId`、`ownerId`、`requestId`、`sourceEventId`、`batchId`、`batchIndex`、`pendingFields`、`partial`、`status: "awaiting_input"`。
  - `DraftPatch = { amount?: Money; categoryId?: string; category?: string; accountFromId?: string }`
  - `completeDraft(draft: IncompleteDraft, patch: DraftPatch): CompleteDraftResult`，回傳 `{ kind: "draft"; draft: TransactionDraft }` 或 `{ kind: "incomplete"; draft: IncompleteDraft }`。

- [ ] **Step 1：寫失敗測試**

```ts
import { describe, expect, it } from "vitest";

import { completeDraft, IncompleteDraftSchema } from "../../src/domain/draft.js";
import { money } from "../../src/domain/money.js";

function lunchShell() {
  return IncompleteDraftSchema.parse({
    draftId: "draft-1",
    ownerId: "owner-1",
    requestId: "request-1",
    sourceEventId: "event-1",
    batchId: "batch-1",
    batchIndex: 0,
    pendingFields: [{ field: "amount", candidateIds: [] }],
    partial: {
      occurredDate: "2026-09-21",
      rawSegment: "午餐",
      allocations: [
        {
          allocationId: "allocation-1",
          fundsEffect: "outflow",
          purpose: "expense",
          categoryId: "category-lunch",
          category: "餐飲",
          subcategory: "午餐",
        },
      ],
    },
    status: "awaiting_input",
  });
}

describe("completeDraft", () => {
  it("upgrades to a confirmable draft once the amount arrives", () => {
    const result = completeDraft(lunchShell(), { amount: money("120", "TWD") });

    expect(result.kind).toBe("draft");
    if (result.kind !== "draft") return;
    expect(result.draft.status).toBe("awaiting_confirmation");
    expect(result.draft.amount.amount).toBe("120");
    expect(result.draft.allocations[0]?.amount.amount).toBe("120");
    expect(result.draft.draftId).toBe("draft-1");
  });

  it("keeps the draft incomplete while other fields are still pending", () => {
    const draft = IncompleteDraftSchema.parse({
      ...lunchShell(),
      pendingFields: [
        { field: "amount", candidateIds: [] },
        { field: "category", candidateIds: ["category-a", "category-b"] },
      ],
      partial: {
        occurredDate: "2026-09-21",
        rawSegment: "咖啡",
        allocations: [],
      },
    });

    const result = completeDraft(draft, { amount: money("60", "TWD") });

    expect(result.kind).toBe("incomplete");
    if (result.kind !== "incomplete") return;
    expect(result.draft.pendingFields.map((item) => item.field)).toEqual(["category"]);
  });

  it("applies a category answer to the first allocation missing one", () => {
    const draft = IncompleteDraftSchema.parse({
      ...lunchShell(),
      pendingFields: [{ field: "category", candidateIds: ["category-coffee"] }],
      partial: {
        occurredDate: "2026-09-21",
        rawSegment: "咖啡 60",
        allocations: [
          {
            allocationId: "allocation-1",
            fundsEffect: "outflow",
            purpose: "expense",
            amount: { amount: "60", currency: "TWD" },
            category: "待分類",
          },
        ],
      },
    });

    const result = completeDraft(draft, { categoryId: "category-coffee", category: "餐飲" });

    expect(result.kind).toBe("draft");
    if (result.kind !== "draft") return;
    expect(result.draft.allocations[0]?.categoryId).toBe("category-coffee");
    expect(result.draft.allocations[0]?.category).toBe("餐飲");
  });

  it("stays incomplete when the patched values cannot form a valid draft", () => {
    const draft = IncompleteDraftSchema.parse({
      ...lunchShell(),
      partial: { occurredDate: "2026-09-21", rawSegment: "午餐", allocations: [] },
    });

    const result = completeDraft(draft, { amount: money("120", "TWD") });

    expect(result.kind).toBe("incomplete");
  });
});
```

- [ ] **Step 2：執行測試確認失敗**

Run: `pnpm vitest run tests/domain/draft.test.ts`
Expected: FAIL，找不到模組 `src/domain/draft.js`。

- [ ] **Step 3：寫最小實作**

```ts
import { Decimal } from "decimal.js";
import { z } from "zod";

import { AllocationSchema, TransactionDraftSchema, type TransactionDraft } from "./ledger.js";
import { money, MoneySchema, type Money } from "./money.js";

export const ParseFieldSchema = z.enum([
  "amount",
  "category",
  "account",
  "refundTarget",
  "purpose",
]);
export type ParseField = z.infer<typeof ParseFieldSchema>;

export const PendingFieldSchema = z.object({
  field: ParseFieldSchema,
  candidateIds: z.array(z.string().min(1)).default([]),
});
export type PendingField = z.infer<typeof PendingFieldSchema>;

export const PartialAllocationSchema = AllocationSchema.omit({ amount: true }).extend({
  amount: MoneySchema.optional(),
});
export type PartialAllocation = z.infer<typeof PartialAllocationSchema>;

export const PartialDraftSchema = z.object({
  occurredDate: z.iso.date(),
  rawSegment: z.string().min(1).max(4_096),
  allocations: z.array(PartialAllocationSchema),
  accountFromId: z.string().min(1).optional(),
  accountToId: z.string().min(1).optional(),
  merchantId: z.string().min(1).optional(),
});
export type PartialDraft = z.infer<typeof PartialDraftSchema>;

export const IncompleteDraftSchema = z.object({
  draftId: z.string().min(1),
  ownerId: z.string().min(1),
  requestId: z.string().min(1),
  sourceEventId: z.string().min(1),
  batchId: z.string().min(1),
  batchIndex: z.number().int().min(0),
  pendingFields: z.array(PendingFieldSchema).min(1),
  partial: PartialDraftSchema,
  status: z.literal("awaiting_input"),
});
export type IncompleteDraft = z.infer<typeof IncompleteDraftSchema>;

export interface DraftPatch {
  readonly amount?: Money;
  readonly categoryId?: string;
  readonly category?: string;
  readonly accountFromId?: string;
}

export type CompleteDraftResult =
  | { readonly kind: "draft"; readonly draft: TransactionDraft }
  | { readonly kind: "incomplete"; readonly draft: IncompleteDraft };

function applyPatch(partial: PartialDraft, patch: DraftPatch): PartialDraft {
  const allocations = partial.allocations.map((allocation) => {
    const next = { ...allocation };
    if (patch.amount && !next.amount) next.amount = patch.amount;
    if (patch.category && !allocation.categoryId) {
      next.category = patch.category;
      if (patch.categoryId) next.categoryId = patch.categoryId;
    }
    return next;
  });

  return {
    ...partial,
    allocations,
    ...(patch.accountFromId ? { accountFromId: patch.accountFromId } : {}),
  };
}

function satisfied(field: ParseField, patch: DraftPatch): boolean {
  if (field === "amount") return patch.amount !== undefined;
  if (field === "category") return patch.category !== undefined;
  if (field === "account") return patch.accountFromId !== undefined;
  return false;
}

export function completeDraft(draft: IncompleteDraft, patch: DraftPatch): CompleteDraftResult {
  const partial = applyPatch(draft.partial, patch);
  const pendingFields = draft.pendingFields.filter((item) => !satisfied(item.field, patch));

  if (pendingFields.length > 0) {
    return {
      kind: "incomplete",
      draft: IncompleteDraftSchema.parse({ ...draft, partial, pendingFields }),
    };
  }

  const total = partial.allocations.reduce(
    (sum, allocation) => sum.plus(allocation.amount?.amount ?? "0"),
    new Decimal(0),
  );
  const candidate = TransactionDraftSchema.safeParse({
    draftId: draft.draftId,
    ownerId: draft.ownerId,
    requestId: draft.requestId,
    sourceEventId: draft.sourceEventId,
    occurredDate: partial.occurredDate,
    amount: money(total.toString(), "TWD"),
    allocations: partial.allocations,
    ...(partial.accountFromId ? { accountFromId: partial.accountFromId } : {}),
    ...(partial.accountToId ? { accountToId: partial.accountToId } : {}),
    ...(partial.merchantId ? { merchantId: partial.merchantId } : {}),
    rawInputSnapshot: partial.rawSegment,
    status: "awaiting_confirmation",
  });

  if (!candidate.success) {
    // 欄位都補齊了但仍無法通過領域驗證：保留原本的待補欄位，草稿不升級。
    return { kind: "incomplete", draft: IncompleteDraftSchema.parse({ ...draft, partial }) };
  }
  return { kind: "draft", draft: candidate.data };
}
```

- [ ] **Step 4：執行測試確認通過**

Run: `pnpm vitest run tests/domain/draft.test.ts`
Expected: PASS，4 個測試。

- [ ] **Step 5：確認既有測試未受影響並提交**

Run: `pnpm vitest run tests/domain`
Expected: PASS。

```bash
git add src/domain/draft.ts tests/domain/draft.test.ts
git commit -m "feat: model incomplete drafts and their upgrade path"
```

---

### Task 3：解析器回傳部分解析結果

**Files:**

- Modify: `src/parser/rule-parser.ts`
- Test: `tests/parser/rule-parser.test.ts`

**Interfaces:**

- Consumes: Task 2 的 `PartialDraft`、`ParseField`。
- Produces: `ParseResult` 的 `missing_fields` 與 `ambiguous` 兩個 variant 各新增 `partial: PartialDraft` 欄位；`ParseField` 改由 `src/domain/draft.ts` 匯入並重新匯出，既有 import 路徑不變。

- [ ] **Step 1：寫失敗測試（追加於既有檔案）**

```ts
it("returns the resolved allocation shell when only the amount is missing", () => {
  const result = parseTransaction("午餐", {
    ownerId: "owner-1",
    requestId: "request-1",
    sourceEventId: "event-1",
    draftId: "draft-1",
    allocationId: "allocation-1",
    today: "2026-09-21",
  });

  expect(result.kind).toBe("missing_fields");
  if (result.kind !== "missing_fields") return;
  expect(result.fields).toEqual(["amount"]);
  expect(result.partial.rawSegment).toBe("午餐");
  expect(result.partial.occurredDate).toBe("2026-09-21");
  expect(result.partial.allocations[0]).toMatchObject({
    fundsEffect: "outflow",
    purpose: "expense",
    category: "餐飲",
    subcategory: "午餐",
  });
  expect(result.partial.allocations[0]?.amount).toBeUndefined();
});

it("carries the relative date into the partial result", () => {
  const result = parseTransaction("昨天 午餐", {
    ownerId: "owner-1",
    requestId: "request-1",
    sourceEventId: "event-1",
    draftId: "draft-1",
    allocationId: "allocation-1",
    today: "2026-09-21",
  });

  expect(result.kind).toBe("missing_fields");
  if (result.kind !== "missing_fields") return;
  expect(result.partial.occurredDate).toBe("2026-09-20");
});
```

- [ ] **Step 2：執行測試確認失敗**

Run: `pnpm vitest run tests/parser/rule-parser.test.ts`
Expected: FAIL，`result.partial` 為 undefined。

- [ ] **Step 3：實作**

在 `rule-parser.ts` 頂端改為匯入並重新匯出領域型別，並新增兩個輔助函式：

```ts
import {
  type ParseField,
  type PartialAllocation,
  type PartialDraft,
} from "../domain/draft.js";

export type { ParseField };

export type ParseResult =
  | { readonly kind: "draft"; readonly draft: TransactionDraft }
  | {
      readonly kind: "missing_fields";
      readonly fields: readonly ParseField[];
      readonly partial: PartialDraft;
    }
  | {
      readonly kind: "ambiguous";
      readonly field: ParseField;
      readonly candidateIds: readonly string[];
      readonly partial: PartialDraft;
    };

function expenseShell(
  context: ParseContext,
  text: string,
  account: Account | undefined,
  merchant: Merchant | undefined,
): PartialAllocation[] {
  const isLunch = text.includes("午餐");
  const knownMerchant = merchant?.name === "Uber";
  if (!isLunch && !knownMerchant) return [];
  const categoryKey = knownMerchant ? "expense_transport" : "expense_dining_lunch";
  const categoryFallback = knownMerchant ? "交通" : "餐飲";
  return [
    {
      allocationId: context.allocationId,
      fundsEffect: account?.type === "credit_card" ? "none" : "outflow",
      purpose: "expense",
      ...category(context, categoryKey, categoryFallback),
      ...(isLunch ? { subcategory: "午餐" } : {}),
    },
  ];
}

function incomplete(
  context: ParseContext,
  text: string,
  fields: readonly ParseField[],
  partial: Partial<PartialDraft> = {},
): ParseResult {
  return {
    kind: "missing_fields",
    fields,
    partial: {
      occurredDate: parseRelativeDate(text, context.today),
      rawSegment: text,
      allocations: [],
      ...partial,
    },
  };
}
```

接著把 `parseTransaction` 中所有 `return { kind: "missing_fields", fields: [...] }` 改為呼叫 `incomplete`，並在只缺金額的支出路徑帶入 `expenseShell` 的結果。缺金額的判斷需移到參照解析之後，才能取得 `account` 與 `merchant`：

```ts
  const account = accounts[0];
  const merchant = merchants[0];
  if (amounts.length !== 1) {
    return incomplete(context, text, ["amount"], {
      allocations: expenseShell(context, text, account, merchant),
      ...(account ? { accountFromId: account.accountId } : {}),
      ...(merchant ? { merchantId: merchant.merchantId } : {}),
    });
  }
```

缺分類的路徑必須帶出一個**沒有 categoryId 的 allocation 殼**，否則使用者選了分類之後仍然湊不出合法草稿（`allocations` 為空無法通過 `TransactionDraftSchema`）：

```ts
  if (!text.includes("午餐") && merchants.length === 0 && accounts.length === 0) {
    return incomplete(context, text, ["category"], {
      allocations: [
        {
          allocationId: context.allocationId,
          fundsEffect: "outflow",
          purpose: "expense",
          amount,
          category: "待分類",
        },
      ],
    });
  }
```

`category` 欄位是必填字串，因此以 `待分類` 作為佔位值；`categoryId` 留空，`completeDraft` 的 `applyPatch` 正是以「沒有 categoryId」判斷該 allocation 需要填入使用者選擇的分類。

所有 `ambiguous` 的回傳同樣補上 `partial`，內容為 `incomplete(...)` 使用的相同結構。既有的 `draft` 回傳路徑不得更動。

- [ ] **Step 4：執行測試確認通過**

Run: `pnpm vitest run tests/parser tests/application tests/telegram`
Expected: PASS。既有 M2 語句行為不得改變——若 `tests/parser/accounting-flows.test.ts` 有任何失敗，表示重構改動了既有解析路徑，必須修正而非調整既有測試。

- [ ] **Step 5：提交**

```bash
git add src/parser/rule-parser.ts tests/parser/rule-parser.test.ts
git commit -m "feat: return partial parse results for incomplete input"
```

---

### Task 4：Migration 0003 與外鍵開關

**Files:**

- Create: `src/db/migrations/0003_conversation_state.sql`
- Modify: `src/db/migrate.ts`
- Test: `tests/db/migrate-conversation-state.test.ts`

**Interfaces:**

- Consumes: 既有 `migrate(database)`。
- Produces: schema version 3。`batches` 表；`drafts` 新增 `draft_ref`、`batch_id`、`batch_index`、`pending_fields`、`preview_chat_id`、`preview_message_id`、`created_date`、`updated_at`，且 `amount` 與 `currency` 可空；`transactions.batch_id`。

**背景（實作者必讀）：** `openDatabase` 設定 `PRAGMA foreign_keys = ON`，而 `PRAGMA foreign_keys` 在 transaction 內是 no-op。本 migration 需要 DROP 被 `transactions.draft_id` 參照的 `drafts`，因此必須在進入 transaction **之前**關閉外鍵強制、提交後再開啟。`foreign_key_check` 不受開關影響，既有的完整性斷言仍然有效。

- [ ] **Step 1：寫失敗測試**

```ts
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { migrate } from "../../src/db/migrate.js";

function openMemoryDatabase(): Database.Database {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  return database;
}

describe("migration 0003", () => {
  it("adds conversation state columns while keeping existing drafts", () => {
    const database = openMemoryDatabase();
    migrate(database);

    database
      .prepare(
        `INSERT INTO input_events (event_id, owner_id, telegram_update_id, source_type, source_ref, raw_text, received_at)
         VALUES ('event-1', 'owner-1', '1', 'telegram', '1:1', '午餐 120', '2026-09-20T01:00:00.000Z')`,
      )
      .run();
    database
      .prepare(
        `INSERT INTO drafts (draft_id, owner_id, request_id, source_event_id, occurred_date, amount, currency, status, draft_json)
         VALUES ('draft-1', 'owner-1', 'request-1', 'event-1', '2026-09-20', '120', 'TWD', 'awaiting_confirmation', '{}')`,
      )
      .run();

    const draft = database.prepare("SELECT * FROM drafts WHERE draft_id = 'draft-1'").get() as {
      draft_ref: string;
      created_date: string | null;
      batch_id: string | null;
    };

    expect(draft.draft_ref).toMatch(/^[0-9a-f]{8}$/);
    expect(draft.batch_id).toBeNull();
    expect(database.pragma("foreign_key_check")).toEqual([]);
  });

  it("allows drafts without an amount", () => {
    const database = openMemoryDatabase();
    migrate(database);
    database
      .prepare(
        `INSERT INTO input_events (event_id, owner_id, telegram_update_id, source_type, source_ref, raw_text, received_at)
         VALUES ('event-2', 'owner-1', '2', 'telegram', '1:2', '午餐', '2026-09-21T01:00:00.000Z')`,
      )
      .run();
    database
      .prepare(
        `INSERT INTO batches (batch_id, owner_id, source_event_id, item_count, created_at)
         VALUES ('batch-1', 'owner-1', 'event-2', 1, '2026-09-21T01:00:00.000Z')`,
      )
      .run();

    expect(() =>
      database
        .prepare(
          `INSERT INTO drafts (draft_id, draft_ref, owner_id, request_id, source_event_id, batch_id, batch_index, occurred_date, status, pending_fields, draft_json, created_date)
           VALUES ('draft-2', 'aabbccdd', 'owner-1', 'request-2', 'event-2', 'batch-1', 0, '2026-09-21', 'awaiting_input', '[{"field":"amount","candidateIds":[]}]', '{}', '2026-09-21')`,
        )
        .run(),
    ).not.toThrow();
  });

  it("is idempotent across repeated startups", () => {
    const database = openMemoryDatabase();
    migrate(database);
    migrate(database);

    const versions = database.prepare("SELECT version FROM schema_migrations ORDER BY version").all();
    expect(versions).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }]);
  });
});
```

- [ ] **Step 2：執行測試確認失敗**

Run: `pnpm vitest run tests/db/migrate-conversation-state.test.ts`
Expected: FAIL，`drafts` 沒有 `draft_ref` 欄位。

- [ ] **Step 3：撰寫 migration 與 migrate.ts 調整**

`src/db/migrations/0003_conversation_state.sql`：

```sql
CREATE TABLE batches (
  batch_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  source_event_id TEXT NOT NULL REFERENCES input_events(event_id),
  item_count INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE drafts_v2 (
  draft_id TEXT PRIMARY KEY,
  draft_ref TEXT NOT NULL DEFAULT (lower(hex(randomblob(4)))),
  owner_id TEXT NOT NULL,
  request_id TEXT NOT NULL UNIQUE,
  source_event_id TEXT NOT NULL REFERENCES input_events(event_id),
  batch_id TEXT REFERENCES batches(batch_id),
  batch_index INTEGER,
  occurred_date TEXT NOT NULL,
  amount TEXT,
  currency TEXT,
  status TEXT NOT NULL,
  pending_fields TEXT,
  draft_json TEXT NOT NULL,
  preview_chat_id TEXT,
  preview_message_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_date TEXT,
  updated_at TEXT,
  confirmed_transaction_id TEXT,
  UNIQUE (owner_id, draft_ref)
);

INSERT INTO drafts_v2 (
  draft_id, draft_ref, owner_id, request_id, source_event_id,
  occurred_date, amount, currency, status, draft_json,
  created_at, created_date, confirmed_transaction_id
)
SELECT
  draft_id,
  lower(hex(randomblob(4))),
  owner_id,
  request_id,
  source_event_id,
  occurred_date,
  amount,
  currency,
  status,
  draft_json,
  created_at,
  date(created_at),
  confirmed_transaction_id
FROM drafts;

DROP TABLE drafts;
ALTER TABLE drafts_v2 RENAME TO drafts;

ALTER TABLE transactions ADD COLUMN batch_id TEXT REFERENCES batches(batch_id);

CREATE INDEX drafts_owner_status_idx ON drafts(owner_id, status, created_at DESC);
CREATE INDEX drafts_preview_message_idx ON drafts(preview_chat_id, preview_message_id);
CREATE INDEX drafts_batch_idx ON drafts(batch_id);
```

`src/db/migrate.ts` 的 `migrate` 迴圈改為在 transaction 外關閉外鍵：

```ts
    const sql = readFileSync(migration.url, "utf8");
    const apply = database.transaction(() => {
      database.exec(sql);
      assertForeignKeys(database);
      database.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run(migration.version);
    });

    const foreignKeysEnabled = database.pragma("foreign_keys", { simple: true }) === 1;
    if (foreignKeysEnabled) database.pragma("foreign_keys = OFF");
    try {
      apply.immediate();
    } finally {
      if (foreignKeysEnabled) database.pragma("foreign_keys = ON");
    }
```

並在 `migrations` 陣列加入：

```ts
  { version: 3, url: new URL("./migrations/0003_conversation_state.sql", import.meta.url) },
```

`package.json` 的 `build` script 已經複製 `src/db/migrations/*.sql`，無需調整。

- [ ] **Step 4：執行測試確認通過**

Run: `pnpm vitest run tests/db`
Expected: PASS，包含既有的 `migrate-accounting-core.test.ts`（M1 → M2 → M3 連續升級後資料仍完整）。

- [ ] **Step 5：提交**

```bash
git add src/db/migrations/0003_conversation_state.sql src/db/migrate.ts tests/db/migrate-conversation-state.test.ts
git commit -m "feat: migrate drafts for batch and conversation state"
```

---

### Task 5：Repository 與 port 擴充

**Files:**

- Modify: `src/ports/ledger-repository.ts`
- Modify: `src/db/sqlite-ledger-repository.ts`
- Modify: `tests/support/fake-ledger-repository.ts`
- Test: `tests/db/sqlite-draft-state.test.ts`

**Interfaces:**

- Consumes: Task 2 的 `IncompleteDraft`、Task 4 的 schema。
- Produces（加入 `LedgerRepository`）：

```ts
export interface BatchInput {
  readonly batchId: string;
  readonly ownerId: string;
  readonly sourceEventId: string;
  readonly itemCount: number;
  readonly createdAt: string;
}

export interface DraftMeta {
  readonly batchId?: string;
  readonly batchIndex?: number;
  readonly createdDate?: string;
}

export type DraftSelector =
  | { readonly draftId: string }
  | { readonly ownerId: string; readonly draftRef: string }
  | { readonly previewChatId: string; readonly previewMessageId: string };

export interface DraftRecord {
  readonly draftId: string;
  readonly draftRef: string;
  readonly ownerId: string;
  readonly status: TransactionDraft["status"];
  readonly createdDate: string | null;
  readonly batchId: string | null;
  readonly draft: TransactionDraft | null;
  readonly incomplete: IncompleteDraft | null;
}

export interface PendingQuery {
  readonly ownerId: string;
  readonly status: "awaiting_input" | "awaiting_confirmation";
  readonly limit: number;
  readonly offset: number;
}

export interface PendingDraftSummary {
  readonly draftRef: string;
  readonly draftId: string;
  readonly occurredDate: string;
  readonly amount: string | null;
  readonly rawSegment: string;
  readonly createdDate: string | null;
}

// 新增方法
saveBatch(input: BatchInput): Promise<void>;
saveDraft(draft: TransactionDraft, meta?: DraftMeta): Promise<string>;
saveIncompleteDraft(draft: IncompleteDraft, meta: DraftMeta): Promise<string>;
replaceDraft(draftId: string, next: TransactionDraft | IncompleteDraft): Promise<void>;
getDraftRecord(selector: DraftSelector): Promise<DraftRecord | null>;
setPreviewMessage(draftId: string, chatId: string, messageId: string): Promise<void>;
listPendingDrafts(query: PendingQuery): Promise<PendingDraftSummary[]>;
countPendingDrafts(ownerId: string, status: PendingQuery["status"]): Promise<number>;
archiveDraft(draftId: string): Promise<void>;
```

`saveDraft` 由 `Promise<void>` 改為 `Promise<string>`（回傳 `draftRef`）；既有呼叫端忽略回傳值即可，不需修改。`draft_ref` 由 repository 產生，沿用 `transaction_id` 既有的內部產生慣例。

- [ ] **Step 1：寫失敗測試**

```ts
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { migrate } from "../../src/db/migrate.js";
import { SqliteLedgerRepository } from "../../src/db/sqlite-ledger-repository.js";
import { IncompleteDraftSchema } from "../../src/domain/draft.js";

function setup() {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  migrate(database);
  const repository = new SqliteLedgerRepository(database);
  return { database, repository };
}

async function seedEvent(repository: SqliteLedgerRepository, eventId: string, updateId: string) {
  await repository.recordInputEvent({
    eventId,
    ownerId: "owner-1",
    telegramUpdateId: updateId,
    sourceType: "telegram",
    sourceRef: `1:${updateId}`,
    rawText: "午餐",
    receivedAt: "2026-09-21T01:00:00.000Z",
  });
}

function incompleteDraft(overrides: Record<string, unknown> = {}) {
  return IncompleteDraftSchema.parse({
    draftId: "draft-1",
    ownerId: "owner-1",
    requestId: "request-1",
    sourceEventId: "event-1",
    batchId: "batch-1",
    batchIndex: 0,
    pendingFields: [{ field: "amount", candidateIds: [] }],
    partial: { occurredDate: "2026-09-21", rawSegment: "午餐", allocations: [] },
    status: "awaiting_input",
    ...overrides,
  });
}

describe("SqliteLedgerRepository draft state", () => {
  it("persists an incomplete draft and reads it back by short reference", async () => {
    const { repository } = setup();
    await seedEvent(repository, "event-1", "1");
    await repository.saveBatch({
      batchId: "batch-1",
      ownerId: "owner-1",
      sourceEventId: "event-1",
      itemCount: 1,
      createdAt: "2026-09-21T01:00:00.000Z",
    });

    const draftRef = await repository.saveIncompleteDraft(incompleteDraft(), {
      batchId: "batch-1",
      batchIndex: 0,
      createdDate: "2026-09-21",
    });

    const record = await repository.getDraftRecord({ ownerId: "owner-1", draftRef });
    expect(record?.draftId).toBe("draft-1");
    expect(record?.status).toBe("awaiting_input");
    expect(record?.createdDate).toBe("2026-09-21");
    expect(record?.draft).toBeNull();
    expect(record?.incomplete?.pendingFields[0]?.field).toBe("amount");
  });

  it("finds a draft by the preview message it was sent as", async () => {
    const { repository } = setup();
    await seedEvent(repository, "event-1", "1");
    await repository.saveBatch({
      batchId: "batch-1",
      ownerId: "owner-1",
      sourceEventId: "event-1",
      itemCount: 1,
      createdAt: "2026-09-21T01:00:00.000Z",
    });
    await repository.saveIncompleteDraft(incompleteDraft(), {
      batchId: "batch-1",
      batchIndex: 0,
      createdDate: "2026-09-21",
    });

    await repository.setPreviewMessage("draft-1", "123", "456");

    const record = await repository.getDraftRecord({ previewChatId: "123", previewMessageId: "456" });
    expect(record?.draftId).toBe("draft-1");
  });

  it("lists and counts pending drafts by status and archives them", async () => {
    const { repository } = setup();
    await seedEvent(repository, "event-1", "1");
    await repository.saveBatch({
      batchId: "batch-1",
      ownerId: "owner-1",
      sourceEventId: "event-1",
      itemCount: 1,
      createdAt: "2026-09-21T01:00:00.000Z",
    });
    await repository.saveIncompleteDraft(incompleteDraft(), {
      batchId: "batch-1",
      batchIndex: 0,
      createdDate: "2026-09-21",
    });

    const pending = await repository.listPendingDrafts({
      ownerId: "owner-1",
      status: "awaiting_input",
      limit: 10,
      offset: 0,
    });
    expect(pending).toHaveLength(1);
    expect(pending[0]?.rawSegment).toBe("午餐");
    expect(await repository.countPendingDrafts("owner-1", "awaiting_input")).toBe(1);

    await repository.archiveDraft("draft-1");
    expect(await repository.countPendingDrafts("owner-1", "awaiting_input")).toBe(0);
    const archived = await repository.getDraftRecord({ draftId: "draft-1" });
    expect(archived?.status).toBe("archived");
  });

  it("replaces an incomplete draft with the upgraded complete draft", async () => {
    const { repository } = setup();
    await seedEvent(repository, "event-1", "1");
    await repository.saveBatch({
      batchId: "batch-1",
      ownerId: "owner-1",
      sourceEventId: "event-1",
      itemCount: 1,
      createdAt: "2026-09-21T01:00:00.000Z",
    });
    await repository.saveIncompleteDraft(incompleteDraft(), {
      batchId: "batch-1",
      batchIndex: 0,
      createdDate: "2026-09-21",
    });

    await repository.replaceDraft("draft-1", {
      draftId: "draft-1",
      ownerId: "owner-1",
      requestId: "request-1",
      sourceEventId: "event-1",
      occurredDate: "2026-09-21",
      amount: { amount: "120", currency: "TWD" },
      allocations: [
        {
          allocationId: "allocation-1",
          fundsEffect: "outflow",
          purpose: "expense",
          amount: { amount: "120", currency: "TWD" },
          category: "餐飲",
        },
      ],
      status: "awaiting_confirmation",
    });

    const record = await repository.getDraftRecord({ draftId: "draft-1" });
    expect(record?.status).toBe("awaiting_confirmation");
    expect(record?.draft?.amount.amount).toBe("120");
    expect(record?.incomplete).toBeNull();
  });
});
```

- [ ] **Step 2：執行測試確認失敗**

Run: `pnpm vitest run tests/db/sqlite-draft-state.test.ts`
Expected: FAIL，`repository.saveBatch` 不是函式。

- [ ] **Step 3：實作**

在 `SqliteLedgerRepository` 中新增下列方法。`getDraftRecord` 是核心：三種 selector 共用同一組 row 對應邏輯。

```ts
  public saveBatch(input: BatchInput): Promise<void> {
    this.database
      .prepare(
        `INSERT INTO batches (batch_id, owner_id, source_event_id, item_count, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(input.batchId, input.ownerId, input.sourceEventId, input.itemCount, input.createdAt);
    return Promise.resolve();
  }

  public saveIncompleteDraft(draft: IncompleteDraft, meta: DraftMeta): Promise<string> {
    const value = IncompleteDraftSchema.parse(draft);
    const draftRef = this.generateDraftRef(value.ownerId);
    this.database
      .prepare(
        `INSERT INTO drafts (draft_id, draft_ref, owner_id, request_id, source_event_id, batch_id, batch_index, occurred_date, amount, currency, status, pending_fields, draft_json, created_date)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'awaiting_input', ?, ?, ?)`,
      )
      .run(
        value.draftId,
        draftRef,
        value.ownerId,
        value.requestId,
        value.sourceEventId,
        meta.batchId ?? null,
        meta.batchIndex ?? null,
        value.partial.occurredDate,
        JSON.stringify(value.pendingFields),
        JSON.stringify(value),
        meta.createdDate ?? null,
      );
    return Promise.resolve(draftRef);
  }

  public replaceDraft(draftId: string, next: TransactionDraft | IncompleteDraft): Promise<void> {
    const isComplete = next.status !== "awaiting_input";
    const value = isComplete
      ? TransactionDraftSchema.parse(next)
      : IncompleteDraftSchema.parse(next);
    this.database
      .prepare(
        `UPDATE drafts
         SET status = ?, amount = ?, currency = ?, occurred_date = ?, pending_fields = ?, draft_json = ?, updated_at = CURRENT_TIMESTAMP
         WHERE draft_id = ?`,
      )
      .run(
        value.status,
        isComplete ? (value as TransactionDraft).amount.amount : null,
        isComplete ? (value as TransactionDraft).amount.currency : null,
        isComplete
          ? (value as TransactionDraft).occurredDate
          : (value as IncompleteDraft).partial.occurredDate,
        isComplete ? null : JSON.stringify((value as IncompleteDraft).pendingFields),
        JSON.stringify(value),
        draftId,
      );
    return Promise.resolve();
  }

  public getDraftRecord(selector: DraftSelector): Promise<DraftRecord | null> {
    const query =
      "draftId" in selector
        ? { where: "draft_id = ?", args: [selector.draftId] }
        : "draftRef" in selector
          ? { where: "owner_id = ? AND draft_ref = ?", args: [selector.ownerId, selector.draftRef] }
          : {
              where: "preview_chat_id = ? AND preview_message_id = ?",
              args: [selector.previewChatId, selector.previewMessageId],
            };
    const row = this.database
      .prepare(`SELECT * FROM drafts WHERE ${query.where}`)
      .get(...query.args) as DraftRow | undefined;
    if (!row) return Promise.resolve(null);

    const parsed: unknown = JSON.parse(row.draft_json);
    return Promise.resolve({
      draftId: row.draft_id,
      draftRef: row.draft_ref,
      ownerId: row.owner_id,
      status: row.status as TransactionDraft["status"],
      createdDate: row.created_date,
      batchId: row.batch_id,
      draft: row.status === "awaiting_input" ? null : TransactionDraftSchema.parse(parsed),
      incomplete: row.status === "awaiting_input" ? IncompleteDraftSchema.parse(parsed) : null,
    });
  }

  public setPreviewMessage(draftId: string, chatId: string, messageId: string): Promise<void> {
    this.database
      .prepare("UPDATE drafts SET preview_chat_id = ?, preview_message_id = ? WHERE draft_id = ?")
      .run(chatId, messageId, draftId);
    return Promise.resolve();
  }

  public archiveDraft(draftId: string): Promise<void> {
    this.database
      .prepare(
        "UPDATE drafts SET status = 'archived', updated_at = CURRENT_TIMESTAMP WHERE draft_id = ?",
      )
      .run(draftId);
    return Promise.resolve();
  }

  public listPendingDrafts(query: PendingQuery): Promise<PendingDraftSummary[]> {
    const rows = this.database
      .prepare(
        `SELECT draft_id, draft_ref, occurred_date, amount, draft_json, created_date
         FROM drafts
         WHERE owner_id = ? AND status = ?
         ORDER BY created_at DESC
         LIMIT ? OFFSET ?`,
      )
      .all(query.ownerId, query.status, query.limit, query.offset) as PendingRow[];
    return Promise.resolve(rows.map((row) => toPendingSummary(row)));
  }

  public countPendingDrafts(ownerId: string, status: PendingQuery["status"]): Promise<number> {
    const row = this.database
      .prepare("SELECT count(*) AS total FROM drafts WHERE owner_id = ? AND status = ?")
      .get(ownerId, status) as { total: number };
    return Promise.resolve(row.total);
  }
```

`toPendingSummary` 取 `rawSegment`：`awaiting_input` 由 `draft_json.partial.rawSegment` 取得；`awaiting_confirmation` 由 `draft_json.rawInputSnapshot` 取得，兩者皆無則以空字串表示。

`draft_ref` 產生方式：

```ts
  private generateDraftRef(ownerId: string): string {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const candidate = randomBytes(4).toString("hex");
      const clash = this.database
        .prepare("SELECT 1 FROM drafts WHERE owner_id = ? AND draft_ref = ?")
        .get(ownerId, candidate);
      if (!clash) return candidate;
    }
    throw new Error("unable to allocate draft reference");
  }
```

`FakeLedgerRepository` 實作相同介面：以 `Map` 保存草稿記錄，`draft_ref` 使用遞增計數的 8 位十六進位字串（`ref-` 前綴不可用，格式必須與正式實作一致，測試才能共用斷言）。

- [ ] **Step 4：執行測試確認通過**

Run: `pnpm vitest run`
Expected: PASS，既有 22 個測試檔全數維持通過。

- [ ] **Step 5：提交**

```bash
git add src/ports/ledger-repository.ts src/db/sqlite-ledger-repository.ts tests/support/fake-ledger-repository.ts tests/db/sqlite-draft-state.test.ts
git commit -m "feat: persist batches, short references and pending drafts"
```

---

### Task 6：批次建立應用服務

**Files:**

- Create: `src/application/create-batch.ts`
- Test: `tests/application/create-batch.test.ts`

**Interfaces:**

- Consumes: Task 1 `splitInput`、Task 3 `parseTransaction`、Task 5 repository 方法。
- Produces:

```ts
export const MAX_SEGMENTS = 10;

export interface CreateBatchCommand {
  readonly ownerId: string;
  readonly telegramUpdateId: string;
  readonly sourceRef: string;
  readonly text: string;
  readonly receivedAt: string;
  readonly occurredDate: string;
}

export type BatchItemOutcome =
  | { readonly kind: "draft"; readonly draft: TransactionDraft; readonly draftRef: string }
  | { readonly kind: "incomplete"; readonly draft: IncompleteDraft; readonly draftRef: string }
  | { readonly kind: "unparsed"; readonly reason: "missing_category" | "ambiguous" };

export interface BatchItem {
  readonly index: number;
  readonly segment: string;
  readonly outcome: BatchItemOutcome;
}

export type CreateBatchResult =
  | { readonly kind: "batch"; readonly batchId: string; readonly items: readonly BatchItem[] }
  | { readonly kind: "duplicate"; readonly eventId: string }
  | { readonly kind: "too_many_segments"; readonly count: number }
  | { readonly kind: "empty" };

export function createBatch(
  command: CreateBatchCommand,
  dependencies: CreateBatchDependencies,
): Promise<CreateBatchResult>;
```

分類規則：`missing_fields` 且 `partial.allocations` 為空且缺的欄位不只金額時歸為 `unparsed`；其餘 `missing_fields` 建立 `IncompleteDraft`；`ambiguous` 歸為 `unparsed`。

- [ ] **Step 1：寫失敗測試**

```ts
import { describe, expect, it } from "vitest";

import { createBatch, MAX_SEGMENTS } from "../../src/application/create-batch.js";
import { FakeLedgerRepository } from "../support/fake-ledger-repository.js";
import { FakeReferenceRepository } from "../support/fake-reference-repository.js";

function setup() {
  const repository = new FakeLedgerRepository();
  let counter = 0;
  return {
    repository,
    dependencies: {
      repository,
      referenceRepository: new FakeReferenceRepository(),
      generateId: () => `id-${String(++counter)}`,
    },
  };
}

const baseCommand = {
  ownerId: "owner-1",
  telegramUpdateId: "1",
  sourceRef: "123:1",
  receivedAt: "2026-09-21T01:00:00.000Z",
  occurredDate: "2026-09-21",
};

describe("createBatch", () => {
  it("creates one draft per segment under a shared batch", async () => {
    const { dependencies } = setup();

    const result = await createBatch({ ...baseCommand, text: "午餐 120，午餐 60" }, dependencies);

    expect(result.kind).toBe("batch");
    if (result.kind !== "batch") return;
    expect(result.items).toHaveLength(2);
    expect(result.items.every((item) => item.outcome.kind === "draft")).toBe(true);
    const batchIds = new Set(
      result.items.map((item) =>
        item.outcome.kind === "draft" ? item.outcome.draft.draftId : "",
      ),
    );
    expect(batchIds.size).toBe(2);
  });

  it("keeps successful segments while holding the incomplete one for follow-up", async () => {
    const { dependencies } = setup();

    const result = await createBatch({ ...baseCommand, text: "午餐 120，午餐 60，午餐" }, dependencies);

    expect(result.kind).toBe("batch");
    if (result.kind !== "batch") return;
    expect(result.items.map((item) => item.outcome.kind)).toEqual([
      "draft",
      "draft",
      "incomplete",
    ]);
    const third = result.items[2]?.outcome;
    if (third?.kind !== "incomplete") throw new Error("expected incomplete outcome");
    expect(third.draft.pendingFields.map((field) => field.field)).toEqual(["amount"]);
  });

  it("rejects the whole message when it exceeds the segment limit", async () => {
    const { dependencies, repository } = setup();
    const text = Array.from({ length: MAX_SEGMENTS + 1 }, (_, index) => `午餐 ${String(index + 1)}`).join("，");

    const result = await createBatch({ ...baseCommand, text }, dependencies);

    expect(result).toEqual({ kind: "too_many_segments", count: MAX_SEGMENTS + 1 });
    expect(repository.drafts.size).toBe(0);
  });

  it("returns duplicate for a replayed telegram update", async () => {
    const { dependencies } = setup();
    await createBatch({ ...baseCommand, text: "午餐 120" }, dependencies);

    const result = await createBatch({ ...baseCommand, text: "午餐 120" }, dependencies);

    expect(result.kind).toBe("duplicate");
  });
});
```

- [ ] **Step 2：執行測試確認失敗**

Run: `pnpm vitest run tests/application/create-batch.test.ts`
Expected: FAIL，找不到模組 `src/application/create-batch.js`。

- [ ] **Step 3：實作**

```ts
export async function createBatch(
  command: CreateBatchCommand,
  dependencies: CreateBatchDependencies,
): Promise<CreateBatchResult> {
  const segments = splitInput(command.text);
  if (segments.length === 0) return { kind: "empty" };
  if (segments.length > MAX_SEGMENTS) {
    return { kind: "too_many_segments", count: segments.length };
  }

  const eventId = dependencies.generateId();
  const recorded = await dependencies.repository.recordInputEvent({
    eventId,
    ownerId: command.ownerId,
    telegramUpdateId: command.telegramUpdateId,
    sourceType: "telegram",
    sourceRef: command.sourceRef,
    rawText: command.text,
    receivedAt: command.receivedAt,
  });
  if (!recorded.created) return { kind: "duplicate", eventId: recorded.eventId };

  const references = await loadReferenceSnapshot(
    dependencies.referenceRepository,
    command.ownerId,
  );
  const batchId = dependencies.generateId();
  await dependencies.repository.saveBatch({
    batchId,
    ownerId: command.ownerId,
    sourceEventId: eventId,
    itemCount: segments.length,
    createdAt: command.receivedAt,
  });

  const items: BatchItem[] = [];
  for (const [index, segment] of segments.entries()) {
    const parsed = parseTransaction(segment, {
      ownerId: command.ownerId,
      requestId: dependencies.generateId(),
      sourceEventId: eventId,
      draftId: dependencies.generateId(),
      allocationId: dependencies.generateId(),
      additionalAllocationId: dependencies.generateId(),
      today: command.occurredDate,
      ...references,
    });
    items.push({
      index,
      segment,
      outcome: await persist(parsed, { batchId, index, command, dependencies, eventId, segment }),
    });
  }

  return { kind: "batch", batchId, items };
}
```

`persist` 依 `parsed.kind` 分派。**候選 ID 在此處填入**——parser 只回報缺哪個欄位，候選來自參照快照，這是應用層的責任：

```ts
function candidatesFor(
  field: ParseField,
  references: ReferenceSnapshot,
  parsed: ParseResult,
): string[] {
  if (parsed.kind === "ambiguous" && parsed.field === field) return [...parsed.candidateIds];
  if (field === "category") {
    return references.categories
      .filter((item) => item.active && item.type === "expense")
      .map((item) => item.categoryId);
  }
  if (field === "account") {
    return references.accounts.filter((item) => item.active).map((item) => item.accountId);
  }
  return [];
}

async function persist(
  parsed: ParseResult,
  context: PersistContext,
): Promise<BatchItemOutcome> {
  if (parsed.kind === "draft") {
    const draftRef = await context.repository.saveDraft(parsed.draft, {
      batchId: context.batchId,
      batchIndex: context.index,
      createdDate: context.createdDate,
    });
    return { kind: "draft", draft: parsed.draft, draftRef };
  }

  if (parsed.kind === "ambiguous") {
    return { kind: "unparsed", reason: "ambiguous" };
  }

  // missing_fields：沒有任何 allocation 殼就無法靠追問湊出合法草稿，
  // 屬於「完全無法解析」，依設計不建草稿（設計 §5）。
  if (parsed.partial.allocations.length === 0) {
    return { kind: "unparsed", reason: "missing_category" };
  }

  const draft = IncompleteDraftSchema.parse({
    draftId: context.draftId,
    ownerId: context.ownerId,
    requestId: context.requestId,
    sourceEventId: context.sourceEventId,
    batchId: context.batchId,
    batchIndex: context.index,
    pendingFields: parsed.fields.map((field) => ({
      field,
      candidateIds: candidatesFor(field, context.references, parsed),
    })),
    partial: parsed.partial,
    status: "awaiting_input",
  });
  const draftRef = await context.repository.saveIncompleteDraft(draft, {
    batchId: context.batchId,
    batchIndex: context.index,
    createdDate: context.createdDate,
  });
  return { kind: "incomplete", draft, draftRef };
}
```

`IncompleteDraft` 的 `requestId`、`draftId` 必須沿用該段落 parser context 中已產生的值，確保同一段落只有一組 ID。

- [ ] **Step 4：執行測試確認通過**

Run: `pnpm vitest run tests/application`
Expected: PASS。

- [ ] **Step 5：提交**

```bash
git add src/application/create-batch.ts tests/application/create-batch.test.ts
git commit -m "feat: create batched drafts from one telegram message"
```

---

### Task 7：補欄位應用服務

**Files:**

- Create: `src/application/answer-draft.ts`
- Test: `tests/application/answer-draft.test.ts`

**Interfaces:**

- Consumes: Task 2 `completeDraft`、Task 5 `getDraftRecord` 與 `replaceDraft`。
- Produces:

```ts
export type AnswerValue =
  | { readonly kind: "amount"; readonly text: string }
  | { readonly kind: "reference"; readonly id: string; readonly label: string };

export interface AnswerDraftCommand {
  readonly ownerId: string;
  readonly draftId: string;
  readonly field: ParseField;
  readonly value: AnswerValue;
  readonly telegramUpdateId: string;
  readonly sourceRef: string;
  readonly rawText: string;
  readonly receivedAt: string;
}

export type AnswerDraftResult =
  | { readonly kind: "draft"; readonly draft: TransactionDraft }
  | { readonly kind: "incomplete"; readonly draft: IncompleteDraft }
  | {
      readonly kind: "invalid";
      readonly reason: "draft_not_found" | "not_pending" | "amount_not_numeric";
    };

export function answerDraft(
  command: AnswerDraftCommand,
  dependencies: AnswerDraftDependencies,
): Promise<AnswerDraftResult>;
```

- [ ] **Step 1：寫失敗測試**

```ts
describe("answerDraft", () => {
  it("upgrades an incomplete draft when the amount answer arrives", async () => {
    const { repository, dependencies } = await seedIncompleteLunchDraft();

    const result = await answerDraft(
      {
        ownerId: "owner-1",
        draftId: "draft-1",
        field: "amount",
        value: { kind: "amount", text: "120" },
        telegramUpdateId: "2",
        sourceRef: "123:2",
        rawText: "120",
        receivedAt: "2026-09-21T02:00:00.000Z",
      },
      dependencies,
    );

    expect(result.kind).toBe("draft");
    const record = await repository.getDraftRecord({ draftId: "draft-1" });
    expect(record?.status).toBe("awaiting_confirmation");
  });

  it("records the answer as its own immutable input event", async () => {
    const { repository, dependencies } = await seedIncompleteLunchDraft();

    await answerDraft(
      {
        ownerId: "owner-1",
        draftId: "draft-1",
        field: "amount",
        value: { kind: "amount", text: "120" },
        telegramUpdateId: "2",
        sourceRef: "123:2",
        rawText: "120",
        receivedAt: "2026-09-21T02:00:00.000Z",
      },
      dependencies,
    );

    expect(repository.inputEvents.size).toBe(2);
  });

  it("rejects a non-numeric amount without touching the draft", async () => {
    const { repository, dependencies } = await seedIncompleteLunchDraft();

    const result = await answerDraft(
      {
        ownerId: "owner-1",
        draftId: "draft-1",
        field: "amount",
        value: { kind: "amount", text: "一百二" },
        telegramUpdateId: "2",
        sourceRef: "123:2",
        rawText: "一百二",
        receivedAt: "2026-09-21T02:00:00.000Z",
      },
      dependencies,
    );

    expect(result).toEqual({ kind: "invalid", reason: "amount_not_numeric" });
    const record = await repository.getDraftRecord({ draftId: "draft-1" });
    expect(record?.status).toBe("awaiting_input");
  });

  it("rejects answering a field that is not pending", async () => {
    const { dependencies } = await seedIncompleteLunchDraft();

    const result = await answerDraft(
      {
        ownerId: "owner-1",
        draftId: "draft-1",
        field: "account",
        value: { kind: "reference", id: "account-1", label: "台新" },
        telegramUpdateId: "2",
        sourceRef: "123:2",
        rawText: "台新",
        receivedAt: "2026-09-21T02:00:00.000Z",
      },
      dependencies,
    );

    expect(result).toEqual({ kind: "invalid", reason: "not_pending" });
  });
});
```

`seedIncompleteLunchDraft` 建立 `FakeLedgerRepository`、寫入來源事件與一筆缺金額的 `午餐` 草稿，回傳 `{ repository, dependencies }`。

- [ ] **Step 2：執行測試確認失敗**

Run: `pnpm vitest run tests/application/answer-draft.test.ts`
Expected: FAIL，找不到模組 `src/application/answer-draft.js`。

- [ ] **Step 3：實作**

```ts
const AMOUNT_PATTERN = /^\d+(?:\.\d+)?$/;

export async function answerDraft(
  command: AnswerDraftCommand,
  dependencies: AnswerDraftDependencies,
): Promise<AnswerDraftResult> {
  const record = await dependencies.repository.getDraftRecord({ draftId: command.draftId });
  if (!record?.incomplete || record.ownerId !== command.ownerId) {
    return { kind: "invalid", reason: "draft_not_found" };
  }
  if (!record.incomplete.pendingFields.some((item) => item.field === command.field)) {
    return { kind: "invalid", reason: "not_pending" };
  }
  if (command.value.kind === "amount" && !AMOUNT_PATTERN.test(command.value.text.trim())) {
    return { kind: "invalid", reason: "amount_not_numeric" };
  }

  await dependencies.repository.recordInputEvent({
    eventId: dependencies.generateId(),
    ownerId: command.ownerId,
    telegramUpdateId: command.telegramUpdateId,
    sourceType: "telegram",
    sourceRef: command.sourceRef,
    rawText: command.rawText,
    receivedAt: command.receivedAt,
  });

  const patch: DraftPatch =
    command.value.kind === "amount"
      ? { amount: money(command.value.text.trim(), "TWD") }
      : command.field === "account"
        ? { accountFromId: command.value.id }
        : { categoryId: command.value.id, category: command.value.label };

  const result = completeDraft(record.incomplete, patch);
  await dependencies.repository.replaceDraft(command.draftId, result.draft);
  return result;
}
```

- [ ] **Step 4：執行測試確認通過**

Run: `pnpm vitest run tests/application`
Expected: PASS。

- [ ] **Step 5：提交**

```bash
git add src/application/answer-draft.ts tests/application/answer-draft.test.ts
git commit -m "feat: answer pending draft fields and upgrade drafts"
```

---

### Task 8：callback 編解碼

**Files:**

- Create: `src/telegram/callback-data.ts`
- Test: `tests/telegram/callback-data.test.ts`

**Interfaces:**

- Consumes: Task 2 `ParseField`。
- Produces:

```ts
export const CALLBACK_DATA_LIMIT = 64;

export type CallbackAction =
  | { readonly kind: "answer"; readonly draftRef: string; readonly field: ParseField; readonly index: number }
  | { readonly kind: "apply-amount"; readonly draftRef: string; readonly amount: string }
  | { readonly kind: "pending-page"; readonly status: "input" | "confirm"; readonly page: number }
  | { readonly kind: "pending-open"; readonly draftRef: string }
  | { readonly kind: "archive"; readonly draftRef: string };

export function encodeCallback(action: CallbackAction): string;
export function decodeCallback(data: string): CallbackAction | null;
```

既有的 `confirm:<draftId>`、`cancel:<draftId>`、`recent:`、`delete:`、`refund:` callback 維持原狀不得更動，升級後對話記錄中的舊按鈕才不會失效。

- [ ] **Step 1：寫失敗測試**

```ts
import { describe, expect, it } from "vitest";

import {
  CALLBACK_DATA_LIMIT,
  decodeCallback,
  encodeCallback,
  type CallbackAction,
} from "../../src/telegram/callback-data.js";

const samples: CallbackAction[] = [
  { kind: "answer", draftRef: "a7k2m9x4", field: "category", index: 9 },
  { kind: "answer", draftRef: "ffffffff", field: "refundTarget", index: 0 },
  { kind: "apply-amount", draftRef: "a7k2m9x4", amount: "123456.78" },
  { kind: "pending-page", status: "input", page: 3 },
  { kind: "pending-open", draftRef: "a7k2m9x4" },
  { kind: "archive", draftRef: "a7k2m9x4" },
];

describe("callback data", () => {
  it("round-trips every action", () => {
    for (const action of samples) {
      expect(decodeCallback(encodeCallback(action))).toEqual(action);
    }
  });

  it("never exceeds the telegram callback data limit", () => {
    for (const action of samples) {
      expect(Buffer.byteLength(encodeCallback(action), "utf8")).toBeLessThanOrEqual(
        CALLBACK_DATA_LIMIT,
      );
    }
  });

  it("rejects an amount that would overflow the limit", () => {
    expect(() =>
      encodeCallback({ kind: "apply-amount", draftRef: "a7k2m9x4", amount: "1".repeat(64) }),
    ).toThrow();
  });

  it("returns null for unknown or malformed payloads", () => {
    expect(decodeCallback("confirm:00000000-0000-0000-0000-000000000000")).toBeNull();
    expect(decodeCallback("a:a7k2m9x4:zzz:1")).toBeNull();
    expect(decodeCallback("")).toBeNull();
  });
});
```

- [ ] **Step 2：執行測試確認失敗**

Run: `pnpm vitest run tests/telegram/callback-data.test.ts`
Expected: FAIL，找不到模組 `src/telegram/callback-data.js`。

- [ ] **Step 3：實作**

```ts
export const CALLBACK_DATA_LIMIT = 64;

const fieldCodes: Record<ParseField, string> = {
  amount: "amt",
  category: "cat",
  account: "acc",
  refundTarget: "ref",
  purpose: "pur",
};
const fieldsByCode = new Map(Object.entries(fieldCodes).map(([field, code]) => [code, field]));
const REF_PATTERN = /^[0-9a-f]{8}$/;

function guard(data: string): string {
  if (Buffer.byteLength(data, "utf8") > CALLBACK_DATA_LIMIT) {
    throw new Error("callback data exceeds telegram limit");
  }
  return data;
}

export function encodeCallback(action: CallbackAction): string {
  switch (action.kind) {
    case "answer":
      return guard(`a:${action.draftRef}:${fieldCodes[action.field]}:${String(action.index)}`);
    case "apply-amount":
      return guard(`v:${action.draftRef}:${action.amount}`);
    case "pending-page":
      return guard(`p:${action.status}:${String(action.page)}`);
    case "pending-open":
      return guard(`o:${action.draftRef}`);
    case "archive":
      return guard(`z:${action.draftRef}`);
  }
}

const AMOUNT_PATTERN = /^\d+(?:\.\d+)?$/;
const INDEX_PATTERN = /^\d{1,2}$/;

export function decodeCallback(data: string): CallbackAction | null {
  const [prefix, first, second, third] = data.split(":");

  if (prefix === "a" && first && second && third !== undefined) {
    const field = fieldsByCode.get(second);
    if (!REF_PATTERN.test(first) || !field || !INDEX_PATTERN.test(third)) return null;
    return { kind: "answer", draftRef: first, field, index: Number(third) };
  }
  if (prefix === "v" && first && second !== undefined) {
    if (!REF_PATTERN.test(first) || !AMOUNT_PATTERN.test(second)) return null;
    return { kind: "apply-amount", draftRef: first, amount: second };
  }
  if (prefix === "p" && (first === "input" || first === "confirm") && second !== undefined) {
    if (!INDEX_PATTERN.test(second)) return null;
    return { kind: "pending-page", status: first, page: Number(second) };
  }
  if (prefix === "o" && first) {
    if (!REF_PATTERN.test(first)) return null;
    return { kind: "pending-open", draftRef: first };
  }
  if (prefix === "z" && first) {
    if (!REF_PATTERN.test(first)) return null;
    return { kind: "archive", draftRef: first };
  }
  return null;
}
```

`fieldsByCode` 的型別需標註為 `Map<string, ParseField>`，否則 `field` 會被推導為 `string`。

- [ ] **Step 4：執行測試確認通過**

Run: `pnpm vitest run tests/telegram/callback-data.test.ts`
Expected: PASS，4 個測試。

- [ ] **Step 5：提交**

```bash
git add src/telegram/callback-data.ts tests/telegram/callback-data.test.ts
git commit -m "feat: encode draft callbacks within the telegram size limit"
```

---

### Task 9：追問訊息與候選鍵盤

**Files:**

- Create: `src/telegram/format-prompt.ts`
- Test: `tests/telegram/format-prompt.test.ts`

**Interfaces:**

- Consumes: Task 2 `IncompleteDraft`、Task 8 `encodeCallback`、`ReferenceSnapshot`。
- Produces:

```ts
export interface DraftPrompt {
  readonly text: string;
  readonly replyMarkup?: InlineKeyboardMarkup;
}

export function formatPrompt(
  draft: IncompleteDraft,
  draftRef: string,
  references: Partial<ReferenceSnapshot>,
): DraftPrompt;

export function formatBatchSummary(items: readonly BatchItem[]): string;
```

金額追問沒有鍵盤，文案必須指示使用者回覆該訊息。可枚舉欄位每頁最多 10 個候選。

- [ ] **Step 1：寫失敗測試**

```ts
describe("formatPrompt", () => {
  it("asks for an amount by reply and offers no keyboard", () => {
    const prompt = formatPrompt(incompleteLunchDraft(), "a7k2m9x4", {});

    expect(prompt.text).toContain("午餐");
    expect(prompt.text).toContain("回覆這則訊息");
    expect(prompt.replyMarkup).toBeUndefined();
  });

  it("offers candidate buttons for an enumerable field", () => {
    const draft = incompleteDraftWithPendingCategory(["category-a", "category-b"]);

    const prompt = formatPrompt(draft, "a7k2m9x4", {
      categories: [
        { categoryId: "category-a", key: "expense_dining", name: "餐飲", type: "expense", active: true },
        { categoryId: "category-b", key: "expense_transport", name: "交通", type: "expense", active: true },
      ],
    });

    expect(prompt.replyMarkup?.inline_keyboard[0]).toEqual([
      { text: "餐飲", callback_data: "a:a7k2m9x4:cat:0" },
      { text: "交通", callback_data: "a:a7k2m9x4:cat:1" },
    ]);
  });

  it("caps candidates at ten per prompt", () => {
    const candidates = Array.from({ length: 14 }, (_, index) => `category-${String(index)}`);
    const draft = incompleteDraftWithPendingCategory(candidates);

    const prompt = formatPrompt(draft, "a7k2m9x4", { categories: expenseCategories(candidates) });

    const buttons = prompt.replyMarkup?.inline_keyboard.flat() ?? [];
    expect(buttons).toHaveLength(10);
  });
});

describe("formatBatchSummary", () => {
  it("reports counts per outcome", () => {
    const items = [
      { index: 0, segment: "午餐 120", outcome: { kind: "draft" as const, draft: completeLunchDraft(), draftRef: "a7k2m9x4" } },
      { index: 1, segment: "午餐 60", outcome: { kind: "draft" as const, draft: completeLunchDraft(), draftRef: "b7k2m9x4" } },
      { index: 2, segment: "午餐", outcome: { kind: "incomplete" as const, draft: incompleteLunchDraft(), draftRef: "c7k2m9x4" } },
    ];

    expect(formatBatchSummary(items)).toBe("3 筆：2 筆待確認、1 筆待補金額");
  });
});
```

- [ ] **Step 2：執行測試確認失敗**

Run: `pnpm vitest run tests/telegram/format-prompt.test.ts`
Expected: FAIL，找不到模組 `src/telegram/format-prompt.js`。

- [ ] **Step 3：實作**

```ts
const MAX_CANDIDATES = 10;
const BUTTONS_PER_ROW = 2;

export function formatPrompt(
  draft: IncompleteDraft,
  draftRef: string,
  references: Partial<ReferenceSnapshot>,
): DraftPrompt {
  const pending = draft.pendingFields[0];
  if (!pending) throw new Error("incomplete draft must have a pending field");
  const segment = draft.partial.rawSegment;

  if (pending.field === "amount") {
    return { text: [`待補金額：${segment}`, "請回覆這則訊息並輸入金額。"].join("\n") };
  }

  const labels = new Map<string, string>([
    ...(references.categories ?? []).map((item) => [item.categoryId, item.name] as const),
    ...(references.accounts ?? []).map((item) => [item.accountId, item.name] as const),
  ]);
  const buttons = pending.candidateIds.slice(0, MAX_CANDIDATES).map((id, index) => ({
    text: labels.get(id) ?? id,
    callback_data: encodeCallback({ kind: "answer", draftRef, field: pending.field, index }),
  }));
  const rows = buttons.reduce<(typeof buttons)[]>((acc, button, index) => {
    if (index % BUTTONS_PER_ROW === 0) acc.push([]);
    acc.at(-1)?.push(button);
    return acc;
  }, []);

  return {
    text: [`待補${pending.field === "account" ? "帳戶" : "分類"}：${segment}`, "請選擇："].join("\n"),
    replyMarkup: { inline_keyboard: rows },
  };
}

export function formatBatchSummary(items: readonly BatchItem[]): string {
  const counts = { draft: 0, incomplete: 0, unparsed: 0 };
  for (const item of items) counts[item.outcome.kind] += 1;
  const parts = [
    ...(counts.draft > 0 ? [`${String(counts.draft)} 筆待確認`] : []),
    ...(counts.incomplete > 0 ? [`${String(counts.incomplete)} 筆待補金額`] : []),
    ...(counts.unparsed > 0 ? [`${String(counts.unparsed)} 筆無法解析`] : []),
  ];
  return `${String(items.length)} 筆：${parts.join("、")}`;
}
```

`formatBatchSummary` 的「待補金額」文案在 M3a 涵蓋所有 `incomplete` 情形；缺分類或帳戶的段落數量極少，且摘要之後緊接著就是各自的追問訊息，不需要再細分。

- [ ] **Step 4：執行測試確認通過**

Run: `pnpm vitest run tests/telegram/format-prompt.test.ts`
Expected: PASS。

- [ ] **Step 5：提交**

```bash
git add src/telegram/format-prompt.ts tests/telegram/format-prompt.test.ts
git commit -m "feat: format draft field prompts and batch summaries"
```

---

### Task 10：Telegram handler 拆分（無行為變更）

**Files:**

- Create: `src/telegram/handlers/transactions.ts`、`src/telegram/handlers/summaries.ts`、`src/telegram/handlers/drafts.ts`
- Create: `tests/support/telegram-harness.ts`
- Modify: `src/telegram/create-bot.ts`、`tests/telegram/create-bot.test.ts`

**Interfaces:**

- Consumes: 既有 `LedgerBotDependencies`。
- Produces:
  - 每個 handler 模組匯出 `registerXxxHandlers(bot: Bot, dependencies: LedgerBotDependencies): void`。
  - `create-bot.ts` 繼續匯出 `createLedgerBot` 與 `formatRecentPage`（既有測試由此 import，簽名不得更動）。
  - `tests/support/telegram-harness.ts` 匯出 Task 11 至 14 共用的測試工具：
    - `createHarness(options?: { today?: string; now?: Date }): { bot; calls; repository; referenceRepository }`——由 `tests/telegram/create-bot.test.ts` 內的既有實作搬出，並擴充兩點：接受 `today` 覆寫，且 `capture` transformer 對 `sendMessage` 回傳遞增的 `message_id`（`{ ok: true, result: { message_id: n } }`），讓 `setPreviewMessage` 能被驗證。
    - `messageUpdate`、`replyUpdate`（多帶 `reply_to_message`）、`callbackUpdate`（帶 `callback_query.data` 與 `message`）。
    - `getText(call)`、`lastSentMessageId(calls)`、`firstDraftRef(repository)`。

**這是純搬移任務：不新增行為測試，既有測試必須全綠。**

- [ ] **Step 1：確認基準線**

Run: `pnpm vitest run tests/telegram tests/smoke`
Expected: PASS。記下測試數，拆分後必須一致。

- [ ] **Step 2：搬移 handler**

- `transactions.ts`：`/recent`、`recent:`、`recent-home`、`dismiss-recent`、`delete:`、`delete-confirm:`、`delete-cancel:`、`refund:`、`refund-confirm:`、`refund-cancel:`，以及 `formatRecentPage`（由 `create-bot.ts` 重新匯出以維持既有 import 路徑）。
- `summaries.ts`：`/today`、`/month`。
- `drafts.ts`：`confirm:`、`cancel:`、`message:text`。
- `create-bot.ts`：保留 `createLedgerBot`、白名單 middleware、三個 `register*` 呼叫，以及 `export { formatRecentPage } from "./handlers/transactions.js";`。

同時把 `tests/telegram/create-bot.test.ts` 內的 `createHarness`、`messageUpdate`、`getText` 搬到 `tests/support/telegram-harness.ts` 並補上 `replyUpdate`、`callbackUpdate`、`lastSentMessageId`、`firstDraftRef`；原測試改為 import。這一步讓 Task 11 至 14 的測試有共用起點，不需要各自複製 harness。

- [ ] **Step 3：執行測試確認無行為變更**

Run: `pnpm vitest run`
Expected: PASS，測試數與 Step 1 相同。

- [ ] **Step 4：確認型別與 lint**

Run: `pnpm typecheck && pnpm lint`
Expected: 無錯誤。

- [ ] **Step 5：提交**

```bash
git add src/telegram/create-bot.ts src/telegram/handlers tests/support/telegram-harness.ts tests/telegram/create-bot.test.ts
git commit -m "refactor: split telegram handlers by topic"
```

---

### Task 11：批次輸入接線

**Files:**

- Modify: `src/telegram/handlers/drafts.ts`
- Test: `tests/telegram/batch-input.test.ts`

**Interfaces:**

- Consumes: Task 6 `createBatch`、Task 9 `formatPrompt` 與 `formatBatchSummary`、Task 5 `setPreviewMessage`。
- Produces: `message:text` 改用 `createBatch`；每筆完整草稿送出 `formatPreview`、每筆不完整草稿送出 `formatPrompt`，兩者都在送出後以回傳的 `message_id` 呼叫 `setPreviewMessage`；兩段以上時最後送出批次摘要。

- [ ] **Step 1：寫失敗測試**

```ts
it("sends one preview per segment for AC-09", async () => {
  const { bot, calls } = createHarness();

  await bot.handleUpdate(messageUpdate({ updateId: 1, text: "午餐 120，Uber 245" }));

  const sent = calls.filter((call) => call.method === "sendMessage");
  expect(sent).toHaveLength(3); // 兩則預覽加一則批次摘要
  expect(getText(sent[0])).toContain("總金額：TWD 120");
  expect(getText(sent[1])).toContain("總金額：TWD 245");
  expect(getText(sent[2])).toBe("2 筆：2 筆待確認");
});

it("previews the parsable segments and prompts for the incomplete one for AC-10", async () => {
  const { bot, calls, repository } = createHarness();

  await bot.handleUpdate(messageUpdate({ updateId: 1, text: "午餐 120，Uber 245，午餐" }));

  const sent = calls.filter((call) => call.method === "sendMessage");
  expect(sent).toHaveLength(4);
  expect(getText(sent[2])).toContain("回覆這則訊息");
  expect(getText(sent[3])).toBe("3 筆：2 筆待確認、1 筆待補金額");
  expect(repository.drafts.size).toBe(3);
});

it("rejects a message with more than ten segments without creating drafts", async () => {
  const { bot, calls, repository } = createHarness();
  const text = Array.from({ length: 11 }, () => "午餐 10").join("，");

  await bot.handleUpdate(messageUpdate({ updateId: 1, text }));

  expect(getText(calls[0])).toContain("一次最多 10 筆");
  expect(repository.drafts.size).toBe(0);
});
```

測試 harness 需擴充 `capture` transformer，讓 `sendMessage` 回傳遞增的 `message_id`，以便驗證 `setPreviewMessage` 有被呼叫。

- [ ] **Step 2：執行測試確認失敗**

Run: `pnpm vitest run tests/telegram/batch-input.test.ts`
Expected: FAIL，目前只會送出一則訊息。

- [ ] **Step 3：實作**

```ts
async function handleBatchResult(
  context: Context,
  result: CreateBatchResult,
  dependencies: LedgerBotDependencies,
): Promise<void> {
  if (result.kind === "duplicate") {
    await context.reply("此更新已處理。");
    return;
  }
  if (result.kind === "too_many_segments") {
    await context.reply("一次最多 10 筆，請分次輸入。");
    return;
  }
  if (result.kind === "empty") return;

  const references = await loadReferenceSnapshot(
    dependencies.referenceRepository,
    dependencies.ownerId,
  );

  for (const item of result.items) {
    if (item.outcome.kind === "unparsed") continue;
    const message =
      item.outcome.kind === "draft"
        ? formatPreview(item.outcome.draft, references)
        : formatPrompt(item.outcome.draft, item.outcome.draftRef, references);
    const sent = await context.reply(message.text, {
      ...(message.replyMarkup ? { reply_markup: message.replyMarkup } : {}),
    });
    await dependencies.repository.setPreviewMessage(
      item.outcome.kind === "draft" ? item.outcome.draft.draftId : item.outcome.draft.draftId,
      String(sent.chat.id),
      String(sent.message_id),
    );
  }

  if (result.items.length > 1) {
    await context.reply(formatBatchSummary(result.items));
  }
}
```

`unparsed` 項目不送個別訊息，只計入摘要。單段訊息不送摘要，維持 M2 的既有體驗。

- [ ] **Step 4：執行測試確認通過**

Run: `pnpm vitest run tests/telegram`
Expected: PASS。

- [ ] **Step 5：提交**

```bash
git add src/telegram/handlers/drafts.ts tests/telegram/batch-input.test.ts
git commit -m "feat: reply with one preview per parsed segment"
```

---

### Task 12：追問路由

**Files:**

- Modify: `src/telegram/handlers/drafts.ts`
- Test: `tests/telegram/draft-routing.test.ts`

**Interfaces:**

- Consumes: Task 7 `answerDraft`、Task 8 `decodeCallback`、Task 5 `getDraftRecord`。
- Produces: 三條路由——候選按鈕 callback、reply 預覽訊息的文字、無 reply 的文字 fallback。

- [ ] **Step 1：寫失敗測試**

```ts
it("routes a reply to the draft that preview message belongs to", async () => {
  const { bot, calls, repository } = createHarness();
  await bot.handleUpdate(messageUpdate({ updateId: 1, text: "午餐" }));
  const promptMessageId = lastSentMessageId(calls);

  await bot.handleUpdate(
    replyUpdate({ updateId: 2, text: "120", replyToMessageId: promptMessageId }),
  );

  const record = await repository.getDraftRecord({ draftId: [...repository.drafts.keys()][0] ?? "" });
  expect(record?.status).toBe("awaiting_confirmation");
  expect(getText(calls.at(-1))).toContain("總金額：TWD 120");
});

it("offers the pending drafts when a bare amount cannot be parsed as a new transaction", async () => {
  const { bot, calls } = createHarness();
  await bot.handleUpdate(messageUpdate({ updateId: 1, text: "午餐" }));

  await bot.handleUpdate(messageUpdate({ updateId: 2, text: "120" }));

  const last = calls.at(-1);
  expect(getText(last)).toContain("要把 120 填到哪一筆");
  expect(JSON.stringify(last?.payload)).toContain("v:");
});

it("treats a parsable message as a new transaction even while drafts await input", async () => {
  const { bot, calls, repository } = createHarness();
  await bot.handleUpdate(messageUpdate({ updateId: 1, text: "午餐" }));

  await bot.handleUpdate(messageUpdate({ updateId: 2, text: "午餐 250" }));

  expect(getText(calls.at(-1))).toContain("總金額：TWD 250");
  expect(repository.drafts.size).toBe(2);
});

it("applies a candidate button answer to the referenced draft", async () => {
  const { bot, calls, repository } = createHarness();
  await bot.handleUpdate(messageUpdate({ updateId: 1, text: "咖啡 60" }));
  const draftRef = firstDraftRef(repository);

  await bot.handleUpdate(callbackUpdate({ updateId: 2, data: `a:${draftRef}:cat:0` }));

  expect(calls.some((call) => call.method === "answerCallbackQuery")).toBe(true);
  const record = await repository.getDraftRecord({ ownerId: "owner-1", draftRef });
  expect(record?.status).toBe("awaiting_confirmation");
});
```

- [ ] **Step 2：執行測試確認失敗**

Run: `pnpm vitest run tests/telegram/draft-routing.test.ts`
Expected: FAIL，reply 會被當成新交易輸入。

- [ ] **Step 3：實作**

`message:text` handler 在呼叫 `createBatch` 之前先判斷路由：

```ts
  bot.on("message:text", async (context) => {
    const replyTo = context.message.reply_to_message;
    if (replyTo) {
      const record = await dependencies.repository.getDraftRecord({
        previewChatId: String(context.chat.id),
        previewMessageId: String(replyTo.message_id),
      });
      if (record?.incomplete) {
        await applyAnswer(context, record, record.incomplete.pendingFields[0]?.field ?? "amount", {
          kind: "amount",
          text: context.message.text,
        });
        return;
      }
    }

    // 純數字訊息必須在 createBatch 之前攔截：`120` 本身會被解析成一筆缺分類的
    // 草稿，若先建批次就永遠走不到候選清單，也會留下一筆使用者沒要的草稿。
    if (AMOUNT_ONLY.test(context.message.text.trim())) {
      const pending = await listPending(dependencies.repository, dependencies.ownerId, "awaiting_input", 0);
      const awaitingAmount = pending.items.filter((item) => item.amount === null);
      if (awaitingAmount.length > 0) {
        await context.reply(`要把 ${context.message.text.trim()} 填到哪一筆？`, {
          reply_markup: {
            inline_keyboard: awaitingAmount.map((item) => [
              {
                text: `${item.occurredDate} ${item.rawSegment}`,
                callback_data: encodeCallback({
                  kind: "apply-amount",
                  draftRef: item.draftRef,
                  amount: context.message.text.trim(),
                }),
              },
            ]),
          },
        });
        return;
      }
      // 沒有任何草稿在等金額，就讓它照常走新交易路徑。
    }

    const result = await createBatch(toCommand(context, dependencies), dependencies);
    await handleBatchResult(context, result, dependencies);
  });
```

`AMOUNT_ONLY` 為 `/^\d+(?:\.\d+)?$/`。純數字且沒有草稿在等金額時仍然建立新草稿（會追問分類），維持「不讓舊草稿攔截新輸入」的原則。`apply-amount` 與 `answer` 兩個 callback 都收斂到 `applyAnswer`：

```ts
async function applyAnswer(
  context: Context,
  record: DraftRecord,
  field: ParseField,
  value: AnswerValue,
): Promise<void> {
  const result = await answerDraft(
    {
      ownerId: dependencies.ownerId,
      draftId: record.draftId,
      field,
      value,
      telegramUpdateId: String(context.update.update_id),
      sourceRef: context.callbackQuery
        ? context.callbackQuery.id
        : `${String(context.chat?.id ?? "")}:${String(context.message?.message_id ?? "")}`,
      rawText: value.kind === "amount" ? value.text : value.label,
      receivedAt: dependencies.now().toISOString(),
    },
    dependencies,
  );

  const references = await loadReferenceSnapshot(
    dependencies.referenceRepository,
    dependencies.ownerId,
  );
  if (result.kind === "draft") {
    const preview = formatPreview(result.draft, references);
    const sent = await context.reply(preview.text, { reply_markup: preview.replyMarkup });
    await dependencies.repository.setPreviewMessage(
      result.draft.draftId,
      String(sent.chat.id),
      String(sent.message_id),
    );
    return;
  }
  if (result.kind === "incomplete") {
    const prompt = formatPrompt(result.draft, record.draftRef, references);
    const sent = await context.reply(prompt.text, {
      ...(prompt.replyMarkup ? { reply_markup: prompt.replyMarkup } : {}),
    });
    await dependencies.repository.setPreviewMessage(
      result.draft.draftId,
      String(sent.chat.id),
      String(sent.message_id),
    );
    return;
  }
  await context.reply(
    result.reason === "amount_not_numeric" ? "金額格式無法辨識，請輸入數字。" : "這筆草稿已無法補欄位。",
  );
}
```

`answer` callback 先以 `draftRef` 取回草稿，用 `pendingFields` 中對應欄位的 `candidateIds[index]` 取得參照 ID 與名稱，再呼叫 `applyAnswer`，並以 `answerCallbackQuery` 結束 callback。

- [ ] **Step 4：執行測試確認通過**

Run: `pnpm vitest run tests/telegram`
Expected: PASS。

- [ ] **Step 5：提交**

```bash
git add src/telegram/handlers/drafts.ts tests/telegram/draft-routing.test.ts
git commit -m "feat: route field answers to the right draft"
```

---

### Task 13：過期草稿重新預覽

**Files:**

- Modify: `src/telegram/handlers/drafts.ts`
- Test: `tests/telegram/stale-draft.test.ts`

**Interfaces:**

- Consumes: Task 5 `DraftRecord.createdDate`、`dependencies.today()`。
- Produces:
  - `LedgerRepository.touchDraftDate(draftId: string, date: string): Promise<void>`（SQLite 與 fake 皆需實作），把 `created_date` 更新為今日，使重新預覽後的第二次確認可以入帳。
  - `confirm:` callback 在 `record.createdDate !== dependencies.today()` 時不入帳，改重發完整預覽。

- [ ] **Step 1：寫失敗測試**

```ts
it("does not confirm a draft created on an earlier day", async () => {
  const { bot, calls, repository } = createHarness({ today: "2026-09-21" });
  await seedDraftCreatedOn(repository, "2026-09-20", "draft-1");

  await bot.handleUpdate(callbackUpdate({ updateId: 2, data: "confirm:draft-1" }));

  expect(repository.transactions.size).toBe(0);
  const answer = calls.find((call) => call.method === "answerCallbackQuery");
  expect(JSON.stringify(answer?.payload)).toContain("請重新確認");
  expect(getText(calls.at(-1))).toContain("建立日期：2026-09-20");
});

it("confirms a draft created today", async () => {
  const { bot, repository } = createHarness({ today: "2026-09-21" });
  await seedDraftCreatedOn(repository, "2026-09-21", "draft-1");

  await bot.handleUpdate(callbackUpdate({ updateId: 2, data: "confirm:draft-1" }));

  expect(repository.transactions.size).toBe(1);
});

it("confirms on the second press after a re-preview", async () => {
  const { bot, repository } = createHarness({ today: "2026-09-21" });
  await seedDraftCreatedOn(repository, "2026-09-20", "draft-1");

  await bot.handleUpdate(callbackUpdate({ updateId: 2, data: "confirm:draft-1" }));
  await bot.handleUpdate(callbackUpdate({ updateId: 3, data: "confirm:draft-1" }));

  expect(repository.transactions.size).toBe(1);
});
```

第三個測試要求重新預覽時把 `created_date` 更新為今日——這是「再按一次即可入帳」的實作方式，必須在 `replaceDraft` 或專用方法中完成。

- [ ] **Step 2：執行測試確認失敗**

Run: `pnpm vitest run tests/telegram/stale-draft.test.ts`
Expected: FAIL，過期草稿仍然直接入帳。

- [ ] **Step 3：實作**

`confirm:` handler 開頭：

```ts
    const record = await dependencies.repository.getDraftRecord({ draftId });
    if (!record?.draft) {
      await context.answerCallbackQuery({ text: "草稿不存在" });
      return;
    }
    if (record.createdDate !== null && record.createdDate !== dependencies.today()) {
      await dependencies.repository.touchDraftDate(draftId, dependencies.today());
      const references = await loadReferenceSnapshot(
        dependencies.referenceRepository,
        dependencies.ownerId,
      );
      const preview = formatPreview(record.draft, references);
      await context.answerCallbackQuery({ text: "草稿已跨日，請重新確認" });
      await context.reply(
        [`建立日期：${record.createdDate}`, preview.text].join("\n"),
        { reply_markup: preview.replyMarkup },
      );
      return;
    }
```

`touchDraftDate(draftId, date)` 加入 `LedgerRepository`、SQLite 實作與 fake 實作。

- [ ] **Step 4：執行測試確認通過**

Run: `pnpm vitest run tests/telegram`
Expected: PASS。

- [ ] **Step 5：提交**

```bash
git add src/ports/ledger-repository.ts src/db/sqlite-ledger-repository.ts tests/support/fake-ledger-repository.ts src/telegram/handlers/drafts.ts tests/telegram/stale-draft.test.ts
git commit -m "feat: require re-confirmation for drafts from earlier days"
```

---

### Task 14：`/pending` 與封存

**Files:**

- Create: `src/application/list-pending.ts`、`src/telegram/handlers/pending.ts`
- Modify: `src/telegram/create-bot.ts`
- Test: `tests/application/list-pending.test.ts`、`tests/telegram/pending-command.test.ts`

**Interfaces:**

- Consumes: Task 5 `listPendingDrafts`、`countPendingDrafts`、`archiveDraft`；Task 8 `encodeCallback`。
- Produces:

```ts
export const PENDING_PAGE_SIZE = 10;

export interface PendingPage {
  readonly status: "awaiting_input" | "awaiting_confirmation";
  readonly page: number;
  readonly totalPages: number;
  readonly items: readonly PendingDraftSummary[];
}

export function listPending(
  repository: LedgerRepository,
  ownerId: string,
  status: PendingPage["status"],
  page: number,
): Promise<PendingPage>;
```

- [ ] **Step 1：寫失敗測試**

```ts
// tests/application/list-pending.test.ts
it("pages pending drafts ten at a time", async () => {
  const repository = await seedPendingDrafts(23);

  const page = await listPending(repository, "owner-1", "awaiting_input", 1);

  expect(page.items).toHaveLength(10);
  expect(page.totalPages).toBe(3);
});

it("returns an empty page when nothing is pending", async () => {
  const page = await listPending(new FakeLedgerRepository(), "owner-1", "awaiting_input", 0);

  expect(page.items).toEqual([]);
  expect(page.totalPages).toBe(0);
});

// tests/telegram/pending-command.test.ts
it("lists both groups and archives a draft on demand", async () => {
  const { bot, calls, repository } = createHarness();
  await bot.handleUpdate(messageUpdate({ updateId: 1, text: "午餐" }));
  const draftRef = firstDraftRef(repository);

  await bot.handleUpdate(messageUpdate({ updateId: 2, text: "/pending" }));
  expect(getText(calls.at(-1))).toContain("待補充");

  await bot.handleUpdate(callbackUpdate({ updateId: 3, data: `z:${draftRef}` }));

  const record = await repository.getDraftRecord({ ownerId: "owner-1", draftRef });
  expect(record?.status).toBe("archived");
});

it("keeps archived drafts out of the default list", async () => {
  const { bot, calls, repository } = createHarness();
  await bot.handleUpdate(messageUpdate({ updateId: 1, text: "午餐" }));
  await repository.archiveDraft([...repository.drafts.keys()][0] ?? "");

  await bot.handleUpdate(messageUpdate({ updateId: 2, text: "/pending" }));

  expect(getText(calls.at(-1))).toContain("目前沒有待處理項目");
});
```

- [ ] **Step 2：執行測試確認失敗**

Run: `pnpm vitest run tests/application/list-pending.test.ts tests/telegram/pending-command.test.ts`
Expected: FAIL，找不到模組。

- [ ] **Step 3：實作**

```ts
// src/application/list-pending.ts
export const PENDING_PAGE_SIZE = 10;

export async function listPending(
  repository: LedgerRepository,
  ownerId: string,
  status: PendingPage["status"],
  page: number,
): Promise<PendingPage> {
  const total = await repository.countPendingDrafts(ownerId, status);
  const items = await repository.listPendingDrafts({
    ownerId,
    status,
    limit: PENDING_PAGE_SIZE,
    offset: page * PENDING_PAGE_SIZE,
  });
  return {
    status,
    page,
    totalPages: Math.ceil(total / PENDING_PAGE_SIZE),
    items,
  };
}
```

```ts
// src/telegram/handlers/pending.ts
function formatPendingGroup(page: PendingPage, title: string): string[] {
  if (page.items.length === 0) return [];
  return [
    `${title}（${String(page.page + 1)} / ${String(page.totalPages)}）`,
    ...page.items.map(
      (item) =>
        `· ${item.draftRef} ${item.occurredDate} ${item.amount ?? "待補金額"} ${item.rawSegment}`,
    ),
  ];
}

export function registerPendingHandlers(bot: Bot, dependencies: LedgerBotDependencies): void {
  bot.command("pending", async (context) => {
    const input = await listPending(dependencies.repository, dependencies.ownerId, "awaiting_input", 0);
    const confirm = await listPending(
      dependencies.repository,
      dependencies.ownerId,
      "awaiting_confirmation",
      0,
    );
    const lines = [
      ...formatPendingGroup(input, "待補充"),
      ...formatPendingGroup(confirm, "待確認"),
    ];
    if (lines.length === 0) {
      await context.reply("目前沒有待處理項目。");
      return;
    }
    await context.reply(lines.join("\n"), {
      reply_markup: { inline_keyboard: pendingKeyboard(input, confirm) },
    });
  });

  bot.callbackQuery(/^[opz]:/, async (context) => {
    const action = decodeCallback(context.callbackQuery.data);
    if (!action) {
      await context.answerCallbackQuery({ text: "操作已失效" });
      return;
    }
    if (action.kind === "archive") {
      const record = await dependencies.repository.getDraftRecord({
        ownerId: dependencies.ownerId,
        draftRef: action.draftRef,
      });
      if (!record) {
        await context.answerCallbackQuery({ text: "草稿不存在" });
        return;
      }
      await dependencies.repository.archiveDraft(record.draftId);
      await context.answerCallbackQuery({ text: "已封存" });
      return;
    }
    // pending-open 與 pending-page 依相同模式處理：取回草稿後重發預覽或追問，
    // 分頁則以 listPending(page) 重新編排同一則訊息。
  });
}
```

`pendingKeyboard` 為每筆項目產生一列 `pending-open` 與 `archive` 兩顆按鈕，並在 `totalPages > 1` 時追加 `pending-page` 的上下頁按鈕。

`create-bot.ts` 註冊 `registerPendingHandlers`。

- [ ] **Step 4：執行測試確認通過**

Run: `pnpm vitest run`
Expected: PASS。

- [ ] **Step 5：提交**

```bash
git add src/application/list-pending.ts src/telegram/handlers/pending.ts src/telegram/create-bot.ts tests/application/list-pending.test.ts tests/telegram/pending-command.test.ts
git commit -m "feat: list and archive pending drafts"
```

---

### Task 15：解析回歸語料與交付文件

**Files:**

- Create: `tests/fixtures/parser-corpus.ts`、`tests/parser/corpus.test.ts`、`docs/quality/m3a-acceptance.md`
- Modify: `README.md`、`docs/roadmap.md`

**Interfaces:**

- Consumes: Task 1 `splitInput`、Task 3 `parseTransaction`。
- Produces: 20 至 30 筆匿名化輸入語料與其預期切分段數及解析結果種類。此為路線圖列出的 M3 通過條件。

- [ ] **Step 1：建立語料與失敗測試**

```ts
// tests/fixtures/parser-corpus.ts
export interface CorpusCase {
  readonly input: string;
  readonly segments: number;
  readonly outcomes: readonly ("draft" | "missing_fields" | "ambiguous")[];
}

export const parserCorpus: readonly CorpusCase[] = [
  { input: "午餐 120", segments: 1, outcomes: ["draft"] },
  { input: "薪水 +85000", segments: 1, outcomes: ["draft"] },
  { input: "昨天 Uber 245 國泰卡", segments: 1, outcomes: ["draft"] },
  { input: "台新轉國泰 5000", segments: 1, outcomes: ["draft"] },
  { input: "國泰卡刷 1200", segments: 1, outcomes: ["draft"] },
  { input: "繳國泰卡 18000 從台新", segments: 1, outcomes: ["draft"] },
  { input: "台新轉國泰 1000 手續費 15", segments: 1, outcomes: ["draft"] },
  { input: "午餐 120，Uber 245", segments: 2, outcomes: ["draft", "draft"] },
  { input: "午餐 120，Uber 245，午餐", segments: 3, outcomes: ["draft", "draft", "missing_fields"] },
  { input: "午餐 120，午餐 60", segments: 2, outcomes: ["draft", "draft"] },
  { input: "午餐", segments: 1, outcomes: ["missing_fields"] },
  { input: "咖啡 60", segments: 1, outcomes: ["missing_fields"] },
  { input: "午餐 120\nUber 245", segments: 2, outcomes: ["draft", "draft"] },
  { input: "午餐 120、Uber 245", segments: 2, outcomes: ["draft", "draft"] },
  { input: "昨天 午餐 120", segments: 1, outcomes: ["draft"] },
  { input: "台新轉國泰", segments: 1, outcomes: ["missing_fields"] },
  { input: "轉帳 5000", segments: 1, outcomes: ["missing_fields"] },
  { input: "退款 300", segments: 1, outcomes: ["missing_fields"] },
  { input: "午餐 120 200", segments: 1, outcomes: ["missing_fields"] },
  { input: "吃飯", segments: 1, outcomes: ["missing_fields"] },
  { input: "在嗎", segments: 1, outcomes: ["missing_fields"] },
  { input: "午餐 120，，Uber 245", segments: 2, outcomes: ["draft", "draft"] },
  { input: "午餐 120，我先付", segments: 1, outcomes: ["draft"] },
  { input: "Uber 245 國泰卡", segments: 1, outcomes: ["draft"] },
  { input: "薪水 +85000，午餐 120", segments: 2, outcomes: ["draft", "draft"] },
  { input: "國泰卡刷 1200，午餐 120", segments: 2, outcomes: ["draft", "draft"] },
  { input: "台新轉國泰 1000 手續費 15，午餐 120", segments: 2, outcomes: ["draft", "draft"] },
  { input: "繳國泰卡 18000 從台新，午餐 120", segments: 2, outcomes: ["draft", "draft"] },
];
```

語料共 22 筆。三筆需要特別說明：

- `午餐 120，我先付` 只有一段，因為「我先付」不含金額而被併回——這正是 M3b 代墊語句在 M3a 不會被誤切的保證。
- `午餐 120 200` 在同一段出現兩個金額，解析器無法判斷何者為總額，落入 `missing_fields`。
- `在嗎` 與 `吃飯` 是常見誤傳，確認它們不會產生草稿。

`parseKind` 輔助函式以 `FakeReferenceRepository` 的參照快照呼叫 `parseTransaction`，回傳 `ParseResult["kind"]`：

```ts
function parseKind(segment: string, index: number): ParseResult["kind"] {
  return parseTransaction(segment, {
    ownerId: "owner-1",
    requestId: `request-${String(index)}`,
    sourceEventId: "event-1",
    draftId: `draft-${String(index)}`,
    allocationId: `allocation-${String(index)}`,
    additionalAllocationId: `allocation-fee-${String(index)}`,
    today: "2026-09-21",
    ...referenceSnapshotFixture(),
  }).kind;
}
```

```ts
// tests/parser/corpus.test.ts
describe("parser corpus", () => {
  it("covers at least twenty anonymised inputs", () => {
    expect(parserCorpus.length).toBeGreaterThanOrEqual(20);
  });

  it.each(parserCorpus)("parses $input consistently", (testCase) => {
    const segments = splitInput(testCase.input);
    expect(segments).toHaveLength(testCase.segments);
    expect(segments.map((segment, index) => parseKind(segment, index))).toEqual(testCase.outcomes);
  });
});
```

- [ ] **Step 2：執行語料測試**

Run: `pnpm vitest run tests/parser/corpus.test.ts`
Expected: 全數通過。語料是回歸網，不是驅動實作的失敗測試——此時功能都已完成。任何一筆不符，先判斷是語料期望寫錯還是前面任務留下缺陷；若是後者，回到對應任務修正，不得直接改語料遷就實作。

- [ ] **Step 3：撰寫交付文件**

語料不得包含真實金額以外的個人資訊、帳戶全名或可辨識的商家以外資訊。

`README.md` 新增一節說明多筆輸入、追問、`/pending` 與跨日重新確認。`docs/roadmap.md` 的 M3 段落標示 M3a 已完成、M3b 待進行。`docs/quality/m3a-acceptance.md` 比照 `m2-acceptance.md` 的結構，列出自動驗證與人工 Telegram 驗收清單，且不得記錄 token、owner ID 或交易 ID。

- [ ] **Step 4：執行完整驗證**

Run: `pnpm check`
Expected: format、test、typecheck、lint、build 全數通過。

Run: `docker compose config --quiet && docker build -t personal-ledger:m3a .`
Expected: 建置成功。

Run: 以測試 token、測試 owner ID、暫存 SQLite 路徑及 `LEDGER_STARTUP_CHECK=1` 啟動容器。
Expected: migration 0003 套用成功後正常結束。

- [ ] **Step 5：提交**

```bash
git add tests/fixtures/parser-corpus.ts tests/parser/corpus.test.ts docs/quality/m3a-acceptance.md README.md docs/roadmap.md
git commit -m "docs: record m3a acceptance evidence"
```

---

## 完成定義

- AC-09 與 AC-10 的自動測試通過，且人工 Telegram 驗收完成並記錄於 `docs/quality/m3a-acceptance.md`。
- `pnpm check` 全綠；Docker 建置與啟動檢查通過。
- 既有 M2 資料經 migration 0003 後完整保留，`foreign_key_check` 無錯誤。
- 所有 callback payload 經測試斷言不超過 64 bytes。
- `/pending` 可列出、繼續處理與封存草稿；跨日草稿的舊按鈕不會直接入帳。

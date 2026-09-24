# M3b 代墊與回收實作計畫

> **給 agentic workers：** 必須使用 `superpowers:subagent-driven-development`（建議）或 `superpowers:executing-plans`，逐項執行本計畫。所有步驟使用 checkbox（`- [ ]`）追蹤。

**目標：** 讓使用者記錄替他人墊付的金額、追蹤未回收餘額、登記回收（含部分、多筆與超額），並在決定不再收回時把代墊轉為個人消費。

**架構：** 回收關聯是配置層欄位 `recovers_allocation_id`，不是交易層關聯表；未回收餘額是推導值，不落地。餘額計算、先進先出分配與放棄回收的配置拆分都是純函式，位於 `src/domain/advance.ts`；應用層只協調 repository port；Telegram adapter 只負責授權、輸入轉換與呈現。追問沿用 M3a 的 `pendingFields` 與候選按鈕機制。

**技術棧：** Node.js 24、TypeScript strict ESM、Zod 4、Decimal.js、better-sqlite3、grammY、Vitest、ESLint、Docker。

**設計規格：** `docs/domain/advance-model.md`

## 全域限制

- 所有專案文件預設使用繁體中文；程式識別字、schema 欄位、enum、指令與必要技術名詞保留英文。
- 只實作 AC-11 至 AC-14 與 `/advances`；不得加入借貸（`loan_out`、`loan_in`、`loan_repayment`）、外幣、月摘要通知或 Sheet 同步。
- 金額一律使用正規化十進位字串與 Decimal.js。**禁止使用 SQL 的 `sum()` 聚合金額**——欄位是 TEXT，SQLite 會轉成 IEEE 浮點數。加總一律取出明細後在領域層以 Decimal 計算。
- `0001` 至 `0004` 的 migration 不得修改；所有 schema 演進放在 `0005_advance_recovery.sql`。
- `summarizeAllocations` 與 `src/domain/ledger-summary.ts` 不得修改。代墊與回收的雙口徑語意由既有的 purpose 分派自動成立。
- Telegram `callback_data` 上限 64 bytes；交易對象名稱不得放進 callback。
- 領域層與應用層不得 import grammy 或其型別。
- 每筆正式交易仍須經使用者確認；放棄回收必須二次確認。
- 每次正式帳本異動必須連回 InputEvent，並在同一 SQLite transaction 寫入 AuditEvent。
- 既有 M3a 資料、測試與行為不得破壞；`pnpm check` 必須全綠。
- 每個任務遵循 red-green-refactor，且只提交該任務相關檔案。

### 不變條件的執行位置

設計第 4.3 節的五條不變條件分屬兩層，實作時不要找錯地方：

| 條件 | 執行位置 |
|---|---|
| 1. `recovers_allocation_id` 只出現在回收配置 | 領域層 `validateAllocations`（Task 2） |
| 5. 代墊必須有交易對象 | 領域層 `validateAllocations`（Task 2） |
| 2. 被指向的必須是有效的代墊配置 | 回收建立流程（Task 10）——候選一律來自 `computeOutstanding`，不接受使用者自行指定配置 ID |
| 3. 回收合計不得超過代墊金額 | `planRecovery`（Task 3）——超出的部分成為 `surplus`，由 Task 10 另立配置 |
| 4. 回收沿用代墊的分類與對象 | Task 10 組裝配置時複製 |

條件 2 與 3 跨越多筆交易，領域層在驗證單張草稿時看不到其他交易，因此由建立流程保證。**不要為此在領域層加入 repository 依賴。**

---

## 預計檔案結構

```text
src/
├── application/
│   ├── abandon-advance.ts       # 新增：放棄回收
│   ├── list-advances.ts         # 新增：未回收查詢
│   ├── record-recovery.ts       # 新增：回收登記
│   ├── answer-draft.ts          # 修改：支援 counterparty 與 advanceShare
│   └── reference-data.ts        # 修改：快照納入交易對象
├── db/
│   ├── migrations/
│   │   └── 0005_advance_recovery.sql   # 新增
│   ├── sqlite-ledger-repository.ts     # 修改：配置欄位、代墊查詢、刪除保護
│   └── sqlite-reference-repository.ts  # 修改：列出交易對象
├── domain/
│   ├── advance.ts               # 新增：餘額、先進先出分配、放棄拆分
│   ├── draft.ts                 # 修改：新增追問欄位與 proposedName
│   └── ledger.ts                # 修改：帳務形狀與不變條件
├── parser/
│   ├── split-share.ts           # 新增：分帳語句解析
│   └── rule-parser.ts           # 修改：產生代墊配置
├── ports/
│   ├── ledger-repository.ts     # 修改：代墊查詢介面
│   └── reference-repository.ts  # 修改：列出交易對象
└── telegram/
    ├── format-advance.ts        # 新增：代墊清單與回收預覽呈現
    └── handlers/
        ├── advances.ts          # 新增：/advances 與回收、放棄
        └── drafts.ts            # 修改：回收文字入口
```

---

### Task 1：分帳語句解析

**Files:**

- Create: `src/parser/split-share.ts`
- Test: `tests/parser/split-share.test.ts`

**Interfaces:**

- Consumes: 無。
- Produces：

```ts
export type ShareResult =
  | { readonly kind: "none" }
  | {
      readonly kind: "split";
      readonly participants: number;
      readonly names: readonly string[];
      readonly share: string;
    }
  | { readonly kind: "explicit"; readonly shares: readonly { name: string; amount: string }[] }
  | { readonly kind: "not_divisible"; readonly participants: number; readonly names: readonly string[] };

export function parseShare(text: string, total: string): ShareResult;
```

`share` 是每人負擔金額（`總額 ÷ 人數`，整除才回傳）。`participants` 含使用者本人。

- [ ] **Step 1：寫失敗測試**

```ts
import { describe, expect, it } from "vitest";

import { parseShare } from "../../src/parser/split-share.js";

describe("parseShare", () => {
  it("returns none when the text has no sharing phrase", () => {
    expect(parseShare("午餐 120", "120")).toEqual({ kind: "none" });
  });

  it("reads a half split with one named counterparty", () => {
    expect(parseShare("聚餐 1260，我先付，朋友欠一半", "1260")).toEqual({
      kind: "split",
      participants: 2,
      names: ["朋友"],
      share: "630",
    });
  });

  it("reads an explicit amount", () => {
    expect(parseShare("聚餐 1260，小明欠 630", "1260")).toEqual({
      kind: "explicit",
      shares: [{ name: "小明", amount: "630" }],
    });
  });

  it("reads a three way split and leaves unparseable names to the follow-up", () => {
    // 逗號列舉的名字不在四種明確寫法之內，因此 names 為空，由應用層追問。
    expect(parseShare("聚餐 1260，小明，小華，三個人平分", "1260")).toEqual({
      kind: "split",
      participants: 3,
      names: [],
      share: "420",
    });
  });

  it("only takes names from the four explicit forms", () => {
    expect(parseShare("聚餐 1260，現金支付，三個人平分", "1260")).toMatchObject({ names: [] });
    expect(parseShare("聚餐 1260，幫小明付，三個人平分", "1260")).toMatchObject({
      names: ["小明"],
    });
  });

  it("reports a split that does not divide exactly", () => {
    expect(parseShare("聚餐 1000，三個人平分", "1000")).toEqual({
      kind: "not_divisible",
      participants: 3,
      names: [],
    });
  });

  it("accepts arabic and chinese participant counts", () => {
    const arabic = parseShare("聚餐 900，3 個人平分", "900");
    const chinese = parseShare("聚餐 900，三個人平分", "900");

    expect(arabic).toEqual(chinese);
  });

  it("treats 平分 without a count as two people", () => {
    expect(parseShare("聚餐 500，跟小明平分", "500")).toMatchObject({
      kind: "split",
      participants: 2,
      share: "250",
    });
  });

  it("ignores the amount token when extracting names", () => {
    const result = parseShare("聚餐 1260，朋友欠一半", "1260");

    expect(result.kind).toBe("split");
    if (result.kind !== "split") return;
    expect(result.names).not.toContain("1260");
  });
});
```

- [ ] **Step 2：執行測試確認失敗**

Run: `pnpm vitest run tests/parser/split-share.test.ts`
Expected: FAIL，找不到模組 `src/parser/split-share.js`。

- [ ] **Step 3：寫最小實作**

```ts
import { Decimal } from "decimal.js";

const CHINESE_DIGITS = new Map([
  ["一", 1],
  ["二", 2],
  ["兩", 2],
  ["三", 3],
  ["四", 4],
  ["五", 5],
  ["六", 6],
  ["七", 7],
  ["八", 8],
  ["九", 9],
  ["十", 10],
]);

const COUNT_PATTERN = /([0-9]+|[一二兩三四五六七八九十])\s*個?\s*人\s*平分/;
const HALF_PATTERN = /(一半|各半|平分)/;
const EXPLICIT_PATTERN = /([^\s，,、]{1,10}?)欠\s*([0-9]+(?:\.[0-9]+)?)/g;
const OWES_PATTERN = /([^\s，,、]{1,10}?)(?:欠|要還|該給)/g;
const PAYS_FOR_PATTERN = /幫\s*([^\s，,、]{1,10}?)\s*付/g;
const SELF_WORDS = new Set(["我", "我先付", "自己"]);

function participantCount(text: string): number {
  const match = COUNT_PATTERN.exec(text);
  if (!match) return 2;
  const token = match[1] ?? "";
  const chinese = CHINESE_DIGITS.get(token);
  return chinese ?? Number(token);
}

function extractNames(text: string): string[] {
  const names = new Set<string>();
  for (const pattern of [OWES_PATTERN, PAYS_FOR_PATTERN]) {
    pattern.lastIndex = 0;
    let match = pattern.exec(text);
    while (match) {
      const name = (match[1] ?? "").trim();
      if (name && !SELF_WORDS.has(name) && !/^[0-9.]+$/.test(name)) names.add(name);
      match = pattern.exec(text);
    }
  }
  return [...names];
}

export function parseShare(text: string, total: string): ShareResult {
  EXPLICIT_PATTERN.lastIndex = 0;
  const explicit: { name: string; amount: string }[] = [];
  let explicitMatch = EXPLICIT_PATTERN.exec(text);
  while (explicitMatch) {
    const name = (explicitMatch[1] ?? "").trim();
    const amount = explicitMatch[2] ?? "";
    if (name && !SELF_WORDS.has(name)) explicit.push({ name, amount });
    explicitMatch = EXPLICIT_PATTERN.exec(text);
  }
  if (explicit.length > 0) return { kind: "explicit", shares: explicit };

  if (!HALF_PATTERN.test(text) && !COUNT_PATTERN.test(text)) return { kind: "none" };

  const participants = participantCount(text);
  const names = extractNames(text);
  const shares = new Decimal(total).dividedBy(participants);
  if (!shares.times(participants).equals(new Decimal(total)) || shares.decimalPlaces() > 0) {
    return { kind: "not_divisible", participants, names };
  }
  return { kind: "split", participants, names, share: shares.toString() };
}
```

名字抽取只認 `X欠`、`X要還`、`X該給`、`幫X付` 這四種明確寫法。抽不到名字時 `names` 為空陣列，由應用層追問——解析器不猜測誰是誰。

**不得為了讓多人平分的測試通過而擴大抽取範圍。** 逗號列舉（`小明，小華，三個人平分`）不在四種寫法之內：任何「把逗號分隔的詞當人名」的規則都會把 `現金支付`、`小明先走了` 這類片語收進 `names`，讓應用層誤以為已經取得分帳對象而不再追問。設計 §5.3 明定「名字數量少於 N−1 就追問」，空陣列是完全受支援的路徑。

- [ ] **Step 4：執行測試確認通過**

Run: `pnpm vitest run tests/parser/split-share.test.ts`
Expected: PASS，8 個測試。

- [ ] **Step 5：提交**

```bash
git add src/parser/split-share.ts tests/parser/split-share.test.ts
git commit -m "feat: parse deterministic expense sharing phrases"
```

---

### Task 2：帳務形狀與代墊不變條件

**Files:**

- Modify: `src/domain/ledger.ts`
- Test: `tests/domain/ledger.test.ts`

**Interfaces:**

- Consumes: 無。
- Produces：`AllocationSchema` 新增可選的 `recoversAllocationId`；`supportedAccountingShapes` 新增 `outflow:advance`、`none:advance`、`inflow:advance_recovery`；`validateAllocations` 新增兩條規則。

- [ ] **Step 1：寫失敗測試（追加於既有檔案）**

```ts
const advanceBase = {
  ownerId: "owner-1",
  requestId: "request-1",
  sourceEventId: "event-1",
  draftId: "draft-1",
  occurredDate: "2026-09-24",
  status: "awaiting_confirmation" as const,
};

it("accepts a cash advance alongside the personal share", () => {
  const draft = TransactionDraftSchema.parse({
    ...advanceBase,
    amount: { amount: "1260", currency: "TWD" },
    allocations: [
      {
        allocationId: "mine",
        fundsEffect: "outflow",
        purpose: "expense",
        amount: { amount: "630", currency: "TWD" },
        category: "餐飲",
      },
      {
        allocationId: "theirs",
        fundsEffect: "outflow",
        purpose: "advance",
        amount: { amount: "630", currency: "TWD" },
        category: "餐飲",
        counterpartyId: "counterparty-1",
      },
    ],
  });

  expect(draft.allocations).toHaveLength(2);
});

it("accepts a credit card advance", () => {
  expect(() =>
    TransactionDraftSchema.parse({
      ...advanceBase,
      amount: { amount: "600", currency: "TWD" },
      allocations: [
        {
          allocationId: "theirs",
          fundsEffect: "none",
          purpose: "advance",
          amount: { amount: "600", currency: "TWD" },
          category: "餐飲",
          counterpartyId: "counterparty-1",
        },
      ],
      accountFromId: "card-1",
    }),
  ).not.toThrow();
});

it("rejects an advance without a counterparty", () => {
  expect(() =>
    TransactionDraftSchema.parse({
      ...advanceBase,
      amount: { amount: "630", currency: "TWD" },
      allocations: [
        {
          allocationId: "theirs",
          fundsEffect: "outflow",
          purpose: "advance",
          amount: { amount: "630", currency: "TWD" },
          category: "餐飲",
        },
      ],
    }),
  ).toThrow();
});

it("accepts a recovery that points at an advance allocation", () => {
  expect(() =>
    TransactionDraftSchema.parse({
      ...advanceBase,
      amount: { amount: "300", currency: "TWD" },
      allocations: [
        {
          allocationId: "recovery",
          fundsEffect: "inflow",
          purpose: "advance_recovery",
          amount: { amount: "300", currency: "TWD" },
          category: "餐飲",
          counterpartyId: "counterparty-1",
          recoversAllocationId: "theirs",
        },
      ],
    }),
  ).not.toThrow();
});

it("rejects a recovery reference on a non recovery allocation", () => {
  expect(() =>
    TransactionDraftSchema.parse({
      ...advanceBase,
      amount: { amount: "300", currency: "TWD" },
      allocations: [
        {
          allocationId: "mine",
          fundsEffect: "outflow",
          purpose: "expense",
          amount: { amount: "300", currency: "TWD" },
          category: "餐飲",
          recoversAllocationId: "theirs",
        },
      ],
    }),
  ).toThrow();
});
```

- [ ] **Step 2：執行測試確認失敗**

Run: `pnpm vitest run tests/domain/ledger.test.ts`
Expected: FAIL，代墊形狀不在白名單、`recoversAllocationId` 不是已知欄位。

- [ ] **Step 3：實作**

在 `AllocationSchema` 加入欄位：

```ts
  counterpartyId: z.string().min(1).optional(),
  recoversAllocationId: z.string().min(1).optional(),
```

白名單加入三種形狀：

```ts
const supportedAccountingShapes = new Set([
  "inflow:income",
  "outflow:expense",
  "none:expense",
  "internal:transfer",
  "outflow:transfer",
  "inflow:refund",
  "none:refund",
  "outflow:fee",
  "outflow:advance",
  "none:advance",
  "inflow:advance_recovery",
]);
```

`validateAllocations` 追加兩條規則：

```ts
  for (const [index, allocation] of value.allocations.entries()) {
    if (allocation.purpose === "advance" && !allocation.counterpartyId) {
      context.addIssue({
        code: "custom",
        message: "advance allocation requires a counterparty",
        path: ["allocations", index, "counterpartyId"],
      });
    }
    if (allocation.recoversAllocationId && allocation.purpose !== "advance_recovery") {
      context.addIssue({
        code: "custom",
        message: "only an advance recovery may reference an advance allocation",
        path: ["allocations", index, "recoversAllocationId"],
      });
    }
  }
```

- [ ] **Step 4：執行測試確認通過**

Run: `pnpm vitest run tests/domain tests/parser tests/application tests/telegram`
Expected: PASS。既有 M2、M3a 行為不得改變。

- [ ] **Step 5：提交**

```bash
git add src/domain/ledger.ts tests/domain/ledger.test.ts
git commit -m "feat: validate advance and recovery accounting shapes"
```

---

### Task 3：代墊領域運算

**Files:**

- Create: `src/domain/advance.ts`
- Test: `tests/domain/advance.test.ts`

**Interfaces:**

- Consumes: Task 2 的 `Allocation`。
- Produces：

```ts
export interface OutstandingAdvance {
  readonly allocationId: string;
  readonly transactionId: string;
  readonly occurredDate: string;
  readonly counterpartyId: string;
  readonly categoryId?: string;
  readonly category: string;
  readonly subcategory?: string;
  readonly amount: string;
  readonly recovered: string;
  readonly outstanding: string;
}

export interface AdvanceRow {
  readonly allocationId: string;
  readonly transactionId: string;
  readonly occurredDate: string;
  readonly counterpartyId: string;
  readonly categoryId?: string;
  readonly category: string;
  readonly subcategory?: string;
  readonly amount: string;
}

export interface RecoveryRow {
  readonly recoversAllocationId: string;
  readonly amount: string;
}

export function computeOutstanding(
  advances: readonly AdvanceRow[],
  recoveries: readonly RecoveryRow[],
): OutstandingAdvance[];

export interface RecoveryPlanItem {
  readonly advance: OutstandingAdvance;
  readonly amount: string;
}

export interface RecoveryPlan {
  readonly items: readonly RecoveryPlanItem[];
  readonly surplus: string;
}

export function planRecovery(
  advances: readonly OutstandingAdvance[],
  received: string,
): RecoveryPlan;

export function splitForAbandonment(
  allocations: readonly Allocation[],
  allocationId: string,
  recovered: string,
  newAllocationId: string,
): Allocation[];
```

`computeOutstanding` 只回傳餘額大於 0 的項目，並依日期由舊到新排序。`planRecovery` 以先進先出分配，`surplus` 為未能沖抵的餘額（`"0"` 表示沒有）。

- [ ] **Step 1：寫失敗測試**

```ts
import { describe, expect, it } from "vitest";

import {
  computeOutstanding,
  planRecovery,
  splitForAbandonment,
  type AdvanceRow,
} from "../../src/domain/advance.js";

const rows: AdvanceRow[] = [
  {
    allocationId: "A1",
    transactionId: "T1",
    occurredDate: "2026-03-01",
    counterpartyId: "jia",
    category: "餐飲",
    amount: "100",
  },
  {
    allocationId: "A2",
    transactionId: "T2",
    occurredDate: "2026-03-05",
    counterpartyId: "jia",
    category: "餐飲",
    amount: "200",
  },
];

describe("computeOutstanding", () => {
  it("subtracts recoveries from each advance", () => {
    const result = computeOutstanding(rows, [{ recoversAllocationId: "A1", amount: "40" }]);

    expect(result.map((item) => [item.allocationId, item.outstanding])).toEqual([
      ["A1", "60"],
      ["A2", "200"],
    ]);
  });

  it("drops fully recovered advances", () => {
    const result = computeOutstanding(rows, [{ recoversAllocationId: "A1", amount: "100" }]);

    expect(result.map((item) => item.allocationId)).toEqual(["A2"]);
  });

  it("sorts oldest first", () => {
    const result = computeOutstanding([rows[1]!, rows[0]!], []);

    expect(result.map((item) => item.allocationId)).toEqual(["A1", "A2"]);
  });
});

describe("planRecovery", () => {
  it("allocates one payment across several advances oldest first", () => {
    const outstanding = computeOutstanding(rows, []);

    const plan = planRecovery(outstanding, "300");

    expect(plan.items.map((item) => [item.advance.allocationId, item.amount])).toEqual([
      ["A1", "100"],
      ["A2", "200"],
    ]);
    expect(plan.surplus).toBe("0");
  });

  it("stops when the payment runs out", () => {
    const outstanding = computeOutstanding(rows, []);

    const plan = planRecovery(outstanding, "150");

    expect(plan.items.map((item) => [item.advance.allocationId, item.amount])).toEqual([
      ["A1", "100"],
      ["A2", "50"],
    ]);
    expect(plan.surplus).toBe("0");
  });

  it("reports the surplus when the payment exceeds every advance", () => {
    const outstanding = computeOutstanding([rows[1]!], []);

    const plan = planRecovery(outstanding, "700");

    expect(plan.items.map((item) => item.amount)).toEqual(["200"]);
    expect(plan.surplus).toBe("500");
  });
});

describe("splitForAbandonment", () => {
  const allocations = [
    {
      allocationId: "mine",
      fundsEffect: "outflow" as const,
      purpose: "expense" as const,
      amount: { amount: "630", currency: "TWD" as const },
      category: "餐飲",
    },
    {
      allocationId: "theirs",
      fundsEffect: "outflow" as const,
      purpose: "advance" as const,
      amount: { amount: "630", currency: "TWD" as const },
      category: "餐飲",
      counterpartyId: "friend",
    },
  ];

  it("splits a partially recovered advance into advance and expense", () => {
    const result = splitForAbandonment(allocations, "theirs", "300", "abandoned");

    expect(result).toHaveLength(3);
    expect(result.find((item) => item.allocationId === "theirs")?.amount.amount).toBe("300");
    const abandoned = result.find((item) => item.allocationId === "abandoned");
    expect(abandoned).toMatchObject({
      purpose: "expense",
      fundsEffect: "outflow",
      category: "餐飲",
      counterpartyId: "friend",
    });
    expect(abandoned?.amount.amount).toBe("330");
  });

  it("converts the whole allocation when nothing was recovered", () => {
    const result = splitForAbandonment(allocations, "theirs", "0", "abandoned");

    expect(result).toHaveLength(2);
    expect(result.find((item) => item.allocationId === "theirs")).toMatchObject({
      purpose: "expense",
      amount: { amount: "630" },
    });
    expect(result.some((item) => item.allocationId === "abandoned")).toBe(false);
  });

  it("refuses to abandon an allocation that is fully recovered", () => {
    expect(() => splitForAbandonment(allocations, "theirs", "630", "abandoned")).toThrow();
  });
});
```

- [ ] **Step 2：執行測試確認失敗**

Run: `pnpm vitest run tests/domain/advance.test.ts`
Expected: FAIL，找不到模組 `src/domain/advance.js`。

- [ ] **Step 3：實作**

```ts
import { Decimal } from "decimal.js";

import type { Allocation } from "./ledger.js";

export function computeOutstanding(
  advances: readonly AdvanceRow[],
  recoveries: readonly RecoveryRow[],
): OutstandingAdvance[] {
  const recovered = new Map<string, Decimal>();
  for (const row of recoveries) {
    const current = recovered.get(row.recoversAllocationId) ?? new Decimal(0);
    recovered.set(row.recoversAllocationId, current.plus(row.amount));
  }

  return advances
    .map((advance) => {
      const paid = recovered.get(advance.allocationId) ?? new Decimal(0);
      const outstanding = new Decimal(advance.amount).minus(paid);
      return { ...advance, recovered: paid.toString(), outstanding: outstanding.toString() };
    })
    .filter((item) => new Decimal(item.outstanding).greaterThan(0))
    .sort(
      (left, right) =>
        left.occurredDate.localeCompare(right.occurredDate) ||
        left.allocationId.localeCompare(right.allocationId),
    );
}

export function planRecovery(
  advances: readonly OutstandingAdvance[],
  received: string,
): RecoveryPlan {
  let remaining = new Decimal(received);
  const items: RecoveryPlanItem[] = [];

  for (const advance of advances) {
    if (!remaining.greaterThan(0)) break;
    const outstanding = new Decimal(advance.outstanding);
    const applied = Decimal.min(outstanding, remaining);
    items.push({ advance, amount: applied.toString() });
    remaining = remaining.minus(applied);
  }

  return { items, surplus: remaining.toString() };
}

export function splitForAbandonment(
  allocations: readonly Allocation[],
  allocationId: string,
  recovered: string,
  newAllocationId: string,
): Allocation[] {
  const target = allocations.find((item) => item.allocationId === allocationId);
  if (!target || target.purpose !== "advance") throw new Error("advance allocation not found");

  const total = new Decimal(target.amount.amount);
  const paid = new Decimal(recovered);
  const abandoned = total.minus(paid);
  if (!abandoned.greaterThan(0)) throw new Error("nothing left to abandon");

  // 尚未回收任何金額：整筆轉為個人消費。拆分會讓代墊金額變成 0，違反金額必須為正。
  if (!paid.greaterThan(0)) {
    return allocations.map((item) =>
      item.allocationId === allocationId ? { ...item, purpose: "expense" as const } : item,
    );
  }

  return allocations.flatMap((item) => {
    if (item.allocationId !== allocationId) return [item];
    return [
      { ...item, amount: { ...item.amount, amount: paid.toString() } },
      {
        ...item,
        allocationId: newAllocationId,
        purpose: "expense" as const,
        amount: { ...item.amount, amount: abandoned.toString() },
      },
    ];
  });
}
```

- [ ] **Step 4：執行測試確認通過**

Run: `pnpm vitest run tests/domain/advance.test.ts`
Expected: PASS，9 個測試。

- [ ] **Step 5：提交**

```bash
git add src/domain/advance.ts tests/domain/advance.test.ts
git commit -m "feat: compute advance balances and recovery plans"
```

---

### Task 4：Migration 0005 與配置欄位持久化

**Files:**

- Create: `src/db/migrations/0005_advance_recovery.sql`
- Modify: `src/db/migrate.ts`、`src/db/sqlite-ledger-repository.ts`
- Test: `tests/db/migrate-advance-recovery.test.ts`

**Interfaces:**

- Consumes: Task 2 的 `recoversAllocationId`。
- Produces: schema version 5；`allocations.recovers_allocation_id` 的讀寫。

- [ ] **Step 1：寫失敗測試**

```ts
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { migrate } from "../../src/db/migrate.js";

function openMemoryDatabase(): Database.Database {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  migrate(database);
  return database;
}

describe("migration 0005", () => {
  it("adds the recovery reference column", () => {
    const database = openMemoryDatabase();

    const columns = database.pragma("table_info(allocations)") as { name: string }[];

    expect(columns.map((column) => column.name)).toContain("recovers_allocation_id");
    expect(database.pragma("foreign_key_check")).toEqual([]);
  });

  it("registers version 5 and stays idempotent", () => {
    const database = openMemoryDatabase();
    migrate(database);

    expect(database.prepare("SELECT version FROM schema_migrations ORDER BY version").all()).toEqual(
      [{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }],
    );
  });
});
```

同時在 `tests/db/sqlite-ledger-repository.test.ts` 追加往返測試：

```ts
it("round-trips the recovery reference on an allocation", async () => {
  const { repository, recoveryTransactionId } = await setupConfirmedAdvance();

  const transaction = await repository.getTransaction("owner-1", recoveryTransactionId);

  expect(transaction?.allocations[0]?.recoversAllocationId).toBe("advance-allocation");
});
```

`setupConfirmedAdvance` 建立一筆含代墊配置的已確認交易，再確認一筆帶 `recoversAllocationId` 的回收草稿，並回傳 `{ repository, recoveryTransactionId }`。

`confirmDraft` 的 `transaction_id` 一律由 `randomUUID()` 產生，沒有指定字面值的管道，因此測試必須使用實際回傳的 ID。**不要為了測試在 `confirmDraft` 開可注入 ID 的後門**，也不要繞過 repository 直接寫 SQL——後者會讓這個測試失去意義（它要驗證的正是 `replaceAllocations` 的寫入與讀取）。

代墊配置必須有 `counterpartyId`（Task 2 的不變條件），而該欄位是外鍵，因此 `setupConfirmedAdvance` 需要先插入一列 `counterparties`。

- [ ] **Step 2：執行測試確認失敗**

Run: `pnpm vitest run tests/db`
Expected: FAIL，`allocations` 沒有 `recovers_allocation_id` 欄位。

- [ ] **Step 3：實作**

`src/db/migrations/0005_advance_recovery.sql`：

```sql
ALTER TABLE allocations ADD COLUMN recovers_allocation_id TEXT REFERENCES allocations(allocation_id);

CREATE INDEX allocations_recovers_idx ON allocations(recovers_allocation_id);
CREATE INDEX allocations_purpose_idx ON allocations(purpose);
```

`migrate.ts` 的 `migrations` 陣列加入：

```ts
  { version: 5, url: new URL("./migrations/0005_advance_recovery.sql", import.meta.url) },
```

`sqlite-ledger-repository.ts` 的 `replaceAllocations` INSERT 補上欄位：

```ts
      "INSERT INTO allocations (allocation_id, transaction_id, funds_effect, purpose, amount, currency, category_id, category_snapshot, subcategory_snapshot, counterparty_id, note, recovers_allocation_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
```

並在參數尾端加上 `item.recoversAllocationId ?? null`。`AllocationRow` 介面新增 `recovers_allocation_id: string | null`，讀取交易時映射：

```ts
        ...(item.recovers_allocation_id
          ? { recoversAllocationId: item.recovers_allocation_id }
          : {}),
```

既有 migration 測試中列舉版本的斷言要一併更新為包含 `{ version: 5 }`（`tests/db/migrate-conversation-state.test.ts`、`tests/db/migrate-accounting-core.test.ts`、`tests/smoke/runtime.test.ts`）。

- [ ] **Step 4：執行測試確認通過**

Run: `pnpm vitest run`
Expected: PASS。

- [ ] **Step 5：提交**

```bash
git add src/db/migrations/0005_advance_recovery.sql src/db/migrate.ts src/db/sqlite-ledger-repository.ts tests/db tests/smoke/runtime.test.ts
git commit -m "feat: persist advance recovery references"
```

---

### Task 5：代墊查詢與刪除保護

**Files:**

- Modify: `src/ports/ledger-repository.ts`、`src/db/sqlite-ledger-repository.ts`、`tests/support/fake-ledger-repository.ts`
- Test: `tests/db/sqlite-advances.test.ts`

**Interfaces:**

- Consumes: Task 3 的 `AdvanceRow`、`RecoveryRow`。
- Produces（加入 `LedgerRepository`）：

```ts
listAdvanceRows(ownerId: string): Promise<AdvanceRow[]>;
listRecoveryRows(ownerId: string): Promise<RecoveryRow[]>;
countRecoveriesForTransaction(ownerId: string, transactionId: string): Promise<number>;
```

金額一律以字串回傳，不在 SQL 聚合。`softDeleteTransaction` 在偵測到該交易的代墊配置仍被回收指向時拋出 `advance still has recoveries`。

- [ ] **Step 1：寫失敗測試**

```ts
describe("advance queries", () => {
  it("lists advance rows with their reference data", async () => {
    const { repository } = await setupAdvanceLedger();

    const rows = await repository.listAdvanceRows("owner-1");

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      allocationId: "advance-allocation",
      counterpartyId: "counterparty-1",
      amount: "630",
      occurredDate: "2026-09-24",
    });
  });

  it("lists recovery rows as raw amounts", async () => {
    const { repository } = await setupAdvanceLedgerWithRecovery("300");

    const rows = await repository.listRecoveryRows("owner-1");

    expect(rows).toEqual([{ recoversAllocationId: "advance-allocation", amount: "300" }]);
  });

  it("excludes deleted transactions from both queries", async () => {
    const { repository } = await setupAdvanceLedgerWithDeletedRecovery("300");

    expect(await repository.listRecoveryRows("owner-1")).toEqual([]);
  });

  it("refuses to delete an advance transaction that still has recoveries", async () => {
    const { repository, command } = await setupAdvanceLedgerWithRecovery("300");

    // better-sqlite3 是同步的，execute.immediate() 在 Promise.resolve() 包裝之前就拋錯，
    // 因此要用同步斷言。既有測試對 softDeleteTransaction 的其他保護也是這樣寫。
    expect(() => repository.softDeleteTransaction(command)).toThrow(
      "advance still has recoveries",
    );
  });

  it("counts recoveries pointing at a transaction", async () => {
    const { repository } = await setupAdvanceLedgerWithRecovery("300");

    expect(await repository.countRecoveriesForTransaction("owner-1", "advance-transaction")).toBe(
      1,
    );
  });
});
```

- [ ] **Step 2：執行測試確認失敗**

Run: `pnpm vitest run tests/db/sqlite-advances.test.ts`
Expected: FAIL，`repository.listAdvanceRows` 不是函式。

- [ ] **Step 3：實作**

```ts
  public listAdvanceRows(ownerId: string): Promise<AdvanceRow[]> {
    const rows = this.database
      .prepare(
        `SELECT a.allocation_id, a.transaction_id, t.occurred_date, a.counterparty_id,
          a.category_id, a.category_snapshot, a.subcategory_snapshot, a.amount
       FROM allocations a
       JOIN transactions t ON t.transaction_id = a.transaction_id
       WHERE t.owner_id = ? AND t.status = 'confirmed' AND a.purpose = 'advance'
       ORDER BY t.occurred_date, a.rowid`,
      )
      .all(ownerId) as AdvanceRowRecord[];
    return Promise.resolve(
      rows.map((row) => ({
        allocationId: row.allocation_id,
        transactionId: row.transaction_id,
        occurredDate: row.occurred_date,
        counterpartyId: row.counterparty_id ?? "",
        ...(row.category_id ? { categoryId: row.category_id } : {}),
        category: row.category_snapshot,
        ...(row.subcategory_snapshot ? { subcategory: row.subcategory_snapshot } : {}),
        amount: row.amount,
      })),
    );
  }

  public listRecoveryRows(ownerId: string): Promise<RecoveryRow[]> {
    const rows = this.database
      .prepare(
        `SELECT a.recovers_allocation_id, a.amount
       FROM allocations a
       JOIN transactions t ON t.transaction_id = a.transaction_id
       WHERE t.owner_id = ? AND t.status = 'confirmed'
         AND a.purpose = 'advance_recovery' AND a.recovers_allocation_id IS NOT NULL`,
      )
      .all(ownerId) as { recovers_allocation_id: string; amount: string }[];
    return Promise.resolve(
      rows.map((row) => ({
        recoversAllocationId: row.recovers_allocation_id,
        amount: row.amount,
      })),
    );
  }

  public countRecoveriesForTransaction(ownerId: string, transactionId: string): Promise<number> {
    const row = this.database
      .prepare(
        `SELECT count(*) AS total
       FROM allocations r
       JOIN transactions rt ON rt.transaction_id = r.transaction_id
       WHERE rt.owner_id = ? AND rt.status = 'confirmed'
         AND r.recovers_allocation_id IN (
           SELECT allocation_id FROM allocations WHERE transaction_id = ?
         )`,
      )
      .get(ownerId, transactionId) as { total: number };
    return Promise.resolve(row.total);
  }
```

`softDeleteTransaction` 在 `requireMutable` 之後、寫入之前加入保護：

```ts
      const recoveries = this.database
        .prepare(
          `SELECT count(*) AS total
         FROM allocations r
         JOIN transactions rt ON rt.transaction_id = r.transaction_id
         WHERE rt.status = 'confirmed' AND r.recovers_allocation_id IN (
           SELECT allocation_id FROM allocations WHERE transaction_id = ?
         )`,
        )
        .get(command.transactionId) as { total: number };
      if (recoveries.total > 0) throw new Error("advance still has recoveries");
```

`FakeLedgerRepository` 以相同語意實作三個方法：掃描 `this.transactions` 中狀態為 `confirmed` 的交易配置即可。

- [ ] **Step 4：執行測試確認通過**

Run: `pnpm vitest run`
Expected: PASS。

- [ ] **Step 5：提交**

```bash
git add src/ports/ledger-repository.ts src/db/sqlite-ledger-repository.ts tests/support/fake-ledger-repository.ts tests/db/sqlite-advances.test.ts
git commit -m "feat: query advances and guard their deletion"
```

---

### Task 6：交易對象參照

**Files:**

- Modify: `src/ports/reference-repository.ts`、`src/db/sqlite-reference-repository.ts`、`src/application/reference-data.ts`、`tests/support/fake-reference-repository.ts`
- Test: `tests/db/sqlite-reference-repository.test.ts`

**Interfaces:**

- Consumes: 既有 `upsertCounterparty`。
- Produces: `listActiveCounterparties(ownerId): Promise<Counterparty[]>`；`ReferenceSnapshot` 新增 `counterparties: readonly Counterparty[]`。

- [ ] **Step 1：寫失敗測試（追加於既有檔案）**

```ts
it("lists active counterparties", async () => {
  const { repository } = setup();
  await repository.upsertCounterparty({
    referenceId: "counterparty-1",
    ownerId: "owner-1",
    name: "小明",
  });

  const counterparties = await repository.listActiveCounterparties("owner-1");

  expect(counterparties.map((item) => item.name)).toEqual(["小明"]);
});
```

- [ ] **Step 2：執行測試確認失敗**

Run: `pnpm vitest run tests/db/sqlite-reference-repository.test.ts`
Expected: FAIL，`listActiveCounterparties` 不是函式。

- [ ] **Step 3：實作**

```ts
  public listActiveCounterparties(ownerId: string): Promise<Counterparty[]> {
    const rows = this.database
      .prepare(
        "SELECT counterparty_id, owner_id, name, active FROM counterparties WHERE owner_id = ? AND active = 1 ORDER BY name",
      )
      .all(ownerId) as { counterparty_id: string; owner_id: string; name: string; active: number }[];
    return Promise.resolve(
      rows.map((row) =>
        CounterpartySchema.parse({
          counterpartyId: row.counterparty_id,
          ownerId: row.owner_id,
          name: row.name,
          active: row.active === 1,
        }),
      ),
    );
  }
```

`loadReferenceSnapshot` 一併載入：

```ts
  const [accounts, categories, merchants, counterparties] = await Promise.all([
    repository.listActiveAccounts(ownerId),
    repository.listActiveCategories(ownerId),
    repository.listActiveMerchants(ownerId),
    repository.listActiveCounterparties(ownerId),
  ]);
  return { accounts, categories, merchants, counterparties };
```

`ReferenceSnapshot` 介面同步新增 `counterparties`。`FakeReferenceRepository` 加入 `counterparties: Counterparty[]` 陣列與對應方法。

- [ ] **Step 4：執行測試確認通過**

Run: `pnpm vitest run`
Expected: PASS。

- [ ] **Step 5：提交**

```bash
git add src/ports/reference-repository.ts src/db/sqlite-reference-repository.ts src/application/reference-data.ts tests/support/fake-reference-repository.ts tests/db/sqlite-reference-repository.test.ts
git commit -m "feat: expose counterparties in the reference snapshot"
```

---

### Task 7：追問欄位擴充

**Files:**

- Modify: `src/domain/draft.ts`、`src/application/answer-draft.ts`
- Modify: `src/telegram/callback-data.ts`、`src/telegram/format-prompt.ts`（僅補窮盡對應表，見下方說明）
- Test: `tests/domain/draft.test.ts`、`tests/application/answer-draft.test.ts`

**為什麼要動兩個 telegram 檔案：** `ParseField` 有兩處窮盡對應表——`callback-data.ts` 的 `fieldCodes: Record<ParseField, string>` 與 `format-prompt.ts` 的 `fieldLabels`。新增 enum 值卻不補這兩張表，typecheck、lint 與 build 會立刻失敗，分支在後續任務期間一直是紅的。本任務只補最小條目讓專案保持綠燈，**追問訊息的行為留給 Task 9**：

```ts
// src/telegram/callback-data.ts
const fieldCodes: Record<ParseField, string> = {
  amount: "amt",
  category: "cat",
  account: "acc",
  refundTarget: "ref",
  purpose: "pur",
  counterparty: "cpy",
  advanceShare: "shr",
};
```

```ts
// src/telegram/format-prompt.ts
const fieldLabels = {
  amount: "金額",
  category: "分類",
  account: "帳戶",
  refundTarget: "退款原交易",
  purpose: "用途",
  counterparty: "交易對象",
  advanceShare: "代墊金額",
} as const;
```

**Interfaces:**

- Consumes: Task 2、Task 6。
- Produces：
  - `ParseFieldSchema` 新增 `"counterparty"` 與 `"advanceShare"`。
  - `PendingFieldSchema` 新增可選的 `proposedName: string`。
  - `DraftPatch` 新增 `counterpartyId?: string`、`advanceShare?: Money`。
  - `completeDraft` 能把交易對象填入所有缺 `counterpartyId` 的代墊配置，並以 `advanceShare` 設定代墊金額並重算個人負擔。

- [ ] **Step 1：寫失敗測試**

```ts
it("fills the counterparty into every advance allocation that lacks one", () => {
  const draft = IncompleteDraftSchema.parse({
    ...incompleteLunchDraft(),
    pendingFields: [{ field: "counterparty", candidateIds: [], proposedName: "小明" }],
    partial: {
      occurredDate: "2026-09-24",
      rawSegment: "聚餐 1260，小明欠一半",
      allocations: [
        {
          allocationId: "mine",
          fundsEffect: "outflow",
          purpose: "expense",
          amount: { amount: "630", currency: "TWD" },
          category: "餐飲",
        },
        {
          allocationId: "theirs",
          fundsEffect: "outflow",
          purpose: "advance",
          amount: { amount: "630", currency: "TWD" },
          category: "餐飲",
        },
      ],
    },
  });

  const result = completeDraft(draft, { counterpartyId: "counterparty-1" });

  expect(result.kind).toBe("draft");
  if (result.kind !== "draft") return;
  expect(result.draft.allocations[1]?.counterpartyId).toBe("counterparty-1");
  expect(result.draft.allocations[0]?.counterpartyId).toBeUndefined();
});

it("sets the advance share and rebalances the personal share", () => {
  const draft = IncompleteDraftSchema.parse({
    ...incompleteLunchDraft(),
    pendingFields: [{ field: "advanceShare", candidateIds: [] }],
    partial: {
      occurredDate: "2026-09-24",
      rawSegment: "聚餐 1000，三個人平分",
      allocations: [
        {
          allocationId: "mine",
          fundsEffect: "outflow",
          purpose: "expense",
          amount: { amount: "1000", currency: "TWD" },
          category: "餐飲",
        },
        {
          allocationId: "theirs",
          fundsEffect: "outflow",
          purpose: "advance",
          category: "餐飲",
          counterpartyId: "counterparty-1",
        },
      ],
    },
  });

  const result = completeDraft(draft, { advanceShare: money("667", "TWD") });

  expect(result.kind).toBe("draft");
  if (result.kind !== "draft") return;
  expect(result.draft.amount.amount).toBe("1000");
  expect(result.draft.allocations[0]?.amount.amount).toBe("333");
  expect(result.draft.allocations[1]?.amount.amount).toBe("667");
});
```

- [ ] **Step 2：執行測試確認失敗**

Run: `pnpm vitest run tests/domain/draft.test.ts`
Expected: FAIL，`counterparty` 不是合法的 `ParseField`。

- [ ] **Step 3：實作**

`ParseFieldSchema` 與 `PendingFieldSchema`：

```ts
export const ParseFieldSchema = z.enum([
  "amount",
  "category",
  "account",
  "refundTarget",
  "purpose",
  "counterparty",
  "advanceShare",
]);

export const PendingFieldSchema = z.object({
  field: ParseFieldSchema,
  candidateIds: z.array(z.string().min(1)).default([]),
  proposedName: z.string().trim().min(1).max(100).optional(),
});
```

`DraftPatch` 與 `applyPatch`：

```ts
export interface DraftPatch {
  readonly amount?: Money;
  readonly categoryId?: string;
  readonly category?: string;
  readonly accountFromId?: string;
  readonly counterpartyId?: string;
  readonly advanceShare?: Money;
}
```

`applyPatch` 追加兩段處理。交易對象只填入缺 `counterpartyId` 的**代墊**配置：

```ts
    if (patch.counterpartyId && next.purpose === "advance" && !next.counterpartyId) {
      next.counterpartyId = patch.counterpartyId;
    }
```

代墊金額在 `applyPatch` 之後單獨處理：代墊配置設為 `advanceShare`，個人負擔配置改為「交易總額 − 代墊合計」。交易總額取自 `partial.allocations` 原本的合計：

```ts
function applyAdvanceShare(partial: PartialDraft, share: Money): PartialDraft {
  const total = partial.allocations.reduce(
    (sum, allocation) => sum.plus(allocation.amount?.amount ?? "0"),
    new Decimal(0),
  );
  const allocations = partial.allocations.map((allocation) =>
    allocation.purpose === "advance" ? { ...allocation, amount: share } : allocation,
  );
  const advanceTotal = allocations
    .filter((allocation) => allocation.purpose === "advance")
    .reduce((sum, allocation) => sum.plus(allocation.amount?.amount ?? "0"), new Decimal(0));
  const personal = total.minus(advanceTotal);
  return {
    ...partial,
    allocations: allocations.map((allocation) =>
      allocation.purpose === "expense"
        ? { ...allocation, amount: { amount: personal.toString(), currency: "TWD" as const } }
        : allocation,
    ),
  };
}
```

`satisfied` 追加兩個欄位的判斷：

```ts
  if (field === "counterparty") return patch.counterpartyId !== undefined;
  if (field === "advanceShare") return patch.advanceShare !== undefined;
```

`answerDraft` 的 `patchFor` 追加分派：`field === "counterparty"` 時回傳 `{ counterpartyId: value.id }`；`field === "advanceShare"` 且值為金額時回傳 `{ advanceShare: money(...) }`。

- [ ] **Step 4：執行測試確認通過**

Run: `pnpm vitest run tests/domain tests/application`
Expected: PASS。

- [ ] **Step 5：提交**

在 `tests/application/answer-draft.test.ts` 追加兩個測試，覆蓋 `patchFor` 的新分派：

```ts
it("routes a counterparty answer to the counterparty patch", async () => {
  const { repository, dependencies } = await seedIncompleteAdvanceDraft();

  const result = await answerDraft(
    {
      ...amountAnswer,
      field: "counterparty",
      value: { kind: "reference", id: "counterparty-1", label: "小明" },
      rawText: "小明",
    },
    dependencies,
  );

  expect(result.kind).toBe("draft");
  const record = await repository.getDraftRecord({ draftId: "draft-1" });
  expect(record?.draft?.allocations[1]?.counterpartyId).toBe("counterparty-1");
});

it("rejects a non-numeric advance share", async () => {
  const { dependencies } = await seedIncompleteAdvanceDraft();

  const result = await answerDraft(
    {
      ...amountAnswer,
      field: "advanceShare",
      value: { kind: "amount", text: "一半" },
      rawText: "一半",
    },
    dependencies,
  );

  expect(result).toEqual({ kind: "invalid", reason: "amount_not_numeric" });
});
```

`seedIncompleteAdvanceDraft` 比照既有的 `seedIncompleteLunchDraft`，建立一筆含個人支出與代墊兩個配置、待補欄位為 counterparty 的不完整草稿。

```bash
git add src/domain/draft.ts src/application/answer-draft.ts src/telegram/callback-data.ts src/telegram/format-prompt.ts tests/domain/draft.test.ts tests/application/answer-draft.test.ts
git commit -m "feat: support counterparty and advance share follow-ups"
```

---

### Task 8：解析器產生代墊配置

**Files:**

- Modify: `src/parser/rule-parser.ts`
- Test: `tests/parser/advance-flows.test.ts`

**Interfaces:**

- Consumes: Task 1 `parseShare`、Task 6 的 `counterparties` 快照。
- Produces: `ParseContext` 新增 `counterparties?: readonly Counterparty[]` 與 `advanceAllocationIds?: readonly string[]`；支出路徑在偵測到分帳語句時產生代墊配置，或回報 `counterparty`／`advanceShare` 追問。

- [ ] **Step 1：寫失敗測試**

```ts
const context = {
  ownerId: "123",
  requestId: "request-1",
  sourceEventId: "event-1",
  draftId: "draft-1",
  allocationId: "allocation-1",
  advanceAllocationIds: ["advance-1", "advance-2"],
  today: "2026-09-24",
  counterparties: [
    { counterpartyId: "friend", ownerId: "123", name: "朋友", active: true },
  ],
  categories: [
    {
      categoryId: "category-dining",
      ownerId: "123",
      key: "expense_dining_lunch",
      name: "餐飲",
      kind: "expense" as const,
      parentId: "category-expense",
      depth: 2 as const,
      active: true,
    },
  ],
};

describe("advance parsing", () => {
  it("splits a known counterparty's half into an advance allocation", () => {
    const result = parseTransaction("午餐 1260，朋友欠一半", context);

    expect(result.kind).toBe("draft");
    if (result.kind !== "draft") return;
    expect(result.draft.amount.amount).toBe("1260");
    expect(result.draft.allocations).toHaveLength(2);
    expect(result.draft.allocations[0]).toMatchObject({ purpose: "expense" });
    expect(result.draft.allocations[0]?.amount.amount).toBe("630");
    expect(result.draft.allocations[1]).toMatchObject({
      purpose: "advance",
      fundsEffect: "outflow",
      counterpartyId: "friend",
    });
    expect(result.draft.allocations[1]?.amount.amount).toBe("630");
  });

  it("asks for the counterparty when the name is unknown", () => {
    const result = parseTransaction("午餐 1260，小明欠一半", context);

    expect(result.kind).toBe("missing_fields");
    if (result.kind !== "missing_fields") return;
    expect(result.fields).toEqual(["counterparty"]);
    expect(result.partial.allocations).toHaveLength(2);
    expect(result.partial.allocations[1]?.purpose).toBe("advance");
  });

  it("asks for the advance amount when the split does not divide exactly", () => {
    const result = parseTransaction("午餐 1000，三個人平分", context);

    expect(result.kind).toBe("missing_fields");
    if (result.kind !== "missing_fields") return;
    expect(result.fields).toEqual(["advanceShare"]);
  });

  it("marks a credit card advance as not affecting available funds", () => {
    const result = parseTransaction("午餐 1260 國泰卡，朋友欠一半", {
      ...context,
      accounts: [
        {
          accountId: "cathay-card",
          ownerId: "123",
          name: "國泰卡",
          type: "credit_card" as const,
          currency: "TWD" as const,
          active: true,
        },
      ],
    });

    expect(result.kind).toBe("draft");
    if (result.kind !== "draft") return;
    expect(result.draft.allocations.map((item) => item.fundsEffect)).toEqual(["none", "none"]);
  });

  it("leaves sentences without a sharing phrase unchanged", () => {
    const result = parseTransaction("午餐 120", context);

    expect(result.kind).toBe("draft");
    if (result.kind !== "draft") return;
    expect(result.draft.allocations).toHaveLength(1);
  });
});
```

- [ ] **Step 2：執行測試確認失敗**

Run: `pnpm vitest run tests/parser/advance-flows.test.ts`
Expected: FAIL，代墊配置沒有產生。

- [ ] **Step 3：實作**

**不等額分帳必須在 `amounts.length !== 1` 關卡之前處理。** `午餐 1260，小明欠 630` 有兩個數字，會被 M1 起就存在的金額關卡攔下，因此 `explicit` 分支在關卡之後永遠不可達。條件嚴格限縮為「數字總數 = 明確金額數量 + 1」，其餘情形不接手：

```ts
  // 不等額分帳是唯一能表達「每人負擔不同」的輸入方式，必須在金額關卡之前攔截。
  // 條件嚴格限縮：只有數字數量剛好等於「總額 + 每筆明確代墊」時才接手，
  // 「午餐 120 另加 30」這類仍然交回既有關卡處理。
  const explicitShare = parseShare(text, amounts[0]?.value ?? "0");
  if (
    explicitShare.kind === "explicit" &&
    amounts.length === explicitShare.shares.length + 1
  ) {
    const total = money(amounts[0]?.value ?? "", "TWD");
    const shell = expenseShell(context, text, accounts[0], merchants[0], total)[0];
    if (!shell) return incomplete(context, text, ["category"]);

    const advances = explicitShare.shares.map((item, index) => ({
      ...shell,
      allocationId:
        context.advanceAllocationIds?.[index] ?? `${context.allocationId}-advance-${String(index)}`,
      purpose: "advance" as const,
      amount: money(item.amount, "TWD"),
      ...(matchingReferences(item.name, context.counterparties ?? [])[0]
        ? {
            counterpartyId: matchingReferences(item.name, context.counterparties ?? [])[0]
              ?.counterpartyId,
          }
        : {}),
    }));
    const advanceTotal = advances.reduce(
      (sum, item) => sum.plus(item.amount.amount),
      new Decimal(0),
    );
    const personal = new Decimal(total.amount).minus(advanceTotal);

    // 代墊合計超過總額：語句自相矛盾，改為追問代墊金額。
    if (personal.isNegative()) return incomplete(context, text, ["advanceShare"]);

    // 個人負擔為 0 代表整筆都是代墊，不產生金額為 0 的配置（違反金額必須為正）。
    const allocations = personal.greaterThan(0)
      ? [{ ...shell, amount: money(personal.toString(), "TWD") }, ...advances]
      : advances;

    if (advances.some((item) => !item.counterpartyId)) {
      return incomplete(context, text, ["counterparty"], { allocations });
    }
    return draft(context, text, allocations as Allocation[], {});
  }
```

在 `parseTransaction` 的支出草稿路徑（`expenseShell` 取得非空 shell 之後、回傳 `draft(...)` 之前）插入平分與除不盡的處理：

```ts
  const share = parseShare(text, amount.amount);
  if (share.kind !== "none") {
    const shell = expenseShell(context, text, account, merchant, amount)[0];
    if (!shell) return incomplete(context, text, ["category"], { ...references });

    if (share.kind === "not_divisible") {
      // 依人數產生 N−1 筆代墊 placeholder。只產生一筆會讓「三個人平分」補完金額後
      // 少算一個人的欠款，個人負擔也隨之多算——而且不會有任何測試抓到。
      const placeholders = Array.from({ length: share.participants - 1 }, (_, index) => ({
        ...shell,
        allocationId:
          context.advanceAllocationIds?.[index] ??
          `${context.allocationId}-advance-${String(index)}`,
        purpose: "advance" as const,
        ...(matchingReferences(share.names[index] ?? "", context.counterparties ?? [])[0]
          ? {
              counterpartyId: matchingReferences(
                share.names[index] ?? "",
                context.counterparties ?? [],
              )[0]?.counterpartyId,
            }
          : {}),
      }));
      return incomplete(context, text, ["advanceShare"], {
        allocations: [{ ...shell, amount }, ...placeholders],
        ...references,
      });
    }

    const requested =
      share.kind === "explicit"
        ? share.shares
        : share.names.map((name) => ({ name, amount: share.share }));
    const expected = share.kind === "explicit" ? requested.length : share.participants - 1;

    const resolved = requested.map((item) => ({
      ...item,
      counterparty: matchingReferences(item.name, context.counterparties ?? [])[0],
    }));

    const advances = resolved.map((item, index) => ({
      ...shell,
      allocationId: context.advanceAllocationIds?.[index] ?? `${context.allocationId}-advance-${String(index)}`,
      purpose: "advance" as const,
      amount: money(item.amount, "TWD"),
      ...(item.counterparty ? { counterpartyId: item.counterparty.counterpartyId } : {}),
    }));

    const advanceTotal = advances.reduce(
      (sum, item) => sum.plus(item.amount.amount),
      new Decimal(0),
    );
    const personal = new Decimal(amount.amount).minus(advanceTotal);
    const allocations = [
      { ...shell, amount: money(personal.toString(), "TWD") },
      ...advances,
    ];

    if (resolved.length < expected || advances.some((item) => !item.counterpartyId)) {
      return incomplete(context, text, ["counterparty"], { allocations, ...references });
    }
    return draft(context, text, allocations as Allocation[], references);
  }
```

`matchingReferences` 既有實作以 `text.includes(value.name)` 比對，此處傳入單一名字即可重用。`ParseContext` 新增：

```ts
  readonly counterparties?: readonly Counterparty[];
  readonly advanceAllocationIds?: readonly string[];
```

`create-batch.ts` 產生 context 時提供 `advanceAllocationIds`：預先以 `generateId()` 產生 4 個 ID（支援最多 4 位共同參與者，超過則由 fallback 字串命名），並把 `counterparties` 併入既有的參照展開。

- [ ] **Step 4：執行測試確認通過**

Run: `pnpm vitest run tests/parser tests/application tests/telegram`
Expected: PASS。既有語句行為不得改變。

- [ ] **Step 5：提交**

```bash
git add src/parser/rule-parser.ts src/application/create-batch.ts tests/parser/advance-flows.test.ts
git commit -m "feat: build advance allocations from sharing phrases"
```

---

### Task 9：交易對象追問與建立

**Files:**

- Modify: `src/telegram/format-prompt.ts`、`src/telegram/callback-data.ts`、`src/telegram/handlers/drafts.ts`
- Test: `tests/telegram/counterparty-prompt.test.ts`

**Interfaces:**

- Consumes: Task 7 的 `proposedName`、Task 6 的交易對象快照。
- Produces：
  - `formatPrompt` 對 `counterparty` 欄位產生既有對象按鈕；`proposedName` 存在時改為「建立『X』並繼續／取消」兩顆按鈕。
  - `CallbackAction` 新增 `{ kind: "create-counterparty"; draftRef: string }`，編碼為 `c:<draftRef>`。
  - 回覆追問訊息輸入文字時，若待補欄位是 `counterparty`，以該文字作為 `proposedName` 重新追問確認。

- [ ] **Step 1：寫失敗測試**

```ts
it("offers existing counterparties as buttons", async () => {
  const { bot, calls, referenceRepository } = createHarness();
  referenceRepository.counterparties.push({
    counterpartyId: "friend",
    ownerId: "123",
    name: "朋友",
    active: true,
  });
  seedDiningCategory(referenceRepository);

  await bot.handleUpdate(messageUpdate({ updateId: 1, text: "午餐 1260，小明欠一半" }));

  const prompt = getText(calls.at(-1));
  expect(prompt).toContain("待補交易對象");
  expect(JSON.stringify(calls.at(-1)?.payload)).toContain("朋友");
});

it("asks to create an unknown counterparty typed as a reply", async () => {
  const { bot, calls, referenceRepository } = createHarness();
  seedDiningCategory(referenceRepository);
  await bot.handleUpdate(messageUpdate({ updateId: 1, text: "午餐 1260，小明欠一半" }));
  const promptId = sentMessages(calls).length;

  await bot.handleUpdate(replyUpdate({ updateId: 2, text: "小明", replyToMessageId: promptId }));

  expect(getText(calls.at(-1))).toContain("尚未建立「小明」");
  expect(JSON.stringify(calls.at(-1)?.payload)).toContain('"c:');
});

it("creates the counterparty and completes the draft", async () => {
  const { bot, calls, repository, referenceRepository } = createHarness();
  seedDiningCategory(referenceRepository);
  await bot.handleUpdate(messageUpdate({ updateId: 1, text: "午餐 1260，小明欠一半" }));
  const promptId = sentMessages(calls).length;
  await bot.handleUpdate(replyUpdate({ updateId: 2, text: "小明", replyToMessageId: promptId }));
  const draftRef = firstDraftRef(repository);

  await bot.handleUpdate(callbackUpdate({ updateId: 3, data: `c:${draftRef}` }));

  expect(referenceRepository.counterparties.map((item) => item.name)).toContain("小明");
  const record = await repository.getDraftRecord({ ownerId: "123", draftRef });
  expect(record?.status).toBe("awaiting_confirmation");
  expect(record?.draft?.allocations[1]?.counterpartyId).toBeDefined();
});
```

- [ ] **Step 2：執行測試確認失敗**

Run: `pnpm vitest run tests/telegram/counterparty-prompt.test.ts`
Expected: FAIL，追問訊息沒有交易對象欄位。

- [ ] **Step 3：實作**

`callback-data.ts` 新增編解碼：

```ts
    case "create-counterparty":
      return guard(`c:${action.draftRef}`);
```

```ts
  if (prefix === "c" && first !== undefined) {
    if (!REF_PATTERN.test(first)) return null;
    return { kind: "create-counterparty", draftRef: first };
  }
```

`format-prompt.ts` 在 `fieldLabels` 加入 `counterparty: "交易對象"`、`advanceShare: "代墊金額"`，並在函式開頭處理 `proposedName`：

```ts
  if (pending.proposedName) {
    return {
      text: `尚未建立「${pending.proposedName}」這個交易對象，要建立嗎？`,
      replyMarkup: {
        inline_keyboard: [
          [
            {
              text: `建立「${pending.proposedName}」並繼續`,
              callback_data: encodeCallback({ kind: "create-counterparty", draftRef }),
            },
            { text: "取消", callback_data: `cancel:${draft.draftId}` },
          ],
        ],
      },
    };
  }
```

`advanceShare` 與 `amount` 一樣走文字回覆路徑（無鍵盤）。`counterparty` 欄位的候選來自 `references.counterparties`。

`handlers/drafts.ts` 的文字回覆路徑依待補欄位分派：`amount` 與 `advanceShare` 視為金額；`counterparty` 則把輸入文字當成 `proposedName` 寫回草稿並重發追問。`c:` callback 呼叫 `upsertCounterparty` 後，以新建立的 ID 呼叫 `applyAnswer`。

`create-batch.ts` 的 `candidatesFor` 需補上 `counterparty` 分支（候選為啟用中的交易對象），否則候選按鈕無法產生。

**`answerDraft` 不需要 `referenceRepository`。** 建立交易對象是在 `drafts.ts` 的 `create-counterparty` callback 裡完成的：先 `upsertCounterparty` 取得 ID，再把該 ID 當成一般的 reference 答案傳給 `applyAnswer`。讓應用層的 `answerDraft` 認識參照儲存庫只會多一條無人使用的依賴。

- [ ] **Step 4：執行測試確認通過**

Run: `pnpm vitest run tests/telegram`
Expected: PASS。

- [ ] **Step 5：提交**

```bash
git add src/telegram tests/telegram/counterparty-prompt.test.ts src/application/answer-draft.ts
git commit -m "feat: confirm and create counterparties during follow-up"
```

---

### Task 10：回收登記應用服務

**Files:**

- Create: `src/application/record-recovery.ts`
- Test: `tests/application/record-recovery.test.ts`

**Interfaces:**

- Consumes: Task 3 `computeOutstanding`、`planRecovery`；Task 5 的查詢方法。
- Produces：

```ts
export interface RecordRecoveryCommand {
  readonly ownerId: string;
  readonly counterpartyId: string;
  readonly received: string;
  readonly occurredDate: string;
  readonly telegramUpdateId: string;
  readonly sourceRef: string;
  readonly rawText: string;
  readonly receivedAt: string;
  readonly accountToId?: string;
}

export type RecordRecoveryResult =
  | { readonly kind: "draft"; readonly draft: TransactionDraft; readonly draftRef: string }
  | {
      readonly kind: "incomplete";
      readonly draft: IncompleteDraft;
      readonly draftRef: string;
      readonly surplus: string;
    }
  | { readonly kind: "no_outstanding" }
  | { readonly kind: "duplicate" };

export function recordRecovery(
  command: RecordRecoveryCommand,
  dependencies: RecordRecoveryDependencies,
): Promise<RecordRecoveryResult>;
```

有超額時回傳 `incomplete`，待補欄位為 `category`，候選為啟用中的收入分類。

- [ ] **Step 1：寫失敗測試**

```ts
describe("recordRecovery", () => {
  it("allocates one payment across two advances oldest first", async () => {
    const { dependencies, repository } = await setupTwoAdvances();

    const result = await recordRecovery(
      { ...baseCommand, received: "300" },
      dependencies,
    );

    expect(result.kind).toBe("draft");
    if (result.kind !== "draft") return;
    expect(result.draft.amount.amount).toBe("300");
    expect(
      result.draft.allocations.map((item) => [item.amount.amount, item.recoversAllocationId]),
    ).toEqual([
      ["100", "A1"],
      ["200", "A2"],
    ]);
    expect(repository.drafts.size).toBe(1);
  });

  it("keeps the recovery partial when the payment is smaller", async () => {
    const { dependencies } = await setupTwoAdvances();

    const result = await recordRecovery({ ...baseCommand, received: "150" }, dependencies);

    expect(result.kind).toBe("draft");
    if (result.kind !== "draft") return;
    expect(result.draft.allocations.map((item) => item.amount.amount)).toEqual(["100", "50"]);
  });

  it("asks for a category when the payment exceeds the outstanding total", async () => {
    const { dependencies } = await setupSingleAdvance("630");

    const result = await recordRecovery({ ...baseCommand, received: "700" }, dependencies);

    expect(result.kind).toBe("incomplete");
    if (result.kind !== "incomplete") return;
    expect(result.surplus).toBe("70");
    expect(result.draft.pendingFields[0]?.field).toBe("category");
    expect(result.draft.partial.allocations.map((item) => item.amount?.amount)).toEqual([
      "630",
      "70",
    ]);
  });

  it("reports when the counterparty has nothing outstanding", async () => {
    const { dependencies } = await setupNoAdvances();

    const result = await recordRecovery({ ...baseCommand, received: "100" }, dependencies);

    expect(result).toEqual({ kind: "no_outstanding" });
  });

  it("inherits the category and counterparty of the advance it recovers", async () => {
    const { dependencies } = await setupSingleAdvance("630");

    const result = await recordRecovery({ ...baseCommand, received: "300" }, dependencies);

    expect(result.kind).toBe("draft");
    if (result.kind !== "draft") return;
    expect(result.draft.allocations[0]).toMatchObject({
      category: "餐飲",
      counterpartyId: "counterparty-1",
      purpose: "advance_recovery",
      fundsEffect: "inflow",
    });
  });
});
```

- [ ] **Step 2：執行測試確認失敗**

Run: `pnpm vitest run tests/application/record-recovery.test.ts`
Expected: FAIL，找不到模組 `src/application/record-recovery.js`。

- [ ] **Step 3：實作**

```ts
export async function recordRecovery(
  command: RecordRecoveryCommand,
  dependencies: RecordRecoveryDependencies,
): Promise<RecordRecoveryResult> {
  const eventId = dependencies.generateId();
  const recorded = await dependencies.repository.recordInputEvent({
    eventId,
    ownerId: command.ownerId,
    telegramUpdateId: command.telegramUpdateId,
    sourceType: "telegram",
    sourceRef: command.sourceRef,
    rawText: command.rawText,
    receivedAt: command.receivedAt,
  });
  if (!recorded.created) return { kind: "duplicate" };

  const [advanceRows, recoveryRows] = await Promise.all([
    dependencies.repository.listAdvanceRows(command.ownerId),
    dependencies.repository.listRecoveryRows(command.ownerId),
  ]);
  const outstanding = computeOutstanding(advanceRows, recoveryRows).filter(
    (item) => item.counterpartyId === command.counterpartyId,
  );
  if (outstanding.length === 0) return { kind: "no_outstanding" };

  const plan = planRecovery(outstanding, command.received);
  const allocations = plan.items.map((item) => ({
    allocationId: dependencies.generateId(),
    fundsEffect: "inflow" as const,
    purpose: "advance_recovery" as const,
    amount: money(item.amount, "TWD"),
    ...(item.advance.categoryId ? { categoryId: item.advance.categoryId } : {}),
    category: item.advance.category,
    ...(item.advance.subcategory ? { subcategory: item.advance.subcategory } : {}),
    counterpartyId: item.advance.counterpartyId,
    recoversAllocationId: item.advance.allocationId,
  }));

  const base = {
    draftId: dependencies.generateId(),
    ownerId: command.ownerId,
    requestId: dependencies.generateId(),
    sourceEventId: eventId,
    occurredDate: command.occurredDate,
    ...(command.accountToId ? { accountToId: command.accountToId } : {}),
  };

  if (new Decimal(plan.surplus).greaterThan(0)) {
    const draft = IncompleteDraftSchema.parse({
      ...base,
      batchId: dependencies.generateId(),
      batchIndex: 0,
      pendingFields: [
        {
          field: "category",
          candidateIds: dependencies.incomeCategoryIds,
        },
      ],
      partial: {
        occurredDate: command.occurredDate,
        rawSegment: command.rawText,
        allocations: [
          ...allocations,
          {
            allocationId: dependencies.generateId(),
            fundsEffect: "inflow" as const,
            purpose: "income" as const,
            amount: money(plan.surplus, "TWD"),
            category: "待分類",
          },
        ],
      },
      status: "awaiting_input",
    });
    const draftRef = await dependencies.repository.saveIncompleteDraft(draft, {
      createdDate: command.occurredDate,
    });
    return { kind: "incomplete", draft, draftRef, surplus: plan.surplus };
  }

  const total = allocations.reduce((sum, item) => sum.plus(item.amount.amount), new Decimal(0));
  const draft = TransactionDraftSchema.parse({
    ...base,
    amount: money(total.toString(), "TWD"),
    allocations,
    rawInputSnapshot: command.rawText,
    status: "awaiting_confirmation",
  });
  const draftRef = await dependencies.repository.saveDraft(draft, {
    createdDate: command.occurredDate,
  });
  return { kind: "draft", draft, draftRef };
}
```

`RecordRecoveryDependencies` 含 `repository`、`generateId` 與 `incomeCategoryIds`（由呼叫端自參照快照取出啟用中的收入葉分類 ID）。

- [ ] **Step 4：執行測試確認通過**

Run: `pnpm vitest run tests/application`
Expected: PASS。

- [ ] **Step 5：提交**

```bash
git add src/application/record-recovery.ts tests/application/record-recovery.test.ts
git commit -m "feat: plan and draft advance recoveries"
```

---

### Task 11：放棄回收應用服務

**Files:**

- Create: `src/application/abandon-advance.ts`
- Test: `tests/application/abandon-advance.test.ts`

**Interfaces:**

- Consumes: Task 3 `splitForAbandonment`、既有 `updateConfirmedTransaction`。
- Produces：

```ts
export interface AbandonAdvanceCommand {
  readonly ownerId: string;
  readonly allocationId: string;
  readonly telegramUpdateId: string;
  readonly sourceRef: string;
  readonly receivedAt: string;
}

export type AbandonAdvanceResult =
  | { readonly kind: "abandoned"; readonly transaction: ConfirmedTransaction; readonly amount: string }
  | { readonly kind: "not_found" }
  | { readonly kind: "nothing_to_abandon" };

export function abandonAdvance(
  command: AbandonAdvanceCommand,
  dependencies: AbandonAdvanceDependencies,
): Promise<AbandonAdvanceResult>;
```

- [ ] **Step 1：寫失敗測試**

```ts
describe("abandonAdvance", () => {
  it("splits a partially recovered advance and keeps the transaction total", async () => {
    const { dependencies, repository } = await setupAdvanceWithRecovery("630", "300");

    const result = await abandonAdvance({ ...baseCommand }, dependencies);

    expect(result.kind).toBe("abandoned");
    if (result.kind !== "abandoned") return;
    expect(result.amount).toBe("330");
    const allocations = result.transaction.allocations;
    expect(allocations.find((item) => item.purpose === "advance")?.amount.amount).toBe("300");
    expect(
      allocations.filter((item) => item.purpose === "expense").map((item) => item.amount.amount),
    ).toContain("330");
    const total = allocations.reduce(
      (sum, item) => sum + Number(item.amount.amount),
      0,
    );
    expect(String(total)).toBe(result.transaction.amount.amount);
  });

  it("converts the whole allocation when nothing was recovered", async () => {
    const { dependencies } = await setupAdvanceWithRecovery("630", "0");

    const result = await abandonAdvance({ ...baseCommand }, dependencies);

    expect(result.kind).toBe("abandoned");
    if (result.kind !== "abandoned") return;
    expect(result.transaction.allocations.some((item) => item.purpose === "advance")).toBe(false);
    expect(result.amount).toBe("630");
  });

  it("reports when the advance is already fully recovered", async () => {
    const { dependencies } = await setupAdvanceWithRecovery("630", "630");

    expect(await abandonAdvance({ ...baseCommand }, dependencies)).toEqual({
      kind: "nothing_to_abandon",
    });
  });

  it("writes an audit event with before and after snapshots", async () => {
    const { dependencies, repository } = await setupAdvanceWithRecovery("630", "300");

    await abandonAdvance({ ...baseCommand }, dependencies);

    const events = await repository.listAuditEvents("owner-1", "advance-transaction");
    expect(events.at(-1)?.action).toBe("transaction_updated");
  });
});
```

- [ ] **Step 2：執行測試確認失敗**

Run: `pnpm vitest run tests/application/abandon-advance.test.ts`
Expected: FAIL，找不到模組 `src/application/abandon-advance.js`。

- [ ] **Step 3：實作**

```ts
export async function abandonAdvance(
  command: AbandonAdvanceCommand,
  dependencies: AbandonAdvanceDependencies,
): Promise<AbandonAdvanceResult> {
  const [advanceRows, recoveryRows] = await Promise.all([
    dependencies.repository.listAdvanceRows(command.ownerId),
    dependencies.repository.listRecoveryRows(command.ownerId),
  ]);
  const outstanding = computeOutstanding(advanceRows, recoveryRows).find(
    (item) => item.allocationId === command.allocationId,
  );
  if (!outstanding) {
    const known = advanceRows.some((row) => row.allocationId === command.allocationId);
    return known ? { kind: "nothing_to_abandon" } : { kind: "not_found" };
  }

  const before = await dependencies.repository.getTransaction(
    command.ownerId,
    outstanding.transactionId,
  );
  if (!before) return { kind: "not_found" };

  const allocations = splitForAbandonment(
    before.allocations,
    command.allocationId,
    outstanding.recovered,
    dependencies.generateId(),
  );

  const changedAt = dependencies.now().toISOString();
  const eventId = dependencies.generateId();
  const transaction = await updateConfirmedTransaction(
    {
      ownerId: command.ownerId,
      transactionId: before.transactionId,
      sourceEventId: eventId,
      auditEventId: dependencies.generateId(),
      expectedUpdatedAt: before.updatedAt ?? before.confirmedAt,
      replacement: { ...before, allocations },
      changedAt,
    },
    {
      repository: dependencies.repository,
      inputEvent: {
        eventId,
        ownerId: command.ownerId,
        telegramUpdateId: command.telegramUpdateId,
        sourceType: "telegram",
        sourceRef: command.sourceRef,
        rawText: "abandon advance callback",
        receivedAt: command.receivedAt,
      },
    },
  );

  return { kind: "abandoned", transaction, amount: outstanding.outstanding };
}
```

- [ ] **Step 4：執行測試確認通過**

Run: `pnpm vitest run tests/application`
Expected: PASS。

- [ ] **Step 5：提交**

```bash
git add src/application/abandon-advance.ts tests/application/abandon-advance.test.ts
git commit -m "feat: abandon advance recovery with an audit trail"
```

---

### Task 12：未回收查詢

**Files:**

- Create: `src/application/list-advances.ts`
- Test: `tests/application/list-advances.test.ts`

**Interfaces:**

- Consumes: Task 3、Task 5、Task 6。
- Produces：

```ts
export interface CounterpartyAdvances {
  readonly counterpartyId: string;
  readonly name: string;
  readonly total: string;
  readonly items: readonly OutstandingAdvance[];
}

export function listAdvances(
  repository: LedgerRepository,
  referenceRepository: ReferenceRepository,
  ownerId: string,
): Promise<CounterpartyAdvances[]>;
```

依未回收總額由大到小排序；總額相同時依對象名稱排序。

- [ ] **Step 1：寫失敗測試**

```ts
it("groups outstanding advances by counterparty", async () => {
  const { repository, referenceRepository } = await setupTwoCounterparties();

  const groups = await listAdvances(repository, referenceRepository, "owner-1");

  expect(groups.map((group) => [group.name, group.total, group.items.length])).toEqual([
    ["小明", "500", 2],
    ["小華", "200", 1],
  ]);
});

it("omits counterparties whose advances are fully recovered", async () => {
  const { repository, referenceRepository } = await setupFullyRecovered();

  expect(await listAdvances(repository, referenceRepository, "owner-1")).toEqual([]);
});

it("falls back to the counterparty id when the name is missing", async () => {
  const { repository, referenceRepository } = await setupUnknownCounterparty();

  const groups = await listAdvances(repository, referenceRepository, "owner-1");

  expect(groups[0]?.name).toBe("counterparty-gone");
});
```

- [ ] **Step 2：執行測試確認失敗**

Run: `pnpm vitest run tests/application/list-advances.test.ts`
Expected: FAIL，找不到模組 `src/application/list-advances.js`。

- [ ] **Step 3：實作**

```ts
export async function listAdvances(
  repository: LedgerRepository,
  referenceRepository: ReferenceRepository,
  ownerId: string,
): Promise<CounterpartyAdvances[]> {
  const [advanceRows, recoveryRows, counterparties] = await Promise.all([
    repository.listAdvanceRows(ownerId),
    repository.listRecoveryRows(ownerId),
    referenceRepository.listActiveCounterparties(ownerId),
  ]);
  const names = new Map(counterparties.map((item) => [item.counterpartyId, item.name]));
  const grouped = new Map<string, OutstandingAdvance[]>();
  for (const advance of computeOutstanding(advanceRows, recoveryRows)) {
    const items = grouped.get(advance.counterpartyId) ?? [];
    items.push(advance);
    grouped.set(advance.counterpartyId, items);
  }

  return [...grouped.entries()]
    .map(([counterpartyId, items]) => ({
      counterpartyId,
      name: names.get(counterpartyId) ?? counterpartyId,
      total: items
        .reduce((sum, item) => sum.plus(item.outstanding), new Decimal(0))
        .toString(),
      items,
    }))
    .sort(
      (left, right) =>
        new Decimal(right.total).comparedTo(left.total) || left.name.localeCompare(right.name),
    );
}
```

- [ ] **Step 4：補上統計語意測試**

新增 `tests/domain/advance-summary.test.ts`，證明既有統計程式不需修改即可正確處理代墊：

```ts
import { describe, expect, it } from "vitest";

import { summarizeAllocations } from "../../src/domain/ledger-summary.js";

describe("advance statistics", () => {
  it("counts an advance as an outflow but not as personal expense", () => {
    const summary = summarizeAllocations([
      {
        fundsEffect: "outflow",
        purpose: "expense",
        amount: "630",
        categoryId: "c1",
        categoryKey: "expense_dining_lunch",
        categoryName: "餐飲",
      },
      {
        fundsEffect: "outflow",
        purpose: "advance",
        amount: "630",
        categoryId: "c1",
        categoryKey: "expense_dining_lunch",
        categoryName: "餐飲",
      },
    ]);

    expect(summary.actualOutflow.amount).toBe("1260");
    expect(summary.grossPersonalExpense.amount).toBe("630");
    expect(summary.categories[0]?.netExpense.amount).toBe("630");
  });

  it("counts a recovery as an inflow but not as personal income", () => {
    const summary = summarizeAllocations([
      {
        fundsEffect: "inflow",
        purpose: "advance_recovery",
        amount: "300",
        categoryId: "c1",
        categoryKey: "expense_dining_lunch",
        categoryName: "餐飲",
      },
    ]);

    expect(summary.actualInflow.amount).toBe("300");
    expect(summary.personalIncome.amount).toBe("0");
    expect(summary.categories).toEqual([]);
  });
});
```

Run: `pnpm vitest run tests/domain/advance-summary.test.ts`
Expected: PASS，且 `src/domain/ledger-summary.ts` 未被修改。

- [ ] **Step 5：提交**

```bash
git add src/application/list-advances.ts tests/application/list-advances.test.ts tests/domain/advance-summary.test.ts
git commit -m "feat: group outstanding advances by counterparty"
```

---

### Task 13：`/advances` 指令與操作

**Files:**

- Create: `src/telegram/format-advance.ts`、`src/telegram/handlers/advances.ts`
- Modify: `src/telegram/create-bot.ts`、`src/telegram/callback-data.ts`
- Test: `tests/telegram/advances-command.test.ts`

**Interfaces:**

- Consumes: Task 10、11、12。
- Produces：
  - `formatAdvances(groups, page)` 產生清單文字與鍵盤，每頁 10 位對象，附「關閉清單」。
  - `CallbackAction` 新增 `{ kind: "advance-recover"; counterpartyRef: string }` 與 `{ kind: "advance-abandon"; allocationRef: string }`，編碼為 `ar:<ref>` 與 `aa:<ref>`；`ref` 為 8 碼短碼，對應關係存於 `settings`，避免 UUID 撞上 64 bytes 上限。
  - `registerAdvanceHandlers(bot, dependencies)`。

- [ ] **Step 1：寫失敗測試**

```ts
it("lists outstanding advances grouped by counterparty", async () => {
  const { bot, calls } = await harnessWithAdvances();

  await bot.handleUpdate(messageUpdate({ updateId: 10, text: "/advances" }));

  const text = getText(calls.at(-1));
  expect(text).toContain("小明");
  expect(text).toContain("未回收 630");
  expect(JSON.stringify(calls.at(-1)?.payload)).toContain("dismiss-advances");
});

it("says nothing is outstanding when every advance is recovered", async () => {
  const { bot, calls } = createHarness();

  await bot.handleUpdate(messageUpdate({ updateId: 10, text: "/advances" }));

  expect(getText(calls.at(-1))).toContain("目前沒有未回收代墊");
});

it("asks for the received amount when recording a recovery", async () => {
  const { bot, calls, counterpartyRef } = await harnessWithAdvances();
  await bot.handleUpdate(messageUpdate({ updateId: 10, text: "/advances" }));

  await bot.handleUpdate(callbackUpdate({ updateId: 11, data: `ar:${counterpartyRef}` }));

  expect(getText(calls.at(-1))).toContain("收到多少");
});

it("confirms before abandoning and reports the amount", async () => {
  const { bot, calls, allocationRef } = await harnessWithAdvances();
  await bot.handleUpdate(messageUpdate({ updateId: 10, text: "/advances" }));

  await bot.handleUpdate(callbackUpdate({ updateId: 11, data: `aa:${allocationRef}` }));

  expect(getText(calls.at(-1))).toContain("放棄回收 630");
  expect(JSON.stringify(calls.at(-1)?.payload)).toContain("aa-confirm:");
});
```

- [ ] **Step 2：執行測試確認失敗**

Run: `pnpm vitest run tests/telegram/advances-command.test.ts`
Expected: FAIL，`/advances` 未註冊。

- [ ] **Step 3：實作**

短碼對應：`/advances` 產生清單時，把「短碼 → 交易對象 ID」與「短碼 → 配置 ID」寫入 `settings`（key 前綴 `advance_ref:`），callback 只帶短碼。中文名稱與 UUID 都不進 callback。

```ts
// src/telegram/format-advance.ts
const ADVANCES_PAGE_SIZE = 10;

export interface AdvanceView {
  readonly text: string;
  readonly replyMarkup?: InlineKeyboardMarkup;
}

export function formatAdvances(
  groups: readonly CounterpartyAdvances[],
  refs: { counterparty: Map<string, string>; allocation: Map<string, string> },
  page: number,
): AdvanceView {
  const totalPages = Math.ceil(groups.length / ADVANCES_PAGE_SIZE);
  const slice = groups.slice(page * ADVANCES_PAGE_SIZE, (page + 1) * ADVANCES_PAGE_SIZE);
  if (slice.length === 0) return { text: "目前沒有未回收代墊。" };

  const lines: string[] = [];
  const rows: InlineKeyboardButton[][] = [];
  for (const group of slice) {
    lines.push(`${group.name} · 未回收 ${group.total}（${String(group.items.length)} 筆）`);
    const counterpartyRef = refs.counterparty.get(group.counterpartyId) ?? "";
    rows.push([
      {
        text: `記錄收款 ${group.name}`,
        callback_data: encodeCallback({ kind: "advance-recover", ref: counterpartyRef }),
      },
    ]);
    for (const item of group.items) {
      lines.push(
        `· ${item.occurredDate} 原 ${item.amount} 已回收 ${item.recovered} 餘 ${item.outstanding}`,
      );
      const allocationRef = refs.allocation.get(item.allocationId) ?? "";
      rows.push([
        {
          text: `放棄回收 ${item.outstanding}`,
          callback_data: encodeCallback({ kind: "advance-abandon", ref: allocationRef }),
        },
      ]);
    }
  }
  if (totalPages > 1) {
    rows.push([
      ...(page > 0
        ? [{ text: "上一頁", callback_data: `advances-page:${String(page - 1)}` }]
        : []),
      ...(page < totalPages - 1
        ? [{ text: "下一頁", callback_data: `advances-page:${String(page + 1)}` }]
        : []),
    ]);
  }
  rows.push([{ text: "關閉清單", callback_data: "dismiss-advances" }]);
  return { text: lines.join("\n"), replyMarkup: { inline_keyboard: rows } };
}
```

`callback-data.ts` 新增兩種動作，共用 8 碼短碼：

```ts
    case "advance-recover":
      return guard(`ar:${action.ref}`);
    case "advance-abandon":
      return guard(`aa:${action.ref}`);
```

```ts
  if ((prefix === "ar" || prefix === "aa") && first !== undefined) {
    if (!REF_PATTERN.test(first)) return null;
    return prefix === "ar"
      ? { kind: "advance-recover", ref: first }
      : { kind: "advance-abandon", ref: first };
  }
```

handler 行為：

- `/advances` 呼叫 `listAdvances`，產生短碼寫入 `settings`，送出清單，並沿用 `/pending` 的做法關閉上一份清單。
- `ar:` 以 `answerCallbackQuery` 結束後回覆「收到多少？請回覆這則訊息並輸入金額。」，並把該對象短碼記在 `settings` 的 `advance_pending_recovery`；使用者回覆數字時呼叫 `recordRecovery`，再以 `formatPreview` 顯示沖抵明細，確認後才入帳。
- `aa:` 先回覆「放棄回收 <餘額>？此金額會計入原交易日期的個人消費。」加上 `aa-confirm:<短碼>` 與 `cancel-abandon` 兩顆按鈕；按下確認才呼叫 `abandonAdvance`，完成後就地更新清單訊息。
- `dismiss-advances` 刪除清單訊息並清除 `settings` 中的清單訊息 ID。

`create-bot.ts` 註冊 `registerAdvanceHandlers`。

- [ ] **Step 4：執行測試確認通過**

Run: `pnpm vitest run tests/telegram`
Expected: PASS。

- [ ] **Step 5：提交**

```bash
git add src/telegram tests/telegram/advances-command.test.ts
git commit -m "feat: browse and settle advances from telegram"
```

---

### Task 14：回收文字入口

**Files:**

- Modify: `src/telegram/handlers/drafts.ts`、`src/parser/split-share.ts`
- Test: `tests/telegram/recovery-input.test.ts`

**Interfaces:**

- Consumes: Task 10 `recordRecovery`。
- Produces: `parseRepayment(text, counterparties)` 回傳 `{ counterpartyId, amount } | null`，辨識 `小明還 300`、`收到小明 300`；`message:text` 在建立批次之前先嘗試此路徑。

- [ ] **Step 1：寫失敗測試**

```ts
it("records a recovery typed as free text", async () => {
  const { bot, calls, repository } = await harnessWithAdvances();

  await bot.handleUpdate(messageUpdate({ updateId: 10, text: "小明還 300" }));

  const text = getText(calls.at(-1));
  expect(text).toContain("總金額：TWD 300");
  expect(text).toContain("代墊收回");
  expect(repository.drafts.size).toBe(1);
});

it("ignores a repayment for a counterparty with nothing outstanding", async () => {
  const { bot, calls, referenceRepository } = createHarness();
  referenceRepository.counterparties.push({
    counterpartyId: "friend",
    ownerId: "123",
    name: "小明",
    active: true,
  });

  await bot.handleUpdate(messageUpdate({ updateId: 10, text: "小明還 300" }));

  expect(getText(calls.at(-1))).toContain("目前沒有未回收代墊");
});

it("treats an ordinary expense as a new transaction", async () => {
  const { bot, calls } = await harnessWithAdvances();

  await bot.handleUpdate(messageUpdate({ updateId: 10, text: "午餐 120" }));

  expect(getText(calls.at(-1))).toContain("總金額：TWD 120");
});
```

- [ ] **Step 2：執行測試確認失敗**

Run: `pnpm vitest run tests/telegram/recovery-input.test.ts`
Expected: FAIL，`小明還 300` 會被當成一般支出解析。

- [ ] **Step 3：實作**

```ts
const REPAYMENT_PATTERN = /^(?:收到\s*)?(.+?)\s*(?:還|還我|歸還)\s*([0-9]+(?:\.[0-9]+)?)$/;

export function parseRepayment(
  text: string,
  counterparties: readonly Counterparty[],
): { counterpartyId: string; amount: string } | null {
  const match = REPAYMENT_PATTERN.exec(text.trim());
  if (!match) return null;
  const name = (match[1] ?? "").trim();
  const counterparty = counterparties.find((item) => item.name === name);
  if (!counterparty) return null;
  return { counterpartyId: counterparty.counterpartyId, amount: match[2] ?? "" };
}
```

`message:text` 的順序：reply 路由 → 純數字候選 → **回收語句** → `createBatch`。回收語句只在對象名稱**完全相符**時觸發，避免把「小明還欠我錢」這類敘述誤判。

- [ ] **Step 4：執行測試確認通過**

Run: `pnpm vitest run`
Expected: PASS。

- [ ] **Step 5：提交**

```bash
git add src/parser/split-share.ts src/telegram/handlers/drafts.ts tests/telegram/recovery-input.test.ts
git commit -m "feat: record recoveries from plain text"
```

---

### Task 15：語料、文件與驗收

**Files:**

- Modify: `tests/fixtures/parser-corpus.ts`、`README.md`、`docs/roadmap.md`
- Create: `docs/quality/m3b-acceptance.md`
- Test: `tests/parser/corpus.test.ts`

**Interfaces:**

- Consumes: 全部先前任務。
- Produces: 語料補入代墊語句；交付文件與驗收清單。

- [ ] **Step 1：補入語料**

```ts
  // M3b 代墊語句
  { input: "午餐 1260，朋友欠一半", segments: 1, outcomes: ["draft"] },
  { input: "午餐 1260，小明欠 630", segments: 1, outcomes: ["missing_fields"] },
  { input: "午餐 1000，三個人平分", segments: 1, outcomes: ["missing_fields"] },
  { input: "午餐 900，三個人平分", segments: 1, outcomes: ["missing_fields"] },
  { input: "小明還 300", segments: 1, outcomes: ["missing_fields"] },
```

語料的參照快照沒有交易對象，因此含名字的語句會落在追問路徑；`朋友欠一半` 需在 `referenceSnapshotFixture` 加入名為「朋友」的交易對象才會成為 `draft`。實作時依實際行為調整期望值，但**不得為了讓測試通過而放寬語意**：若某句的結果與設計不符，先修實作。

- [ ] **Step 2：執行語料測試**

Run: `pnpm vitest run tests/parser/corpus.test.ts`
Expected: 全數通過，語料總數不少於 25 筆。

- [ ] **Step 3：撰寫交付文件**

`README.md` 新增代墊小節：分帳寫法、除不盡會追問、`/advances`、回收與放棄回收。`docs/roadmap.md` 的 M3 段落標示 M3b 完成日期。`docs/quality/m3b-acceptance.md` 比照 `m3a-acceptance.md` 結構，列出自動驗證與人工 Telegram 驗收清單，且不得記錄 token、owner ID 或交易 ID。

- [ ] **Step 4：執行完整驗證**

Run: `pnpm check`
Expected: format、test、typecheck、lint、build 全數通過。

Run: `docker compose config --quiet && docker build -t personal-ledger:m3b .`
Expected: 建置成功。

Run: 以測試 token、測試 owner ID、暫存 SQLite 路徑及 `LEDGER_STARTUP_CHECK=1` 啟動容器。
Expected: migration 0005 套用成功後正常結束。

- [ ] **Step 5：提交**

```bash
git add tests/fixtures/parser-corpus.ts tests/parser/corpus.test.ts docs/quality/m3b-acceptance.md README.md docs/roadmap.md
git commit -m "docs: record m3b acceptance evidence"
```

---

## 完成定義

依序完成下列三道關卡，任一道未過就不算結案：

### 關卡一：自動驗證

- AC-11 至 AC-14 的自動測試通過。
- `pnpm check` 全綠；Docker 建置與啟動檢查通過。

### 關卡二：程式審查

- Task 15 完成後、人工驗收之前，對整個分支的 diff 執行 `superpowers:requesting-code-review`。
- 審查意見依 `superpowers:receiving-code-review` 處理：每一條都要判斷是否成立，不盲目照做，也不無視。
- 需要修正的項目補上回歸測試後再重跑關卡一。

M3a 的經驗是這道關卡的理由：當時沒有程式審查，四個互動缺陷全數由人工驗收才發現。審查未必抓得到體驗問題，但「封存後沒有重繪清單」這類在 handler 裡讀得出來的漏洞，應該在進人工驗收之前就被攔下。

### 關卡三：人工 Telegram 驗收

- 於真實資料的**複本**上執行，結束後刪除複本，正式帳本不得留下測試資料。
- 逐項完成 `docs/quality/m3b-acceptance.md` 的人工清單並記錄結果。
- 驗收期間發現的缺陷一律補上回歸測試後再修，不得只修行為。

### 其餘條件
- 既有 M3a 資料經 migration 0005 後完整保留，`foreign_key_check` 無錯誤。
- 任何金額加總都不經過 SQL `sum()`，一律以 Decimal 計算。
- `/advances` 可列出、收款與放棄；帶回收關聯的代墊交易無法被軟刪除。
- `summarizeAllocations` 未被修改，且統計測試證明代墊不計入個人消費、回收不計入個人收入。

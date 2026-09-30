# M5a：Google Sheets 鏡像 實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把帳本單向鏡像到一張 Google Sheet，讓使用者用試算表看自己的錢，而 Sheet 故障時記帳完全不受影響。

**Architecture:** 收斂式鏡像而非工作佇列 —— 以 `transactions.updated_at` 為游標找出變更的交易，
把它們投影成三張分頁的列，以 id 為鍵 upsert。Sheet 是 SQLite 的投影，寫兩次無害，
因此所有邊界情況一律用「寧可重做」化解。每日全表校正走同一段程式。

**Tech Stack:** Node 24、TypeScript 6 strict ESM（import 要 `.js` 副檔名）、pnpm 10、Vitest、
better-sqlite3、Zod 4、decimal.js、googleapis（新增）。

**Spec:** `docs/superpowers/specs/2026-09-30-m5a-sheets-mirror-design.md`

## Global Constraints

- 沒有 Node／pnpm 在主機上。每個指令都在 Docker 裡跑：
  `docker run --rm -v "$PWD":/app -v personal-ledger-modules:/app/node_modules -w /app personal-ledger:deps pnpm <cmd>`
  完整檢查 `pnpm check`。**驗證看離開碼，不是 grep 輸出。**
- 文件與使用者可見文案一律繁體中文。
- 金錢一律 `Decimal`，不得用 IEEE 浮點，不得對 TEXT 金額欄位下 SQL `sum()`。
  （例外已在 spec §4 載明：寫進 Sheet 的金額用 `numberValue`，因為 Sheet 是給人分析的投影。）
- `src/domain/` 與 `src/application/` 永不 import grammY，**也永不 import googleapis**。
- 正式日誌不得含 bot token、owner id、完整財務原文、SQL 細節、Google 金鑰、試算表 id。
- `callback_data` ≤ 64 bytes，無 UUID，無中文。
- migrations `0001`–`0008` 不得修改。本計畫新增 `0009`。
- commit message 結尾不得加任何 Co-Authored-By、Generated-with 之類的署名行。
- 一件事一個 commit。變異驗證只在**已提交之後**做，一次改一個地方，
  改回來後 `git status --short` 必須乾淨。
- 宣稱被保護的行為，一律附「把它改壞、對應測試變紅」的證據與失敗訊息原文。自我宣稱不算數。

## Review Focus

這五種情況 spec 隱含要求、但最容易在實作時沒有測試涵蓋，且真的會咬到使用者。
每一條都已指派給擁有該程式的 task。

1. **交易的 `occurred_date` 跨月搬移** → 舊月份的摘要靜默停在錯的數字。（Task 4）
2. **備註或原始輸入以 `=`、`+`、`-`、`@` 開頭** → 若用 `USER_ENTERED` 會變成 Sheet 裡的
   實際公式。（Task 3）
3. **使用者在 Sheet 手動插入或刪除列** → `id → 列號` 對應錯位，之後每次同步都寫到錯的列。（Task 6）
4. **兩筆交易共用同一個 `updated_at` 毫秒值且落在批次邊界** → 用 `>` 會永久漏掉一筆。（Task 2）
5. **只設定了 `GOOGLE_SERVICE_ACCOUNT_KEY_FILE` 與 `SHEET_SPREADSHEET_ID` 其中一個**
   → 半開啟狀態，鏡像靜默不運作。（Task 10）

---

## 檔案結構

**新增**

| 檔案 | 責任 |
|---|---|
| `src/db/migrations/0009_sheet_sync_state.sql` | 游標與同步狀態表 |
| `src/ports/sheet-sync-repository.ts` | 同步狀態與增量查詢的 port |
| `src/db/sqlite-sheet-sync-repository.ts` | 上者的 SQLite 實作 |
| `src/domain/sheet-serial-date.ts` | ISO 日期 ↔ Sheets 序列值 |
| `src/domain/sheet-rows.ts` | 純投影：交易＋配置 → 具型別的儲存格列 |
| `src/domain/sheet-months.ts` | 受影響月份的計算（含跨月搬移） |
| `src/ports/sheets-client.ts` | 窄介面：`readColumns` 與 `updateCells` |
| `src/sheets/google-sheets-client.ts` | googleapis adapter（唯一 import googleapis 的地方） |
| `src/sheets/sheet-mirror.ts` | 同步引擎：增量、校正、游標推進 |
| `src/sheets/sheet-mirror-runner.ts` | 週期執行器：20 秒 tick、每日校正、start/stop |
| `src/sheets/sheet-failure.ts` | 失敗分類（暫時／永久） |
| `tests/support/fake-sheets-client.ts` | 位置定址的**模擬器**，不是樁 |
| `tests/integration/sheets.integration.test.ts` | 對真實 Sheets 的來回測試 |

**修改**：`src/config.ts`、`src/db/migrate.ts`、`src/main.ts`、`src/logger.ts`、
`src/telegram/format-status.ts`、`src/telegram/handlers/status.ts`、
`src/telegram/outbox-runner.ts`、`src/telegram/notify-attention.ts`、
`package.json`、`vitest.config.ts`、`docs/roadmap.md`、`docs/quality/`（新增驗收文件）。

---

## Task 1：游標表與同步狀態讀寫

**Files:**
- Create: `src/db/migrations/0009_sheet_sync_state.sql`
- Create: `src/ports/sheet-sync-repository.ts`
- Create: `src/db/sqlite-sheet-sync-repository.ts`
- Modify: `src/db/migrate.ts`（註冊 version 9）
- Test: `tests/db/sheet-sync-state.test.ts`

**Interfaces:**
- Produces: `SheetSyncState`、`SheetSyncRepository.loadSyncState`、`saveSyncState`

- [ ] **Step 1: 寫 migration**

`src/db/migrations/0009_sheet_sync_state.sql`：

```sql
-- Sheets 鏡像的游標與健康狀態。一個 owner 一列，三張分頁共用同一個游標：
-- 三張分頁在同一輪裡一起寫，任何一張失敗就整輪不推進，下一輪三張全部重做。
-- 因為以 id 為鍵的 upsert 是冪等的，重做的代價是零；一頁一個游標只會讓三頁的
-- 進度各自漂移，換來的好處不存在。
CREATE TABLE sheet_sync_state (
  owner_id              TEXT PRIMARY KEY,
  -- 游標是 (updated_at, transaction_id) 兩欄，比較採字典序。兩者皆為 NULL 代表
  -- 從未同步過，下一輪會走全表校正。
  cursor_updated_at     TEXT,
  cursor_transaction_id TEXT,
  last_success_at       TEXT,
  last_error            TEXT,
  consecutive_failures  INTEGER NOT NULL DEFAULT 0,
  last_reconciled_at    TEXT
);
```

- [ ] **Step 2: 在 migrate.ts 註冊**

`src/db/migrate.ts` 的 `migrations` 陣列末端加一行（**不要改動既有的八行**）：

```ts
  { version: 9, url: new URL("./migrations/0009_sheet_sync_state.sql", import.meta.url) },
```

- [ ] **Step 3: 寫 port**

`src/ports/sheet-sync-repository.ts`：

```ts
export interface SheetSyncState {
  readonly ownerId: string;
  readonly cursorUpdatedAt: string | null;
  readonly cursorTransactionId: string | null;
  readonly lastSuccessAt: string | null;
  readonly lastError: string | null;
  readonly consecutiveFailures: number;
  readonly lastReconciledAt: string | null;
}

export interface SheetSyncRepository {
  loadSyncState(ownerId: string): Promise<SheetSyncState>;
  saveSyncState(state: SheetSyncState): Promise<void>;
}
```

- [ ] **Step 4: 寫失敗的測試**

`tests/db/sheet-sync-state.test.ts`：

```ts
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import { migrate } from "../../src/db/migrate.js";
import { SqliteSheetSyncRepository } from "../../src/db/sqlite-sheet-sync-repository.js";

describe("SqliteSheetSyncRepository", () => {
  let database: Database.Database;
  let repository: SqliteSheetSyncRepository;

  beforeEach(() => {
    database = new Database(":memory:");
    migrate(database);
    repository = new SqliteSheetSyncRepository(database);
  });

  it("returns a zero state for an owner that has never synced", async () => {
    // 從未同步過必須回傳游標為 null 而不是拋錯或回傳空字串——null 是「走全表校正」
    // 的訊號，空字串會被字典序比較當成「比任何時間都早」而誤入增量路徑。
    const state = await repository.loadSyncState("owner-1");

    expect(state.cursorUpdatedAt).toBeNull();
    expect(state.cursorTransactionId).toBeNull();
    expect(state.consecutiveFailures).toBe(0);
    expect(state.lastSuccessAt).toBeNull();
  });

  it("round-trips a saved state", async () => {
    await repository.saveSyncState({
      ownerId: "owner-1",
      cursorUpdatedAt: "2026-10-01T00:00:00.000Z",
      cursorTransactionId: "txn-9",
      lastSuccessAt: "2026-10-01T00:00:01.000Z",
      lastError: null,
      consecutiveFailures: 0,
      lastReconciledAt: "2026-10-01T20:00:00.000Z",
    });

    expect(await repository.loadSyncState("owner-1")).toEqual({
      ownerId: "owner-1",
      cursorUpdatedAt: "2026-10-01T00:00:00.000Z",
      cursorTransactionId: "txn-9",
      lastSuccessAt: "2026-10-01T00:00:01.000Z",
      lastError: null,
      consecutiveFailures: 0,
      lastReconciledAt: "2026-10-01T20:00:00.000Z",
    });
  });

  it("overwrites rather than accumulating rows for the same owner", async () => {
    // PRIMARY KEY (owner_id) 是「一個 owner 一列」這條設計的執行點。若 saveSyncState
    // 寫成 INSERT 而非 upsert，第二次儲存會拋 constraint 錯誤；若改成多列，
    // loadSyncState 會隨機讀到舊游標而重複同步。
    const base = {
      ownerId: "owner-1",
      lastSuccessAt: null,
      lastError: null,
      consecutiveFailures: 0,
      lastReconciledAt: null,
    };
    await repository.saveSyncState({
      ...base,
      cursorUpdatedAt: "2026-10-01T00:00:00.000Z",
      cursorTransactionId: "txn-1",
    });
    await repository.saveSyncState({
      ...base,
      cursorUpdatedAt: "2026-10-02T00:00:00.000Z",
      cursorTransactionId: "txn-2",
    });

    const rows = database.prepare("SELECT count(*) AS total FROM sheet_sync_state").get() as {
      total: number;
    };
    expect(rows.total).toBe(1);
    expect((await repository.loadSyncState("owner-1")).cursorTransactionId).toBe("txn-2");
  });
});
```

- [ ] **Step 5: 跑測試確認它失敗**

Run：`docker run --rm -v "$PWD":/app -v personal-ledger-modules:/app/node_modules -w /app personal-ledger:deps pnpm vitest run tests/db/sheet-sync-state.test.ts`
Expected：FAIL，找不到模組 `sqlite-sheet-sync-repository.js`。

- [ ] **Step 6: 寫實作**

`src/db/sqlite-sheet-sync-repository.ts`：

```ts
import type Database from "better-sqlite3";

import type { SheetSyncRepository, SheetSyncState } from "../ports/sheet-sync-repository.js";

interface SheetSyncStateRow {
  owner_id: string;
  cursor_updated_at: string | null;
  cursor_transaction_id: string | null;
  last_success_at: string | null;
  last_error: string | null;
  consecutive_failures: number;
  last_reconciled_at: string | null;
}

export class SqliteSheetSyncRepository implements SheetSyncRepository {
  public constructor(private readonly database: Database.Database) {}

  public loadSyncState(ownerId: string): Promise<SheetSyncState> {
    const row = this.database
      .prepare("SELECT * FROM sheet_sync_state WHERE owner_id = ?")
      .get(ownerId) as SheetSyncStateRow | undefined;

    // 沒有列不是錯誤，是「還沒同步過」。回傳游標為 null 的零狀態，讓呼叫端走全表校正。
    if (!row) {
      return Promise.resolve({
        ownerId,
        cursorUpdatedAt: null,
        cursorTransactionId: null,
        lastSuccessAt: null,
        lastError: null,
        consecutiveFailures: 0,
        lastReconciledAt: null,
      });
    }

    return Promise.resolve({
      ownerId: row.owner_id,
      cursorUpdatedAt: row.cursor_updated_at,
      cursorTransactionId: row.cursor_transaction_id,
      lastSuccessAt: row.last_success_at,
      lastError: row.last_error,
      consecutiveFailures: row.consecutive_failures,
      lastReconciledAt: row.last_reconciled_at,
    });
  }

  public saveSyncState(state: SheetSyncState): Promise<void> {
    this.database
      .prepare(
        `INSERT INTO sheet_sync_state (
           owner_id, cursor_updated_at, cursor_transaction_id,
           last_success_at, last_error, consecutive_failures, last_reconciled_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (owner_id) DO UPDATE SET
           cursor_updated_at = excluded.cursor_updated_at,
           cursor_transaction_id = excluded.cursor_transaction_id,
           last_success_at = excluded.last_success_at,
           last_error = excluded.last_error,
           consecutive_failures = excluded.consecutive_failures,
           last_reconciled_at = excluded.last_reconciled_at`,
      )
      .run(
        state.ownerId,
        state.cursorUpdatedAt,
        state.cursorTransactionId,
        state.lastSuccessAt,
        state.lastError,
        state.consecutiveFailures,
        state.lastReconciledAt,
      );
    return Promise.resolve();
  }
}
```

- [ ] **Step 7: 跑測試確認通過**

Run：同 Step 5。Expected：PASS，3 條。

- [ ] **Step 8: 跑完整檢查**

**預期會有既有測試變紅，這是正常的。** 專案裡有數個測試把 migration 版本清單或
`/status` 的「schema 版本：N」字串寫死 —— 它們存在的目的就是在有人新增 migration 時
發出訊號。看到它們紅了不要懷疑自己的改動，把版本 9 補進去即可。
**最小幅度更新**（清單追加 `{ version: 9 }`、字串改成 9），不要放寬或重寫這些斷言 ——
放寬等於把哨兵拆掉。

Run：`docker run --rm -v "$PWD":/app -v personal-ledger-modules:/app/node_modules -w /app personal-ledger:deps pnpm check`
Expected：exit 0。

- [ ] **Step 9: 提交**

```bash
git add src/db/migrations/0009_sheet_sync_state.sql src/ports/sheet-sync-repository.ts \
        src/db/sqlite-sheet-sync-repository.ts src/db/migrate.ts tests/db/sheet-sync-state.test.ts
git commit -m "feat: 加入 Sheets 鏡像的游標與同步狀態表"
```

- [ ] **Step 10: 變異驗證**

提交後，把 `saveSyncState` 的 `ON CONFLICT (owner_id) DO UPDATE SET ...` 整段刪掉（變成純
INSERT）。Expected：`overwrites rather than accumulating rows for the same owner` 變紅。
還原，確認 `git status --short` 乾淨。

---

## Task 2：增量查詢與游標語意

**Files:**
- Modify: `src/ports/sheet-sync-repository.ts`（加型別與一個方法）
- Modify: `src/db/sqlite-sheet-sync-repository.ts`
- Test: `tests/db/sheet-sync-changes.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `SheetSyncRepository`
- Produces: `MirrorTransaction`、`MirrorAllocation`、`SyncCursor`、`listChangedTransactions`

**這個 task 擁有 Review Focus #4**（同毫秒的批次邊界）。

- [ ] **Step 1: 擴充 port**

在 `src/ports/sheet-sync-repository.ts` 追加：

```ts
export interface MirrorAllocation {
  readonly allocationId: string;
  readonly fundsEffect: string;
  readonly purpose: string;
  readonly amount: string;
  readonly categoryName: string;
  readonly subcategoryName: string | null;
  readonly counterpartyName: string | null;
  readonly note: string | null;
}

export interface MirrorTransaction {
  readonly transactionId: string;
  readonly occurredDate: string;
  readonly occurredTime: string | null;
  readonly amount: string;
  readonly accountFromName: string | null;
  readonly accountToName: string | null;
  readonly merchantName: string | null;
  readonly counterpartyName: string | null;
  readonly note: string | null;
  readonly rawInputSnapshot: string | null;
  readonly status: string;
  readonly confirmedAt: string;
  readonly updatedAt: string;
  readonly allocations: readonly MirrorAllocation[];
}

export interface SyncCursor {
  readonly updatedAt: string;
  readonly transactionId: string;
}
```

並在 `SheetSyncRepository` 介面加：

```ts
  /**
   * cursor 為 null 代表全表掃描（初次同步與每日校正走這條）。
   * 非 null 時語意是 (updated_at, transaction_id) >= cursor——刻意包含邊界那一列。
   */
  listChangedTransactions(
    ownerId: string,
    cursor: SyncCursor | null,
    limit: number,
  ): Promise<MirrorTransaction[]>;
```

- [ ] **Step 2: 寫失敗的測試**

`tests/db/sheet-sync-changes.test.ts`。先寫一個 seed 工具，直接以 SQL 塞資料（不經過
application 層，這個 task 測的是查詢本身）。

> **2026-10-01 更正：下面這段 seed 與真實 schema 不符，實作時已修正。**
> 它是照著 migration 檔案寫的、從未執行過 —— 也就是一個假設，不是事實。實際差異：
> `input_events` 沒有 `chat_id`／`message_id`（真實欄位是 `telegram_update_id`、
> `source_type`、`source_ref`）；`drafts` 的 `request_id` 與 `draft_json` 是 NOT NULL
> 但 seed 沒給；`categories` 的 `kind` 與 `depth` 是 NOT NULL，且有 CHECK 綁定
> `depth = 1` 時 `parent_id` 必須為 NULL。
>
> （原本這裡還寫了「`transactions` 那句 `.run()` 傳了 12 個值對 11 個佔位符」——
> **那一項是錯的**，我照實作者的回報寫上去而沒有自己數。審查員逐字元數過是 11 對 11，
> 我複驗確認。其餘四項差異是真的。）
> **以 `tests/db/sheet-sync-changes.test.ts` 的實際內容為準**，下面保留原文只為記錄。

```ts
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import { migrate } from "../../src/db/migrate.js";
import { SqliteSheetSyncRepository } from "../../src/db/sqlite-sheet-sync-repository.js";

const OWNER = "owner-1";

function seedTransaction(
  database: Database.Database,
  input: {
    id: string;
    updatedAt: string;
    occurredDate?: string;
    status?: string;
    amount?: string;
  },
): void {
  database
    .prepare(
      `INSERT INTO input_events (event_id, owner_id, chat_id, message_id, received_at, raw_text)
       VALUES (?, ?, '1', '1', ?, 'seed')`,
    )
    .run(`evt-${input.id}`, OWNER, input.updatedAt);
  database
    .prepare(
      `INSERT INTO drafts (draft_id, owner_id, source_event_id, status, created_date, created_at, updated_at)
       VALUES (?, ?, ?, 'archived', '2026-10-01', ?, ?)`,
    )
    .run(`draft-${input.id}`, OWNER, `evt-${input.id}`, input.updatedAt, input.updatedAt);
  database
    .prepare(
      `INSERT INTO transactions (
         transaction_id, draft_id, owner_id, request_id, source_event_id, source_type, source_ref,
         occurred_date, amount, currency, status, confirmed_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'telegram', '1', ?, ?, 'TWD', ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      `draft-${input.id}`,
      OWNER,
      `req-${input.id}`,
      `evt-${input.id}`,
      input.occurredDate ?? "2026-10-01",
      input.amount ?? "100",
      input.status ?? "confirmed",
      input.updatedAt,
      input.updatedAt,
      input.updatedAt,
    );
}

describe("listChangedTransactions", () => {
  let database: Database.Database;
  let repository: SqliteSheetSyncRepository;

  beforeEach(() => {
    database = new Database(":memory:");
    migrate(database);
    repository = new SqliteSheetSyncRepository(database);
  });

  it("returns every transaction when the cursor is null", async () => {
    seedTransaction(database, { id: "t1", updatedAt: "2026-10-01T00:00:00.000Z" });
    seedTransaction(database, { id: "t2", updatedAt: "2026-10-01T00:00:01.000Z" });

    const rows = await repository.listChangedTransactions(OWNER, null, 100);

    expect(rows.map((row) => row.transactionId)).toEqual(["t1", "t2"]);
  });

  it("includes the row sitting exactly on the cursor", async () => {
    // 2026-10-01 更正：游標語意改為 tuple 上的嚴格 >。理由見 spec §3 ——
    // 而用 > 的話，下面那條同毫秒的測試會永久漏掉一筆。
    seedTransaction(database, { id: "t1", updatedAt: "2026-10-01T00:00:00.000Z" });

    const rows = await repository.listChangedTransactions(
      OWNER,
      { updatedAt: "2026-10-01T00:00:00.000Z", transactionId: "t1" },
      100,
    );

    expect(rows.map((row) => row.transactionId)).toEqual(["t1"]);
  });

  it("does not lose a transaction that shares the cursor's millisecond", async () => {
    // Review Focus #4。t1 與 t2 的 updated_at 完全相同；上一輪在 t1 停下，
    // 游標是 (該毫秒, "t1")。若查詢寫成 updated_at > cursor，t2 會被永遠跳過——
    // 它的 updated_at 不大於游標，而且之後再也不會變。
    seedTransaction(database, { id: "t1", updatedAt: "2026-10-01T00:00:00.000Z" });
    seedTransaction(database, { id: "t2", updatedAt: "2026-10-01T00:00:00.000Z" });

    const rows = await repository.listChangedTransactions(
      OWNER,
      { updatedAt: "2026-10-01T00:00:00.000Z", transactionId: "t1" },
      100,
    );

    expect(rows.map((row) => row.transactionId)).toEqual(["t1", "t2"]);
  });

  it("orders by (updated_at, transaction_id) so the cursor is well defined", async () => {
    seedTransaction(database, { id: "tb", updatedAt: "2026-10-01T00:00:00.000Z" });
    seedTransaction(database, { id: "ta", updatedAt: "2026-10-01T00:00:00.000Z" });
    seedTransaction(database, { id: "tc", updatedAt: "2026-09-30T00:00:00.000Z" });

    const rows = await repository.listChangedTransactions(OWNER, null, 100);

    expect(rows.map((row) => row.transactionId)).toEqual(["tc", "ta", "tb"]);
  });

  it("includes soft-deleted transactions so the mirror can mark them", async () => {
    // 已刪除的交易仍要進鏡像（狀態欄寫已刪除），否則 Sheet 上會留著一列看起來還存在的
    // 交易。查詢若過濾掉 status='deleted'，刪除就永遠不會傳播出去。
    seedTransaction(database, {
      id: "t1",
      updatedAt: "2026-10-01T00:00:00.000Z",
      status: "deleted",
    });

    const rows = await repository.listChangedTransactions(OWNER, null, 100);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("deleted");
  });

  it("carries each transaction's allocations", async () => {
    seedTransaction(database, { id: "t1", updatedAt: "2026-10-01T00:00:00.000Z" });
    const categoryId = (
      database.prepare("SELECT category_id FROM categories LIMIT 1").get() as
        | { category_id: string }
        | undefined
    )?.category_id;
    expect(categoryId).toBeDefined();
    database
      .prepare(
        `INSERT INTO allocations (
           allocation_id, transaction_id, funds_effect, purpose, amount, currency,
           category_id, category_snapshot, subcategory_snapshot
         ) VALUES ('a1', 't1', 'outflow', 'expense', '100', 'TWD', ?, '餐飲', '午餐')`,
      )
      .run(categoryId);

    const rows = await repository.listChangedTransactions(OWNER, null, 100);

    expect(rows[0]?.allocations).toEqual([
      {
        allocationId: "a1",
        fundsEffect: "outflow",
        purpose: "expense",
        amount: "100",
        categoryName: "餐飲",
        subcategoryName: "午餐",
        counterpartyName: null,
        note: null,
      },
    ]);
  });

  it("respects the limit", async () => {
    seedTransaction(database, { id: "t1", updatedAt: "2026-10-01T00:00:00.000Z" });
    seedTransaction(database, { id: "t2", updatedAt: "2026-10-01T00:00:01.000Z" });
    seedTransaction(database, { id: "t3", updatedAt: "2026-10-01T00:00:02.000Z" });

    const rows = await repository.listChangedTransactions(OWNER, null, 2);

    expect(rows.map((row) => row.transactionId)).toEqual(["t1", "t2"]);
  });
});
```

`seedTransaction` 需要 `categories` 已存在。migrate 之後 `categories` 是空的，所以
「carries each transaction's allocations」那條先查一筆 category_id；若查不到，
在 `beforeEach` 裡補一列：

```ts
    database
      .prepare(
        `INSERT INTO categories (category_id, owner_id, key, name, active)
         VALUES ('cat-1', ?, 'expense_dining', '餐飲', 1)`,
      )
      .run(OWNER);
```

實作前先跑一次確認 `categories` 的實際欄位（`sqlite3 ... ".schema categories"`），
欄位對不上就以實際 schema 為準調整這段 seed。

- [ ] **Step 3: 跑測試確認失敗**

Run：`docker run --rm -v "$PWD":/app -v personal-ledger-modules:/app/node_modules -w /app personal-ledger:deps pnpm vitest run tests/db/sheet-sync-changes.test.ts`
Expected：FAIL，`listChangedTransactions is not a function`。

- [ ] **Step 4: 實作查詢**

在 `SqliteSheetSyncRepository` 加：

```ts
  public listChangedTransactions(
    ownerId: string,
    cursor: SyncCursor | null,
    limit: number,
  ): Promise<MirrorTransaction[]> {
    // 游標語意刻意是 >=：兩列可能共用同一個 updated_at 毫秒值，用 > 會讓排在游標
    // 後面、但時間相同的那一列永遠被跳過（它的時間之後不會再變）。重寫邊界那一列
    // 是冪等的，代價為零。
    const cursorClause = cursor
      ? "AND (t.updated_at > @cursorUpdatedAt OR (t.updated_at = @cursorUpdatedAt AND t.transaction_id >= @cursorTransactionId))"
      : "";

    const transactionRows = this.database
      .prepare(
        `SELECT t.transaction_id, t.occurred_date, t.occurred_time, t.amount,
                af.name AS account_from_name, at2.name AS account_to_name,
                m.name AS merchant_name, cp.name AS counterparty_name,
                t.note, t.raw_input_snapshot, t.status, t.confirmed_at, t.updated_at
         FROM transactions t
         LEFT JOIN accounts af ON af.account_id = t.account_from_id
         LEFT JOIN accounts at2 ON at2.account_id = t.account_to_id
         LEFT JOIN merchants m ON m.merchant_id = t.merchant_id
         LEFT JOIN counterparties cp ON cp.counterparty_id = t.counterparty_id
         WHERE t.owner_id = @ownerId ${cursorClause}
         ORDER BY t.updated_at, t.transaction_id
         LIMIT @limit`,
      )
      .all({
        ownerId,
        limit,
        cursorUpdatedAt: cursor?.updatedAt ?? null,
        cursorTransactionId: cursor?.transactionId ?? null,
      }) as TransactionRow[];

    if (transactionRows.length === 0) return Promise.resolve([]);

    const ids = transactionRows.map((row) => row.transaction_id);
    const placeholders = ids.map(() => "?").join(", ");
    const allocationRows = this.database
      .prepare(
        `SELECT a.allocation_id, a.transaction_id, a.funds_effect, a.purpose, a.amount,
                a.category_snapshot, a.subcategory_snapshot,
                cp.name AS counterparty_name, a.note
         FROM allocations a
         LEFT JOIN counterparties cp ON cp.counterparty_id = a.counterparty_id
         WHERE a.transaction_id IN (${placeholders})
         ORDER BY a.transaction_id, a.rowid`,
      )
      .all(...ids) as AllocationRow[];

    const byTransaction = new Map<string, MirrorAllocation[]>();
    for (const row of allocationRows) {
      const list = byTransaction.get(row.transaction_id) ?? [];
      list.push({
        allocationId: row.allocation_id,
        fundsEffect: row.funds_effect,
        purpose: row.purpose,
        amount: row.amount,
        categoryName: row.category_snapshot,
        subcategoryName: row.subcategory_snapshot,
        counterpartyName: row.counterparty_name,
        note: row.note,
      });
      byTransaction.set(row.transaction_id, list);
    }

    return Promise.resolve(
      transactionRows.map((row) => ({
        transactionId: row.transaction_id,
        occurredDate: row.occurred_date,
        occurredTime: row.occurred_time,
        amount: row.amount,
        accountFromName: row.account_from_name,
        accountToName: row.account_to_name,
        merchantName: row.merchant_name,
        counterpartyName: row.counterparty_name,
        note: row.note,
        rawInputSnapshot: row.raw_input_snapshot,
        status: row.status,
        confirmedAt: row.confirmed_at,
        updatedAt: row.updated_at,
        allocations: byTransaction.get(row.transaction_id) ?? [],
      })),
    );
  }
```

以及對應的 row 型別（放在檔案上方，與既有的 `SheetSyncStateRow` 並列）：

```ts
interface TransactionRow {
  transaction_id: string;
  occurred_date: string;
  occurred_time: string | null;
  amount: string;
  account_from_name: string | null;
  account_to_name: string | null;
  merchant_name: string | null;
  counterparty_name: string | null;
  note: string | null;
  raw_input_snapshot: string | null;
  status: string;
  confirmed_at: string;
  updated_at: string;
}

interface AllocationRow {
  allocation_id: string;
  transaction_id: string;
  funds_effect: string;
  purpose: string;
  amount: string;
  category_snapshot: string;
  subcategory_snapshot: string | null;
  counterparty_name: string | null;
  note: string | null;
}
```

- [ ] **Step 5: 跑測試確認通過**

Expected：PASS，7 條。

- [ ] **Step 6: 完整檢查並提交**

```bash
git add src/ports/sheet-sync-repository.ts src/db/sqlite-sheet-sync-repository.ts \
        tests/db/sheet-sync-changes.test.ts
git commit -m "feat: 以 (updated_at, transaction_id) 游標查出變更的交易"
```

- [ ] **Step 7: 變異驗證（兩個，逐一做）**

1. 把 `cursorClause` 的 `t.transaction_id >= @cursorTransactionId` 改成 `>`。
   Expected：`does not lose a transaction that shares the cursor's millisecond` 與
   `includes the row sitting exactly on the cursor` 變紅。
2. 在 WHERE 加上 `AND t.status = 'confirmed'`。
   Expected：`includes soft-deleted transactions so the mirror can mark them` 變紅。

每次還原後 `git status --short` 必須乾淨。

---

## Task 3：純投影 —— 日期序列值與具型別的儲存格

**Files:**
- Create: `src/domain/sheet-serial-date.ts`
- Create: `src/domain/sheet-rows.ts`
- Test: `tests/domain/sheet-serial-date.test.ts`、`tests/domain/sheet-rows.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `MirrorTransaction`、`MirrorAllocation`
- Produces: `toSheetSerialDate(iso: string): number`、`SheetCell`、
  `transactionRow(txn): SheetCell[]`、`allocationRows(txn): SheetCell[][]`、
  `TRANSACTIONS_HEADER`、`ALLOCATIONS_HEADER`

**這個 task 擁有 Review Focus #2**（公式注入）。

- [ ] **Step 1: 寫 `sheet-serial-date.ts` 的失敗測試**

`tests/domain/sheet-serial-date.test.ts`：

```ts
import { describe, expect, it } from "vitest";

import { toSheetSerialDate } from "../../src/domain/sheet-serial-date.js";

describe("toSheetSerialDate", () => {
  it("maps the sheets epoch to zero", () => {
    // Sheets 的序列值原點是 1899-12-30（不是 1900-01-01，也不是 Unix epoch）。
    expect(toSheetSerialDate("1899-12-30")).toBe(0);
  });

  it("maps a known date to its serial value", () => {
    // 2026-10-01 距 1899-12-30 共 46296 天。這個數字若算錯，Sheet 上每一筆的日期
    // 都會整體平移，而且看起來仍像個合理的日期——不會有任何東西報錯。
    expect(toSheetSerialDate("2026-10-01")).toBe(46296);
  });

  it("is unaffected by the host timezone", () => {
    // occurred_date 是純日期字串，不帶時區。若實作用 new Date(iso) 再取 UTC 天數，
    // 在 UTC+8 的主機上跨日邊界會整批差一天。
    const previous = process.env.TZ;
    try {
      process.env.TZ = "Pacific/Kiritimati";
      expect(toSheetSerialDate("2026-10-01")).toBe(46296);
    } finally {
      process.env.TZ = previous;
    }
  });
});
```

- [ ] **Step 2: 跑測試確認失敗，然後實作**

`src/domain/sheet-serial-date.ts`：

```ts
// Google Sheets 的日期序列值以 1899-12-30 為 0。這個原點是歷史產物（Lotus 1-2-3 的
// 1900 閏年 bug），不是任何標準 epoch，所以硬編在這裡並用測試釘住。
const SHEETS_EPOCH_UTC_MS = Date.UTC(1899, 11, 30);
const MS_PER_DAY = 86_400_000;

/**
 * 把 `YYYY-MM-DD` 轉成 Sheets 的日期序列值。
 *
 * 刻意手動解析而不是 `new Date(iso)`：後者在不同主機時區下對純日期字串的解讀會差一天，
 * 而 occurred_date 本來就不帶時區。用 Date.UTC 組出當日午夜的 UTC 毫秒，兩端一致。
 */
export function toSheetSerialDate(isoDate: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) throw new Error(`not a YYYY-MM-DD date: ${isoDate}`);
  const [, year, month, day] = match;
  const utcMs = Date.UTC(Number(year), Number(month) - 1, Number(day));
  return Math.round((utcMs - SHEETS_EPOCH_UTC_MS) / MS_PER_DAY);
}
```

- [ ] **Step 3: 寫 `sheet-rows.ts` 的失敗測試**

`tests/domain/sheet-rows.test.ts`。重點三條：

```ts
import { describe, expect, it } from "vitest";

import { allocationRows, transactionRow } from "../../src/domain/sheet-rows.js";
import type { MirrorTransaction } from "../../src/ports/sheet-sync-repository.js";

const base: MirrorTransaction = {
  transactionId: "t1",
  occurredDate: "2026-10-01",
  occurredTime: null,
  amount: "332",
  accountFromName: null,
  accountToName: null,
  merchantName: null,
  counterpartyName: null,
  note: null,
  rawInputSnapshot: "午餐 332",
  status: "confirmed",
  confirmedAt: "2026-10-01T04:00:00.000Z",
  updatedAt: "2026-10-01T04:00:00.000Z",
  allocations: [],
};

describe("transactionRow", () => {
  it("writes the amount as a number and the date as a serial date", () => {
    // 金額必須是 numberValue，否則使用者在 Sheet 裡不能 SUM——那是做這個功能的全部理由。
    const row = transactionRow(base);

    expect(row[3]).toEqual({ kind: "number", value: 332 });
    expect(row[1]).toEqual({ kind: "date", value: 46296 });
  });

  it("writes free text as a string cell even when it looks like a formula", () => {
    // Review Focus #2。備註與原始輸入是使用者自由輸入。若以 USER_ENTERED 寫入，
    // 一則以 = 開頭的備註會變成 Sheet 裡的實際公式——可能跳出權限提示、可能顯示
    // #ERROR!、也可能真的去抓外部資料。明確指定 string 讓這件事結構上不可能發生。
    const row = transactionRow({ ...base, note: "=IMPORTXML(1,2)", rawInputSnapshot: "+886 電話" });

    expect(row[8]).toEqual({ kind: "string", value: "=IMPORTXML(1,2)" });
    expect(row[9]).toEqual({ kind: "string", value: "+886 電話" });
  });

  it("writes an empty cell for a missing optional field rather than the text null", () => {
    const row = transactionRow(base);

    expect(row[2]).toEqual({ kind: "empty" });
    expect(row[4]).toEqual({ kind: "empty" });
  });
});

describe("allocationRows", () => {
  it("denormalises the transaction's date and status onto every allocation", () => {
    // 這兩欄是 Allocations 分頁能不能用的關鍵：有了它們才能直接做樞紐分析、
    // 直接篩掉已刪除的，不必 VLOOKUP 回 Transactions。
    const rows = allocationRows({
      ...base,
      status: "deleted",
      allocations: [
        {
          allocationId: "a1",
          fundsEffect: "outflow",
          purpose: "expense",
          amount: "332",
          categoryName: "餐飲",
          subcategoryName: "午餐",
          counterpartyName: null,
          note: null,
        },
      ],
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.[2]).toEqual({ kind: "date", value: 46296 });
    expect(rows[0]?.[10]).toEqual({ kind: "string", value: "deleted" });
  });
});
```

- [ ] **Step 4: 實作 `sheet-rows.ts`**

```ts
import type { MirrorTransaction } from "../ports/sheet-sync-repository.js";

import { toSheetSerialDate } from "./sheet-serial-date.js";

/**
 * 一個儲存格的值與它的型別。型別由我們明確決定，不交給 Sheets 去猜——
 * 交給它猜就等於開放公式注入（見 spec §4）。
 */
export type SheetCell =
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "date"; readonly value: number }
  | { readonly kind: "empty" };

const text = (value: string | null): SheetCell =>
  value === null || value === "" ? { kind: "empty" } : { kind: "string", value };

const money = (value: string): SheetCell => ({ kind: "number", value: Number(value) });

const date = (value: string): SheetCell => ({ kind: "date", value: toSheetSerialDate(value) });

export const TRANSACTIONS_HEADER = [
  "transaction_id", "日期", "時間", "金額", "轉出帳戶", "轉入帳戶",
  "商家", "對象", "備註", "原始輸入", "狀態", "確認時間", "更新時間",
] as const;

export const ALLOCATIONS_HEADER = [
  "allocation_id", "transaction_id", "日期", "資金流向", "用途", "金額",
  "分類", "子分類", "對象", "備註", "交易狀態",
] as const;

export const MONTHLY_SUMMARY_HEADER = [
  "月份", "實際流入", "實際流出", "淨現金流", "個人收入",
  "個人支出毛額", "退款", "個人支出淨額", "個人結餘", "更新時間",
] as const;

export function transactionRow(txn: MirrorTransaction): SheetCell[] {
  return [
    text(txn.transactionId),
    date(txn.occurredDate),
    text(txn.occurredTime),
    money(txn.amount),
    text(txn.accountFromName),
    text(txn.accountToName),
    text(txn.merchantName),
    text(txn.counterpartyName),
    text(txn.note),
    text(txn.rawInputSnapshot),
    text(txn.status),
    text(txn.confirmedAt),
    text(txn.updatedAt),
  ];
}

export function allocationRows(txn: MirrorTransaction): SheetCell[][] {
  return txn.allocations.map((allocation) => [
    text(allocation.allocationId),
    text(txn.transactionId),
    date(txn.occurredDate),
    text(allocation.fundsEffect),
    text(allocation.purpose),
    money(allocation.amount),
    text(allocation.categoryName),
    text(allocation.subcategoryName),
    text(allocation.counterpartyName),
    text(allocation.note),
    text(txn.status),
  ]);
}
```

**注意 `money()` 用了 `Number(value)`。** 這是 spec §4 明載的、經過裁決的例外：Sheet 是給人
分析的投影，寫成文字就不能 SUM。SQLite 仍是唯一真相，`Decimal` 仍管所有運算。
這一行要帶著上面那段註解，否則下一個讀者會以為是違規。

- [ ] **Step 5: 跑測試、完整檢查、提交**

```bash
git add src/domain/sheet-serial-date.ts src/domain/sheet-rows.ts \
        tests/domain/sheet-serial-date.test.ts tests/domain/sheet-rows.test.ts
git commit -m "feat: 把交易與配置投影成具型別的儲存格"
```

- [ ] **Step 6: 變異驗證（三個，逐一做）**

1. `text()` 改成 `{ kind: "string", value: String(value) }`（不分空值）。
   Expected：`writes an empty cell for a missing optional field` 變紅。
2. `money()` 改成 `text(value)`。Expected：`writes the amount as a number` 變紅。
3. `SHEETS_EPOCH_UTC_MS` 改成 `Date.UTC(1900, 0, 1)`。
   Expected：`maps the sheets epoch to zero` 與 `maps a known date to its serial value` 變紅。

---

## Task 4：受影響月份與月度摘要列

**Files:**
- Create: `src/domain/sheet-months.ts`
- Test: `tests/domain/sheet-months.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `MirrorTransaction`
- Produces: `affectedMonths(changed, previousDatesById): string[]`、
  `monthRange(month): { from: string; to: string }`、
  `monthlySummaryRow(month, summary, now): SheetCell[]`

**這個 task 擁有 Review Focus #1**（跨月搬移）。

- [ ] **Step 1: 寫失敗的測試**

`tests/domain/sheet-months.test.ts`：

```ts
import { describe, expect, it } from "vitest";

import { affectedMonths, monthRange, monthlySummaryRow } from "../../src/domain/sheet-months.js";

describe("affectedMonths", () => {
  it("returns the month of each changed transaction", () => {
    expect(
      affectedMonths([{ transactionId: "t1", occurredDate: "2026-10-05" }], new Map()),
    ).toEqual(["2026-10"]);
  });

  it("also returns the month the transaction moved away from", () => {
    // Review Focus #1。一筆交易從 9 月被改到 10 月：兩個月的摘要都變了，但只看
    // 新資料只知道 10 月。9 月會靜默停在錯的數字，而且沒有任何東西會報錯。
    // Sheet 上那一列的舊日期是唯一能知道舊月份的來源，而我們本來就要讀它。
    const previous = new Map([["t1", "2026-09-28"]]);

    expect(affectedMonths([{ transactionId: "t1", occurredDate: "2026-10-05" }], previous)).toEqual(
      ["2026-09", "2026-10"],
    );
  });

  it("does not duplicate a month when several transactions share it", () => {
    expect(
      affectedMonths(
        [
          { transactionId: "t1", occurredDate: "2026-10-05" },
          { transactionId: "t2", occurredDate: "2026-10-20" },
        ],
        new Map(),
      ),
    ).toEqual(["2026-10"]);
  });

  it("ignores an unchanged date rather than listing the month twice", () => {
    const previous = new Map([["t1", "2026-10-05"]]);

    expect(affectedMonths([{ transactionId: "t1", occurredDate: "2026-10-05" }], previous)).toEqual(
      ["2026-10"],
    );
  });
});

describe("monthlySummaryRow", () => {
  it("places each of the eight figures under its own heading", () => {
    // 2026-10-01 補：原本這份計畫完全沒有測 monthlySummaryRow —— 相鄰兩個欄位對調
    // 會讓使用者的試算表把錯的數字放在錯的標題下，而整套檢查不會有任何反應。
    // 標題列與資料列是由兩段不同的程式寫出去的，所以位置必須逐一釘住。
    const summary = {
      actualInflow: { amount: "1", currency: "TWD" as const },
      actualOutflow: { amount: "2", currency: "TWD" as const },
      netCashFlow: { amount: "3", currency: "TWD" as const },
      personalIncome: { amount: "4", currency: "TWD" as const },
      grossPersonalExpense: { amount: "5", currency: "TWD" as const },
      refunds: { amount: "6", currency: "TWD" as const },
      netPersonalExpense: { amount: "7", currency: "TWD" as const },
      personalBalance: { amount: "8", currency: "TWD" as const },
      categories: [],
    };

    const row = monthlySummaryRow("2026-10", summary, new Date("2026-10-01T00:00:00.000Z"));

    expect(row).toEqual([
      { kind: "string", value: "2026-10" },
      { kind: "number", value: 1 },
      { kind: "number", value: 2 },
      { kind: "number", value: 3 },
      { kind: "number", value: 4 },
      { kind: "number", value: 5 },
      { kind: "number", value: 6 },
      { kind: "number", value: 7 },
      { kind: "number", value: 8 },
      { kind: "string", value: "2026-10-01T00:00:00.000Z" },
    ]);
  });
});

describe("affectedMonths sorting", () => {
  it("returns months sorted regardless of the order they were discovered", () => {
    // 排序原本只是「剛好」被跨月那條測到（它的 fixture 正好是反序）。
    // 這條直接咬住排序本身。
    expect(
      affectedMonths(
        [
          { transactionId: "t1", occurredDate: "2026-12-01" },
          { transactionId: "t2", occurredDate: "2026-01-01" },
          { transactionId: "t3", occurredDate: "2026-06-01" },
        ],
        new Map(),
      ),
    ).toEqual(["2026-01", "2026-06", "2026-12"]);
  });
});

describe("monthRange", () => {
  it("covers the whole month including the last day", () => {
    // 月底若算錯（例如用 30 天），每個月的最後一天都會從摘要裡消失。
    expect(monthRange("2026-10")).toEqual({ from: "2026-10-01", to: "2026-10-31" });
  });

  it("handles february in a leap year", () => {
    expect(monthRange("2028-02")).toEqual({ from: "2028-02-01", to: "2028-02-29" });
  });
});
```

- [ ] **Step 2: 實作**

`src/domain/sheet-months.ts`：

```ts
import type { LedgerSummary } from "./ledger-summary.js";
import type { SheetCell } from "./sheet-rows.js";

export interface DatedTransaction {
  readonly transactionId: string;
  readonly occurredDate: string;
}

const monthOf = (isoDate: string): string => isoDate.slice(0, 7);

/**
 * 哪些月份的摘要需要重算。
 *
 * `previousDatesById` 是 Sheet 上這些 transaction_id 現有的日期。它存在的唯一理由是
 * 跨月搬移：一筆交易從 9 月改到 10 月時，兩個月的摘要都變了，但只看新資料只知道
 * 10 月，9 月會靜默停在錯的數字。Sheet 上的舊值是唯一能知道舊月份的來源，
 * 而同步本來就要讀 Transactions 分頁的鍵欄，順便讀日期欄不增加任何呼叫。
 */
export function affectedMonths(
  changed: readonly DatedTransaction[],
  previousDatesById: ReadonlyMap<string, string>,
): string[] {
  const months = new Set<string>();
  for (const txn of changed) {
    months.add(monthOf(txn.occurredDate));
    const previous = previousDatesById.get(txn.transactionId);
    if (previous !== undefined) months.add(monthOf(previous));
  }
  return [...months].sort();
}

/** `YYYY-MM` → 該月第一天與最後一天，供 SummaryRepository.summarize 使用。 */
export function monthRange(month: string): { from: string; to: string } {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) throw new Error(`not a YYYY-MM month: ${month}`);
  const [, year, monthNumber] = match;
  // 下個月的第 0 天就是這個月的最後一天，閏年與大小月都不必自己算。
  const lastDay = new Date(Date.UTC(Number(year), Number(monthNumber), 0)).getUTCDate();
  return {
    from: `${month}-01`,
    to: `${month}-${String(lastDay).padStart(2, "0")}`,
  };
}

export function monthlySummaryRow(
  month: string,
  summary: LedgerSummary,
  now: Date,
): SheetCell[] {
  const money = (value: string): SheetCell => ({ kind: "number", value: Number(value) });
  return [
    { kind: "string", value: month },
    money(summary.actualInflow.amount),
    money(summary.actualOutflow.amount),
    money(summary.netCashFlow.amount),
    money(summary.personalIncome.amount),
    money(summary.grossPersonalExpense.amount),
    money(summary.refunds.amount),
    money(summary.netPersonalExpense.amount),
    money(summary.personalBalance.amount),
    { kind: "string", value: now.toISOString() },
  ];
}
```

月度摘要**不需要自己聚合**：既有的 `SqliteSummaryRepository.summarize(ownerId, range)` 已經
回傳 `LedgerSummary`，而且它的 SQL 已經過濾 `t.status = 'confirmed'`，已刪除的交易自動
排除，正是 spec §4 要的語意。不要重寫一份。

- [ ] **Step 3: 跑測試、完整檢查、提交**

```bash
git add src/domain/sheet-months.ts tests/domain/sheet-months.test.ts
git commit -m "feat: 算出受影響的月份，含跨月搬移的舊月份"
```

- [ ] **Step 4: 變異驗證（兩個）**

1. 把 `affectedMonths` 裡處理 `previous` 的兩行刪掉。
   Expected：`also returns the month the transaction moved away from` 變紅。
2. `monthRange` 的 `to` 改成固定 `-30`。
   Expected：`covers the whole month including the last day` 與
   `handles february in a leap year` 變紅。

---

## Task 5：`SheetsClient` port 與位置定址模擬器

**Files:**
- Create: `src/ports/sheets-client.ts`
- Create: `tests/support/fake-sheets-client.ts`
- Test: `tests/support/fake-sheets-client.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `SheetCell`
- Produces: `SheetsClient`、`CellWrite`、`FakeSheetsClient`

- [ ] **Step 1: 寫 port**

`src/ports/sheets-client.ts`：

```ts
import type { SheetCell } from "../domain/sheet-rows.js";

/** 一次寫入：把 `cells` 放到 `tab` 的第 `rowIndex` 列（1-based，第 1 列是標題）。 */
export interface CellWrite {
  readonly tab: string;
  readonly rowIndex: number;
  readonly cells: readonly SheetCell[];
}

/**
 * 刻意收窄的介面：鏡像只需要這兩個呼叫。窄介面讓測試不必假造整個 googleapis，
 * 也讓 domain 與 application 不可能碰到它。
 */
export interface SheetsClient {
  /** 讀 `tab` 的前 `columnCount` 欄（含標題列）。回傳的是原始字串，空格為空字串。 */
  readColumns(tab: string, columnCount: number): Promise<string[][]>;
  /** 批次寫入。實作必須是全有全無：任何一格失敗就整批拋錯。 */
  updateCells(writes: readonly CellWrite[]): Promise<void>;
}
```

- [ ] **Step 2: 寫模擬器的失敗測試**

模擬器**必須真的模擬位置定址**，否則「以 id 為鍵 upsert」在測試裡是恆真的。
`tests/support/fake-sheets-client.test.ts`：

```ts
import { describe, expect, it } from "vitest";

import { FakeSheetsClient } from "./fake-sheets-client.js";

describe("FakeSheetsClient", () => {
  it("grows the sheet when a write lands past the current extent", async () => {
    // 真實 Sheets 允許寫到超出現有資料的列，中間會補空白列。模擬器若拋錯或靜默丟棄，
    // 「新 id 附加到最後」這條路徑在測試裡就永遠走不到。
    const client = new FakeSheetsClient({ Transactions: [["transaction_id"]] });

    await client.updateCells([
      { tab: "Transactions", rowIndex: 4, cells: [{ kind: "string", value: "t1" }] },
    ]);

    const rows = await client.readColumns("Transactions", 1);
    expect(rows).toEqual([["transaction_id"], [""], [""], ["t1"]]);
  });

  it("overwrites in place when a write targets an existing row", async () => {
    const client = new FakeSheetsClient({
      Transactions: [["transaction_id"], ["t1"], ["t2"]],
    });

    await client.updateCells([
      { tab: "Transactions", rowIndex: 2, cells: [{ kind: "string", value: "changed" }] },
    ]);

    expect(await client.readColumns("Transactions", 1)).toEqual([
      ["transaction_id"],
      ["changed"],
      ["t2"],
    ]);
  });

  it("renders a date cell as its serial number, not as an iso string", async () => {
    // 真實 Sheets 存的是序列值。模擬器若把日期存成 ISO 字串，Task 4 的
    // 「讀回舊日期算受影響月份」在測試裡會用到錯的格式而假性通過。
    const client = new FakeSheetsClient({ Transactions: [["id", "日期"]] });

    await client.updateCells([
      {
        tab: "Transactions",
        rowIndex: 2,
        cells: [{ kind: "string", value: "t1" }, { kind: "date", value: 46296 }],
      },
    ]);

    expect(await client.readColumns("Transactions", 2)).toEqual([
      ["id", "日期"],
      ["t1", "46296"],
    ]);
  });

  it("fails the whole batch when any write is invalid", async () => {
    // updateCells 的契約是全有全無。模擬器若逐格套用再拋錯，
    // 「失敗時游標不推進、下一輪重做」就會在一個半寫入的狀態上重做。
    const client = new FakeSheetsClient({ Transactions: [["id"], ["t1"]] });

    await expect(
      client.updateCells([
        { tab: "Transactions", rowIndex: 2, cells: [{ kind: "string", value: "ok" }] },
        { tab: "NoSuchTab", rowIndex: 2, cells: [{ kind: "string", value: "boom" }] },
      ]),
    ).rejects.toThrow(/NoSuchTab/);

    expect(await client.readColumns("Transactions", 1)).toEqual([["id"], ["t1"]]);
  });

  it("counts api calls so tests can assert none happen when idle", async () => {
    // Task 9 的「閒置時不打 API」需要這個計數器才能被釘住。
    const client = new FakeSheetsClient({ Transactions: [["id"]] });

    await client.readColumns("Transactions", 1);
    expect(client.callCount).toBe(1);
  });
});
```

- [ ] **Step 3: 實作模擬器**

`tests/support/fake-sheets-client.ts`：

```ts
import type { SheetCell } from "../../src/domain/sheet-rows.js";
import type { CellWrite, SheetsClient } from "../../src/ports/sheets-client.js";

const render = (cell: SheetCell): string => {
  switch (cell.kind) {
    case "string":
      return cell.value;
    case "number":
    case "date":
      return String(cell.value);
    case "empty":
      return "";
  }
};

/**
 * 位置定址的模擬器，不是樁。它真的維護一個二維字串陣列、真的用列索引定位、
 * 真的在寫到超出範圍時補空白列——因為「以 id 為鍵 upsert」的正確性完全建立在
 * 列索引算對了，樁式的替身會讓那件事在測試裡恆真。
 */
export class FakeSheetsClient implements SheetsClient {
  public callCount = 0;
  public failNextWith: Error | null = null;
  private readonly tabs: Map<string, string[][]>;

  public constructor(initial: Record<string, string[][]> = {}) {
    this.tabs = new Map(Object.entries(initial).map(([tab, rows]) => [tab, rows.map((r) => [...r])]));
  }

  public readColumns(tab: string, columnCount: number): Promise<string[][]> {
    this.callCount += 1;
    if (this.failNextWith) {
      const error = this.failNextWith;
      this.failNextWith = null;
      return Promise.reject(error);
    }
    const rows = this.tabs.get(tab);
    if (!rows) return Promise.reject(new Error(`no such tab: ${tab}`));
    return Promise.resolve(
      rows.map((row) => Array.from({ length: columnCount }, (_, i) => row[i] ?? "")),
    );
  }

  public updateCells(writes: readonly CellWrite[]): Promise<void> {
    this.callCount += 1;
    if (this.failNextWith) {
      const error = this.failNextWith;
      this.failNextWith = null;
      return Promise.reject(error);
    }
    // 全有全無：先驗證每一筆，再套用。半套用會讓「失敗就重做」在髒狀態上重做。
    for (const write of writes) {
      if (!this.tabs.has(write.tab)) return Promise.reject(new Error(`no such tab: ${write.tab}`));
      if (write.rowIndex < 1) return Promise.reject(new Error(`row index must be 1-based`));
    }
    for (const write of writes) {
      const rows = this.tabs.get(write.tab) as string[][];
      while (rows.length < write.rowIndex) rows.push([]);
      rows[write.rowIndex - 1] = write.cells.map(render);
    }
    return Promise.resolve();
  }

  /** 測試輔助：直接看某個分頁目前的內容。 */
  public snapshot(tab: string): string[][] {
    return (this.tabs.get(tab) ?? []).map((row) => [...row]);
  }
}
```

- [ ] **Step 4: 跑測試、完整檢查、提交**

```bash
git add src/ports/sheets-client.ts tests/support/fake-sheets-client.ts \
        tests/support/fake-sheets-client.test.ts
git commit -m "feat: 加入 SheetsClient port 與位置定址模擬器"
```

- [ ] **Step 5: 變異驗證（兩個）**

1. `updateCells` 把「先驗證再套用」改成單一迴圈邊驗證邊套用。
   Expected：`fails the whole batch when any write is invalid` 變紅。
2. `while (rows.length < write.rowIndex) rows.push([])` 刪掉。
   Expected：`grows the sheet when a write lands past the current extent` 變紅。

---

## Task 6：增量同步引擎

**Files:**
- Create: `src/sheets/sheet-mirror.ts`
- Test: `tests/sheets/sheet-mirror.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `SheetSyncRepository`、Task 3 的 `transactionRow`／`allocationRows`、
  Task 4 的 `affectedMonths`／`monthRange`／`monthlySummaryRow`、Task 5 的 `SheetsClient`，
  以及既有的 `SummaryRepository`
- Produces: `createSheetMirror(deps): SheetMirror`，`SheetMirror.syncOnce(): Promise<SyncOutcome>`

**這個 task 擁有 Review Focus #3**（手動插入／刪除列）。

- [ ] **Step 1: 寫失敗的測試**

`tests/sheets/sheet-mirror.test.ts`：

```ts
import { describe, expect, it, vi } from "vitest";

import { toSheetSerialDate } from "../../src/domain/sheet-serial-date.js";
import type {
  MirrorTransaction,
  SheetSyncRepository,
  SheetSyncState,
} from "../../src/ports/sheet-sync-repository.js";
import type { SummaryRepository } from "../../src/ports/summary-repository.js";
import { createSheetMirror } from "../../src/sheets/sheet-mirror.js";
import { FakeSheetsClient } from "../support/fake-sheets-client.js";

const OWNER = "owner-1";
const NOW = new Date("2026-10-01T05:00:00.000Z");

function transaction(overrides: Partial<MirrorTransaction> = {}): MirrorTransaction {
  return {
    transactionId: "t1",
    occurredDate: "2026-10-05",
    occurredTime: null,
    amount: "100",
    accountFromName: null,
    accountToName: null,
    merchantName: null,
    counterpartyName: null,
    note: null,
    rawInputSnapshot: null,
    status: "confirmed",
    confirmedAt: "2026-10-05T00:00:00.000Z",
    updatedAt: "2026-10-05T00:00:00.000Z",
    allocations: [],
    ...overrides,
  };
}

const ZERO_SUMMARY = {
  actualInflow: { amount: "0", currency: "TWD" as const },
  actualOutflow: { amount: "0", currency: "TWD" as const },
  netCashFlow: { amount: "0", currency: "TWD" as const },
  personalIncome: { amount: "0", currency: "TWD" as const },
  grossPersonalExpense: { amount: "0", currency: "TWD" as const },
  refunds: { amount: "0", currency: "TWD" as const },
  netPersonalExpense: { amount: "0", currency: "TWD" as const },
  personalBalance: { amount: "0", currency: "TWD" as const },
  categories: [],
};

function harness(options: {
  changed: MirrorTransaction[];
  sheet?: Record<string, string[][]>;
  state?: Partial<SheetSyncState>;
}) {
  const saved: SheetSyncState[] = [];
  const state: SheetSyncState = {
    ownerId: OWNER,
    cursorUpdatedAt: null,
    cursorTransactionId: null,
    lastSuccessAt: null,
    lastError: null,
    consecutiveFailures: 0,
    lastReconciledAt: null,
    ...options.state,
  };
  const syncRepository: SheetSyncRepository = {
    loadSyncState: () => Promise.resolve(state),
    saveSyncState: (next) => {
      saved.push(next);
      return Promise.resolve();
    },
    listChangedTransactions: () => Promise.resolve(options.changed),
  };
  const summarize = vi.fn(() => Promise.resolve(ZERO_SUMMARY));
  const summaryRepository = { summarize } as unknown as SummaryRepository;
  const sheets = new FakeSheetsClient(
    options.sheet ?? {
      Transactions: [["transaction_id", "日期"]],
      Allocations: [["allocation_id"]],
      MonthlySummary: [["月份"]],
    },
  );
  const mirror = createSheetMirror({
    ownerId: OWNER,
    sheets,
    syncRepository,
    summaryRepository,
    now: () => NOW,
  });
  return { mirror, sheets, saved, summarize };
}

describe("sheet mirror", () => {
  it("appends a new transaction after the last row", async () => {
    // 新 id 沒有既有列號，必須附加到最後而不是覆蓋標題或任何既有資料。
    const { mirror, sheets } = harness({ changed: [transaction()] });

    await mirror.syncOnce();

    const rows = sheets.snapshot("Transactions");
    expect(rows).toHaveLength(2);
    expect(rows[1]?.[0]).toBe("t1");
  });

  it("updates in place instead of adding a second row for the same id", async () => {
    // 這就是 upsert 的意義。若每次都附加，Sheet 會隨同步次數不斷長出重複列——
    // 而 AC-22 明確要求「無重複列」。
    const { mirror, sheets } = harness({
      changed: [transaction({ amount: "999" })],
      sheet: {
        Transactions: [["transaction_id", "日期"], ["t1", String(toSheetSerialDate("2026-10-05"))]],
        Allocations: [["allocation_id"]],
        MonthlySummary: [["月份"]],
      },
    });

    await mirror.syncOnce();

    const rows = sheets.snapshot("Transactions");
    expect(rows).toHaveLength(2);
    expect(rows[1]?.[3]).toBe("999");
  });

  it("re-locates a row the user moved instead of writing to the old position", async () => {
    // Review Focus #3。使用者在資料最上方手動插入一列，t1 從第 2 列移到第 3 列。
    // 若列號來自快取或假設，更新會落在第 2 列，把使用者插入的那一列蓋掉——
    // 而且沒有任何東西會報錯，使用者只會看到資料莫名其妙變了。
    const { mirror, sheets } = harness({
      changed: [transaction({ amount: "777" })],
      sheet: {
        Transactions: [
          ["transaction_id", "日期"],
          ["使用者自己插入的一列", ""],
          ["t1", String(toSheetSerialDate("2026-10-05"))],
        ],
        Allocations: [["allocation_id"]],
        MonthlySummary: [["月份"]],
      },
    });

    await mirror.syncOnce();

    const rows = sheets.snapshot("Transactions");
    expect(rows[1]?.[0]).toBe("使用者自己插入的一列");
    expect(rows[2]?.[0]).toBe("t1");
    expect(rows[2]?.[3]).toBe("777");
  });

  it("does not advance the cursor when the write fails", async () => {
    // 失敗就整輪不推進，下一輪三張分頁全部重做（冪等）。
    // 若失敗仍推進游標，那批變更會被永久跳過，而且沒有任何東西會發現。
    const { mirror, sheets, saved } = harness({ changed: [transaction()] });
    sheets.failNextWith = new Error("boom");

    const outcome = await mirror.syncOnce();

    expect(outcome.kind).toBe("failed");
    expect(saved.filter((state) => state.cursorTransactionId === "t1")).toHaveLength(0);
  });

  it("recomputes both months when a transaction moves across a month boundary", async () => {
    // Review Focus #1 在引擎層的對應測試。Sheet 上 t1 的舊日期是 9/28，
    // 新資料是 10/05。若只用新日期，9 月的摘要會靜默停在錯的數字。
    const { mirror, summarize } = harness({
      changed: [transaction({ occurredDate: "2026-10-05" })],
      sheet: {
        Transactions: [["transaction_id", "日期"], ["t1", String(toSheetSerialDate("2026-09-28"))]],
        Allocations: [["allocation_id"]],
        MonthlySummary: [["月份"]],
      },
    });

    await mirror.syncOnce();

    const ranges = summarize.mock.calls.map((call) => (call as unknown as [string, { from: string }])[1].from);
    expect(ranges).toEqual(["2026-09-01", "2026-10-01"]);
  });

  it("makes no sheets call when nothing changed", async () => {
    // 配額設計的基礎（spec §7）。Task 9 的執行器也有一條同名的測試，
    // 但擋在這一層才是真的——執行器只是不呼叫它而已。
    const { mirror, sheets } = harness({ changed: [] });

    const outcome = await mirror.syncOnce();

    expect(outcome.kind).toBe("idle");
    expect(sheets.callCount).toBe(0);
  });
});
```

- [ ] **Step 2: 實作**

`src/sheets/sheet-mirror.ts` 的骨幹（完整實作依測試補齊）：

```ts
import {
  affectedMonths,
  monthRange,
  monthlySummaryRow,
} from "../domain/sheet-months.js";
import { allocationRows, transactionRow } from "../domain/sheet-rows.js";
import type { SheetsClient, CellWrite } from "../ports/sheets-client.js";
import type {
  MirrorTransaction,
  SheetSyncRepository,
  SyncCursor,
} from "../ports/sheet-sync-repository.js";
import type { SummaryRepository } from "../ports/summary-repository.js";

export const TRANSACTIONS_TAB = "Transactions";
export const ALLOCATIONS_TAB = "Allocations";
export const MONTHLY_SUMMARY_TAB = "MonthlySummary";

/** 一輪同步最多處理幾筆交易。超過的留給下一輪，游標保證不會倒退。 */
export const SYNC_BATCH = 200;

export interface SheetMirrorDependencies {
  readonly ownerId: string;
  readonly sheets: SheetsClient;
  readonly syncRepository: SheetSyncRepository;
  readonly summaryRepository: SummaryRepository;
  readonly now: () => Date;
}

export type SyncOutcome =
  | { readonly kind: "idle" }
  | { readonly kind: "synced"; readonly transactions: number; readonly months: number }
  | { readonly kind: "failed"; readonly error: unknown };

export interface SheetMirror {
  syncOnce(): Promise<SyncOutcome>;
  reconcile(): Promise<SyncOutcome>;
}
```

`syncOnce` 的流程（`reconcile` 是同一段程式，只是 cursor 傳 `null` 並在成功後寫
`last_reconciled_at`）：

1. `loadSyncState` 取游標。
2. `listChangedTransactions(ownerId, cursor, SYNC_BATCH)`。
   **空陣列就直接回 `{ kind: "idle" }`，不呼叫 `sheets` 的任何方法。**
   這一條是配額設計的基礎，Task 9 會有測試釘住它。
3. 讀 `Transactions` 分頁的 `A:B` 兩欄（鍵欄＋日期欄）、`Allocations` 的 `A:A`、
   `MonthlySummary` 的 `A:A`，各自建 `id → 列號`。
   Transactions 的日期欄同時組成 `previousDatesById`（值是序列值字串，
   需經 `Number()` 還原成序列值再轉回 `YYYY-MM-DD` 比對月份；
   若該格為空或非數字就視為沒有舊值）。
4. 組 `CellWrite[]`：既有 id 用既有列號，新 id 依序接在該分頁目前最大列號之後。
5. `affectedMonths(changed, previousDatesById)` → 每個月 `summarize(ownerId, monthRange(m))`
   → `monthlySummaryRow` → 併入同一批 `CellWrite[]`。
6. 一次 `updateCells`。
7. 成功才 `saveSyncState`，游標 = 這批最後一筆的 `(updatedAt, transactionId)`，
   `consecutiveFailures = 0`、`lastSuccessAt = now`、`lastError = null`。
8. 失敗回 `{ kind: "failed", error }`，**不推進游標**（狀態的失敗計數由 Task 8 處理）。

- [ ] **Step 3: 跑測試、完整檢查、提交**

```bash
git add src/sheets/sheet-mirror.ts tests/sheets/sheet-mirror.test.ts
git commit -m "feat: 增量同步引擎"
```

- [ ] **Step 4: 變異驗證（三個）**

1. 把步驟 3 的「每次重讀鍵欄」改成只在第一次讀、之後沿用。
   Expected：`re-locates a row the user moved` 變紅。
2. 把步驟 7 的「成功才 saveSyncState」改成無論成敗都存。
   Expected：`does not advance the cursor when the write fails` 變紅。
3. 把步驟 3 讀 `A:B` 改成只讀 `A:A`（`previousDatesById` 變成空 Map）。
   Expected：`recomputes both months when a transaction moves across a month boundary` 變紅。

---

## Task 7：收斂性與每日校正

**Files:**
- Modify: `src/sheets/sheet-mirror.ts`（補 `reconcile`）
- Test: `tests/sheets/sheet-mirror-convergence.test.ts`

**Interfaces:** Consumes Task 6 的 `SheetMirror`。Produces `SheetMirror.reconcile`。

收斂性是方案 A 的全部賣點，這個 task 就是把那個賣點變成可執行的斷言。
這三條測試比逐個函式測有力得多：它們不管實作怎麼寫，只問「最後 Sheet 對不對」。

- [ ] **Step 1: 寫失敗的測試**

```ts
describe("convergence", () => {
  it("projects sqlite onto the sheet after a sequence of changes", async () => {
    // 建立、修改、跨月搬移、軟刪除各一次，跑同步，
    // 斷言 Sheet 的三張分頁等於直接從 SQLite 算出來的期望投影。
  });

  it("is idempotent: syncing the same batch twice leaves the sheet unchanged", async () => {
    // 跑一次、記下快照、把游標倒回去再跑一次，斷言快照完全相同。
    // 這條保護的是整個設計賴以成立的前提——因為冪等，我們才敢用 >= 游標、
    // 才敢失敗就整批重做。
  });

  it("converges after the sheet is corrupted by hand", async () => {
    // 直接改 Sheet 的值、刪一列、在中間插一列，跑 reconcile()，
    // 斷言收斂回正確狀態。這是「Sheet 是 SQLite 的投影」這個不變量的執行點。
  });

  it("reconcile covers rows the delta cursor never saw", async () => {
    // 模擬那筆 M1 沒有稽核事件、且游標已經越過它的交易：
    // 游標設在它之後，跑 syncOnce() 不會處理它，跑 reconcile() 會。
  });

  it("clears a transactions row whose id no longer exists in sqlite", async () => {
    // 與配置列同一種結構性缺口，但在 Transactions 分頁上。
    // 另外：鍵欄若出現重複的 id，目前是後寫獲勝、較早那一列成為永久的殭屍列。
    // 兩者都要在校正時清掉，否則「Sheet 是 SQLite 的投影」這個不變量不成立。
  });

  it("clears an allocation row whose allocation no longer exists", async () => {
    // 2026-10-01 補（Task 6 實作者發現的缺口）。updateTransaction 是
    // 「DELETE 全部配置再 INSERT」，所以改一筆交易之後舊的 allocation_id 就永遠消失了。
    // 若鏡像只 upsert 不清理，Sheet 上會永遠留著那些已經不存在的配置列 ——
    // 使用者用 Allocations 分頁做樞紐分析時會把它們算進去，金額直接錯。
    // 這不是裝飾性的問題，是「Sheet 是 SQLite 的投影」這個不變量的破口。
    //
    // 做法：Allocations 分頁讀 A:B（allocation_id 與 transaction_id 兩欄），
    // 對每一筆處理中的交易，找出 Sheet 上掛在它底下、但已經不在它現有配置裡的列，
    // 把整列清空。清空而不是刪除列：刪除會讓列號位移，而清空是冪等的，
    // 且定位一律靠 id、不靠位置。空白列會累積，這是已知且接受的代價。
  });
});
```

- [ ] **Step 2: 實作 `reconcile`**

`reconcile()` 就是 `syncOnce()` 傳 `cursor = null`，成功後除了游標之外多寫
`lastReconciledAt = now`。**不要複製一份流程** —— 複製出來的第二條路徑會自己長出 bug
而且沒人會發現（spec §3）。用同一個內部函式，差別只在 cursor 與要不要寫
`lastReconciledAt`。

> **2026-10-01 更正（Task 6 實作時發現的計畫缺陷）：照字面做會讓游標倒退。**
> 全表掃描的第一批是最舊的交易，若直接把游標存成那一批的最後一筆，游標就從「今天」
> 倒退回幾個月前，之後的增量同步要重走一遍所有東西 —— 不會遺失資料（寫入是冪等的），
> 但每天的校正等於把整個同步重啟一次。
> **游標只能前進**：存檔前與現有游標比較，取較晚的那一個。Task 6 已實作 `laterCursor()`，
> 在增量路徑上是 no-op。

**`reconcile` 必須在一次呼叫內自己分頁，用自己的區域游標。**

> **2026-10-01 更正。** 這裡原本寫「一次只處理一批，游標推進，下一輪繼續」——
> 那句話在 `laterCursor` 之後是**假的**，兩者直接矛盾。

問題：`reconcile` 傳 `cursor = null`，查詢永遠回傳**最舊**的 `SYNC_BATCH` 筆；
`laterCursor` 又會把這一批的推進丟掉（持久游標已經在前面）。結果是每次校正都只重驗最舊的
200 筆，**永遠到不了其餘資料**。Task 6 審查實測 250 筆交易連跑五次 `reconcile`：
每次都停在 `cursor=t0199`、Sheet 上 200 列，而 `reconcile` 仍回報 `synced`。

這會殺掉自我修復，而自我修復是這整個設計的賣點（spec §2、§9）：被手動改壞的第 500 列
永遠不會被修正。

做法：`reconcile()` 用一個**區域**游標在一次呼叫內往前分頁，直到查詢回傳少於 `SYNC_BATCH`
筆為止，並加一個迭代上限當保險。持久游標仍然只透過 `laterCursor` 前進。

**必須有一條跨越 `SYNC_BATCH` 邊界的測試**：用比 `SYNC_BATCH` 多的交易跑一次 `reconcile`，
斷言最後一筆也出現在 Sheet 上。沒有這條測試，這個洞會再一次全綠出貨。

- [ ] **Step 3: 跑測試、完整檢查、提交**

```bash
git add src/sheets/sheet-mirror.ts tests/sheets/sheet-mirror-convergence.test.ts
git commit -m "feat: 每日全表校正與收斂性測試"
```

- [ ] **Step 4: 變異驗證**

把 `reconcile` 改成直接呼叫 `syncOnce`（即不把 cursor 設成 null）。
Expected：`reconcile covers rows the delta cursor never saw` 與
`converges after the sheet is corrupted by hand` 變紅。

---

## Task 8：失敗分類與升級

**Files:**
- Create: `src/sheets/sheet-failure.ts`
- Modify: `src/sheets/sheet-mirror.ts`（失敗時更新 `consecutiveFailures`／`lastError`）
- Test: `tests/sheets/sheet-failure.test.ts`、`tests/sheets/sheet-mirror-failure.test.ts`

**Interfaces:** Produces `classifySheetFailure(error): SheetFailureKind`（`"transient" | "permanent"`）、
`ESCALATE_AFTER_FAILURES = 5`。

- [ ] **Step 1: 寫失敗分類的測試與實作**

```ts
// tests/sheets/sheet-failure.test.ts
it.each([429, 500, 502, 503, 504])("treats %i as transient", (status) => {
  expect(classifySheetFailure({ code: status })).toBe("transient");
});

it.each([400, 401, 403, 404])("treats %i as permanent", (status) => {
  // 403 是「試算表沒分享給服務帳號」，404 是「試算表被刪」。這兩種會無聲地
  // 永遠重試下去，必須升級成使用者看得到的通知，否則鏡像停了沒人知道。
  expect(classifySheetFailure({ code: status })).toBe("permanent");
});

it("treats a network error with no status as transient", () => {
  expect(classifySheetFailure(new Error("ETIMEDOUT"))).toBe("transient");
});
```

實作 `src/sheets/sheet-failure.ts`：從 googleapis 的錯誤物件取 `code`（數字）或
`response.status`；取不到就當 `transient`（**寧可重試也不要誤判成永久而停掉鏡像**）。

- [ ] **Step 2: 失敗計數與升級**

`syncOnce` 失敗時：`consecutiveFailures += 1`、`lastError = 錯誤的類別與狀態碼`
（**不得寫入訊息本文或財務原文**）、游標不動。成功時歸零。

`consecutiveFailures` 達到 `ESCALATE_AFTER_FAILURES`（5）時呼叫注入的
`onNeedsAttention(state)`，由 Task 11／12 接到 Telegram 通知。節流沿用 M4
`notify-attention.ts` 的形狀，**包含「只在送出成功時寫入節流時間」這條已經裁決過的語意**
（失敗的通知沒到達使用者，不該消耗節流窗口）。

測試要釘住：
- 連續 4 次失敗不通知，第 5 次通知。
- 中間成功一次會把計數歸零，因此不會在第 5 次累計時誤觸。
- 通知本身失敗不會讓 `syncOnce` 拋錯（best-effort）。

- [ ] **Step 3: 提交與變異驗證**

```bash
git commit -m "feat: Sheets 失敗分類與連續失敗升級"
```

變異：把成功時的 `consecutiveFailures = 0` 拿掉。
Expected：`resets the failure count after a success` 變紅。

---

## Task 9：週期執行器

**Files:**
- Create: `src/sheets/sheet-mirror-runner.ts`
- Test: `tests/sheets/sheet-mirror-runner.test.ts`

**Interfaces:** Produces `createSheetMirrorRunner(deps): SheetMirrorRunner`
（`start()`／`stop()`／`syncNow()`）、`SYNC_INTERVAL_MS = 20_000`、
`RECONCILE_HOUR = 4`。

形狀比照 `src/telegram/outbox-runner.ts`：`setInterval` + `timer.unref()`。

- [ ] **Step 1: 寫失敗的測試**

```ts
it("makes no api call when nothing changed", async () => {
  // 這是整個配額設計的基礎（spec §7）：Sheets API 每使用者每分鐘 60 次寫入，
  // 20 秒 tick 若無條件同步就會空轉逼近上限。這種「省略某件事」的保證特別容易
  // 只存在於註解裡——M4 就有一條宣稱在真實參數下並不成立。
  const { runner, sheets } = harness({ changed: [] });

  await runner.syncNow();

  expect(sheets.callCount).toBe(0);
});

it("does call the api when something changed", async () => {
  // 上面那條若因為別的原因（例如同步整個壞掉）而通過，這條會抓到。
  const { runner, sheets } = harness({ changed: [transaction("t1")] });

  await runner.syncNow();

  expect(sheets.callCount).toBeGreaterThan(0);
});

it("unrefs its timer so the process can exit", () => {
  // 沒有 unref 的話 LEDGER_STARTUP_CHECK 探針會掛住不退出——M4 踩過同一個坑。
  const { runner } = harness({ changed: [] });
  runner.start();
  // 斷言 setInterval 回傳的 Timeout 的 hasRef() 為 false，
  // 做法比照 tests/telegram/outbox-runner.test.ts 既有的 unref 測試。
  runner.stop();
});

it("swallows and logs a rejected background sync instead of killing the process", async () => {
  // M4 的 C1：void 一個會 reject 的 promise，Node 24 預設會終止行程，
  // 而 compose 是 restart: unless-stopped——每 20 秒一次的 crash loop。
  // 這裡從第一天就做對，不要重蹈。
});

it("runs a full reconcile once a day at the configured hour", async () => {
  // lastReconciledAt 是昨天且現在是 04:xx → 走 reconcile；
  // 已經是今天校正過 → 走一般增量。
});
```

- [ ] **Step 2: 實作**

關鍵點：

- `setInterval(() => { syncTick().catch((error) => { logger.error("sheet sync failed", { error }); }); }, SYNC_INTERVAL_MS)` ——
  **`.catch` 不可省**（見上面第四條測試）。
- `timer.unref()`。
- `syncTick()` 判斷：若 `lastReconciledAt` 不是「今天」（以 `TZ` 計）且目前時數
  `>= RECONCILE_HOUR`，走 `reconcile()`，否則走 `syncOnce()`。
  日期與時數一律經 `src/timezone.ts` 的 `dateInTimezone`／`timeOfDayInTimezone`，
  不要自己算 —— M4 已經裁決過 `/status` 必須用設定的時區，同一條規則適用。

- [ ] **Step 3: 提交與變異驗證（兩個）**

```bash
git commit -m "feat: Sheets 鏡像的週期執行器"
```

1. 把「沒有變更就不打 API」的提前返回拿掉。Expected：`makes no api call when nothing changed` 變紅。
2. 把 `.catch(...)` 拿掉。Expected：`swallows and logs a rejected background sync` 變紅。

---

## Task 10：Google adapter、設定與接線

**Files:**
- Create: `src/sheets/google-sheets-client.ts`
- Modify: `src/config.ts`、`src/logger.ts`、`src/main.ts`、`package.json`（加 `googleapis` 依賴）
- Test: `tests/config.test.ts`（擴充）、`tests/logger.test.ts`（擴充）、`tests/smoke/runtime.test.ts`（擴充）

**這個 task 擁有 Review Focus #5**（設定只設了一半）。

- [ ] **Step 1: 設定**

`src/config.ts` 的 `envSchema` 加兩個**選填**欄位：

```ts
  GOOGLE_SERVICE_ACCOUNT_KEY_FILE: z.string().trim().min(1).optional(),
  SHEET_SPREADSHEET_ID: z.string().trim().min(1).optional(),
```

`AppConfig` 加 `readonly sheets: { keyFile: string; spreadsheetId: string } | null;`

**兩個都沒設 → `sheets: null`，鏡像整個關閉，bot 照常運作。**
**只設一個 → `loadConfig` 拋錯並明確說明缺哪一個。** 沉默地半開啟比直接失敗糟得多：
使用者會以為鏡像在跑，實際上什麼都沒發生，而且沒有任何訊號。

測試（`tests/config.test.ts`）：

```ts
it("leaves the sheets mirror off when neither variable is set", () => {
  expect(loadConfig(baseEnv).sheets).toBeNull();
});

it("enables the mirror when both are set", () => {
  expect(
    loadConfig({ ...baseEnv, GOOGLE_SERVICE_ACCOUNT_KEY_FILE: "/k.json", SHEET_SPREADSHEET_ID: "s1" })
      .sheets,
  ).toEqual({ keyFile: "/k.json", spreadsheetId: "s1" });
});

it.each([
  ["GOOGLE_SERVICE_ACCOUNT_KEY_FILE", { GOOGLE_SERVICE_ACCOUNT_KEY_FILE: "/k.json" }],
  ["SHEET_SPREADSHEET_ID", { SHEET_SPREADSHEET_ID: "s1" }],
])("refuses to start when only %s is set", (_name, partial) => {
  // Review Focus #5。半開啟狀態下鏡像靜默不運作，使用者不會發現。
  expect(() => {
    loadConfig({ ...baseEnv, ...partial });
  }).toThrow(/SHEET_SPREADSHEET_ID|GOOGLE_SERVICE_ACCOUNT_KEY_FILE/);
});
```

- [ ] **Step 2: 日誌遮罩**

`src/logger.ts` 的 `DENYLISTED_FIELDS` 加 `spreadsheetId`、`serviceAccountKey`、
`privateKey`、`client_email`。各補一條測試，並逐一變異驗證（拿掉任何一個都要有測試變紅）
—— M4 的教訓是遮罩清單只有被測試釘住的欄位才算數。

- [ ] **Step 3: adapter**

`src/sheets/google-sheets-client.ts` 是**唯一** import `googleapis` 的檔案。
用服務帳號金鑰檔建 `google.auth.GoogleAuth`（scope `https://www.googleapis.com/auth/spreadsheets`），
實作 `readColumns`（`spreadsheets.values.get`，range 如 `Transactions!A:B`）與
`updateCells`（`spreadsheets.batchUpdate` 的 `UpdateCellsRequest`，
每格明確給 `userEnteredValue`：`stringValue` / `numberValue`，日期額外帶
`userEnteredFormat.numberFormat = { type: "DATE" }`）。

**不得使用 `valueInputOption: USER_ENTERED`**（spec §4：公式注入）。

**`readColumns` 必須帶 `valueRenderOption: "UNFORMATTED_VALUE"`，這不是可選的。**
Google 的 `values.get` 預設是 `FORMATTED_VALUE`，日期欄會回傳 `"2026/9/28"` 這類字串；
引擎對那一欄做的是 `Number(raw)`，於是得到 NaN、舊日期被靜默丟棄，
**跨月搬移的舊月份摘要永遠不會被重算（Review Focus #1 直接失效），而所有測試依然全綠**
——因為測試替身存的是序列值。Task 6 的審查已用探針實測確認這條路徑。
`src/ports/sheets-client.ts` 的文件註解也要寫明「日期欄回傳的必須是未格式化的序列值」。

- [ ] **Step 4: 接線**

`src/main.ts`：`config.sheets` 為 null 就完全不建立 mirror 與 runner。
非 null 才建立，並在 `outboxRunner.start()` 之後 `sheetRunner.start()`，
`close()` 裡一併 `stop()`。

**同時把 Task 8 的升級接到 Telegram。** Task 8 只定義了注入點
`onNeedsAttention(state)`，真正送出通知是在這裡接的：沿用 `src/telegram/notify-attention.ts`
的形狀（best-effort、自己失敗就吞掉並記一行、節流鍵只在送出成功時寫入），
訊息內容告訴使用者「Sheets 鏡像連續失敗，請檢查試算表是否仍分享給服務帳號」，
並提示用 `/status` 查看。

**訊息內不得帶入錯誤原文**——Google 的錯誤訊息可能回帶試算表 id。只給錯誤類別與狀態碼。

測試要釘住：`onNeedsAttention` 真的被接上（把 `main.ts` 裡傳入的那個函式換成 no-op，
必須有測試變紅）。這正是 M4 AC-24 踩過的坑——元件測試全綠，但沒有人問過
「`main.ts` 有沒有真的把它接起來」。

`tests/smoke/runtime.test.ts` 補兩條：沒設定時 `composeRuntime` 不建立 runner、
有設定時建立。比照該檔既有的做法，**真的經過 `composeRuntime`**，不要只測工廠函式
—— M4 的 AC-24 就是接線層沒測而讓兩個致命變異存活。

- [ ] **Step 5: 提交與變異驗證**

```bash
git commit -m "feat: Google Sheets adapter、設定與接線"
```

變異：把 `loadConfig` 的「只設一個就拋錯」改成靜默視為關閉。
Expected：兩條 `refuses to start when only ... is set` 變紅。

---

## Task 11：`/status` 的 Sheets 區段

**Files:**
- Modify: `src/telegram/format-status.ts`、`src/telegram/handlers/status.ts`
- Test: `tests/telegram/status-command.test.ts`（擴充）

顯示：最後成功同步時間（**以設定時區呈現**，沿用 M4 的裁決）、落後筆數、
連續失敗次數、最後一個錯誤類別。鏡像關閉時顯示「未啟用」而不是空白或 0 ——
空白會讓人以為壞了。

測試要釘住每一個欄位（拿掉任一個都要有測試變紅），並釘住「未啟用」與「啟用但從未同步」
是兩種不同的顯示。

```bash
git commit -m "feat: /status 顯示 Sheets 鏡像狀態"
```

---

## Task 12：可觀測性，並收掉 outbox 的日誌待辦

**Files:**
- Modify: `src/sheets/sheet-mirror.ts`、`src/telegram/outbox-runner.ts`、
  `src/telegram/notify-attention.ts`
- Delete: `docs/todo/outbox-delivery-logging.md`
- Test: `tests/sheets/sheet-mirror-logging.test.ts`、`tests/telegram/outbox-logging.test.ts`

M4 驗收發現：刻意製造的整場遞送事故在 `docker logs` 裡沒有留下任何一行。
`/status` 顯示當下狀態，事故結束就不留痕跡，事後答不出「發生過幾次」。
兩條管線要用**同一套記錄慣例**。

補上的日誌：

| 事件 | 層級 |
|---|---|
| Sheets 同步失敗、將重試 | `info` |
| Sheets 連續失敗升級 | `warn` |
| Sheets 從失敗恢復 | `info` |
| outbox 送出失敗、排定退避重試 | `info` |
| outbox 用盡上限轉 needs_attention | `warn` |
| `notify-attention` 自己送不出去 | `warn`（目前全專案最安靜的失敗路徑） |

**可以記**：內部識別碼、錯誤類別與狀態碼、筆數、耗時。
**不可以記**：訊息本文、財務原文、帳戶／商家／對象名稱、金額。

每一行日誌都要有測試釘住（拔掉就變紅）—— 沒有測試釘住的日誌下次重構就會消失，
而那正是 `docs/todo/outbox-delivery-logging.md` 的完成標準寫的。

```bash
git rm docs/todo/outbox-delivery-logging.md
git commit -m "feat: 兩條管線的遞送事故都留下日誌痕跡"
```

---

## Task 13：真實 Sheets 整合測試與文件

**Files:**
- Create: `tests/integration/sheets.integration.test.ts`
- Create: `docs/quality/m5a-acceptance.md`
- Modify: `package.json`（`test:sheets`）、`vitest.config.ts`（排除 integration）、
  `docs/roadmap.md`

- [ ] **Step 1: 讓整合測試不進 `pnpm check`**

`vitest.config.ts`：

```ts
export default defineConfig({
  test: {
    globals: true,
    include: ["tests/**/*.test.ts"],
    // 整合測試要打真實 Google API。真實網路進了單元測試套件，套件就會隨機變紅，
    // 而一個會無故紅的套件三週後就沒人看——那比沒有套件更糟。改用 pnpm test:sheets
    // 單獨跑，並列入 M5a 的通過條件。
    exclude: ["tests/integration/**", "node_modules/**", "dist/**"],
  },
});
```

`package.json` 加：

```json
    "test:sheets": "vitest run --config vitest.integration.config.ts",
```

並新增 `vitest.integration.config.ts`，`include: ["tests/integration/**/*.test.ts"]`。

- [ ] **Step 2: 缺憑證時大聲失敗**

整合測試開頭：

```ts
const keyFile = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE;
const spreadsheetId = process.env.SHEETS_TEST_SPREADSHEET_ID;

if (!keyFile || !spreadsheetId) {
  throw new Error(
    "pnpm test:sheets 需要 GOOGLE_SERVICE_ACCOUNT_KEY_FILE 與 SHEETS_TEST_SPREADSHEET_ID。" +
      "無聲跳過的整合測試就是另一種空轉的守衛，所以這裡直接失敗。",
  );
}
```

**用專用的 `SHEETS_TEST_SPREADSHEET_ID`，不是正式的 `SHEET_SPREADSHEET_ID`** ——
整合測試會清空並重寫分頁，絕不能指向使用者真正在看的那張表。

- [ ] **Step 3: 測試內容**

對拋棄式試算表跑完整來回：建列 → 改列 → 跨月搬移 → 軟刪除 → 手動把 Sheet 改亂 →
`reconcile()` → 斷言收斂。每一步都從真實 Sheet 讀回來比對，不看記憶體狀態。

這是唯一能發現「我們對 Sheets 語意的理解是錯的」的測試。M4 的 `scripts/backup.sh`
壞了整整一個里程碑、510 條測試全綠，唯一發現它的原因是有人真的跑了一次。

**還要做替身與真實 adapter 的差分測試**（spec §9）：同一串操作分別餵給
`FakeSheetsClient` 與 `GoogleSheetsClient`，斷言兩者讀回來的內容一致。至少涵蓋
寫到超出現有範圍（補空白列）、原地覆寫、日期序列值的讀回格式、以 `=` 開頭的字串
不被當成公式。

M4 有一個潛伏 bug 同時存在於真實實作與測試替身裡，因為替身只是「回傳看起來對的東西」；
最後是靠 5 種情境的差分測試才證明兩者語意一致。替身一旦與真實行為漂移，
所有用替身寫的單元測試就同時失去意義——而且不會有任何一條變紅。

- [ ] **Step 4: 文件**

`docs/quality/m5a-acceptance.md`：三道關卡（自動驗證、程式審查、人工驗收）。
人工驗收清單要人能照著做：在真實 Sheet 上確認三張分頁能排序、能樞紐分析、金額能 SUM、
日期是真的日期（不是文字）、以 `=` 開頭的備註沒有變成公式。

`docs/roadmap.md`：M5a 標完成、記下測試數；M5 的其餘兩塊（b／c）保持未開始。

```bash
git commit -m "docs: M5a 整合測試與驗收文件"
```

---

## 完成定義

1. **自動驗證**：`pnpm check` **exit 0**；AC-21、AC-22 的測試通過。
2. **`pnpm test:sheets` 綠燈** —— 與 AC 並列，不是選配。
3. **程式審查**：對整個分支的 diff 執行 `superpowers:requesting-code-review`，逐條裁決。
4. **人工驗收**：在真實 Sheet 上完成 `docs/quality/m5a-acceptance.md` 的清單。

額外條件：

- `src/domain/` 與 `src/application/` 沒有任何 googleapis import。
- migrations `0001`–`0008` 未被修改。
- 正式日誌不含金鑰、試算表 id、財務原文。

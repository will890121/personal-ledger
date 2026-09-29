# M4 可靠性、工作佇列與可觀測性 實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓「帳本已經改了但使用者沒收到訊息」這個窗口消失，並補上 WAL、migration 前備份、日誌遮罩與 `/status`。

**Architecture:** 帳本變更與一列 outbox 訊息在**同一個 SQLite transaction** 提交；提交後立刻嘗試遞送（使用者體感不變），失敗則由每 5 秒的背景迴圈依退避重試。行程死掉留下的是過期 lease，迴圈啟動後照常規則就撈得到——「啟動恢復」因此沒有獨立的程式路徑。

**Tech Stack:** Node.js 24、TypeScript 6（strict ESM，import 一律帶 `.js`）、better-sqlite3、Zod 4、grammY、Vitest。

**Spec:** [`docs/superpowers/specs/2026-09-29-m4-reliability-design.md`](../specs/2026-09-29-m4-reliability-design.md)

## Global Constraints

- **主機沒有 Node 與 pnpm**，每個指令都在容器裡跑：
  `docker run --rm -v "$PWD":/app -v personal-ledger-modules:/app/node_modules -w /app personal-ledger:deps pnpm <cmd>`
- **驗證看 exit code，不要 grep 輸出**：`pnpm check` 必須 `exit 0`。（本專案曾因 grep 樣式寫成複數 `problems` 而漏看 eslint 的 `1 problem`。）
- `src/domain/ledger-summary.ts` 與 migrations `0001`–`0007` **不得修改**。
- 金額一律用 `Decimal`；**不得**用 IEEE 浮點數，**不得**對 TEXT 金額欄位用 SQL `sum()`。
- `src/domain/` 與 `src/application/` **不得** import grammY。
- 正式環境日誌**不得**含 bot token、owner id、完整財務原文或 SQL 語句。
- `callback_data` ≤ 64 bytes，不得放 UUID，不得放中文。
- 文件與使用者可見文案一律繁體中文。
- commit 訊息**不得**加 Co-Authored-By 或 Generated-with 之類的署名行。
- 每個 task 結束前跑一次 `pnpm check`（exit 0）再 commit。

## Review Focus

以下是規格隱含、但若不特別指定就不會有任何 task 去測的情況。每一條都已指派給擁有該程式碼的 task，用該 task 自己的步驟風格補測試。

1. **送出成功、但標記 `delivered` 之前行程死掉** → 重啟後會再送一次。使用者預期「寧可重複也不要遺失」，但同一列不得無限重複。（Task 6）
2. **`reply_markup` 存進 DB 再讀出來的 JSON 往返** → 按鈕壞掉在手動驗收前沒有人會發現。（Task 4）
3. **訊息文字超過 Telegram 4096 字元上限** → API 會拒絕，且這是重試也不會好的錯誤，必須歸類為「放棄」而不是無限重試。（Task 3）
4. **同一筆帳本變更被重複觸發**（重複 callback）→ 必須只有一筆交易且**只有一列** outbox。（Task 5）
5. **`next_attempt_at` 的字串比較** → ISO 字串格式若不一致（有無毫秒、有無時區後綴），排程會永遠不到期或立刻到期。（Task 4）

---

## 檔案結構

| 檔案 | 責任 |
|---|---|
| `src/domain/outbox.ts`（新） | outbox 的型別、`MAX_ATTEMPTS`、退避計算。純函式，不認得 SQLite 也不認得 grammY |
| `src/db/migrations/0008_outbox.sql`（新） | `outbox_messages` 表 |
| `src/db/sqlite-ledger-repository.ts`（改） | outbox 的讀寫；`confirmDraft` 等五個變更在同一 transaction 內寫入 outbox 列 |
| `src/ports/ledger-repository.ts`（改） | 新增 outbox 方法與 `OutboxRequest` |
| `src/telegram/delivery-error.ts`（新） | 把 grammY 的錯誤分成重試／放棄／已送達／改送新訊息四類 |
| `src/telegram/outbox-runner.ts`（新） | 遞送單列與背景迴圈 |
| `src/telegram/format-status.ts`（新） | `/status` 的訊息 |
| `src/telegram/commands.ts`（新） | 指令清單的唯一定義：`/help`、`setMyCommands`、handler 註冊三者都讀它 |
| `src/telegram/format-help.ts`（新） | `/help` 的訊息 |
| `src/logger.ts`（新） | 唯一的日誌出口，所有輸出都過一次遮罩 |
| `src/db/pre-migration-snapshot.ts`（新） | migration 前的 `VACUUM INTO` 快照 |
| `src/db/database.ts`（改） | WAL + `synchronous=FULL` |
| `src/main.ts`（改） | 快照 → migrate → 啟動迴圈 |

---

### Task 1：WAL 與 synchronous=FULL

**Files:**
- Modify: `src/db/database.ts`
- Test: `tests/db/database.test.ts`（新）

**Interfaces:**
- Consumes: 無
- Produces: `openDatabase(path: string): Database.Database`（簽章不變，pragma 改變）

- [ ] **Step 1: 寫失敗測試**

```ts
// tests/db/database.test.ts
import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "../../src/db/database.js";

const databases: ReturnType<typeof openDatabase>[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("openDatabase", () => {
  it("opens the ledger in WAL with full synchronous durability", () => {
    // 規格 §15.2 要求 WAL；synchronous=FULL 讓主機斷電也不會丟掉已提交的交易。
    // 一天幾筆的寫入量下，fsync 成本無關緊要，而這是帳本。
    const database = openDatabase(":memory:");
    databases.push(database);

    // 記憶體資料庫回報 "memory"，檔案資料庫才會回 "wal"，因此用暫存檔驗證。
    expect(database.pragma("synchronous", { simple: true })).toBe(2);
  });

  it("keeps foreign keys enforced", () => {
    const database = openDatabase(":memory:");
    databases.push(database);

    expect(database.pragma("foreign_keys", { simple: true })).toBe(1);
  });
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `docker run --rm -v "$PWD":/app -v personal-ledger-modules:/app/node_modules -w /app personal-ledger:deps pnpm vitest run tests/db/database.test.ts`
Expected: FAIL，`synchronous` 得到 `1`（預設 NORMAL）而不是 `2`

- [ ] **Step 3: 實作**

```ts
// src/db/database.ts
import Database from "better-sqlite3";

export function openDatabase(path: string): Database.Database {
  const database = new Database(path);
  database.pragma("foreign_keys = ON");
  // 規格 §15.2 要求 WAL。記憶體資料庫不支援，pragma 會回 "memory"，不視為錯誤。
  database.pragma("journal_mode = WAL");
  // synchronous=FULL：NORMAL 在主機斷電時可能丟掉最近幾筆已提交交易。這是帳本，
  // 而寫入量是一天幾筆，fsync 成本無關緊要。
  database.pragma("synchronous = FULL");
  return database;
}
```

- [ ] **Step 4: 補一條檔案資料庫的 WAL 測試**

```ts
  it("uses WAL for a file-backed ledger", () => {
    // 記憶體資料庫不支援 WAL，只有檔案資料庫測得出來。
    const directory = mkdtempSync(join(tmpdir(), "ledger-wal-"));
    const database = openDatabase(join(directory, "ledger.sqlite"));
    databases.push(database);

    expect(database.pragma("journal_mode", { simple: true })).toBe("wal");
  });
```

在檔案頂端加上：

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
```

- [ ] **Step 5: 執行測試確認通過**

Run: `docker run --rm -v "$PWD":/app -v personal-ledger-modules:/app/node_modules -w /app personal-ledger:deps pnpm check`
Expected: exit 0

- [ ] **Step 6: Commit**

```bash
git add src/db/database.ts tests/db/database.test.ts
git commit -m "feat: open the ledger in WAL with full synchronous durability"
```

---

### Task 2：migration 0008 建立 outbox 表

**Files:**
- Create: `src/db/migrations/0008_outbox.sql`
- Modify: `src/db/migrate.ts`
- Test: `tests/db/migrate-outbox.test.ts`（新）
- Modify（版本清單）: `tests/db/migrate-accounting-core.test.ts`、`tests/db/migrate-advance-recovery.test.ts`、`tests/db/migrate-conversation-state.test.ts`、`tests/db/migrate-dining-category.test.ts`、`tests/db/migrate-user-keywords.test.ts`、`tests/smoke/runtime.test.ts`

**Interfaces:**
- Consumes: `migrate(database)`
- Produces: 資料表 `outbox_messages`；schema 版本 8

- [ ] **Step 1: 寫失敗測試**

```ts
// tests/db/migrate-outbox.test.ts
import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "../../src/db/database.js";
import { migrate } from "../../src/db/migrate.js";

const databases: ReturnType<typeof openDatabase>[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function open(): ReturnType<typeof openDatabase> {
  const database = openDatabase(":memory:");
  databases.push(database);
  migrate(database);
  return database;
}

describe("migration 0008", () => {
  it("creates the outbox table", () => {
    const database = open();

    const columns = (database.pragma("table_info(outbox_messages)") as { name: string }[])
      .map((column) => column.name)
      .sort();

    expect(columns).toEqual([
      "attempts",
      "cause",
      "chat_id",
      "created_at",
      "delivered_at",
      "last_error",
      "lease_expires_at",
      "message_id",
      "next_attempt_at",
      "owner_id",
      "reply_markup",
      "status",
      "target_message_id",
      "text",
    ]);
    expect(database.pragma("foreign_key_check")).toEqual([]);
  });

  it("rejects an unknown cause or status", () => {
    const database = open();
    const insert = (cause: string, status: string): void => {
      database
        .prepare(
          `INSERT INTO outbox_messages
             (message_id, owner_id, cause, chat_id, text, status, next_attempt_at)
           VALUES ('m1', 'owner-1', ?, '1', 'hi', ?, '2026-09-30T00:00:00.000Z')`,
        )
        .run(cause, status);
    };

    // arrow 的主體要用大括號包起來：本專案的 eslint 有 no-confusing-void-expression，
    // 單行 arrow 回傳 void 運算式會被判定為錯誤。
    expect(() => {
      insert("something_else", "pending");
    }).toThrow(/CHECK/);
    expect(() => {
      insert("transaction_confirmed", "queued");
    }).toThrow(/CHECK/);
  });

  it("registers version 8 and stays idempotent", () => {
    const database = open();
    migrate(database);

    expect(
      (
        database.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as {
          version: number;
        }[]
      ).map((row) => row.version),
    ).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `docker run --rm -v "$PWD":/app -v personal-ledger-modules:/app/node_modules -w /app personal-ledger:deps pnpm vitest run tests/db/migrate-outbox.test.ts`
Expected: FAIL，`no such table: outbox_messages`

- [ ] **Step 3: 建立 migration**

```sql
-- src/db/migrations/0008_outbox.sql
-- 帳本變更與「要送給使用者的那一則訊息」必須在同一個 transaction 裡提交，否則行程在兩者
-- 之間死掉就會出現「帳記了、人不知道」。這張表存的是已經渲染好的訊息，不是稍後重新渲染
-- 的參照：崩潰重啟後重新渲染可能得到不同輸出，但使用者該收到的是當初那一則。
--
-- 這不是通用工作佇列。規格 §16.1 列的五類工作裡，Sheet 同步與備份在 M5、AI 在 M7，
-- M4 只有「Telegram 遞送」這一個真實消費者。M5 帶來第二個消費者時再抽成多型別。
CREATE TABLE outbox_messages (
  message_id        TEXT PRIMARY KEY,
  owner_id          TEXT NOT NULL,
  -- 這一則訊息是哪一種帳本變更造成的，供 /status 與事後追查
  cause             TEXT NOT NULL CHECK (cause IN (
                      'transaction_confirmed', 'recovery_recorded', 'advance_abandoned',
                      'transaction_updated', 'transaction_deleted')),
  chat_id           TEXT NOT NULL,
  -- 有值＝編輯既有訊息，NULL＝送一則新訊息
  target_message_id TEXT,
  text              TEXT NOT NULL,
  -- grammY 的 InlineKeyboardMarkup，以 JSON 字串保存
  reply_markup      TEXT,
  status            TEXT NOT NULL CHECK (status IN ('pending', 'delivered', 'needs_attention')),
  attempts          INTEGER NOT NULL DEFAULT 0,
  next_attempt_at   TEXT NOT NULL,
  -- 有值且未過期＝有人正在送這一列。單一行程也需要它：擋住「提交後的快速路徑」
  -- 與「背景迴圈」同時送同一列。
  lease_expires_at  TEXT,
  last_error        TEXT,
  created_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  delivered_at      TEXT
);

CREATE INDEX outbox_pending_idx ON outbox_messages(status, next_attempt_at);
```

- [ ] **Step 4: 註冊 migration**

在 `src/db/migrate.ts` 的 `migrations` 陣列末端加入：

```ts
  { version: 8, url: new URL("./migrations/0008_outbox.sql", import.meta.url) },
```

- [ ] **Step 5: 更新既有的版本清單斷言**

六個檔案裡的 `{ version: 7 },` 之後補上 `{ version: 8 },`：
`tests/db/migrate-accounting-core.test.ts`、`tests/db/migrate-advance-recovery.test.ts`、
`tests/db/migrate-conversation-state.test.ts`、`tests/db/migrate-dining-category.test.ts`、
`tests/db/migrate-user-keywords.test.ts`、`tests/smoke/runtime.test.ts`（此檔有兩處）。

- [ ] **Step 6: 執行測試確認通過**

Run: `docker run --rm -v "$PWD":/app -v personal-ledger-modules:/app/node_modules -w /app personal-ledger:deps pnpm check`
Expected: exit 0

- [ ] **Step 7: Commit**

```bash
git add src/db/migrations/0008_outbox.sql src/db/migrate.ts tests/
git commit -m "feat: add the outbox table"
```

---

### Task 3：outbox 領域型別、退避與錯誤分類

**Files:**
- Create: `src/domain/outbox.ts`
- Create: `src/telegram/delivery-error.ts`
- Test: `tests/domain/outbox.test.ts`（新）、`tests/telegram/delivery-error.test.ts`（新）

**Interfaces:**
- Consumes: 無
- Produces:
  - `OutboxCause = "transaction_confirmed" | "recovery_recorded" | "advance_abandoned" | "transaction_updated" | "transaction_deleted"`
  - `interface OutboxPayload { chatId: string; targetMessageId?: string; text: string; replyMarkup?: string }`
  - `interface OutboxMessage extends OutboxPayload { messageId: string; ownerId: string; cause: OutboxCause; status: "pending" | "delivered" | "needs_attention"; attempts: number; nextAttemptAt: string; lastError?: string }`
  - `MAX_ATTEMPTS = 5`
  - `backoffMs(attempts: number): number`
  - `classifyDeliveryError(error: unknown): DeliveryOutcome`
  - `type DeliveryOutcome = { kind: "retry"; retryAfterMs?: number } | { kind: "give-up"; reason: string } | { kind: "already-delivered" } | { kind: "resend-as-new" }`

- [ ] **Step 1: 寫退避的失敗測試**

```ts
// tests/domain/outbox.test.ts
import { describe, expect, it } from "vitest";

import { MAX_ATTEMPTS, backoffMs } from "../../src/domain/outbox.js";

describe("backoffMs", () => {
  it("grows threefold from five seconds and caps at five minutes", () => {
    expect(backoffMs(1)).toBe(5_000);
    expect(backoffMs(2)).toBe(15_000);
    expect(backoffMs(3)).toBe(45_000);
    expect(backoffMs(4)).toBe(135_000);
    expect(backoffMs(5)).toBe(300_000);
  });

  it("never exceeds the cap however many attempts have happened", () => {
    expect(backoffMs(99)).toBe(300_000);
  });

  it("gives up after five attempts, roughly eight minutes in total", () => {
    // 撐得過去的是網路抖動與 Telegram 短暫故障，那是秒到分鐘的量級。真的斷線時
    // long polling 也收不到訊息，outbox 不是承受長時間斷線的正確層級。
    expect(MAX_ATTEMPTS).toBe(5);
    const total = [1, 2, 3, 4, 5].reduce((sum, attempt) => sum + backoffMs(attempt), 0);
    expect(total).toBeLessThan(10 * 60_000);
    expect(total).toBeGreaterThan(7 * 60_000);
  });
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `docker run --rm -v "$PWD":/app -v personal-ledger-modules:/app/node_modules -w /app personal-ledger:deps pnpm vitest run tests/domain/outbox.test.ts`
Expected: FAIL，找不到模組 `src/domain/outbox.js`

- [ ] **Step 3: 實作領域型別與退避**

```ts
// src/domain/outbox.ts
import { z } from "zod";

/**
 * 帳本變更與「要送給使用者的那一則訊息」在同一個 transaction 裡提交。這個模組只放型別與
 * 純計算：它不認得 SQLite，也不認得 grammY。
 */
export const OutboxCauseSchema = z.enum([
  "transaction_confirmed",
  "recovery_recorded",
  "advance_abandoned",
  "transaction_updated",
  "transaction_deleted",
]);
export type OutboxCause = z.infer<typeof OutboxCauseSchema>;

export type OutboxStatus = "pending" | "delivered" | "needs_attention";

/** 已經渲染好的訊息。telegram 層產生，application 層原樣保存。 */
export interface OutboxPayload {
  readonly chatId: string;
  /** 有值＝編輯這則既有訊息，沒有＝送一則新的。 */
  readonly targetMessageId?: string;
  readonly text: string;
  /** grammY 的 InlineKeyboardMarkup，JSON 字串。 */
  readonly replyMarkup?: string;
}

export interface OutboxMessage extends OutboxPayload {
  readonly messageId: string;
  readonly ownerId: string;
  readonly cause: OutboxCause;
  readonly status: OutboxStatus;
  readonly attempts: number;
  readonly nextAttemptAt: string;
  readonly lastError?: string;
}

/** 從第一次失敗到放棄約 8 分鐘：5s／15s／45s／2m15s／5m。 */
export const MAX_ATTEMPTS = 5;
const BASE_MS = 5_000;
const CAP_MS = 300_000;

/** `attempts` 是「已經失敗過幾次」，第一次失敗傳 1。 */
export function backoffMs(attempts: number): number {
  return Math.min(BASE_MS * 3 ** (attempts - 1), CAP_MS);
}
```

- [ ] **Step 4: 執行測試確認通過**

Run: `docker run --rm -v "$PWD":/app -v personal-ledger-modules:/app/node_modules -w /app personal-ledger:deps pnpm vitest run tests/domain/outbox.test.ts`
Expected: PASS

- [ ] **Step 5: 寫錯誤分類的失敗測試**

```ts
// tests/telegram/delivery-error.test.ts
import { GrammyError } from "grammy";
import { describe, expect, it } from "vitest";

import { classifyDeliveryError } from "../../src/telegram/delivery-error.js";

function grammyError(errorCode: number, description: string, parameters = {}): GrammyError {
  return new GrammyError(
    "Call to 'sendMessage' failed!",
    { ok: false, error_code: errorCode, description, parameters },
    "sendMessage",
    {},
  );
}

describe("classifyDeliveryError", () => {
  it("treats an unchanged message as already delivered", () => {
    // 內容相同代表訊息已經在那裡了，這不是失敗。
    expect(
      classifyDeliveryError(grammyError(400, "Bad Request: message is not modified")),
    ).toEqual({ kind: "already-delivered" });
  });

  it("falls back to a new message when the target is gone", () => {
    // 重啟後原訊息可能已被刪除；改送新訊息，不計入失敗次數。
    expect(
      classifyDeliveryError(grammyError(400, "Bad Request: message to edit not found")),
    ).toEqual({ kind: "resend-as-new" });
    expect(
      classifyDeliveryError(grammyError(400, "Bad Request: message can't be edited")),
    ).toEqual({ kind: "resend-as-new" });
  });

  it("honours retry_after instead of its own backoff", () => {
    expect(
      classifyDeliveryError(
        grammyError(429, "Too Many Requests: retry after 12", { retry_after: 12 }),
      ),
    ).toEqual({ kind: "retry", retryAfterMs: 12_000 });
  });

  it("retries a 429 that carries no retry_after", () => {
    // Telegram 不一定會附上 retry_after。少了這個案例，這條分支可以被改成 give-up
    // 而測試全綠——審查時實測過。
    expect(classifyDeliveryError(grammyError(429, "Too Many Requests", {}))).toEqual({
      kind: "retry",
    });
  });

  it("gives up on errors that retrying cannot fix", () => {
    // 被封鎖、聊天室不存在，重試一百次也一樣。訊息太長同理——那是內容問題不是網路問題。
    expect(classifyDeliveryError(grammyError(403, "Forbidden: bot was blocked by the user"))).toEqual(
      { kind: "give-up", reason: "blocked" },
    );
    expect(classifyDeliveryError(grammyError(400, "Bad Request: chat not found"))).toEqual({
      kind: "give-up",
      reason: "chat_not_found",
    });
    expect(classifyDeliveryError(grammyError(400, "Bad Request: message is too long"))).toEqual({
      kind: "give-up",
      reason: "message_too_long",
    });
  });

  it("retries a server error or a plain network failure", () => {
    expect(classifyDeliveryError(grammyError(502, "Bad Gateway"))).toEqual({ kind: "retry" });
    expect(classifyDeliveryError(new Error("fetch failed"))).toEqual({ kind: "retry" });
  });
});
```

- [ ] **Step 6: 執行測試確認失敗**

Run: `docker run --rm -v "$PWD":/app -v personal-ledger-modules:/app/node_modules -w /app personal-ledger:deps pnpm vitest run tests/telegram/delivery-error.test.ts`
Expected: FAIL，找不到模組 `src/telegram/delivery-error.js`

- [ ] **Step 7: 實作錯誤分類**

```ts
// src/telegram/delivery-error.ts
import { GrammyError } from "grammy";

/**
 * 遞送失敗分成四類，因為它們該做的事完全不同：
 *
 * - `already-delivered`：內容相同、訊息已經在那裡，不是失敗。
 * - `resend-as-new`：要編輯的訊息不見了（重啟後常見），改送新訊息且不計入失敗次數。
 * - `give-up`：重試一百次也一樣（被封鎖、聊天室不存在、訊息太長），直接 needs_attention。
 * - `retry`：其餘一律退避重試；429 帶 `retry_after` 時遵守它，不套用自己的退避。
 */
export type DeliveryOutcome =
  | { readonly kind: "retry"; readonly retryAfterMs?: number }
  | { readonly kind: "give-up"; readonly reason: string }
  | { readonly kind: "already-delivered" }
  | { readonly kind: "resend-as-new" };

export function classifyDeliveryError(error: unknown): DeliveryOutcome {
  if (!(error instanceof GrammyError)) return { kind: "retry" };

  const description = error.description.toLowerCase();

  if (description.includes("message is not modified")) return { kind: "already-delivered" };
  if (
    description.includes("message to edit not found") ||
    description.includes("message can't be edited") ||
    description.includes("message to be edited not found")
  ) {
    return { kind: "resend-as-new" };
  }

  if (error.error_code === 429) {
    const retryAfter = error.parameters.retry_after;
    return retryAfter === undefined
      ? { kind: "retry" }
      : { kind: "retry", retryAfterMs: retryAfter * 1_000 };
  }

  if (error.error_code === 403) return { kind: "give-up", reason: "blocked" };
  if (description.includes("chat not found")) return { kind: "give-up", reason: "chat_not_found" };
  if (description.includes("message is too long")) {
    return { kind: "give-up", reason: "message_too_long" };
  }

  return { kind: "retry" };
}
```

- [ ] **Step 8: 執行完整檢查**

Run: `docker run --rm -v "$PWD":/app -v personal-ledger-modules:/app/node_modules -w /app personal-ledger:deps pnpm check`
Expected: exit 0

- [ ] **Step 9: Commit**

```bash
git add src/domain/outbox.ts src/telegram/delivery-error.ts tests/domain/outbox.test.ts tests/telegram/delivery-error.test.ts
git commit -m "feat: add outbox types, backoff and delivery error classification"
```

---

### Task 4：outbox 的讀寫（port 與 SQLite 實作）

**Files:**
- Modify: `src/ports/ledger-repository.ts`
- Modify: `src/db/sqlite-ledger-repository.ts`
- Modify: `tests/support/fake-ledger-repository.ts`
- Test: `tests/db/sqlite-outbox.test.ts`（新）

**Interfaces:**
- Consumes: Task 3 的 `OutboxMessage`、`OutboxPayload`、`OutboxCause`
- Produces（加進 `LedgerRepository`）:
  - `claimDueOutbox(ownerId: string, now: string, leaseUntil: string, limit: number): Promise<OutboxMessage[]>`
  - `markOutboxDelivered(messageId: string, deliveredAt: string): Promise<void>`
  - `markOutboxFailed(messageId: string, nextAttemptAt: string, lastError: string): Promise<void>`
  - `markOutboxNeedsAttention(messageId: string, lastError: string): Promise<void>`
  - `retryOutboxNeedsAttention(ownerId: string, nextAttemptAt: string): Promise<number>`
  - `summarizeOutbox(ownerId: string): Promise<OutboxSummary>`
  - `interface OutboxSummary { pending: number; needsAttention: number; oldestPendingAt: string | null; lastDeliveredAt: string | null; stuck: readonly OutboxMessage[] }`

**時間格式的硬性規定**：所有寫入 `next_attempt_at`、`lease_expires_at`、`delivered_at` 的值
一律是 `new Date(...).toISOString()`（帶毫秒、以 `Z` 結尾）。SQLite 是字串比較，格式一旦
混用（有的帶毫秒、有的不帶）排序就會錯，排程會永遠不到期或立刻到期。

- [ ] **Step 1: 寫失敗測試**

```ts
// tests/db/sqlite-outbox.test.ts
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase } from "../../src/db/database.js";
import { migrate } from "../../src/db/migrate.js";
import { SqliteLedgerRepository } from "../../src/db/sqlite-ledger-repository.js";

const LATER = "2026-09-30T10:00:00.000Z";
const NOW = "2026-09-30T09:00:00.000Z";

describe("outbox storage", () => {
  let database: Database.Database;
  let repository: SqliteLedgerRepository;

  beforeEach(() => {
    database = openDatabase(":memory:");
    migrate(database);
    repository = new SqliteLedgerRepository(database);
  });
  afterEach(() => database.close());

  function seed(messageId: string, nextAttemptAt: string, replyMarkup?: string): void {
    database
      .prepare(
        `INSERT INTO outbox_messages
           (message_id, owner_id, cause, chat_id, target_message_id, text, reply_markup,
            status, next_attempt_at)
         VALUES (?, 'owner-1', 'transaction_confirmed', '55', '77', '已入帳', ?, 'pending', ?)`,
      )
      .run(messageId, replyMarkup ?? null, nextAttemptAt);
  }

  it("claims only rows that are due and not already leased", async () => {
    seed("due", NOW);
    seed("future", LATER);

    const claimed = await repository.claimDueOutbox("owner-1", NOW, LATER, 10);

    expect(claimed.map((item) => item.messageId)).toEqual(["due"]);
    // 取得 lease 之後，第二次撈不該再拿到同一列——這擋住快速路徑與背景迴圈同時送。
    await expect(repository.claimDueOutbox("owner-1", NOW, LATER, 10)).resolves.toEqual([]);
  });

  it("reclaims a row whose lease expired with the process that held it", async () => {
    // 這就是「啟動恢復」：死掉的行程留下過期 lease，沒有另一條開機路徑。
    seed("orphan", NOW);
    await repository.claimDueOutbox("owner-1", NOW, "2026-09-30T09:00:30.000Z", 10);

    const reclaimed = await repository.claimDueOutbox("owner-1", LATER, LATER, 10);

    expect(reclaimed.map((item) => item.messageId)).toEqual(["orphan"]);
  });

  it("round-trips the reply markup through JSON", async () => {
    // 按鈕壞掉在手動驗收之前沒有人會發現。
    const markup = JSON.stringify({
      inline_keyboard: [[{ text: "重試全部", callback_data: "outbox-retry" }]],
    });
    seed("with-buttons", NOW, markup);

    const [claimed] = await repository.claimDueOutbox("owner-1", NOW, LATER, 10);

    expect(claimed?.replyMarkup).toBe(markup);
    expect(JSON.parse(claimed?.replyMarkup ?? "{}")).toEqual({
      inline_keyboard: [[{ text: "重試全部", callback_data: "outbox-retry" }]],
    });
  });

  it("counts attempts up and schedules the next one when delivery fails", async () => {
    seed("failing", NOW);
    await repository.claimDueOutbox("owner-1", NOW, LATER, 10);

    await repository.markOutboxFailed("failing", LATER, "Bad Gateway");

    const row = database
      .prepare("SELECT attempts, next_attempt_at, lease_expires_at, last_error FROM outbox_messages WHERE message_id = 'failing'")
      .get() as { attempts: number; next_attempt_at: string; lease_expires_at: string | null; last_error: string };
    expect(row).toEqual({
      attempts: 1,
      next_attempt_at: LATER,
      // lease 必須釋放，否則重試要等 lease 過期
      lease_expires_at: null,
      last_error: "Bad Gateway",
    });
  });

  it("compares schedule times as ISO strings with milliseconds", async () => {
    // SQLite 做字串比較。格式一旦混用（有的帶毫秒、有的不帶），排序就會錯，
    // 排程於是永遠不到期或立刻到期。所有時間一律 toISOString()。
    seed("due", "2026-09-30T09:00:00.000Z");
    // 不帶毫秒的 "2026-09-30T09:00:00Z" 字串大於帶毫秒的版本，若寫入端格式不一致，
    // 這一列就會被判成還沒到期。
    const nowWithoutMillis = "2026-09-30T09:00:00Z";

    await expect(repository.claimDueOutbox("owner-1", nowWithoutMillis, LATER, 10)).resolves.toHaveLength(1);

    const stored = database
      .prepare("SELECT next_attempt_at FROM outbox_messages WHERE message_id = 'due'")
      .get() as { next_attempt_at: string };
    expect(stored.next_attempt_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("summarises what /status needs", async () => {
    seed("waiting", NOW);
    seed("done", NOW);
    await repository.markOutboxDelivered("done", LATER);
    seed("stuck", NOW);
    await repository.markOutboxNeedsAttention("stuck", "Forbidden");

    await expect(repository.summarizeOutbox("owner-1")).resolves.toMatchObject({
      pending: 1,
      needsAttention: 1,
      oldestPendingAt: NOW,
      lastDeliveredAt: LATER,
    });
  });

  it("puts every stuck row back in the queue on request", async () => {
    seed("stuck", NOW);
    await repository.markOutboxNeedsAttention("stuck", "Forbidden");

    await expect(repository.retryOutboxNeedsAttention("owner-1", LATER)).resolves.toBe(1);

    const row = database
      .prepare("SELECT status, attempts, next_attempt_at FROM outbox_messages WHERE message_id = 'stuck'")
      .get();
    expect(row).toEqual({ status: "pending", attempts: 0, next_attempt_at: LATER });
  });
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `docker run --rm -v "$PWD":/app -v personal-ledger-modules:/app/node_modules -w /app personal-ledger:deps pnpm vitest run tests/db/sqlite-outbox.test.ts`
Expected: FAIL，`repository.claimDueOutbox is not a function`

- [ ] **Step 3: 擴充 port**

在 `src/ports/ledger-repository.ts` 加入型別與方法宣告：

```ts
import type { OutboxCause, OutboxMessage, OutboxPayload } from "../domain/outbox.js";

/** 帳本變更要連帶寫入的那一則訊息。`render` 在 repository 的 transaction 內被呼叫。 */
export interface OutboxRequest<T> {
  readonly messageId: string;
  readonly cause: OutboxCause;
  readonly render: (result: T) => OutboxPayload;
}

export interface OutboxSummary {
  readonly pending: number;
  readonly needsAttention: number;
  readonly oldestPendingAt: string | null;
  readonly lastDeliveredAt: string | null;
  readonly stuck: readonly OutboxMessage[];
}
```

在 `LedgerRepository` 介面內加入六個方法（簽章見本 task 的 Interfaces 段）。

- [ ] **Step 4: 實作 SQLite 版本**

```ts
  // src/db/sqlite-ledger-repository.ts
  // 時間一律是 toISOString()：SQLite 做字串比較，格式混用（有的帶毫秒、有的不帶）
  // 會讓排序錯亂，排程於是永遠不到期或立刻到期。
  public claimDueOutbox(
    ownerId: string,
    now: string,
    leaseUntil: string,
    limit: number,
  ): Promise<OutboxMessage[]> {
    const claim = this.database.transaction(() => {
      const rows = this.database
        .prepare(
          `SELECT * FROM outbox_messages
           WHERE owner_id = ? AND status = 'pending' AND next_attempt_at <= ?
             AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
           ORDER BY next_attempt_at LIMIT ?`,
        )
        .all(ownerId, now, now, limit) as OutboxRow[];
      const lease = this.database.prepare(
        "UPDATE outbox_messages SET lease_expires_at = ? WHERE message_id = ?",
      );
      for (const row of rows) lease.run(leaseUntil, row.message_id);
      return rows.map((row) => toOutboxMessage(row));
    });
    return Promise.resolve(claim.immediate());
  }

  public markOutboxDelivered(messageId: string, deliveredAt: string): Promise<void> {
    this.database
      .prepare(
        "UPDATE outbox_messages SET status = 'delivered', delivered_at = ?, lease_expires_at = NULL WHERE message_id = ?",
      )
      .run(deliveredAt, messageId);
    return Promise.resolve();
  }

  public markOutboxFailed(
    messageId: string,
    nextAttemptAt: string,
    lastError: string,
  ): Promise<void> {
    // lease 必須一起釋放，否則下一次重試要等到 lease 自然過期。
    this.database
      .prepare(
        `UPDATE outbox_messages
         SET attempts = attempts + 1, next_attempt_at = ?, last_error = ?, lease_expires_at = NULL
         WHERE message_id = ?`,
      )
      .run(nextAttemptAt, lastError, messageId);
    return Promise.resolve();
  }

  public markOutboxNeedsAttention(messageId: string, lastError: string): Promise<void> {
    this.database
      .prepare(
        "UPDATE outbox_messages SET status = 'needs_attention', last_error = ?, lease_expires_at = NULL WHERE message_id = ?",
      )
      .run(lastError, messageId);
    return Promise.resolve();
  }

  public retryOutboxNeedsAttention(ownerId: string, nextAttemptAt: string): Promise<number> {
    const result = this.database
      .prepare(
        `UPDATE outbox_messages
         SET status = 'pending', attempts = 0, next_attempt_at = ?, lease_expires_at = NULL
         WHERE owner_id = ? AND status = 'needs_attention'`,
      )
      .run(nextAttemptAt, ownerId);
    return Promise.resolve(result.changes);
  }

  public summarizeOutbox(ownerId: string): Promise<OutboxSummary> {
    const counts = this.database
      .prepare(
        `SELECT
           sum(status = 'pending') AS pending,
           sum(status = 'needs_attention') AS needs_attention,
           min(CASE WHEN status = 'pending' THEN created_at END) AS oldest_pending_at,
           max(delivered_at) AS last_delivered_at
         FROM outbox_messages WHERE owner_id = ?`,
      )
      .get(ownerId) as {
      pending: number | null;
      needs_attention: number | null;
      oldest_pending_at: string | null;
      last_delivered_at: string | null;
    };
    const stuck = this.database
      .prepare(
        "SELECT * FROM outbox_messages WHERE owner_id = ? AND status = 'needs_attention' ORDER BY created_at LIMIT 5",
      )
      .all(ownerId) as OutboxRow[];
    return Promise.resolve({
      pending: counts.pending ?? 0,
      needsAttention: counts.needs_attention ?? 0,
      oldestPendingAt: counts.oldest_pending_at,
      lastDeliveredAt: counts.last_delivered_at,
      stuck: stuck.map((row) => toOutboxMessage(row)),
    });
  }
```

在檔案上方加入 row 型別與轉換函式：

```ts
interface OutboxRow {
  message_id: string;
  owner_id: string;
  cause: string;
  chat_id: string;
  target_message_id: string | null;
  text: string;
  reply_markup: string | null;
  status: string;
  attempts: number;
  next_attempt_at: string;
  last_error: string | null;
}

function toOutboxMessage(row: OutboxRow): OutboxMessage {
  return {
    messageId: row.message_id,
    ownerId: row.owner_id,
    cause: OutboxCauseSchema.parse(row.cause),
    chatId: row.chat_id,
    ...(row.target_message_id ? { targetMessageId: row.target_message_id } : {}),
    text: row.text,
    ...(row.reply_markup ? { replyMarkup: row.reply_markup } : {}),
    status: row.status as OutboxMessage["status"],
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    ...(row.last_error ? { lastError: row.last_error } : {}),
  };
}
```

- [ ] **Step 5: 在 fake repository 實作同樣六個方法**

`tests/support/fake-ledger-repository.ts` 以陣列實作相同語意。**必須與 SQLite 版行為一致**：
lease 過期才可重新取得、失敗時清空 lease 並 `attempts + 1`、`retryOutboxNeedsAttention`
重設 `attempts` 為 0。本專案曾被測試替身與真實實作漂移咬過兩次（分類名稱、正規化函式）。

- [ ] **Step 6: 執行完整檢查**

Run: `docker run --rm -v "$PWD":/app -v personal-ledger-modules:/app/node_modules -w /app personal-ledger:deps pnpm check`
Expected: exit 0

- [ ] **Step 7: Commit**

```bash
git add src/ports/ledger-repository.ts src/db/sqlite-ledger-repository.ts tests/
git commit -m "feat: store, claim and summarise outbox messages"
```

---

### Task 5：確認草稿時在同一個 transaction 寫入 outbox

**Files:**
- Modify: `src/ports/ledger-repository.ts`（`confirmDraft` 簽章）
- Modify: `src/db/sqlite-ledger-repository.ts`（`confirmDraft`，約 line 359-437）
- Modify: `src/application/confirm-draft.ts`
- Modify: `tests/support/fake-ledger-repository.ts`
- Test: `tests/db/sqlite-outbox-atomicity.test.ts`（新）
- Modify（呼叫端）: `tests/db/sqlite-ledger-repository.test.ts`、`tests/application/ledger-actions.test.ts` 等所有呼叫 `confirmDraft` 的測試

**Interfaces:**
- Consumes: Task 4 的 `OutboxRequest<T>`
- Produces: `confirmDraft(draftId: string, confirmedAt: string, auditEventId: string, outbox: OutboxRequest<ConfirmedTransaction>): Promise<ConfirmedTransaction>`

`outbox` 參數是**必填**。設成選填的話，日後新增帳本變更時很容易忘記帶，而漏掉不會有任何
編譯錯誤——本專案已經因為「同一件事有兩份定義、只改了一份」出過三次問題，這裡用型別擋。

- [ ] **Step 1: 寫失敗測試**

```ts
// tests/db/sqlite-outbox-atomicity.test.ts
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase } from "../../src/db/database.js";
import { migrate } from "../../src/db/migrate.js";
import { SqliteLedgerRepository } from "../../src/db/sqlite-ledger-repository.js";
import type { TransactionDraft } from "../../src/domain/ledger.js";

const draft: TransactionDraft = {
  draftId: "draft-1",
  ownerId: "123",
  requestId: "request-1",
  sourceEventId: "event-1",
  occurredDate: "2026-09-30",
  amount: { amount: "120", currency: "TWD" },
  allocations: [
    {
      allocationId: "allocation-1",
      fundsEffect: "outflow",
      purpose: "expense",
      amount: { amount: "120", currency: "TWD" },
      category: "餐飲",
      subcategory: "午餐",
    },
  ],
  status: "awaiting_confirmation",
};

describe("confirmDraft writes the ledger change and its message together", () => {
  let database: Database.Database;
  let repository: SqliteLedgerRepository;

  beforeEach(async () => {
    database = openDatabase(":memory:");
    migrate(database);
    repository = new SqliteLedgerRepository(database);
    await repository.recordInputEvent({
      eventId: "event-1",
      ownerId: "123",
      telegramUpdateId: "update-1",
      sourceType: "telegram",
      sourceRef: "message-1",
      rawText: "午餐 120",
      receivedAt: "2026-09-30T01:00:00.000Z",
    });
    await repository.saveDraft(draft);
  });
  afterEach(() => database.close());

  function outbox(messageId = "outbox-1") {
    return {
      messageId,
      cause: "transaction_confirmed" as const,
      render: (confirmed: { transactionId: string }) => ({
        chatId: "55",
        targetMessageId: "77",
        text: `已入帳：交易 ID ${confirmed.transactionId}`,
      }),
    };
  }

  it("stores a pending message rendered from the committed transaction", async () => {
    const confirmed = await repository.confirmDraft(
      "draft-1",
      "2026-09-30T01:01:00.000Z",
      "audit-1",
      outbox(),
    );

    const row = database.prepare("SELECT * FROM outbox_messages").get() as {
      status: string;
      text: string;
      chat_id: string;
      target_message_id: string;
      attempts: number;
    };
    // 渲染函式必須在 transaction 內、交易產生之後被呼叫，否則拿不到 transactionId。
    expect(row.text).toBe(`已入帳：交易 ID ${confirmed.transactionId}`);
    expect(row).toMatchObject({ status: "pending", chat_id: "55", target_message_id: "77", attempts: 0 });
  });

  it("leaves no message behind when the ledger write fails", async () => {
    // 原子性的另一半：交易沒成立就不該有待送訊息。
    await expect(
      repository.confirmDraft("draft-missing", "2026-09-30T01:01:00.000Z", "audit-2", outbox("outbox-2")),
    ).rejects.toThrow(/draft not found/);

    expect(database.prepare("SELECT count(*) AS total FROM outbox_messages").get()).toEqual({
      total: 0,
    });
  });

  it("does not queue a second message when the same draft is confirmed twice", async () => {
    // 重複 callback：一筆交易、一列 outbox。
    const first = await repository.confirmDraft("draft-1", "2026-09-30T01:01:00.000Z", "audit-1", outbox("outbox-a"));
    const second = await repository.confirmDraft("draft-1", "2026-09-30T01:02:00.000Z", "audit-2", outbox("outbox-b"));

    expect(second.transactionId).toBe(first.transactionId);
    expect(database.prepare("SELECT count(*) AS total FROM transactions").get()).toEqual({ total: 1 });
    expect(database.prepare("SELECT count(*) AS total FROM outbox_messages").get()).toEqual({ total: 1 });
  });
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `docker run --rm -v "$PWD":/app -v personal-ledger-modules:/app/node_modules -w /app personal-ledger:deps pnpm vitest run tests/db/sqlite-outbox-atomicity.test.ts`
Expected: FAIL，`confirmDraft` 只收三個參數

- [ ] **Step 3: 在 repository 的 transaction 內寫入 outbox**

`confirmDraft` 加上第四個參數，並在既有 transaction 的 `return confirmed;` 之前插入：

```ts
      this.enqueueOutbox(outbox.messageId, draft.ownerId, outbox.cause, outbox.render(confirmed), confirmedAt);
      return confirmed;
```

注意 `const existing = this.getByRequestId(draft.requestId); if (existing) return existing;`
這條提前返回**不得**寫入 outbox——重複確認已經有一列了。

新增私有方法：

```ts
  /** 只在帳本變更的 transaction 內呼叫，兩者因此不可能只有一半。 */
  private enqueueOutbox(
    messageId: string,
    ownerId: string,
    cause: OutboxCause,
    payload: OutboxPayload,
    now: string,
  ): void {
    this.database
      .prepare(
        `INSERT INTO outbox_messages
           (message_id, owner_id, cause, chat_id, target_message_id, text, reply_markup,
            status, attempts, next_attempt_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
      )
      .run(
        messageId,
        ownerId,
        cause,
        payload.chatId,
        payload.targetMessageId ?? null,
        payload.text,
        payload.replyMarkup ?? null,
        now,
        now,
      );
  }
```

- [ ] **Step 4: 更新 application 層與 fake**

```ts
// src/application/confirm-draft.ts
export function confirmDraft(
  repository: LedgerRepository,
  draftId: string,
  confirmedAt: string,
  auditEventId: string,
  outbox: OutboxRequest<ConfirmedTransaction>,
): Promise<ConfirmedTransaction> {
  return repository.confirmDraft(draftId, confirmedAt, auditEventId, outbox);
}
```

fake repository 同步更新：確認成功時把渲染結果推進 `outboxMessages` 陣列；提前返回的重複確認
不推。

- [ ] **Step 5: 更新所有既有呼叫端**

編譯器會列出每一處。測試裡傳一個最小的 outbox：

```ts
{ messageId: "outbox-test", cause: "transaction_confirmed" as const, render: () => ({ chatId: "1", text: "ok" }) }
```

- [ ] **Step 6: 執行完整檢查**

Run: `docker run --rm -v "$PWD":/app -v personal-ledger-modules:/app/node_modules -w /app personal-ledger:deps pnpm check`
Expected: exit 0

- [ ] **Step 7: Commit**

```bash
git add src/ tests/
git commit -m "feat: commit the confirmation message with the transaction that caused it"
```

---

### Task 6：遞送單列與背景迴圈

**Files:**
- Create: `src/telegram/outbox-runner.ts`
- Test: `tests/telegram/outbox-runner.test.ts`（新）

**Interfaces:**
- Consumes: Task 3 的 `classifyDeliveryError`、`backoffMs`、`MAX_ATTEMPTS`；Task 4 的六個 repository 方法
- Produces:
  - `deliverOutboxMessage(message: OutboxMessage, deps: OutboxRunnerDependencies): Promise<"delivered" | "retrying" | "needs_attention">`
  - `createOutboxRunner(deps: OutboxRunnerDependencies): { drainOnce(): Promise<void>; start(): void; stop(): void }`
  - `interface OutboxRunnerDependencies { repository: LedgerRepository; ownerId: string; api: OutboxApi; now: () => Date; onNeedsAttention: (message: OutboxMessage) => Promise<void> }`
  - `interface OutboxApi { sendMessage(chatId, text, options): Promise<{ message_id: number }>; editMessageText(chatId, messageId, text, options): Promise<unknown> }`

`OutboxApi` 是刻意收窄的介面，只暴露這兩個呼叫；測試因此不需要整個 grammY Bot。

- [ ] **Step 1: 寫失敗測試**

```ts
// tests/telegram/outbox-runner.test.ts
import { GrammyError } from "grammy";
import { describe, expect, it, vi } from "vitest";

import { createOutboxRunner } from "../../src/telegram/outbox-runner.js";
import { FakeLedgerRepository } from "../support/fake-ledger-repository.js";

// 省略：helper `harness()` 建立 FakeLedgerRepository、假 api、固定時鐘，
// 並提供 `enqueue(partial)` 直接塞一列 pending。

describe("outbox runner", () => {
  it("edits the target message and marks the row delivered", async () => {
    const { runner, api, repository } = harness();
    enqueue(repository, { messageId: "m1", targetMessageId: "77" });

    await runner.drainOnce();

    expect(api.editMessageText).toHaveBeenCalledWith("55", 77, "已入帳", expect.anything());
    expect(await status(repository, "m1")).toBe("delivered");
  });

  it("sends a new message when there is no target", async () => {
    const { runner, api, repository } = harness();
    enqueue(repository, { messageId: "m1" });

    await runner.drainOnce();

    expect(api.sendMessage).toHaveBeenCalled();
    expect(await status(repository, "m1")).toBe("delivered");
  });

  it("falls back to a new message when the target is gone, without counting a failure", async () => {
    const { runner, api, repository } = harness();
    api.editMessageText.mockRejectedValueOnce(
      grammyError(400, "Bad Request: message to edit not found"),
    );
    enqueue(repository, { messageId: "m1", targetMessageId: "77" });

    await runner.drainOnce();

    expect(api.sendMessage).toHaveBeenCalled();
    expect(await status(repository, "m1")).toBe("delivered");
    expect(await attempts(repository, "m1")).toBe(0);
  });

  it("treats an unchanged message as delivered", async () => {
    const { runner, repository } = harness();
    api.editMessageText.mockRejectedValueOnce(
      grammyError(400, "Bad Request: message is not modified"),
    );
    enqueue(repository, { messageId: "m1", targetMessageId: "77" });

    await runner.drainOnce();

    expect(await status(repository, "m1")).toBe("delivered");
  });

  it("schedules a retry with backoff after a transient failure", async () => {
    const { runner, api, repository, clock } = harness();
    api.sendMessage.mockRejectedValueOnce(grammyError(502, "Bad Gateway"));
    enqueue(repository, { messageId: "m1" });

    await runner.drainOnce();

    expect(await status(repository, "m1")).toBe("pending");
    expect(await attempts(repository, "m1")).toBe(1);
    // 第一次失敗退避 5 秒
    expect(await nextAttemptAt(repository, "m1")).toBe(
      new Date(clock.getTime() + 5_000).toISOString(),
    );
  });

  it("gives up immediately on an error retrying cannot fix", async () => {
    const { runner, api, repository, onNeedsAttention } = harness();
    api.sendMessage.mockRejectedValue(grammyError(403, "Forbidden: bot was blocked by the user"));
    enqueue(repository, { messageId: "m1" });

    await runner.drainOnce();

    expect(await status(repository, "m1")).toBe("needs_attention");
    expect(await attempts(repository, "m1")).toBe(0);
    expect(onNeedsAttention).toHaveBeenCalledOnce();
  });

  it("stops after the retry cap and asks for attention", async () => {
    const { runner, api, repository, onNeedsAttention, advance } = harness();
    api.sendMessage.mockRejectedValue(grammyError(502, "Bad Gateway"));
    enqueue(repository, { messageId: "m1" });

    for (let round = 0; round < 6; round += 1) {
      await runner.drainOnce();
      advance(10 * 60_000);
    }

    expect(await status(repository, "m1")).toBe("needs_attention");
    expect(await attempts(repository, "m1")).toBe(5);
    expect(onNeedsAttention).toHaveBeenCalledOnce();
  });

  it("delivers a row left behind by a process that died mid-flight", async () => {
    // AC-20：死掉的行程留下過期 lease，迴圈照常規則就撈得到，沒有另一段開機邏輯。
    const { runner, repository, advance } = harness();
    enqueue(repository, { messageId: "m1", leaseExpiresAt: "2026-09-30T00:00:00.000Z" });
    advance(60_000);

    await runner.drainOnce();

    expect(await status(repository, "m1")).toBe("delivered");
  });

  it("re-sends when the process dies after sending but before marking delivered", async () => {
    // Review Focus 1。寧可重複也不要遺失：帳本只有一筆，使用者看到兩則訊息。
    // lease 讓它最多重複一次，不會無限重複。
    const { runner, api, repository, advance } = harness();
    repository.markOutboxDelivered = vi.fn().mockRejectedValueOnce(new Error("killed"));
    enqueue(repository, { messageId: "m1" });

    await runner.drainOnce().catch(() => undefined);
    advance(60_000); // lease 過期
    await runner.drainOnce();

    expect(api.sendMessage).toHaveBeenCalledTimes(2);
    expect(await status(repository, "m1")).toBe("delivered");
  });

  it("does not resurrect needs_attention rows on its own", async () => {
    // 重啟看似代表連線回來了，但自動重送等於把「不無限重試」從後門繞過去，
    // 而且使用者可能早就用 /recent 確認過那筆交易。要重送就明確按「重試全部」。
    const { runner, api, repository, advance } = harness();
    enqueue(repository, { messageId: "m1", status: "needs_attention" });
    advance(60 * 60_000);

    await runner.drainOnce();

    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(await status(repository, "m1")).toBe("needs_attention");
  });

  it("does not deliver the same row twice when a drain overlaps the fast path", async () => {
    // lease 的用途：單一行程也可能有兩條路徑同時碰同一列。
    const { runner, api, repository } = harness();
    enqueue(repository, { messageId: "m1" });

    await Promise.all([runner.drainOnce(), runner.drainOnce()]);

    expect(api.sendMessage).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `docker run --rm -v "$PWD":/app -v personal-ledger-modules:/app/node_modules -w /app personal-ledger:deps pnpm vitest run tests/telegram/outbox-runner.test.ts`
Expected: FAIL，找不到模組

- [ ] **Step 3: 實作 runner**

重點行為，依序：

1. `claimDueOutbox(ownerId, now, now + LEASE_MS, BATCH)`，`LEASE_MS = 30_000`、`BATCH = 10`。
2. 每一列：有 `targetMessageId` 就 `editMessageText`，否則 `sendMessage`。
3. 成功 → `markOutboxDelivered`。
4. 失敗 → `classifyDeliveryError`：
   - `already-delivered` → `markOutboxDelivered`
   - `resend-as-new` → 改呼叫 `sendMessage`，**不增加 attempts**；再失敗才走下面的分類
   - `give-up` → `markOutboxNeedsAttention` + `onNeedsAttention`
   - `retry` → `attempts + 1` 後若 `>= MAX_ATTEMPTS` 則 `markOutboxNeedsAttention` +
     `onNeedsAttention`，否則 `markOutboxFailed(now + (retryAfterMs ?? backoffMs(attempts + 1)))`
5. `start()` 用 `setInterval(drainOnce, 5_000)`，並呼叫 `.unref()`——否則測試與
   `LEDGER_STARTUP_CHECK` 會因為這個 timer 而無法結束。`stop()` 清掉 interval。

**已知且接受的重複**：送出成功但在 `markOutboxDelivered` 之前行程死掉，重啟後會再送一次。
帳本只有一筆、使用者看到兩則訊息——寧可重複也不要遺失。lease 讓它最多重複一次，不會無限重複。
在 `outbox-runner.ts` 的檔頭註解裡寫明這個取捨。

- [ ] **Step 4: 執行測試確認通過**

Run: `docker run --rm -v "$PWD":/app -v personal-ledger-modules:/app/node_modules -w /app personal-ledger:deps pnpm vitest run tests/telegram/outbox-runner.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/telegram/outbox-runner.ts tests/telegram/outbox-runner.test.ts
git commit -m "feat: deliver outbox messages with leases, backoff and a retry cap"
```

---

### Task 7：確認草稿改走 outbox

**Files:**
- Modify: `src/telegram/handlers/drafts.ts`（confirm handler，約 line 244-277）
- Modify: `src/telegram/dependencies.ts`（加入 runner 與 outbox id 產生器）
- Modify: `src/telegram/create-bot.ts`（建立 runner 並交給 handlers）
- Test: `tests/telegram/outbox-confirm.test.ts`（新）

**Interfaces:**
- Consumes: Task 5 的 `confirmDraft(..., outbox)`、Task 6 的 `deliverOutboxMessage`
- Produces: confirm handler 的新行為

- [ ] **Step 1: 寫失敗測試**

```ts
// tests/telegram/outbox-confirm.test.ts
describe("confirming a draft", () => {
  it("still replies immediately when Telegram is healthy", async () => {
    const { bot, calls, repository } = harness();
    // …建立草稿、按確認…
    expect(getText(calls.at(-1))).toContain("已入帳");
    expect(await outboxStatus(repository)).toBe("delivered");
  });

  it("keeps the transaction and queues the message when delivery throws", async () => {
    // AC-20：帳已經記了，訊息稍後補送。
    const { bot, repository } = harness({ failDelivery: true });
    // …按確認…
    expect(await transactionCount(repository)).toBe(1);
    expect(await outboxStatus(repository)).toBe("pending");
  });

  it("delivers the queued message on the next drain", async () => {
    const { bot, repository, runner, api } = harness({ failDelivery: true });
    // …按確認…
    api.failing = false;

    await runner.drainOnce();

    expect(await outboxStatus(repository)).toBe("delivered");
  });
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `docker run --rm -v "$PWD":/app -v personal-ledger-modules:/app/node_modules -w /app personal-ledger:deps pnpm vitest run tests/telegram/outbox-confirm.test.ts`
Expected: FAIL

- [ ] **Step 3: 改寫 confirm handler**

```ts
    const chatId = String(context.chat?.id ?? "");
    const targetMessageId = String(context.callbackQuery.message?.message_id ?? "");
    const transaction = await confirmDraft(
      dependencies.repository,
      draftId,
      dependencies.now().toISOString(),
      dependencies.generateId(),
      {
        messageId: dependencies.generateId(),
        cause: "transaction_confirmed",
        // 在 repository 的 transaction 內被呼叫：transactionId 這時才存在。
        render: (confirmed) => ({
          chatId,
          targetMessageId,
          text: `已入帳：${confirmed.amount.currency} ${confirmed.amount.amount}\n交易 ID：${confirmed.transactionId}`,
        }),
      },
    );
    await context.answerCallbackQuery({ text: "已確認" });
    // 提交後立刻嘗試遞送，使用者體感與先前相同；失敗就留給背景迴圈。
    await dependencies.outboxRunner.drainOnce();
```

注意：**不要**在這裡直接 `editMessageText`。訊息一律由 runner 送出，否則「已送出」與
「outbox 狀態」會有兩個真相來源。

- [ ] **Step 4: 執行完整檢查**

Run: `docker run --rm -v "$PWD":/app -v personal-ledger-modules:/app/node_modules -w /app personal-ledger:deps pnpm check`
Expected: exit 0

- [ ] **Step 5: Commit**

```bash
git add src/telegram/ tests/telegram/outbox-confirm.test.ts
git commit -m "feat: route the confirmation message through the outbox"
```

---

### Task 8：其餘四種帳本變更改走 outbox

**Files:**
- Modify: `src/ports/ledger-repository.ts`、`src/db/sqlite-ledger-repository.ts`（`recordRecovery` 相關寫入、`abandonAdvance`、`updateTransaction`、`softDelete`）
- Modify: `src/application/record-recovery.ts`、`src/application/abandon-advance.ts`、`src/application/mutate-transaction.ts`
- Modify: `src/telegram/handlers/advances.ts`、`src/telegram/handlers/transactions.ts`
- Test: `tests/telegram/outbox-coverage.test.ts`（新）

**Interfaces:**
- Consumes: Task 5 建立的 `OutboxRequest<T>` 模式
- Produces: 五種 `cause` 全部有實際產生者

- [ ] **Step 1: 寫失敗測試**

```ts
// tests/telegram/outbox-coverage.test.ts
import { describe, expect, it } from "vitest";

import { OutboxCauseSchema } from "../../src/domain/outbox.js";

describe("every ledger change queues a message", () => {
  // 規則要單純到好記：帳本一旦變了，使用者就一定會收到訊息。只保證其中幾種，
  // 日後沒有人記得哪些有保證。
  it.each([
    ["transaction_confirmed", confirmScenario],
    ["recovery_recorded", recoveryScenario],
    ["advance_abandoned", abandonScenario],
    ["transaction_updated", updateScenario],
    ["transaction_deleted", deleteScenario],
  ])("queues one message for %s", async (cause, scenario) => {
    const { repository } = await scenario();

    const rows = await allOutbox(repository);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.cause).toBe(cause);
  });

  it("covers every cause the schema allows", () => {
    // 新增 cause 卻忘記接上產生者時，這條會紅。
    expect(new Set(OutboxCauseSchema.options)).toEqual(
      new Set([
        "transaction_confirmed",
        "recovery_recorded",
        "advance_abandoned",
        "transaction_updated",
        "transaction_deleted",
      ]),
    );
  });
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `docker run --rm -v "$PWD":/app -v personal-ledger-modules:/app/node_modules -w /app personal-ledger:deps pnpm vitest run tests/telegram/outbox-coverage.test.ts`
Expected: FAIL，只有 `transaction_confirmed` 有列

- [ ] **Step 3: 逐一接上**

四處都照 Task 5 的形狀：repository 方法多收 `OutboxRequest<T>`，在既有 transaction 內呼叫
`this.enqueueOutbox(...)`；handler 提供 `render` 並在之後 `drainOnce()`。

`abandonAdvance` 需注意它會 `updateTransaction`，而 `updateTransaction` 本身也要寫 outbox——
**同一個使用者動作只能產生一列**。作法是讓 `abandonAdvance` 內部呼叫不帶 outbox 的私有寫入
路徑，只有最外層的公開方法寫 outbox。

- [ ] **Step 4: 執行完整檢查**

Run: `docker run --rm -v "$PWD":/app -v personal-ledger-modules:/app/node_modules -w /app personal-ledger:deps pnpm check`
Expected: exit 0

- [ ] **Step 5: Commit**

```bash
git add src/ tests/
git commit -m "feat: guarantee delivery for every ledger change"
```

---

### Task 9：`needs_attention` 通知與節流

**Files:**
- Create: `src/telegram/notify-attention.ts`
- Modify: `src/telegram/create-bot.ts`（把它接成 runner 的 `onNeedsAttention`）
- Test: `tests/telegram/notify-attention.test.ts`（新）

**Interfaces:**
- Consumes: Task 6 的 `onNeedsAttention` 回呼、既有的 `getSetting`／`setSetting`
- Produces: `createAttentionNotifier(deps): (message: OutboxMessage) => Promise<void>`

- [ ] **Step 1: 寫失敗測試**

```ts
// tests/telegram/notify-attention.test.ts
describe("attention notifier", () => {
  it("tells the owner once when a message gives up", async () => {
    const { notify, api } = harness();

    await notify(stuckMessage());

    expect(api.sendMessage).toHaveBeenCalledOnce();
    expect(api.sendMessage.mock.calls[0]?.[1]).toContain("有訊息送不出去");
  });

  it("stays quiet for ten minutes after the first alert", async () => {
    // 一次連環失敗不該洗版。
    const { notify, api, advance } = harness();
    await notify(stuckMessage());

    advance(9 * 60_000);
    await notify(stuckMessage());

    expect(api.sendMessage).toHaveBeenCalledOnce();
  });

  it("alerts again once the throttle window has passed", async () => {
    const { notify, api, advance } = harness();
    await notify(stuckMessage());

    advance(11 * 60_000);
    await notify(stuckMessage());

    expect(api.sendMessage).toHaveBeenCalledTimes(2);
  });

  it("swallows its own failure instead of throwing", async () => {
    // 正在壞掉的就是 Telegram 這條管道，通知本來就可能送不出去。丟例外會讓
    // drainOnce 整批中斷，後面的列連試都沒試到。
    const { notify, api } = harness();
    api.sendMessage.mockRejectedValue(new Error("network down"));

    await expect(notify(stuckMessage())).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `docker run --rm -v "$PWD":/app -v personal-ledger-modules:/app/node_modules -w /app personal-ledger:deps pnpm vitest run tests/telegram/notify-attention.test.ts`
Expected: FAIL，找不到模組

- [ ] **Step 3: 實作**

節流狀態存在 `settings` 的 `outbox_last_alert_at`（ISO 字串）。文案：

```
⚠️ 有訊息送不出去
帳已經記好了，只是通知沒送到。連線恢復後用 /status 查看並重試。
```

**不得**在通知裡放財務金額或原文——這則訊息本身可能在管道半通不通時送出，而且它的用途是
「去看 /status」，不是重述交易內容。

- [ ] **Step 4: 執行完整檢查**

Run: `docker run --rm -v "$PWD":/app -v personal-ledger-modules:/app/node_modules -w /app personal-ledger:deps pnpm check`
Expected: exit 0

- [ ] **Step 5: Commit**

```bash
git add src/telegram/notify-attention.ts tests/telegram/notify-attention.test.ts src/telegram/create-bot.ts
git commit -m "feat: alert once when a message gives up, and throttle the alerts"
```

---

### Task 10：`/status`

**Files:**
- Create: `src/telegram/format-status.ts`
- Modify: `src/telegram/handlers/drafts.ts`（或新增 `src/telegram/handlers/status.ts`）
- Test: `tests/telegram/status-command.test.ts`（新）

**Interfaces:**
- Consumes: Task 4 的 `summarizeOutbox`、`retryOutboxNeedsAttention`
- Produces: `formatStatus(summary: OutboxSummary, schemaVersion: number): DraftPrompt`；`/status` 指令；`outbox-retry` callback

- [ ] **Step 1: 寫失敗測試**

```ts
// tests/telegram/status-command.test.ts
describe("/status", () => {
  it("reports a healthy queue", async () => {
    const { bot, calls } = harness();

    await bot.handleUpdate(messageUpdate({ updateId: 1, text: "/status" }));

    const text = getText(calls.at(-1)) ?? "";
    expect(text).toContain("待送 0 筆");
    expect(text).toContain("schema 版本：8");
  });

  it("lists what is stuck and offers a way back", async () => {
    const { bot, calls, repository } = harness();
    await seedStuck(repository);

    await bot.handleUpdate(messageUpdate({ updateId: 1, text: "/status" }));

    const payload = JSON.stringify(calls.at(-1)?.payload);
    expect(getText(calls.at(-1))).toContain("待處理 1 筆");
    expect(payload).toContain('"text":"重試全部"');
    // 與其他五支清單指令一致。
    expect(payload).toContain('"text":"關閉清單"');
  });

  it("puts stuck messages back in the queue and drains them", async () => {
    // 少了這條，一次暫時性斷線耗盡重試之後那則訊息就永遠卡著。
    const { bot, repository } = harness();
    await seedStuck(repository);

    await bot.handleUpdate(messageUpdate({ updateId: 1, text: "/status" }));
    await bot.handleUpdate(callbackUpdate({ updateId: 2, data: "outbox-retry" }));

    await expect(pendingCount(repository)).resolves.toBe(0);
    await expect(deliveredCount(repository)).resolves.toBe(1);
  });

  it("hides the retry button when nothing is stuck", async () => {
    const { bot, calls } = harness();

    await bot.handleUpdate(messageUpdate({ updateId: 1, text: "/status" }));

    expect(JSON.stringify(calls.at(-1)?.payload)).not.toContain("重試全部");
  });
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `docker run --rm -v "$PWD":/app -v personal-ledger-modules:/app/node_modules -w /app personal-ledger:deps pnpm vitest run tests/telegram/status-command.test.ts`
Expected: FAIL，`/status` 未註冊

- [ ] **Step 3: 實作**

訊息格式（`cause` 轉成中文；錯誤只印 Telegram 的 description，不含財務資料）：

```
待送 2 筆（最舊 3 分鐘前）
待處理 1 筆 ⚠️
最後成功遞送：14:32
schema 版本：8

⚠️ 確認交易 · 14:05 · 已重試 5 次
   Telegram 回應 403
```

按鈕：有 `needs_attention` 才出現 `[重試全部]`；最後一列固定 `[關閉清單]`，callback
`dismiss-status`，與其他清單指令一致。`outbox-retry` 呼叫 `retryOutboxNeedsAttention`
後 `drainOnce()` 再重繪。

- [ ] **Step 4: 執行完整檢查**

Run: `docker run --rm -v "$PWD":/app -v personal-ledger-modules:/app/node_modules -w /app personal-ledger:deps pnpm check`
Expected: exit 0

- [ ] **Step 5: Commit**

```bash
git add src/telegram/ tests/telegram/status-command.test.ts
git commit -m "feat: add /status with a way back for stuck messages"
```

---

### Task 11：migration 前快照（AC-24）

**Files:**
- Create: `src/db/pre-migration-snapshot.ts`
- Modify: `src/db/migrate.ts`（匯出「還有哪些版本沒套用」）
- Modify: `src/main.ts`
- Test: `tests/db/pre-migration-snapshot.test.ts`（新）

**Interfaces:**
- Consumes: `migrate(database)`
- Produces:
  - `pendingMigrationVersions(database): number[]`
  - `latestMigrationVersion(): number`（`migrate.ts` 匯出，供快照檔名使用）
  - `takePreMigrationSnapshot(database, dataDirectory: string, targetVersion: number, now: Date): string | null`（回傳快照路徑，沒有待套用則回 `null`）

- [ ] **Step 1: 寫失敗測試**

```ts
// tests/db/pre-migration-snapshot.test.ts
describe("pre-migration snapshot", () => {
  it("writes a snapshot only when a migration is actually pending", () => {
    const { directory, databasePath } = freshLedger(); // 已升級到最新
    const database = openDatabase(databasePath);

    expect(takePreMigrationSnapshot(database, directory, 8, new Date())).toBeNull();
    expect(existsSync(join(directory, "pre-migration"))).toBe(false);
  });

  it("snapshots an old database before upgrading it", () => {
    const { directory, databasePath } = ledgerAtVersion(7);
    const database = openDatabase(databasePath);

    const snapshot = takePreMigrationSnapshot(database, directory, 8, new Date());

    expect(snapshot).toMatch(/pre-migration\/8-.*\.sqlite$/);
    // 快照本身必須是可用的資料庫，否則它不是備份只是檔案。
    const restored = openDatabase(snapshot ?? "");
    expect(restored.pragma("integrity_check", { simple: true })).toBe("ok");
    expect(restored.prepare("SELECT max(version) AS v FROM schema_migrations").get()).toEqual({ v: 7 });
    restored.close();
  });

  it("keeps only the three most recent snapshots", () => {
    // 同一個 volume 裝不下無限份，而且舊的沒有價值。
    const { directory, databasePath } = ledgerAtVersion(7);
    const database = openDatabase(databasePath);
    const folder = join(directory, "pre-migration");

    for (let minute = 0; minute < 5; minute += 1) {
      takePreMigrationSnapshot(database, directory, 8, new Date(Date.UTC(2026, 8, 30, 1, minute)));
    }

    const files = readdirSync(folder).sort();
    expect(files).toHaveLength(3);
    // 留下的是最新的三份。
    expect(files[0]).toContain("01-02");
    expect(files[2]).toContain("01-04");
  });

  it("leaves the snapshot in place when the migration then fails", () => {
    // AC-24 的重點：快照要在失敗之後還找得到，否則沒有東西可以還原。
    const { directory, databasePath } = ledgerAtVersion(7);
    const database = openDatabase(databasePath);
    const snapshot = takePreMigrationSnapshot(database, directory, 8, new Date());
    // 讓 migration 失敗：先佔用它要建立的資料表名稱。
    database.exec("CREATE TABLE outbox_messages (nope TEXT)");

    expect(() => {
      migrate(database);
    }).toThrow();

    expect(existsSync(snapshot ?? "")).toBe(true);
    expect(
      database.prepare("SELECT max(version) AS v FROM schema_migrations").get(),
    ).toEqual({ v: 7 });
  });
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `docker run --rm -v "$PWD":/app -v personal-ledger-modules:/app/node_modules -w /app personal-ledger:deps pnpm vitest run tests/db/pre-migration-snapshot.test.ts`
Expected: FAIL，找不到模組

- [ ] **Step 3: 實作**

```ts
// src/db/pre-migration-snapshot.ts
/**
 * migration 之前拍一份快照。用 VACUUM INTO 而不是複製檔案：它由 SQLite 自己讀一致快照，
 * 在 WAL 模式下也正確（直接複製 .sqlite 會漏掉還在 WAL 裡的已提交資料）。
 *
 * 快照與正本在同一個 volume，volume 整個損毀兩者都沒了。它的用途是 migration 回滾，
 * 不是災難復原——災難復原是 scripts/backup.sh 與 M5 的異地副本。
 */
export function takePreMigrationSnapshot(
  database: Database.Database,
  dataDirectory: string,
  targetVersion: number,
  now: Date,
): string | null {
  if (pendingMigrationVersions(database).length === 0) return null;
  const folder = join(dataDirectory, "pre-migration");
  mkdirSync(folder, { recursive: true });
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const destination = join(folder, `${String(targetVersion)}-${stamp}.sqlite`);
  database.exec(`VACUUM INTO '${destination.replace(/'/g, "''")}'`);
  pruneSnapshots(folder, 3);
  return destination;
}
```

`pendingMigrationVersions` 讀 `schema_migrations` 與 `migrate.ts` 的 `migrations` 陣列比對；
`schema_migrations` 不存在（全新資料庫）時回傳空陣列——全新資料庫沒有東西需要備份。

- [ ] **Step 4: 接進 `main.ts`**

```ts
  const database = openDatabase(config.databasePath);
  try {
    const snapshot = takePreMigrationSnapshot(
      database,
      dirname(resolve(config.databasePath)),
      latestMigrationVersion(),
      new Date(),
    );
    if (snapshot) logger.info("migration 前已建立快照", { snapshot });
    migrate(database);
```

migration 失敗時 `composeRuntime` 既有的 `catch` 會關掉資料庫並往上拋，`main` 印錯誤並
`exitCode = 1`——AC-24 的「不以半升級狀態啟動」已經成立，快照則讓它有東西可還原。

- [ ] **Step 5: 執行完整檢查**

Run: `docker run --rm -v "$PWD":/app -v personal-ledger-modules:/app/node_modules -w /app personal-ledger:deps pnpm check`
Expected: exit 0

- [ ] **Step 6: Commit**

```bash
git add src/db/pre-migration-snapshot.ts src/db/migrate.ts src/main.ts tests/db/pre-migration-snapshot.test.ts
git commit -m "feat: snapshot the ledger before running a migration"
```

---

### Task 12：唯一的日誌出口與遮罩（AC-28）

**Files:**
- Create: `src/logger.ts`
- Modify: `src/main.ts`、`src/telegram/create-bot.ts`（移除各自的 `console.*`）
- Test: `tests/logger.test.ts`（新）

**Interfaces:**
- Consumes: 既有 `describeError`（`create-bot.ts:27-40`，搬進 logger 並保留其註解與判斷）
- Produces: `logger.info(message: string, fields?: Record<string, unknown>): void`、`.warn`、`.error`

- [ ] **Step 1: 寫失敗測試**

```ts
// tests/logger.test.ts
describe("logger", () => {
  it("never prints the bot token", () => {
    const { logger, lines } = capture();

    logger.error("呼叫失敗", { url: "https://api.telegram.org/bot123456789:AAExampleToken/sendMessage" });

    expect(lines.join("\n")).not.toContain("AAExampleToken");
    expect(lines.join("\n")).toContain("***");
  });

  it("prints a short hash instead of the owner id", () => {
    const { logger, lines } = capture();

    logger.info("啟動", { ownerId: "729367170" });

    expect(lines.join("\n")).not.toContain("729367170");
    expect(lines.join("\n")).toMatch(/[0-9a-f]{8}/);
  });

  it("drops fields that carry financial text", () => {
    // 交易原文、訊息內容都不進日誌；要關聯就用 draft_ref 或 message_id。
    const { logger, lines } = capture();

    logger.error("解析失敗", { rawText: "午餐 1260，小明欠 630", draftRef: "a1b2c3d4" });

    expect(lines.join("\n")).not.toContain("午餐");
    expect(lines.join("\n")).not.toContain("1260");
    expect(lines.join("\n")).toContain("a1b2c3d4");
  });

  it("reduces a SQLite error to its class", () => {
    const error = Object.assign(new Error("UNIQUE constraint failed: transactions.request_id"), {
      name: "SqliteError",
    });
    const { logger, lines } = capture();

    logger.error("寫入失敗", { error });

    expect(lines.join("\n")).toContain("SqliteError");
    expect(lines.join("\n")).not.toContain("request_id");
  });

  it("keeps a Telegram error's code and description", () => {
    // 這兩個欄位是 Bot API 的錯誤描述，不含使用者輸入，少了它們就診斷不出是哪一種呼叫失敗。
    const { logger, lines } = capture();

    logger.error("遞送失敗", { error: grammyError(400, "Bad Request: message is not modified") });

    expect(lines.join("\n")).toContain("message is not modified");
  });
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `docker run --rm -v "$PWD":/app -v personal-ledger-modules:/app/node_modules -w /app personal-ledger:deps pnpm vitest run tests/logger.test.ts`
Expected: FAIL，找不到模組

- [ ] **Step 3: 實作**

遮罩規則：

- 欄位名在拒絕清單（`rawText`、`rawInputSnapshot`、`text`、`note`、`token`、`telegramBotToken`）
  一律整個丟掉。
- 值裡符合 `\d{6,}:[A-Za-z0-9_-]{30,}` 的一律換成 `***`（bot token 樣式）。
- `ownerId` 換成 `sha256(ownerId).slice(0, 8)`。
- `error` 欄位交給搬過來的 `describeError`。

- [ ] **Step 4: 換掉所有既有 `console.*`**

`src/main.ts:82`、`src/main.ts:111`、`src/telegram/create-bot.ts:65`、`:72`、`:83` 五處。
再加一條 eslint 規則 `no-console`（`src/logger.ts` 以外），讓下一個人不會繞過去。

- [ ] **Step 5: 執行完整檢查**

Run: `docker run --rm -v "$PWD":/app -v personal-ledger-modules:/app/node_modules -w /app personal-ledger:deps pnpm check`
Expected: exit 0

- [ ] **Step 6: Commit**

```bash
git add src/logger.ts src/main.ts src/telegram/create-bot.ts eslint.config.mjs tests/logger.test.ts
git commit -m "feat: send every log line through one redacting exit"
```

---

### Task 13：指令清單、`/help` 與 `setMyCommands`（附帶項目）

**Files:**
- Create: `src/telegram/commands.ts`、`src/telegram/format-help.ts`
- Modify: `src/telegram/create-bot.ts`
- Test: `tests/telegram/help-command.test.ts`（新）

**Interfaces:**
- Consumes: 無
- Produces: `LEDGER_COMMANDS: readonly { command: string; description: string }[]`、`formatHelp(): string`

- [ ] **Step 1: 寫失敗測試**

```ts
// tests/telegram/help-command.test.ts
describe("/help", () => {
  it("leads with what you can type, not with the command list", () => {
    // 這個 bot 的主要介面是自由文字；三個月後會忘記的是句子怎麼寫。
    const text = formatHelp();

    expect(text.indexOf("午餐 120")).toBeLessThan(text.indexOf("/pending"));
    expect(text).toContain("薪水 +85000");
    expect(text).toContain("午餐 1260，小明欠 630");
  });

  it("lists every registered command", () => {
    const text = formatHelp();

    for (const { command } of LEDGER_COMMANDS) {
      expect(text).toContain(`/${command}`);
    }
  });

  it("registers the same list with Telegram so the / menu shows it", async () => {
    const { bot, calls } = harness();

    await startBot(bot);

    const call = calls.find((item) => item.method === "setMyCommands");
    expect(call).toBeDefined();
    expect((call?.payload as { commands: { command: string }[] }).commands.map((c) => c.command))
      .toEqual(LEDGER_COMMANDS.map((c) => c.command));
  });

  it("keeps the command list and the handlers in step", () => {
    // 手寫的清單一定會漂移。本專案已經因為「同一件事兩份定義」出過三次問題。
    expect(LEDGER_COMMANDS.map((item) => item.command).sort()).toEqual([
      "advances", "help", "keywords", "month", "pending", "recent", "status", "today",
    ]);
  });
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `docker run --rm -v "$PWD":/app -v personal-ledger-modules:/app/node_modules -w /app personal-ledger:deps pnpm vitest run tests/telegram/help-command.test.ts`
Expected: FAIL，找不到模組

- [ ] **Step 3: 實作**

```ts
// src/telegram/commands.ts
/**
 * 指令清單的唯一定義。`/help` 的文字、setMyCommands 的參數、handler 註冊三者都讀這一份，
 * 新增指令時忘記更新 help 這件事因此不可能發生。
 */
export const LEDGER_COMMANDS = [
  { command: "pending", description: "待處理草稿" },
  { command: "advances", description: "未回收代墊" },
  { command: "recent", description: "最近交易" },
  { command: "today", description: "今日統計" },
  { command: "month", description: "本月統計" },
  { command: "keywords", description: "教過的分類關鍵字" },
  { command: "status", description: "服務狀態與待送訊息" },
  { command: "help", description: "怎麼記帳與指令一覽" },
] as const;
```

`formatHelp()` 依 spec §6b 的版面產生；指令段落由 `LEDGER_COMMANDS` 展開。
`create-bot.ts` 在 `bot.start()` 之前呼叫 `bot.api.setMyCommands([...LEDGER_COMMANDS])`。

- [ ] **Step 4: 執行完整檢查**

Run: `docker run --rm -v "$PWD":/app -v personal-ledger-modules:/app/node_modules -w /app personal-ledger:deps pnpm check`
Expected: exit 0

- [ ] **Step 5: Commit**

```bash
git add src/telegram/commands.ts src/telegram/format-help.ts src/telegram/create-bot.ts tests/telegram/help-command.test.ts
git commit -m "feat: add /help and register the command menu from one list"
```

---

### Task 14：文件更正與里程碑收尾

**Files:**
- Modify: `docs/operations/backup-and-restore.md`
- Modify: `docs/roadmap.md`
- Create: `docs/quality/m4-acceptance.md`

- [ ] **Step 1: 更正備份文件的 WAL 段落**

`docs/operations/backup-and-restore.md` 目前寫「`journal_mode=delete`（不是 WAL，因此沒有
`-wal`／`-shm` 需要一起備份）」。M4 之後這句話是錯的。要改：

- 資料位置表格的 `journal_mode` 改成 `WAL`，並說明 `-wal`／`-shm` 會與主檔並存。
- 「目前實際用過的做法：直接複製檔案」整段改為**明確的反面教材**：WAL 模式下直接複製
  `.sqlite` 會漏掉還在 WAL 裡的已提交資料，一律改用 `scripts/backup.sh`。
- 補一句：既有那五份手動備份是在 `delete` 模式下拍的，仍然有效。

- [ ] **Step 2: 實測確認備份腳本在 WAL 下仍正確**

```bash
./scripts/backup.sh
# 還原最新快照到臨時 volume，確認 integrity_check 與筆數
```

把結果寫進 `docs/quality/m4-acceptance.md` 的關卡一。

- [ ] **Step 3: 更新 roadmap**

M4 標成完成、日期、測試數；第 6 節「現在要做的事」改成 M5。

- [ ] **Step 4: 建立驗收文件骨架**

`docs/quality/m4-acceptance.md`，三道關卡的標題與人工驗收清單（見下節）。

- [ ] **Step 5: Commit**

```bash
git add docs/
git commit -m "docs: correct the backup runbook for WAL and record M4"
```

---

## 人工 Telegram 驗收清單（關卡三）

| # | 動作 | 預期 |
|---|---|---|
| 1 | `午餐 120` → 確認 | 立刻看到「已入帳」，與先前無異 |
| 2 | `/status` | 待送 0、待處理 0、有最後成功遞送時間、schema 8 |
| 3 | 斷網後確認一筆草稿 | 帳有記（恢復後 `/recent` 查得到）；`/status` 顯示待送 1 |
| 4 | 恢復連線等 15 秒 | 補送出確認訊息；`/status` 回到待送 0 |
| 5 | 斷網 10 分鐘後確認一筆 | 用盡重試後收到一則「有訊息送不出去」；`/status` 顯示待處理 1 |
| 6 | `/status` 按「重試全部」 | 訊息補送出，待處理歸零 |
| 7 | 確認當下強制 `docker kill` | 重啟後訊息補送出，且交易只有一筆（`/recent` 檢查） |
| 8 | `/help` | 先講輸入語法再列指令；輸入框打 `/` 有指令選單 |
| 9 | `/status` 按「關閉清單」 | 訊息消失 |
| 10 | `docker logs` | 不含 token、owner id、財務原文 |

## 完成定義

1. **自動驗證**：AC-20、AC-23、AC-24、AC-28 的測試通過；`pnpm check` **exit 0**；Docker 建置與
   `LEDGER_STARTUP_CHECK=1` 啟動檢查通過。
2. **程式審查**：對整個分支的 diff 執行 `superpowers:requesting-code-review`，逐條裁決。
3. **人工 Telegram 驗收**：完成上表並記錄；期間發現的缺陷一律先補回歸測試再修。

額外條件：

- 既有資料經 migration 0008 後完整保留，`foreign_key_check` 無錯誤。
- 切換 WAL 之後 `scripts/backup.sh` 的快照仍可還原並通過 `integrity_check`。
- `src/domain/ledger-summary.ts` 與 migrations 0001–0007 未被修改。

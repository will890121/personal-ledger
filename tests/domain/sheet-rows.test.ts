import { describe, expect, it } from "vitest";

import { ALLOCATIONS_HEADER, allocationRows, transactionRow } from "../../src/domain/sheet-rows.js";
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

  it("writes every column in the order ALLOCATIONS_HEADER declares", () => {
    // 修正 B：上面那條測試只咬住日期與狀態兩欄，D–J 七欄（資金流向、用途、金額、
    // 分類、子分類、對象、備註）完全沒人斷言過——把它們全部換成常數，592 條全綠。
    // 這裡逐格手寫期望值、每一欄給不同的值，任何一組欄位對調或寫錯都會被抓到。
    // 期望值刻意不透過 allocationRows 自己算：那樣會讓投影函式對自己的錯誤恆真。
    const rows = allocationRows({
      ...base,
      transactionId: "txn-42",
      occurredDate: "2026-10-01",
      status: "confirmed",
      allocations: [
        {
          allocationId: "alloc-77",
          fundsEffect: "outflow",
          purpose: "expense",
          amount: "555.25",
          categoryName: "餐飲",
          subcategoryName: "午餐",
          counterpartyName: "小明",
          note: "備註內容",
        },
      ],
    });

    expect(rows).toHaveLength(1);
    // 逐格核對 ALLOCATIONS_HEADER 的欄序：
    // allocation_id, transaction_id, 日期, 資金流向, 用途, 金額, 分類, 子分類, 對象, 備註, 交易狀態
    expect(ALLOCATIONS_HEADER).toEqual([
      "allocation_id",
      "transaction_id",
      "日期",
      "資金流向",
      "用途",
      "金額",
      "分類",
      "子分類",
      "對象",
      "備註",
      "交易狀態",
    ]);
    expect(rows[0]).toEqual([
      { kind: "string", value: "alloc-77" },
      { kind: "string", value: "txn-42" },
      { kind: "date", value: 46296 },
      { kind: "string", value: "outflow" },
      { kind: "string", value: "expense" },
      { kind: "number", value: 555.25 },
      { kind: "string", value: "餐飲" },
      { kind: "string", value: "午餐" },
      { kind: "string", value: "小明" },
      { kind: "string", value: "備註內容" },
      { kind: "string", value: "confirmed" },
    ]);
  });
});

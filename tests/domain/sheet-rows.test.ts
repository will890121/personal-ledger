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

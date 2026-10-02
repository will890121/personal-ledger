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
        cells: [
          { kind: "string", value: "t1" },
          { kind: "date", value: 46296 },
        ],
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

  it("rejects a write whose cell count does not match the header width", async () => {
    // 真實的 UpdateCellsRequest 只碰指定範圍，範圍外的欄位不會被清空。模擬器若
    // 靜默「整列取代」，這個落差在測試裡永遠不會被抓到——所以欄數不合就該拋錯。
    const client = new FakeSheetsClient({ Transactions: [["id", "日期", "金額"]] });

    await expect(
      client.updateCells([
        { tab: "Transactions", rowIndex: 2, cells: [{ kind: "string", value: "t1" }] },
      ]),
    ).rejects.toThrow(/Transactions row 2/);

    expect(await client.readColumns("Transactions", 3)).toEqual([["id", "日期", "金額"]]);
  });

  it("skips the width check while the header row is still empty", async () => {
    // 分頁空著時，第一輪會在第 1 列補一個零寬度的空白列（資料一律從第 2 列起）。
    // 若把它當成「0 欄的標題」，同一個分頁之後的每一次寫入都會被拒絕——初始為空的
    // 分頁上就不可能跑多輪同步，而收斂本來就是多輪的性質。
    const client = new FakeSheetsClient({ Transactions: [] });

    await client.updateCells([
      { tab: "Transactions", rowIndex: 2, cells: [{ kind: "string", value: "t1" }] },
    ]);
    await client.updateCells([
      { tab: "Transactions", rowIndex: 3, cells: [{ kind: "string", value: "t2" }] },
    ]);

    expect(await client.readColumns("Transactions", 1)).toEqual([[""], ["t1"], ["t2"]]);
  });

  it("rejects a batch that writes to the same row twice", async () => {
    // 同一批裡兩筆寫到同一列代表引擎的列號算錯了，靜默後寫獲勝會讓這個錯誤
    // 完全沒有訊號。
    const client = new FakeSheetsClient({ Transactions: [["id"]] });

    await expect(
      client.updateCells([
        { tab: "Transactions", rowIndex: 2, cells: [{ kind: "string", value: "first" }] },
        { tab: "Transactions", rowIndex: 2, cells: [{ kind: "string", value: "second" }] },
      ]),
    ).rejects.toThrow(/Transactions row 2/);

    expect(await client.readColumns("Transactions", 1)).toEqual([["id"]]);
  });

  it("counts api calls so tests can assert none happen when idle", async () => {
    // Task 9 的「閒置時不打 API」需要這個計數器才能被釘住。
    const client = new FakeSheetsClient({ Transactions: [["id"]] });

    await client.readColumns("Transactions", 1);
    expect(client.callCount).toBe(1);
  });
});

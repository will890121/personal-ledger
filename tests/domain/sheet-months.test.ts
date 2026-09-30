import { describe, expect, it } from "vitest";

import { affectedMonths, monthRange } from "../../src/domain/sheet-months.js";

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

describe("monthRange", () => {
  it("covers the whole month including the last day", () => {
    // 月底若算錯（例如用 30 天），每個月的最後一天都會從摘要裡消失。
    expect(monthRange("2026-10")).toEqual({ from: "2026-10-01", to: "2026-10-31" });
  });

  it("handles february in a leap year", () => {
    expect(monthRange("2028-02")).toEqual({ from: "2028-02-01", to: "2028-02-29" });
  });
});

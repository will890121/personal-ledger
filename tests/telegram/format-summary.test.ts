import { describe, expect, it } from "vitest";
import { summarizeAllocations } from "../../src/domain/ledger-summary.js";
import { formatSummary } from "../../src/telegram/format-summary.js";

describe("formatSummary", () => {
  it("shows both accounting views, negative values and stable categories", () => {
    const summary = summarizeAllocations([
      {
        fundsEffect: "inflow",
        purpose: "refund",
        amount: "20",
        categoryId: "b",
        categoryKey: "b",
        categoryName: "購物",
      },
      {
        fundsEffect: "none",
        purpose: "expense",
        amount: "5",
        categoryId: "a",
        categoryKey: "a",
        categoryName: "餐飲",
      },
    ]);
    const text = formatSummary("今日摘要", summary);
    expect(text).toContain("實際流入：TWD 20");
    expect(text).toContain("個人淨支出：TWD -15");
    expect(text.indexOf("餐飲")).toBeLessThan(text.indexOf("購物"));
  });

  it("formats an empty ledger", () => {
    expect(formatSummary("本月摘要", summarizeAllocations([]))).toContain("尚無分類支出。");
  });
});

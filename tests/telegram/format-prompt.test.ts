import { describe, expect, it } from "vitest";

import { expenseCategoryLeaves } from "../../src/domain/category-catalog.js";
import { formatBatchSummary, formatPrompt } from "../../src/telegram/format-prompt.js";
import {
  completeLunchDraft,
  expenseCategories,
  incompleteDraftWithPendingCategory,
  incompleteLunchDraft,
} from "../fixtures/drafts.js";

describe("formatPrompt", () => {
  it("asks for an amount by reply and offers no keyboard", () => {
    const prompt = formatPrompt(incompleteLunchDraft(), "a7b2c9e4", {});

    expect(prompt.text).toContain("午餐");
    expect(prompt.text).toContain("回覆這則訊息");
    expect(prompt.replyMarkup).toBeUndefined();
  });

  it("offers candidate buttons for an enumerable field", () => {
    const draft = incompleteDraftWithPendingCategory(["category-a", "category-b"]);

    const prompt = formatPrompt(draft, "a7b2c9e4", {
      categories: expenseCategories(["category-a", "category-b"]),
    });

    expect(prompt.replyMarkup?.inline_keyboard[0]).toEqual([
      { text: "分類 0", callback_data: "a:a7b2c9e4:cat:0" },
      { text: "分類 1", callback_data: "a:a7b2c9e4:cat:1" },
    ]);
  });

  it("caps the candidate buttons so an unbounded list cannot flood the prompt", () => {
    // 上限存在是為了交易對象這種沒有天花板的清單；分類不該被它截斷，見下一則測試。
    const candidates = Array.from({ length: 40 }, (_, index) => `category-${String(index)}`);
    const draft = incompleteDraftWithPendingCategory(candidates);

    const prompt = formatPrompt(draft, "a7b2c9e4", { categories: expenseCategories(candidates) });

    // 最後一列固定是取消鍵，不算候選。
    const candidateRows = (prompt.replyMarkup?.inline_keyboard ?? []).slice(0, -1);
    expect(candidateRows.flat()).toHaveLength(24);
  });

  it("offers a button for every expense category, including the ones sorted last", () => {
    // 「不猜、改追問」把所有解不出分類的句子都送到這裡，所以這則訊息必須能表達完整的
    // 分類表。候選依 key 排序，「旅遊」「待分類」排在最後，上限一旦低於分類數它們就
    // 連按鈕都沒有——而分類追問只收按鈕，文字回覆會被當成金額退回，使用者無路可走。
    const categories = expenseCategoryLeaves.map(([key, name]) => ({
      categoryId: `category-${key}`,
      ownerId: "owner-1",
      key,
      name,
      kind: "expense" as const,
      parentId: "category-expense-root",
      depth: 2 as const,
      active: true,
    }));
    const draft = incompleteDraftWithPendingCategory(categories.map((item) => item.categoryId));

    const prompt = formatPrompt(draft, "a7b2c9e4", { categories });

    const labels = (prompt.replyMarkup?.inline_keyboard ?? [])
      .slice(0, -1)
      .flatMap((row) => row.map((button) => button.text));
    expect(labels).toEqual(categories.map((item) => item.name));
    expect(labels).toContain("旅遊");
    expect(labels).toContain("待分類");
  });
  it("always offers a way out of a candidate prompt", () => {
    // 分類追問只收按鈕（文字回覆會被當成金額退回），少了取消鍵這則訊息就沒有出口，
    // 草稿只能一直停在 awaiting_input，要另外開 /pending 才處理得掉。
    const draft = incompleteDraftWithPendingCategory(["category-0", "category-1"]);

    const prompt = formatPrompt(draft, "a7b2c9e4", {
      categories: expenseCategories(["category-0", "category-1"]),
    });

    const rows = prompt.replyMarkup?.inline_keyboard ?? [];
    expect(rows.at(-1)).toEqual([{ text: "取消", callback_data: "x:a7b2c9e4" }]);
  });
});

describe("formatBatchSummary", () => {
  it("reports counts per outcome", () => {
    const items = [
      {
        index: 0,
        segment: "午餐 120",
        outcome: { kind: "draft" as const, draft: completeLunchDraft(), draftRef: "a7b2c9e4" },
      },
      {
        index: 1,
        segment: "午餐 60",
        outcome: { kind: "draft" as const, draft: completeLunchDraft(), draftRef: "b7b2c9e4" },
      },
      {
        index: 2,
        segment: "午餐",
        outcome: {
          kind: "incomplete" as const,
          draft: incompleteLunchDraft(),
          draftRef: "c7b2c9e4",
        },
      },
    ];

    expect(formatBatchSummary(items)).toBe("3 筆：2 筆待確認、1 筆待補欄位");
  });

  it("reports unparsed segments", () => {
    const items = [
      {
        index: 0,
        segment: "午餐 120",
        outcome: { kind: "draft" as const, draft: completeLunchDraft(), draftRef: "a7b2c9e4" },
      },
      {
        index: 1,
        segment: "在嗎",
        outcome: { kind: "unparsed" as const, reason: "unresolved_purpose" as const },
      },
    ];

    expect(formatBatchSummary(items)).toBe("2 筆：1 筆待確認、1 筆無法解析");
  });
});

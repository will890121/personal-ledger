import { describe, expect, it } from "vitest";

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

  it("caps candidates at ten per prompt", () => {
    const candidates = Array.from({ length: 14 }, (_, index) => `category-${String(index)}`);
    const draft = incompleteDraftWithPendingCategory(candidates);

    const prompt = formatPrompt(draft, "a7b2c9e4", { categories: expenseCategories(candidates) });

    expect(prompt.replyMarkup?.inline_keyboard.flat()).toHaveLength(10);
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

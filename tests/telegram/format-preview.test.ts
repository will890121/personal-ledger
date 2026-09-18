import { describe, expect, it } from "vitest";

import { formatPreview } from "../../src/telegram/format-preview.js";
import type { TransactionDraft } from "../../src/domain/ledger.js";

const draft: TransactionDraft = {
  draftId: "draft-1",
  ownerId: "123",
  requestId: "request-1",
  sourceEventId: "event-1",
  occurredDate: "2026-09-18",
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

describe("formatPreview", () => {
  it("shows accounting fields and confirm/cancel callbacks", () => {
    const preview = formatPreview(draft);

    expect(preview.text).toContain("2026-09-18");
    expect(preview.text).toContain("支出");
    expect(preview.text).toContain("TWD 120");
    expect(preview.text).toContain("餐飲／午餐");
    expect(preview.replyMarkup.inline_keyboard).toEqual([
      [
        { text: "確認", callback_data: "confirm:draft-1" },
        { text: "取消", callback_data: "cancel:draft-1" },
      ],
    ]);
  });
});

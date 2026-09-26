import { describe, expect, it } from "vitest";

import { formatPreview } from "../../src/telegram/format-preview.js";
import type { TransactionDraft } from "../../src/domain/ledger.js";

const baseAllocation = {
  allocationId: "allocation-1",
  fundsEffect: "outflow" as const,
  purpose: "expense" as const,
  amount: { amount: "120", currency: "TWD" as const },
  category: "餐飲",
  subcategory: "午餐",
};

const draft: TransactionDraft = {
  draftId: "draft-1",
  ownerId: "123",
  requestId: "request-1",
  sourceEventId: "event-1",
  occurredDate: "2026-09-18",
  amount: { amount: "120", currency: "TWD" },
  allocations: [baseAllocation],
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

  it("renders a single-allocation draft as a blank-line-separated tree block", () => {
    // 鎖定版型 D 的完整輸出：總額與配置區塊之間空一行，配置本身用
    // 「▸ 資金效果 · 用途」與縮排「分類 · 幣別 金額」兩行呈現。
    const preview = formatPreview(draft);

    expect(preview.text).toBe(
      ["日期：2026-09-18", "總金額：TWD 120", "", "資金流出 · 支出", "└ 餐飲／午餐 · TWD 120"].join(
        "\n",
      ),
    );
  });

  it("renders a multi-allocation split with per-person tree entries", () => {
    // 對應使用者驗收時指定的三人分帳範例：每筆配置各自成一個樹狀節點，
    // 資金效果與用途放在第一行、交易對象附加在用途後方括號中。
    const preview = formatPreview(
      {
        ...draft,
        occurredDate: "2026-09-25",
        amount: { amount: "1000", currency: "TWD" },
        allocations: [
          {
            ...baseAllocation,
            allocationId: "self",
            amount: { amount: "332", currency: "TWD" },
            category: "餐飲",
            subcategory: "午餐",
          },
          {
            ...baseAllocation,
            allocationId: "xiaoming-share",
            amount: { amount: "334", currency: "TWD" },
            purpose: "advance",
            category: "餐飲",
            subcategory: "午餐",
            counterpartyId: "xiaoming",
          },
          {
            ...baseAllocation,
            allocationId: "xiaohua-share",
            amount: { amount: "334", currency: "TWD" },
            purpose: "advance",
            category: "餐飲",
            subcategory: "午餐",
            counterpartyId: "xiaohua",
          },
        ],
      },
      {
        counterparties: [
          { counterpartyId: "xiaoming", ownerId: "123", name: "小明", active: true },
          { counterpartyId: "xiaohua", ownerId: "123", name: "小華", active: true },
        ],
      },
    );

    expect(preview.text).toBe(
      [
        "日期：2026-09-25",
        "總金額：TWD 1000",
        "",
        "資金流出 · 支出",
        "└ 餐飲／午餐 · TWD 332",
        "資金流出 · 代墊 (小明)",
        "└ 餐飲／午餐 · TWD 334",
        "資金流出 · 代墊 (小華)",
        "└ 餐飲／午餐 · TWD 334",
      ].join("\n"),
    );
  });

  it("falls back to the counterparty id when the name cannot be resolved", () => {
    const preview = formatPreview({
      ...draft,
      allocations: [
        { ...baseAllocation, purpose: "advance_recovery", counterpartyId: "unknown-id" },
      ],
    });

    expect(preview.text).toContain("資金流出 · 代墊收回 (unknown-id)");
  });

  it("shows every allocation and the credit-card cash effect", () => {
    const preview = formatPreview({
      ...draft,
      amount: { amount: "1015", currency: "TWD" },
      allocations: [
        {
          ...baseAllocation,
          amount: { amount: "1000", currency: "TWD" },
          fundsEffect: "internal",
          purpose: "transfer",
          category: "轉帳",
          subcategory: undefined,
        },
        {
          ...baseAllocation,
          allocationId: "fee",
          amount: { amount: "15", currency: "TWD" },
          purpose: "fee",
          category: "金融費用",
          subcategory: undefined,
        },
      ],
    });
    expect(preview.text).toContain("內部移轉 · 轉帳");
    expect(preview.text).toContain("資金流出 · 手續費");

    const credit = formatPreview({
      ...draft,
      allocations: [{ ...baseAllocation, fundsEffect: "none" }],
    });
    expect(credit.text).toContain("不影響當下可動用資金");
  });

  it("shows resolved merchant and account names", () => {
    const preview = formatPreview(
      { ...draft, merchantId: "uber", accountFromId: "card" },
      {
        merchants: [{ merchantId: "uber", ownerId: "123", name: "Uber", active: true }],
        accounts: [
          {
            accountId: "card",
            ownerId: "123",
            name: "國泰卡",
            type: "credit_card",
            currency: "TWD",
            active: true,
          },
        ],
      },
    );
    expect(preview.text).toContain("商家：Uber");
    expect(preview.text).toContain("帳戶：國泰卡");
  });

  it("shows both source and destination accounts for transfers", () => {
    const preview = formatPreview(
      {
        ...draft,
        accountFromId: "taishin",
        accountToId: "cathay",
        allocations: [
          { ...baseAllocation, fundsEffect: "internal", purpose: "transfer", category: "轉帳" },
        ],
      },
      {
        accounts: [
          {
            accountId: "taishin",
            ownerId: "123",
            name: "台新",
            type: "bank",
            currency: "TWD",
            active: true,
          },
          {
            accountId: "cathay",
            ownerId: "123",
            name: "國泰",
            type: "bank",
            currency: "TWD",
            active: true,
          },
        ],
      },
    );
    expect(preview.text).toContain("來源帳戶：台新");
    expect(preview.text).toContain("目的帳戶：國泰");
  });
});

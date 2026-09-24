import { describe, expect, it } from "vitest";

import { parseTransaction } from "../../src/parser/rule-parser.js";

const cathayCard = {
  accountId: "cathay-card",
  ownerId: "123",
  name: "國泰卡",
  type: "credit_card" as const,
  currency: "TWD" as const,
  active: true,
};
const accounts = [
  {
    accountId: "cash",
    ownerId: "123",
    name: "現金",
    type: "cash" as const,
    currency: "TWD" as const,
    active: true,
  },
  {
    accountId: "taishin",
    ownerId: "123",
    name: "台新",
    type: "bank" as const,
    currency: "TWD" as const,
    active: true,
  },
  {
    accountId: "cathay",
    ownerId: "123",
    name: "國泰",
    type: "bank" as const,
    currency: "TWD" as const,
    active: true,
  },
  cathayCard,
];
const context = {
  ownerId: "123",
  requestId: "request-1",
  sourceEventId: "event-1",
  draftId: "draft-1",
  allocationId: "allocation-1",
  additionalAllocationId: "allocation-2",
  today: "2026-09-18",
  accounts,
  merchants: [{ merchantId: "uber", ownerId: "123", name: "Uber", active: true }],
};

describe("M2 accounting parser", () => {
  it("parses salary income", () => {
    expect(parseTransaction("薪水 +85000", context)).toMatchObject({
      kind: "draft",
      draft: {
        amount: { amount: "85000" },
        allocations: [{ purpose: "income", fundsEffect: "inflow" }],
      },
    });
  });

  it("parses relative date, merchant and credit-card expense", () => {
    expect(parseTransaction("昨天 Uber 245 國泰卡", context)).toMatchObject({
      kind: "draft",
      draft: {
        occurredDate: "2026-09-17",
        merchantId: "uber",
        accountFromId: "cathay-card",
        allocations: [
          {
            amount: { amount: "245" },
            fundsEffect: "none",
            purpose: "expense",
            category: "交通",
          },
        ],
      },
    });
  });

  it("parses internal transfer and card payment", () => {
    expect(parseTransaction("台新轉國泰 5000", context)).toMatchObject({
      kind: "draft",
      draft: {
        accountFromId: "taishin",
        accountToId: "cathay",
        allocations: [{ fundsEffect: "internal", purpose: "transfer" }],
      },
    });
    expect(parseTransaction("繳國泰卡 18000 從台新", context)).toMatchObject({
      kind: "draft",
      draft: {
        amount: { amount: "18000" },
        accountFromId: "taishin",
        accountToId: "cathay-card",
        allocations: [{ fundsEffect: "outflow", purpose: "transfer" }],
      },
    });
  });

  it("splits transfer principal and fee exactly", () => {
    expect(parseTransaction("台新轉國泰 1000 手續費 15", context)).toMatchObject({
      kind: "draft",
      draft: {
        amount: { amount: "1015" },
        allocations: [
          { amount: { amount: "1000" }, purpose: "transfer" },
          { amount: { amount: "15" }, purpose: "fee" },
        ],
      },
    });
  });

  it("returns structured unknown and ambiguous references", () => {
    expect(parseTransaction("未知卡刷 1200", context)).toMatchObject({
      kind: "missing_fields",
      fields: ["account"],
    });
    expect(parseTransaction("退款 120", context)).toMatchObject({
      kind: "missing_fields",
      fields: ["refundTarget", "category"],
    });
    expect(
      parseTransaction("國泰卡刷 1200", {
        ...context,
        accounts: [cathayCard, { ...cathayCard, accountId: "duplicate-card" }],
      }),
    ).toMatchObject({
      kind: "ambiguous",
      field: "account",
      candidateIds: ["cathay-card", "duplicate-card"],
    });
  });
});

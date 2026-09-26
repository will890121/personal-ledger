import { describe, expect, it } from "vitest";

import { extractResidualKeyword } from "../../src/parser/residual-text.js";

const references = {
  accounts: [
    {
      accountId: "a1",
      ownerId: "1",
      name: "現金",
      type: "cash" as const,
      currency: "TWD" as const,
      active: true,
    },
    {
      accountId: "a2",
      ownerId: "1",
      name: "國泰卡",
      type: "credit_card" as const,
      currency: "TWD" as const,
      active: true,
    },
    {
      accountId: "a3",
      ownerId: "1",
      name: "台新",
      type: "bank" as const,
      currency: "TWD" as const,
      active: true,
    },
  ],
  merchants: [{ merchantId: "m1", ownerId: "1", name: "Uber", active: true }],
  counterparties: [{ counterpartyId: "c1", ownerId: "1", name: "小明", active: true }],
  userKeywords: [] as { keyword: string }[],
};

describe("extractResidualKeyword", () => {
  it("returns the one word the parser could not account for", () => {
    expect(extractResidualKeyword("牛排 300", references)).toBe("牛排");
    expect(extractResidualKeyword("一蘭拉麵 200", references)).toBe("一蘭拉麵");
  });

  it("strips dates, accounts, merchants and counterparties", () => {
    expect(extractResidualKeyword("昨天 牛排 300 國泰卡", references)).toBe("牛排");
    expect(extractResidualKeyword("牛排 300 現金", references)).toBe("牛排");
  });

  it("gives up when nothing meaningful is left", () => {
    // 「國泰卡」是帳戶、1200 是金額，剩下的「刷」只有一個字，當成店名或品項都太冒險。
    expect(extractResidualKeyword("國泰卡刷 1200", references)).toBeUndefined();
    expect(extractResidualKeyword("300", references)).toBeUndefined();
    expect(extractResidualKeyword("Uber 245", references)).toBeUndefined();
  });

  it("gives up on a sentence carrying split or repayment clauses", () => {
    // 分帳語句裡的殘餘文字不是店名，而且這種句子已經有別的追問要處理。
    expect(extractResidualKeyword("聚餐 1260，小明欠 630", references)).toBeUndefined();
    expect(extractResidualKeyword("聚餐 1260，我先付，朋友欠一半", references)).toBeUndefined();
  });

  it("rejects a candidate that is too long or contains digits", () => {
    expect(
      extractResidualKeyword("這是一段非常長的描述文字不像店名也不像品項 300", references),
    ).toBeUndefined();
    expect(extractResidualKeyword("A1B2 300", references)).toBeUndefined();
  });

  it("does not offer a word the user already taught", () => {
    expect(
      extractResidualKeyword("牛排 300", { ...references, userKeywords: [{ keyword: "牛排" }] }),
    ).toBeUndefined();
  });

  it("does not offer a word the built-in table already knows", () => {
    expect(extractResidualKeyword("晚餐 300", references)).toBeUndefined();
  });
});

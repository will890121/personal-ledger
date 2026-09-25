import { describe, expect, it } from "vitest";

import { categoryName } from "../../src/domain/category-catalog.js";
import {
  categoryKeywords,
  matchCategoryKeyword,
  matchMerchantCategory,
} from "../../src/parser/category-keywords.js";

describe("matchCategoryKeyword", () => {
  it("maps each meal keyword to 餐飲 with the meal as the subcategory", () => {
    expect(matchCategoryKeyword("早餐 100")).toEqual({
      categoryKey: "expense_dining",
      subcategory: "早餐",
    });
    expect(matchCategoryKeyword("午餐 120")).toEqual({
      categoryKey: "expense_dining",
      subcategory: "午餐",
    });
    expect(matchCategoryKeyword("晚餐 150")).toEqual({
      categoryKey: "expense_dining",
      subcategory: "晚餐",
    });
  });

  it("matches a keyword embedded in a longer phrase", () => {
    // 比對是子字串包含，與既有的商家比對同一套語意：句子裡夾著關鍵字仍分得出分類。
    expect(matchCategoryKeyword("巷口買便當 90")).toEqual({
      categoryKey: "expense_dining",
      subcategory: "便當",
    });
  });

  it("prefers the longest matching keyword", () => {
    // 「看醫生」與「醫」若同時在表裡，短的不得搶走長的；這條守住比對順序。
    expect(matchCategoryKeyword("看醫生 350")).toEqual({
      categoryKey: "expense_medical",
      subcategory: "看診",
    });
  });

  it("returns undefined for a word the table does not know", () => {
    expect(matchCategoryKeyword("雜支 60")).toBeUndefined();
    expect(matchCategoryKeyword("國泰卡刷 1200")).toBeUndefined();
    // 店名與細品項刻意不進表：表一膨脹就變成猜測，這類需求留給「商家記憶」。
    expect(matchCategoryKeyword("一蘭拉麵 200")).toBeUndefined();
  });

  it("never gives a subcategory equal to its own category name", () => {
    // 這是 M2 「午餐／午餐」重複的不變量：分類名稱與 subcategory 必須是不同層級的
    // 資訊。新增關鍵字時若把 subcategory 寫成分類名稱，這條會擋下來。
    for (const entry of categoryKeywords) {
      const name = categoryName(entry.categoryKey);
      expect(name).toBeDefined();
      expect(entry.subcategory).not.toBe(name);
    }
  });

  it("keeps every keyword distinct", () => {
    const keywords = categoryKeywords.map((entry) => entry.keyword);
    expect(new Set(keywords).size).toBe(keywords.length);
  });
});

describe("matchMerchantCategory", () => {
  it("maps a known merchant to its category", () => {
    // Uber 維持 M2 的行為：分類交通、不帶 subcategory（Uber 同時有乘車與外送，
    // 硬指定品項只會猜錯）。
    expect(matchMerchantCategory("Uber")).toEqual({ categoryKey: "expense_transport" });
  });

  it("returns undefined for an unmapped merchant", () => {
    expect(matchMerchantCategory("一蘭拉麵")).toBeUndefined();
  });
});

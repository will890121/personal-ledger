import { describe, expect, it } from "vitest";

import { categoryName } from "../../src/domain/category-catalog.js";
import {
  categoryKeywords,
  matchCategoryKeyword,
  matchMerchantCategory,
  orderedKeywords,
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

  it("prefers the longest matching keyword over a shorter one nested inside it", () => {
    // 「水電」是「水電費」的子字串，兩者都會命中，長的必須贏。
    expect(matchCategoryKeyword("水電費 1200")).toEqual({
      categoryKey: "expense_housing",
      subcategory: "水電費",
    });
    expect(matchCategoryKeyword("水電 1200")).toEqual({
      categoryKey: "expense_housing",
      subcategory: "水電",
    });
  });

  it("scans keywords from longest to shortest", () => {
    // 直接咬住比較子本身。只靠行為測試很脆弱：表裡巢狀關鍵字很少，把排序反向後
    // 整份測試仍可能全綠，那條規則就等於沒有被守住。
    const lengths = orderedKeywords.map((entry) => entry.keyword.length);

    expect(lengths).toEqual([...lengths].sort((a, b) => b - a));
    expect(Math.max(...lengths)).toBeGreaterThan(Math.min(...lengths));
  });

  it("breaks a same-length tie by table order", () => {
    // 「水電」與「電費」同長且同時命中「水電費」的前綴情境之外的句子；表序決定勝負，
    // 因此新增關鍵字時的排列位置是有意義的。
    const table = categoryKeywords.map((entry) => entry.keyword);
    expect(table.indexOf("水電")).toBeLessThan(table.indexOf("電費"));
    expect(matchCategoryKeyword("這個月水電電費 1200")).toEqual({
      categoryKey: "expense_housing",
      subcategory: "水電",
    });
  });

  it("maps a standalone fee to 金融費用", () => {
    // 轉帳分支會自己拆出 fee 配置並直接回傳，走不到這張表；單獨的手續費才需要它。
    expect(matchCategoryKeyword("手續費 15 現金")).toEqual({
      categoryKey: "expense_financial_fee",
      subcategory: "手續費",
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

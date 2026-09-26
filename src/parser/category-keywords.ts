/**
 * 關鍵字 → 分類對照表。
 *
 * M2 的 expenseShell 只認得「午餐」一個關鍵字，其餘句子只要帶得出帳戶就一律預設成
 * 午餐，於是「早餐 100 現金」被靜靜記成午餐、連追問都沒有。這張表把「哪個詞屬於
 * 哪個分類」從程式邏輯裡抽出來：命中就用表裡的分類，**比對不到就不猜**，交回既有的
 * 「待分類殼 + 追問分類」路徑。
 *
 * 表裡刻意只放餐別與明確品類，不放店名或細品項（「一蘭拉麵」「珍奶」）。表一膨脹
 * 就變成替使用者猜測，那個需求的正解是讓使用者教一次就記住的「商家記憶」
 * （docs/todo/merchant-memory.md），不是無止盡地加詞。
 */
import { categoryName } from "../domain/category-catalog.js";

export interface CategoryMatch {
  readonly categoryKey: string;
  readonly subcategory?: string;
}

export interface CategoryKeyword extends CategoryMatch {
  readonly keyword: string;
}

/**
 * subcategory 一律填「比關鍵字更規範的品項名」，不得等於分類自己的名稱——M2 正是
 * 因為 category 與 subcategory 都是「午餐」才在預覽印出「午餐／午餐」。
 *
 * 「手續費」與轉帳不衝突：`台新轉國泰 1000 手續費 15` 由轉帳分支自己拆出 fee 配置並
 * 直接回傳，根本走不到 expenseShell，兩邊不會搶同一句話。單獨的「手續費 15 現金」則
 * 需要這張表才分得出金融費用。
 */
const keywordTable: readonly CategoryKeyword[] = [
  { keyword: "早餐", categoryKey: "expense_dining", subcategory: "早餐" },
  { keyword: "午餐", categoryKey: "expense_dining", subcategory: "午餐" },
  { keyword: "晚餐", categoryKey: "expense_dining", subcategory: "晚餐" },
  { keyword: "宵夜", categoryKey: "expense_dining", subcategory: "宵夜" },
  { keyword: "便當", categoryKey: "expense_dining", subcategory: "便當" },
  { keyword: "外送", categoryKey: "expense_dining", subcategory: "外送" },
  { keyword: "咖啡", categoryKey: "expense_dining", subcategory: "咖啡" },
  { keyword: "飲料", categoryKey: "expense_dining", subcategory: "飲料" },

  { keyword: "計程車", categoryKey: "expense_transport", subcategory: "計程車" },
  { keyword: "捷運", categoryKey: "expense_transport", subcategory: "捷運" },
  { keyword: "公車", categoryKey: "expense_transport", subcategory: "公車" },
  { keyword: "高鐵", categoryKey: "expense_transport", subcategory: "高鐵" },
  { keyword: "火車", categoryKey: "expense_transport", subcategory: "火車" },
  { keyword: "加油", categoryKey: "expense_transport", subcategory: "加油" },
  { keyword: "停車", categoryKey: "expense_transport", subcategory: "停車" },
  { keyword: "車票", categoryKey: "expense_transport", subcategory: "車票" },

  { keyword: "房租", categoryKey: "expense_housing", subcategory: "房租" },
  { keyword: "水電", categoryKey: "expense_housing", subcategory: "水電" },
  // 與「水電」構成巢狀關鍵字：長關鍵字優先的規則因此有實際可觀察的效果，
  // tests/parser/category-keywords.test.ts 以這一對咬住比對順序。
  { keyword: "水電費", categoryKey: "expense_housing", subcategory: "水電費" },
  { keyword: "電費", categoryKey: "expense_housing", subcategory: "電費" },
  { keyword: "水費", categoryKey: "expense_housing", subcategory: "水費" },
  { keyword: "瓦斯", categoryKey: "expense_housing", subcategory: "瓦斯" },
  { keyword: "管理費", categoryKey: "expense_housing", subcategory: "管理費" },
  { keyword: "電話費", categoryKey: "expense_housing", subcategory: "電話費" },
  { keyword: "手機費", categoryKey: "expense_housing", subcategory: "電話費" },
  { keyword: "網路費", categoryKey: "expense_housing", subcategory: "網路費" },

  { keyword: "電影", categoryKey: "expense_entertainment", subcategory: "電影" },
  { keyword: "KTV", categoryKey: "expense_entertainment", subcategory: "KTV" },
  { keyword: "演唱會", categoryKey: "expense_entertainment", subcategory: "演唱會" },

  { keyword: "看醫生", categoryKey: "expense_medical", subcategory: "看診" },
  { keyword: "掛號", categoryKey: "expense_medical", subcategory: "看診" },
  { keyword: "牙醫", categoryKey: "expense_medical", subcategory: "牙科" },
  { keyword: "藥局", categoryKey: "expense_medical", subcategory: "藥品" },

  { keyword: "課程", categoryKey: "expense_learning", subcategory: "課程" },
  { keyword: "學費", categoryKey: "expense_learning", subcategory: "學費" },
  { keyword: "補習", categoryKey: "expense_learning", subcategory: "補習" },
  { keyword: "買書", categoryKey: "expense_learning", subcategory: "書籍" },

  { keyword: "紅包", categoryKey: "expense_gift", subcategory: "紅包" },
  { keyword: "禮金", categoryKey: "expense_gift", subcategory: "禮金" },
  { keyword: "伴手禮", categoryKey: "expense_gift", subcategory: "伴手禮" },

  { keyword: "機票", categoryKey: "expense_travel", subcategory: "機票" },
  { keyword: "住宿", categoryKey: "expense_travel", subcategory: "住宿" },
  { keyword: "旅館", categoryKey: "expense_travel", subcategory: "住宿" },
  { keyword: "民宿", categoryKey: "expense_travel", subcategory: "住宿" },

  { keyword: "衣服", categoryKey: "expense_shopping", subcategory: "衣著" },
  { keyword: "鞋子", categoryKey: "expense_shopping", subcategory: "衣著" },
  { keyword: "日用品", categoryKey: "expense_shopping", subcategory: "日用品" },

  { keyword: "手續費", categoryKey: "expense_financial_fee", subcategory: "手續費" },
  { keyword: "匯費", categoryKey: "expense_financial_fee", subcategory: "匯費" },
  { keyword: "年費", categoryKey: "expense_financial_fee", subcategory: "年費" },
];

/**
 * 商家 → 分類。Uber 維持 M2 的行為：分類交通、不帶 subcategory——Uber 同時有乘車與
 * 外送，硬指定品項只會猜錯。使用者自己的商家要記住分類，需要
 * `merchants.default_category_id`，屬於「商家記憶」的範圍。
 */
const merchantTable: readonly (CategoryMatch & { readonly name: string })[] = [
  { name: "Uber", categoryKey: "expense_transport" },
];

// 每個 categoryKey 都必須是 category-catalog 裡真的存在的分類：打錯一個字就會讓
// 那些句子拿到一個查不到的 key，parser 只能退回沒有 categoryId 的後援名稱，症狀是
// 「分類看起來對、但確認後落到 legacy 分類」。啟動時就炸掉比事後追查便宜。
for (const entry of keywordTable) {
  if (categoryName(entry.categoryKey) === undefined) {
    throw new Error(`unknown category key in keyword table: ${entry.categoryKey}`);
  }
}

// 長關鍵字優先：短詞不得搶走包含它的長詞（「醫」不該贏過「看醫生」）。長度相同時
// 依表序，讓表的排列本身就是可讀的優先順序。
const byLengthDescending = [...keywordTable].sort((a, b) => b.keyword.length - a.keyword.length);

export const categoryKeywords = keywordTable;

/**
 * 比對時實際採用的順序。匯出它是為了讓「長關鍵字優先」可以被直接斷言：表裡目前只有
 * 少數巢狀關鍵字，光靠行為測試很容易寫成空轉的斷言（把比較子反向排序仍然全綠）。
 */
export const orderedKeywords: readonly CategoryKeyword[] = byLengthDescending;

export function matchCategoryKeyword(text: string): CategoryMatch | undefined {
  const hit = byLengthDescending.find((entry) => text.includes(entry.keyword));
  if (!hit) return undefined;
  return {
    categoryKey: hit.categoryKey,
    ...(hit.subcategory ? { subcategory: hit.subcategory } : {}),
  };
}

export function matchMerchantCategory(name: string): CategoryMatch | undefined {
  const hit = merchantTable.find((entry) => entry.name === name);
  if (!hit) return undefined;
  return {
    categoryKey: hit.categoryKey,
    ...(hit.subcategory ? { subcategory: hit.subcategory } : {}),
  };
}

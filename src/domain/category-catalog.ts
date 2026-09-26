/**
 * 第二層分類的正式清單，是「哪些分類存在、各自叫什麼」的唯一來源。
 *
 * bootstrap 用它種參考資料，parser 用它在沒有參考資料時決定分類名稱。兩邊共用同一份
 * 定義是刻意的：M2 時期各寫一份，測試替身把午餐葉分類命名為「餐飲」而生產環境是
 * 「午餐」，於是「分類名稱與 subcategory 重複」在測試裡永遠看不見，只有真實資料庫
 * 會渲染成「午餐／午餐」。
 *
 * 餐別（早餐／午餐／晚餐）不在這裡——那一層是 allocations.subcategory，見
 * src/parser/category-keywords.ts。
 */
export const expenseCategoryLeaves = [
  ["expense_dining", "餐飲"],
  ["expense_transport", "交通"],
  ["expense_shopping", "購物"],
  ["expense_housing", "居住"],
  ["expense_entertainment", "娛樂"],
  ["expense_medical", "醫療"],
  ["expense_learning", "學習"],
  ["expense_gift", "人情"],
  ["expense_travel", "旅遊"],
  ["expense_financial_fee", "金融費用"],
  ["expense_other", "其他支出"],
  ["expense_uncategorized", "待分類"],
] as const;

export const incomeCategoryLeaves = [
  ["income_salary", "薪資"],
  ["income_bonus", "獎金"],
  ["income_investment", "投資收入"],
  ["income_other", "其他收入"],
] as const;

const namesByKey = new Map<string, string>([...expenseCategoryLeaves, ...incomeCategoryLeaves]);

/** 分類 key 對應的正式名稱；未知的 key 回 undefined，呼叫端自行決定要不要猜。 */
export function categoryName(key: string): string | undefined {
  return namesByKey.get(key);
}

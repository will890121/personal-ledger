import type { Account, Category, Merchant } from "../../src/domain/reference-data.js";

export interface CorpusCase {
  readonly input: string;
  readonly segments: number;
  readonly outcomes: readonly ("draft" | "missing_fields" | "ambiguous")[];
}

/**
 * 匿名化的真實輸入語料，作為切分與解析的回歸網。
 * 只保存語句形狀與金額，不含任何可辨識的個人資訊。
 */
export const parserCorpus: readonly CorpusCase[] = [
  // M2 既有支援語句
  { input: "午餐 120", segments: 1, outcomes: ["draft"] },
  { input: "薪水 +85000", segments: 1, outcomes: ["draft"] },
  { input: "昨天 Uber 245 國泰卡", segments: 1, outcomes: ["draft"] },
  { input: "台新轉國泰 5000", segments: 1, outcomes: ["draft"] },
  { input: "國泰卡刷 1200", segments: 1, outcomes: ["draft"] },
  { input: "繳國泰卡 18000 從台新", segments: 1, outcomes: ["draft"] },
  { input: "台新轉國泰 1000 手續費 15", segments: 1, outcomes: ["draft"] },
  { input: "Uber 245", segments: 1, outcomes: ["draft"] },
  { input: "昨天 午餐 120", segments: 1, outcomes: ["draft"] },

  // M3a 批次
  { input: "午餐 120，Uber 245", segments: 2, outcomes: ["draft", "draft"] },
  {
    input: "午餐 120，Uber 245，咖啡 90",
    segments: 3,
    outcomes: ["draft", "draft", "missing_fields"],
  },
  { input: "午餐 120，午餐 60", segments: 2, outcomes: ["draft", "draft"] },
  { input: "午餐 120\nUber 245", segments: 2, outcomes: ["draft", "draft"] },
  { input: "午餐 120、Uber 245", segments: 2, outcomes: ["draft", "draft"] },
  { input: "午餐 120，，Uber 245", segments: 2, outcomes: ["draft", "draft"] },
  { input: "薪水 +85000，午餐 120", segments: 2, outcomes: ["draft", "draft"] },
  { input: "國泰卡刷 1200，午餐 120", segments: 2, outcomes: ["draft", "draft"] },
  { input: "台新轉國泰 1000 手續費 15，午餐 120", segments: 2, outcomes: ["draft", "draft"] },

  // 合併規則：不含金額的段落併回前一段（保護 M3b 的代墊語句）
  { input: "午餐 120，我先付", segments: 1, outcomes: ["draft"] },
  { input: "聚餐 1260，我先付，朋友欠一半", segments: 1, outcomes: ["missing_fields"] },

  // 追問路徑
  { input: "午餐", segments: 1, outcomes: ["missing_fields"] },
  { input: "咖啡 60", segments: 1, outcomes: ["missing_fields"] },
  { input: "台新轉國泰", segments: 1, outcomes: ["missing_fields"] },
  { input: "退款 300", segments: 1, outcomes: ["missing_fields"] },
  { input: "午餐 120 200", segments: 1, outcomes: ["missing_fields"] },

  // 常見誤傳
  { input: "在嗎", segments: 1, outcomes: ["missing_fields"] },
  { input: "吃飯", segments: 1, outcomes: ["missing_fields"] },
];

const accounts: Account[] = [
  { accountId: "cash", ownerId: "123", name: "現金", type: "cash", currency: "TWD", active: true },
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
  {
    accountId: "cathay-card",
    ownerId: "123",
    name: "國泰卡",
    type: "credit_card",
    currency: "TWD",
    active: true,
  },
];

const merchants: Merchant[] = [
  { merchantId: "merchant-uber", ownerId: "123", name: "Uber", active: true },
];

const categories: Category[] = [
  ["expense_dining_lunch", "餐飲"],
  ["expense_transport", "交通"],
  ["expense_financial_fee", "金融費用"],
  ["income_salary", "薪資"],
].map(([key, name]) => ({
  categoryId: `category-${key ?? ""}`,
  ownerId: "123",
  key: key ?? "",
  name: name ?? "",
  kind: (key ?? "").startsWith("income") ? ("income" as const) : ("expense" as const),
  parentId: "category-root",
  depth: 2 as const,
  active: true,
}));

export function referenceSnapshotFixture(): {
  accounts: Account[];
  categories: Category[];
  merchants: Merchant[];
} {
  return { accounts, categories, merchants };
}

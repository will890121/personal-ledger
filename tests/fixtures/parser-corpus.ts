import type { Account, Category, Counterparty, Merchant } from "../../src/domain/reference-data.js";

export interface CorpusCase {
  readonly input: string;
  readonly segments: number;
  readonly outcomes: readonly ("draft" | "missing_fields" | "ambiguous")[];
  /**
   * 每一段解析結果的配置筆數（draft 看 draft.allocations，其餘看 partial.allocations）。
   * 只斷言 kind 區分不出「missing_fields 帶著可用的配置殼」與「missing_fields 帶著
   * 空配置」——後者會被 create-batch 降級成 unparsed，使用者看到的是「無法解析」，
   * 而語料仍然是綠的。M3b 的分帳路徑就是這樣漏掉「待分類」後援殼的。
   */
  readonly allocationCounts: readonly number[];
}

/**
 * 匿名化的真實輸入語料，作為切分與解析的回歸網。
 * 只保存語句形狀與金額，不含任何可辨識的個人資訊。
 */
export const parserCorpus: readonly CorpusCase[] = [
  // M2 既有支援語句
  { input: "午餐 120", segments: 1, outcomes: ["draft"], allocationCounts: [1] },
  { input: "薪水 +85000", segments: 1, outcomes: ["draft"], allocationCounts: [1] },
  { input: "昨天 Uber 245 國泰卡", segments: 1, outcomes: ["draft"], allocationCounts: [1] },
  { input: "台新轉國泰 5000", segments: 1, outcomes: ["draft"], allocationCounts: [1] },
  // 帳戶不再暗示分類：句子只說了刷哪張卡、沒說買什麼，就該追問而不是預設成餐飲。
  {
    input: "國泰卡刷 1200",
    segments: 1,
    outcomes: ["missing_fields"],
    allocationCounts: [1],
  },
  { input: "繳國泰卡 18000 從台新", segments: 1, outcomes: ["draft"], allocationCounts: [1] },
  // 本金與手續費各一筆配置。
  { input: "台新轉國泰 1000 手續費 15", segments: 1, outcomes: ["draft"], allocationCounts: [2] },
  { input: "Uber 245", segments: 1, outcomes: ["draft"], allocationCounts: [1] },
  { input: "昨天 午餐 120", segments: 1, outcomes: ["draft"], allocationCounts: [1] },

  // M3a 批次
  {
    input: "午餐 120，Uber 245",
    segments: 2,
    outcomes: ["draft", "draft"],
    allocationCounts: [1, 1],
  },
  {
    input: "午餐 120，Uber 245，雜支 90",
    segments: 3,
    outcomes: ["draft", "draft", "missing_fields"],
    // 「雜支」無從判斷分類，但金額已知：留下「待分類」後援殼，才追問得起來。
    allocationCounts: [1, 1, 1],
  },
  {
    input: "午餐 120，午餐 60",
    segments: 2,
    outcomes: ["draft", "draft"],
    allocationCounts: [1, 1],
  },
  {
    input: "午餐 120\nUber 245",
    segments: 2,
    outcomes: ["draft", "draft"],
    allocationCounts: [1, 1],
  },
  {
    input: "午餐 120、Uber 245",
    segments: 2,
    outcomes: ["draft", "draft"],
    allocationCounts: [1, 1],
  },
  {
    input: "午餐 120，，Uber 245",
    segments: 2,
    outcomes: ["draft", "draft"],
    allocationCounts: [1, 1],
  },
  {
    input: "薪水 +85000，午餐 120",
    segments: 2,
    outcomes: ["draft", "draft"],
    allocationCounts: [1, 1],
  },
  {
    input: "國泰卡刷 1200，午餐 120",
    segments: 2,
    outcomes: ["missing_fields", "draft"],
    allocationCounts: [1, 1],
  },
  {
    input: "台新轉國泰 1000 手續費 15，午餐 120",
    segments: 2,
    outcomes: ["draft", "draft"],
    allocationCounts: [2, 1],
  },

  // 合併規則：不含金額的段落併回前一段（保護 M3b 的代墊語句）
  { input: "午餐 120，我先付", segments: 1, outcomes: ["draft"], allocationCounts: [1] },
  // AC-11。「聚餐」沒有對應分類，依「未知參照不猜測」先追問分類；但配置殼（個人
  // 630 + 代墊 630）必須已經在 partial 裡，否則整段會被降級成「無法解析」。
  {
    input: "聚餐 1260，我先付，朋友欠一半",
    segments: 1,
    outcomes: ["missing_fields"],
    allocationCounts: [2],
  },

  // 追問路徑
  { input: "午餐", segments: 1, outcomes: ["missing_fields"], allocationCounts: [1] },
  { input: "雜支 60", segments: 1, outcomes: ["missing_fields"], allocationCounts: [1] },
  // 轉帳與退款的追問還湊不出配置殼，配置為空是既有行為。
  { input: "台新轉國泰", segments: 1, outcomes: ["missing_fields"], allocationCounts: [0] },
  { input: "退款 300", segments: 1, outcomes: ["missing_fields"], allocationCounts: [0] },
  { input: "午餐 120 200", segments: 1, outcomes: ["missing_fields"], allocationCounts: [1] },

  // 常見誤傳
  { input: "在嗎", segments: 1, outcomes: ["missing_fields"], allocationCounts: [0] },
  { input: "吃飯", segments: 1, outcomes: ["missing_fields"], allocationCounts: [0] },

  // M3b 代墊語句
  // splitInput 對純粹的欠款／代付子句（如「小明欠 630」）併回前一段，即使該子句
  // 本身帶著金額數字：那筆錢不是使用者付出去的，是分帳明細，「午餐 1260，
  // 小明欠 630」是一筆交易而不是兩筆。此規則已修正並由 split-input.test.ts 釘住。
  { input: "午餐 1260，朋友欠一半", segments: 1, outcomes: ["draft"], allocationCounts: [2] },
  // 整筆都是代墊，不產生金額為 0 的個人配置。
  { input: "午餐 600，朋友欠600", segments: 1, outcomes: ["draft"], allocationCounts: [1] },
  {
    input: "午餐 500，朋友欠800",
    segments: 1,
    outcomes: ["missing_fields"],
    allocationCounts: [2],
  },
  { input: "午餐 1260，小明欠 630", segments: 1, outcomes: ["draft"], allocationCounts: [2] },
  {
    input: "午餐 999，小明欠一半",
    segments: 1,
    outcomes: ["missing_fields"],
    allocationCounts: [2],
  },
  // 「聚餐」不在關鍵字表裡，帶不帶卡都一樣要追問分類——與上面沒帶卡的同句一致。
  {
    input: "聚餐 1260 國泰卡，朋友欠一半",
    segments: 1,
    outcomes: ["missing_fields"],
    allocationCounts: [2],
  },
  // 三人平分：1 筆個人 + 2 筆代墊 placeholder。
  {
    input: "午餐 1000，三個人平分",
    segments: 1,
    outcomes: ["missing_fields"],
    allocationCounts: [3],
  },
  {
    input: "午餐 900，三個人平分",
    segments: 1,
    outcomes: ["missing_fields"],
    allocationCounts: [3],
  },
  {
    input: "午餐 1260，陌生人欠630",
    segments: 1,
    outcomes: ["missing_fields"],
    allocationCounts: [2],
  },
  // 回收語句由 /advances 與回收入口處理，解析器只看到「待分類」的支出殼。
  { input: "小明還 300", segments: 1, outcomes: ["missing_fields"], allocationCounts: [1] },
  { input: "收到小明 300", segments: 1, outcomes: ["missing_fields"], allocationCounts: [1] },
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

// M3b：代墊語句需要可解析的交易對象，才會落在 draft 而非 counterparty 追問路徑。
const counterparties: Counterparty[] = [
  { counterpartyId: "counterparty-friend", ownerId: "123", name: "朋友", active: true },
  { counterpartyId: "counterparty-xiaoming", ownerId: "123", name: "小明", active: true },
];

const categories: Category[] = [
  ["expense_dining", "午餐"],
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
  counterparties: Counterparty[];
} {
  return { accounts, categories, merchants, counterparties };
}

import type { Account, Category } from "../domain/reference-data.js";
import type { ReferenceRepository } from "../ports/reference-repository.js";

const expenseLeaves = [
  ["expense_dining_lunch", "午餐"],
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

const incomeLeaves = [
  ["income_salary", "薪資"],
  ["income_bonus", "獎金"],
  ["income_investment", "投資收入"],
  ["income_other", "其他收入"],
] as const;

export async function bootstrapReferenceData(
  repository: ReferenceRepository,
  ownerId: string,
): Promise<void> {
  const account: Account = {
    accountId: `m2:${ownerId}:account_cash`,
    ownerId,
    name: "現金",
    type: "cash",
    currency: "TWD",
    active: true,
  };
  await repository.saveAccount(account);

  const roots: Category[] = [
    {
      categoryId: `m2:${ownerId}:expense`,
      ownerId,
      key: "expense",
      name: "支出",
      kind: "expense",
      depth: 1,
      active: true,
    },
    {
      categoryId: `m2:${ownerId}:income`,
      ownerId,
      key: "income",
      name: "收入",
      kind: "income",
      depth: 1,
      active: true,
    },
  ];
  for (const root of roots) await repository.saveCategory(root);

  for (const [key, name] of expenseLeaves) {
    await repository.saveCategory({
      categoryId: `m2:${ownerId}:${key}`,
      ownerId,
      key,
      name,
      kind: "expense",
      parentId: `m2:${ownerId}:expense`,
      depth: 2,
      active: true,
    });
  }
  for (const [key, name] of incomeLeaves) {
    await repository.saveCategory({
      categoryId: `m2:${ownerId}:${key}`,
      ownerId,
      key,
      name,
      kind: "income",
      parentId: `m2:${ownerId}:income`,
      depth: 2,
      active: true,
    });
  }
}

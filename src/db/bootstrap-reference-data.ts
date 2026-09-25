import { expenseCategoryLeaves, incomeCategoryLeaves } from "../domain/category-catalog.js";
import type { Account, Category } from "../domain/reference-data.js";
import type { ReferenceRepository } from "../ports/reference-repository.js";

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

  for (const [key, name] of expenseCategoryLeaves) {
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
  for (const [key, name] of incomeCategoryLeaves) {
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

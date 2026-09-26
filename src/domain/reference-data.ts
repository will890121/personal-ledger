import { z } from "zod";

/**
 * 參考資料名稱的正規化：全形／半形與大小寫視為同一個名稱。merchants、counterparties
 * 與使用者自訂關鍵字共用同一份，比對與唯一鍵才不會各用一套——兩者不一致時，
 * `Costco` 與 `costco` 會變成「存得進去但比對不到」。
 */
export function normalizeReferenceName(name: string): string {
  return name.normalize("NFKC").trim().toLocaleLowerCase("zh-TW");
}

export const AccountTypeSchema = z.enum(["cash", "bank", "credit_card", "e_wallet"]);
export type AccountType = z.infer<typeof AccountTypeSchema>;

export const AccountSchema = z.object({
  accountId: z.string().min(1),
  ownerId: z.string().min(1),
  name: z.string().trim().min(1),
  type: AccountTypeSchema,
  currency: z.literal("TWD"),
  active: z.boolean(),
});
export type Account = z.infer<typeof AccountSchema>;

export const CategorySchema = z
  .object({
    categoryId: z.string().min(1),
    ownerId: z.string().min(1),
    key: z.string().regex(/^[a-z0-9_]+$/),
    name: z.string().trim().min(1),
    kind: z.enum(["income", "expense"]),
    parentId: z.string().min(1).optional(),
    depth: z.union([z.literal(1), z.literal(2)]),
    active: z.boolean(),
  })
  .superRefine((category, context) => {
    const parentMatchesDepth =
      (category.depth === 1 && category.parentId === undefined) ||
      (category.depth === 2 && category.parentId !== undefined);
    if (!parentMatchesDepth) {
      context.addIssue({
        code: "custom",
        message: "category parent must match depth",
        path: ["parentId"],
      });
    }
  });
export type Category = z.infer<typeof CategorySchema>;

const NamedReferenceSchema = z.object({
  ownerId: z.string().min(1),
  name: z.string().trim().min(1),
  active: z.boolean(),
});

export const MerchantSchema = NamedReferenceSchema.extend({
  merchantId: z.string().min(1),
});
export type Merchant = z.infer<typeof MerchantSchema>;

export const CounterpartySchema = NamedReferenceSchema.extend({
  counterpartyId: z.string().min(1),
});
export type Counterparty = z.infer<typeof CounterpartySchema>;

export const TagSchema = NamedReferenceSchema.extend({
  tagId: z.string().min(1),
  normalizedName: z.string().min(1),
});
export type Tag = z.infer<typeof TagSchema>;

/**
 * 使用者自訂的分類關鍵字：內建的 category-keywords 表認不得的詞（「牛排」「一蘭拉麵」），
 * 由使用者教一次就記住，等於在執行期擴充那張表。
 */
export const UserCategoryKeywordSchema = z.object({
  ownerId: z.string().min(1),
  keyword: z.string().trim().min(1),
  categoryId: z.string().min(1),
});
export type UserCategoryKeyword = z.infer<typeof UserCategoryKeywordSchema>;

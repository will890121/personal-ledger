import type {
  Account,
  Category,
  Counterparty,
  Merchant,
  Tag,
  UserCategoryKeyword,
} from "../domain/reference-data.js";

export interface NamedReferenceInput {
  readonly referenceId: string;
  readonly ownerId: string;
  readonly name: string;
}

export interface ReferenceRepository {
  listActiveAccounts(ownerId: string): Promise<Account[]>;
  listActiveCategories(ownerId: string): Promise<Category[]>;
  listActiveMerchants(ownerId: string): Promise<Merchant[]>;
  listActiveCounterparties(ownerId: string): Promise<Counterparty[]>;
  getAccount(ownerId: string, accountId: string): Promise<Account | null>;
  findAccountByName(ownerId: string, name: string): Promise<Account[]>;
  getCategory(ownerId: string, categoryId: string): Promise<Category | null>;
  findCategoryByKey(ownerId: string, key: string): Promise<Category | null>;
  saveAccount(account: Account): Promise<void>;
  saveCategory(category: Category): Promise<void>;
  upsertMerchant(input: NamedReferenceInput): Promise<Merchant>;
  listUserCategoryKeywords(ownerId: string): Promise<UserCategoryKeyword[]>;
  /** 同一個關鍵字再教一次就改指向新分類，不會留下兩筆。 */
  saveUserCategoryKeyword(keyword: UserCategoryKeyword): Promise<void>;
  upsertCounterparty(input: NamedReferenceInput): Promise<Counterparty>;
  upsertTag(input: NamedReferenceInput): Promise<Tag>;
}

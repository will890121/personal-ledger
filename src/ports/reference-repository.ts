import type { Account, Category, Counterparty, Merchant, Tag } from "../domain/reference-data.js";

export interface NamedReferenceInput {
  readonly referenceId: string;
  readonly ownerId: string;
  readonly name: string;
}

export interface ReferenceRepository {
  listActiveAccounts(ownerId: string): Promise<Account[]>;
  listActiveCategories(ownerId: string): Promise<Category[]>;
  listActiveMerchants(ownerId: string): Promise<Merchant[]>;
  getAccount(ownerId: string, accountId: string): Promise<Account | null>;
  findAccountByName(ownerId: string, name: string): Promise<Account[]>;
  getCategory(ownerId: string, categoryId: string): Promise<Category | null>;
  findCategoryByKey(ownerId: string, key: string): Promise<Category | null>;
  saveAccount(account: Account): Promise<void>;
  saveCategory(category: Category): Promise<void>;
  upsertMerchant(input: NamedReferenceInput): Promise<Merchant>;
  upsertCounterparty(input: NamedReferenceInput): Promise<Counterparty>;
  upsertTag(input: NamedReferenceInput): Promise<Tag>;
}

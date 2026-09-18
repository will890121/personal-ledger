import type {
  Account,
  Category,
  Counterparty,
  Merchant,
  Tag,
} from "../../src/domain/reference-data.js";
import type {
  NamedReferenceInput,
  ReferenceRepository,
} from "../../src/ports/reference-repository.js";

export class FakeReferenceRepository implements ReferenceRepository {
  public readonly accounts: Account[] = [];
  public readonly categories: Category[] = [];
  public readonly merchants: Merchant[] = [];

  public listActiveAccounts(ownerId: string): Promise<Account[]> {
    return Promise.resolve(this.accounts.filter((item) => item.ownerId === ownerId && item.active));
  }
  public listActiveCategories(ownerId: string): Promise<Category[]> {
    return Promise.resolve(
      this.categories.filter((item) => item.ownerId === ownerId && item.active),
    );
  }
  public listActiveMerchants(ownerId: string): Promise<Merchant[]> {
    return Promise.resolve(
      this.merchants.filter((item) => item.ownerId === ownerId && item.active),
    );
  }
  public getAccount(ownerId: string, accountId: string): Promise<Account | null> {
    return Promise.resolve(
      this.accounts.find((item) => item.ownerId === ownerId && item.accountId === accountId) ??
        null,
    );
  }
  public findAccountByName(ownerId: string, name: string): Promise<Account[]> {
    return Promise.resolve(
      this.accounts.filter((item) => item.ownerId === ownerId && item.name.includes(name)),
    );
  }
  public getCategory(ownerId: string, categoryId: string): Promise<Category | null> {
    return Promise.resolve(
      this.categories.find((item) => item.ownerId === ownerId && item.categoryId === categoryId) ??
        null,
    );
  }
  public findCategoryByKey(ownerId: string, key: string): Promise<Category | null> {
    return Promise.resolve(
      this.categories.find((item) => item.ownerId === ownerId && item.key === key) ?? null,
    );
  }
  public saveAccount(account: Account): Promise<void> {
    this.accounts.push(account);
    return Promise.resolve();
  }
  public saveCategory(category: Category): Promise<void> {
    this.categories.push(category);
    return Promise.resolve();
  }
  public upsertMerchant(input: NamedReferenceInput): Promise<Merchant> {
    const value = {
      merchantId: input.referenceId,
      ownerId: input.ownerId,
      name: input.name,
      active: true,
    };
    this.merchants.push(value);
    return Promise.resolve(value);
  }
  public upsertCounterparty(input: NamedReferenceInput): Promise<Counterparty> {
    return Promise.resolve({
      counterpartyId: input.referenceId,
      ownerId: input.ownerId,
      name: input.name,
      active: true,
    });
  }
  public upsertTag(input: NamedReferenceInput): Promise<Tag> {
    return Promise.resolve({
      tagId: input.referenceId,
      ownerId: input.ownerId,
      name: input.name,
      normalizedName: input.name.normalize("NFKC").toLocaleLowerCase("zh-TW"),
      active: true,
    });
  }
}

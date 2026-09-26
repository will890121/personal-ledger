import type {
  Account,
  Category,
  Counterparty,
  Merchant,
  Tag,
  UserCategoryKeyword,
} from "../../src/domain/reference-data.js";
import { normalizeReferenceName } from "../../src/domain/reference-data.js";
import type {
  NamedReferenceInput,
  ReferenceRepository,
} from "../../src/ports/reference-repository.js";

export class FakeReferenceRepository implements ReferenceRepository {
  public readonly accounts: Account[] = [];
  public readonly categories: Category[] = [];
  public readonly merchants: Merchant[] = [];
  public readonly counterparties: Counterparty[] = [];
  public readonly userCategoryKeywords: UserCategoryKeyword[] = [];

  public listUserCategoryKeywords(ownerId: string): Promise<UserCategoryKeyword[]> {
    return Promise.resolve(this.userCategoryKeywords.filter((item) => item.ownerId === ownerId));
  }
  public saveUserCategoryKeyword(keyword: UserCategoryKeyword): Promise<void> {
    // 與 SQLite 版本相同的語意：同一個詞再教一次就改指向新分類，不留下兩筆。
    // 與 SQLite 版共用同一個正規化函式，兩邊語意才不會漂移。
    const normalized = normalizeReferenceName(keyword.keyword);
    const existing = this.userCategoryKeywords.findIndex(
      (item) =>
        item.ownerId === keyword.ownerId && normalizeReferenceName(item.keyword) === normalized,
    );
    if (existing >= 0) this.userCategoryKeywords.splice(existing, 1, keyword);
    else this.userCategoryKeywords.push(keyword);
    return Promise.resolve();
  }
  public deleteUserCategoryKeyword(ownerId: string, keyword: string): Promise<void> {
    const normalized = normalizeReferenceName(keyword);
    const index = this.userCategoryKeywords.findIndex(
      (item) => item.ownerId === ownerId && normalizeReferenceName(item.keyword) === normalized,
    );
    if (index >= 0) this.userCategoryKeywords.splice(index, 1);
    return Promise.resolve();
  }
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
  public listActiveCounterparties(ownerId: string): Promise<Counterparty[]> {
    return Promise.resolve(
      this.counterparties.filter((item) => item.ownerId === ownerId && item.active),
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
    const value = {
      counterpartyId: input.referenceId,
      ownerId: input.ownerId,
      name: input.name,
      active: true,
    };
    this.counterparties.push(value);
    return Promise.resolve(value);
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

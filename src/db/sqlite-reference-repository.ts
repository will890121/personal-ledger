import type Database from "better-sqlite3";

import {
  AccountSchema,
  CategorySchema,
  CounterpartySchema,
  MerchantSchema,
  TagSchema,
  type Account,
  type Category,
  type Counterparty,
  type Merchant,
  type Tag,
} from "../domain/reference-data.js";
import type { NamedReferenceInput, ReferenceRepository } from "../ports/reference-repository.js";

interface AccountRow {
  account_id: string;
  owner_id: string;
  name: string;
  type: Account["type"];
  currency: "TWD";
  active: number;
}

interface CategoryRow {
  category_id: string;
  owner_id: string;
  key: string;
  name: string;
  kind: Category["kind"];
  parent_id: string | null;
  depth: 1 | 2;
  active: number;
}

interface NamedRow {
  owner_id: string;
  name: string;
  normalized_name: string;
  active: number;
  merchant_id?: string;
  counterparty_id?: string;
  tag_id?: string;
}

export function normalizeReferenceName(name: string): string {
  return name.normalize("NFKC").trim().toLocaleLowerCase("zh-TW");
}

export class SqliteReferenceRepository implements ReferenceRepository {
  public constructor(private readonly database: Database.Database) {}

  public listActiveAccounts(ownerId: string): Promise<Account[]> {
    const rows = this.database
      .prepare(
        "SELECT * FROM accounts WHERE owner_id = ? AND active = 1 ORDER BY normalized_name, account_id",
      )
      .all(ownerId) as AccountRow[];
    return Promise.resolve(rows.map((row) => this.toAccount(row)));
  }

  public listActiveCategories(ownerId: string): Promise<Category[]> {
    const rows = this.database
      .prepare(
        "SELECT * FROM categories WHERE owner_id = ? AND active = 1 ORDER BY key, category_id",
      )
      .all(ownerId) as CategoryRow[];
    return Promise.resolve(rows.map((row) => this.toCategory(row)));
  }

  public listActiveMerchants(ownerId: string): Promise<Merchant[]> {
    const rows = this.database
      .prepare(
        "SELECT * FROM merchants WHERE owner_id = ? AND active = 1 ORDER BY normalized_name, merchant_id",
      )
      .all(ownerId) as NamedRow[];
    return Promise.resolve(
      rows.map((row) =>
        MerchantSchema.parse({
          merchantId: row.merchant_id,
          ownerId: row.owner_id,
          name: row.name,
          active: true,
        }),
      ),
    );
  }

  public listActiveCounterparties(ownerId: string): Promise<Counterparty[]> {
    const rows = this.database
      .prepare(
        "SELECT counterparty_id, owner_id, name, active FROM counterparties WHERE owner_id = ? AND active = 1 ORDER BY name",
      )
      .all(ownerId) as {
      counterparty_id: string;
      owner_id: string;
      name: string;
      active: number;
    }[];
    return Promise.resolve(
      rows.map((row) =>
        CounterpartySchema.parse({
          counterpartyId: row.counterparty_id,
          ownerId: row.owner_id,
          name: row.name,
          active: row.active === 1,
        }),
      ),
    );
  }

  public getAccount(ownerId: string, accountId: string): Promise<Account | null> {
    const row = this.database
      .prepare("SELECT * FROM accounts WHERE owner_id = ? AND account_id = ?")
      .get(ownerId, accountId) as AccountRow | undefined;
    return Promise.resolve(row ? this.toAccount(row) : null);
  }

  public findAccountByName(ownerId: string, name: string): Promise<Account[]> {
    const normalizedName = normalizeReferenceName(name);
    const rows = this.database
      .prepare(
        `SELECT * FROM accounts
         WHERE owner_id = ? AND normalized_name LIKE '%' || ? || '%'
         ORDER BY normalized_name, account_id`,
      )
      .all(ownerId, normalizedName) as AccountRow[];
    return Promise.resolve(rows.map((row) => this.toAccount(row)));
  }

  public getCategory(ownerId: string, categoryId: string): Promise<Category | null> {
    const row = this.database
      .prepare("SELECT * FROM categories WHERE owner_id = ? AND category_id = ?")
      .get(ownerId, categoryId) as CategoryRow | undefined;
    return Promise.resolve(row ? this.toCategory(row) : null);
  }

  public findCategoryByKey(ownerId: string, key: string): Promise<Category | null> {
    const row = this.database
      .prepare("SELECT * FROM categories WHERE owner_id = ? AND key = ?")
      .get(ownerId, key) as CategoryRow | undefined;
    return Promise.resolve(row ? this.toCategory(row) : null);
  }

  public saveAccount(account: Account): Promise<void> {
    const parsed = AccountSchema.parse(account);
    this.assertIdOwner("accounts", "account_id", parsed.accountId, parsed.ownerId);
    this.database
      .prepare(
        `INSERT INTO accounts (
          account_id, owner_id, name, normalized_name, type, currency, active
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (account_id) DO UPDATE SET
          name = excluded.name,
          normalized_name = excluded.normalized_name,
          type = excluded.type,
          currency = excluded.currency,
          active = excluded.active,
          updated_at = CURRENT_TIMESTAMP
        WHERE accounts.owner_id = excluded.owner_id`,
      )
      .run(
        parsed.accountId,
        parsed.ownerId,
        parsed.name,
        normalizeReferenceName(parsed.name),
        parsed.type,
        parsed.currency,
        parsed.active ? 1 : 0,
      );
    return Promise.resolve();
  }

  public saveCategory(category: Category): Promise<void> {
    const parsed = CategorySchema.parse(category);
    this.assertIdOwner("categories", "category_id", parsed.categoryId, parsed.ownerId);
    this.database
      .prepare(
        `INSERT INTO categories (
          category_id, owner_id, key, name, kind, parent_id, depth, active
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (category_id) DO UPDATE SET
          key = excluded.key,
          name = excluded.name,
          kind = excluded.kind,
          parent_id = excluded.parent_id,
          depth = excluded.depth,
          active = excluded.active,
          updated_at = CURRENT_TIMESTAMP
        WHERE categories.owner_id = excluded.owner_id`,
      )
      .run(
        parsed.categoryId,
        parsed.ownerId,
        parsed.key,
        parsed.name,
        parsed.kind,
        parsed.parentId ?? null,
        parsed.depth,
        parsed.active ? 1 : 0,
      );
    return Promise.resolve();
  }

  public upsertMerchant(input: NamedReferenceInput): Promise<Merchant> {
    const row = this.upsertNamed("merchants", "merchant_id", input);
    return Promise.resolve(
      MerchantSchema.parse({
        merchantId: row.merchant_id,
        ownerId: row.owner_id,
        name: row.name,
        active: row.active === 1,
      }),
    );
  }

  public upsertCounterparty(input: NamedReferenceInput): Promise<Counterparty> {
    const row = this.upsertNamed("counterparties", "counterparty_id", input);
    return Promise.resolve(
      CounterpartySchema.parse({
        counterpartyId: row.counterparty_id,
        ownerId: row.owner_id,
        name: row.name,
        active: row.active === 1,
      }),
    );
  }

  public upsertTag(input: NamedReferenceInput): Promise<Tag> {
    const row = this.upsertNamed("tags", "tag_id", input);
    return Promise.resolve(
      TagSchema.parse({
        tagId: row.tag_id,
        ownerId: row.owner_id,
        name: row.name,
        normalizedName: row.normalized_name,
        active: row.active === 1,
      }),
    );
  }

  private upsertNamed(
    table: "merchants" | "counterparties" | "tags",
    idColumn: "merchant_id" | "counterparty_id" | "tag_id",
    input: NamedReferenceInput,
  ): NamedRow {
    const name = input.name.normalize("NFKC").trim();
    const normalizedName = normalizeReferenceName(name);
    this.database
      .prepare(
        `INSERT INTO ${table} (${idColumn}, owner_id, name, normalized_name, active)
         VALUES (?, ?, ?, ?, 1)
         ON CONFLICT (owner_id, normalized_name) DO UPDATE SET active = 1`,
      )
      .run(input.referenceId, input.ownerId, name, normalizedName);
    const row = this.database
      .prepare(`SELECT * FROM ${table} WHERE owner_id = ? AND normalized_name = ?`)
      .get(input.ownerId, normalizedName) as NamedRow | undefined;
    if (!row) throw new Error("reference upsert could not be loaded");
    return row;
  }

  private assertIdOwner(
    table: "accounts" | "categories",
    idColumn: "account_id" | "category_id",
    id: string,
    ownerId: string,
  ): void {
    const existing = this.database
      .prepare(`SELECT owner_id FROM ${table} WHERE ${idColumn} = ?`)
      .get(id) as { owner_id: string } | undefined;
    if (existing && existing.owner_id !== ownerId) {
      throw new Error("reference ID belongs to another owner");
    }
  }

  private toAccount(row: AccountRow): Account {
    return AccountSchema.parse({
      accountId: row.account_id,
      ownerId: row.owner_id,
      name: row.name,
      type: row.type,
      currency: row.currency,
      active: row.active === 1,
    });
  }

  private toCategory(row: CategoryRow): Category {
    return CategorySchema.parse({
      categoryId: row.category_id,
      ownerId: row.owner_id,
      key: row.key,
      name: row.name,
      kind: row.kind,
      ...(row.parent_id ? { parentId: row.parent_id } : {}),
      depth: row.depth,
      active: row.active === 1,
    });
  }
}

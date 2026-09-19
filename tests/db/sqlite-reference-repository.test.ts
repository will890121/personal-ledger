import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase } from "../../src/db/database.js";
import { migrate } from "../../src/db/migrate.js";
import { SqliteReferenceRepository } from "../../src/db/sqlite-reference-repository.js";

describe("SqliteReferenceRepository", () => {
  let database: Database.Database;
  let repository: SqliteReferenceRepository;

  beforeEach(() => {
    database = openDatabase(":memory:");
    migrate(database);
    repository = new SqliteReferenceRepository(database);
  });

  afterEach(() => database.close());

  it("isolates accounts by owner and returns ambiguous partial-name matches", async () => {
    await repository.saveAccount({
      accountId: "account-1",
      ownerId: "owner-1",
      name: "國泰卡",
      type: "credit_card",
      currency: "TWD",
      active: true,
    });
    await repository.saveAccount({
      accountId: "account-2",
      ownerId: "owner-1",
      name: "國泰銀行",
      type: "bank",
      currency: "TWD",
      active: false,
    });
    await repository.saveAccount({
      accountId: "account-3",
      ownerId: "owner-2",
      name: "國泰卡",
      type: "credit_card",
      currency: "TWD",
      active: true,
    });

    await expect(repository.findAccountByName("owner-1", "國泰")).resolves.toHaveLength(2);
    await expect(repository.getAccount("owner-1", "account-2")).resolves.toMatchObject({
      active: false,
    });
    await expect(repository.getAccount("owner-1", "account-3")).resolves.toBeNull();
  });

  it("loads an owner-scoped category by stable key", async () => {
    await repository.saveCategory({
      categoryId: "category-1",
      ownerId: "owner-1",
      key: "expense",
      name: "支出",
      kind: "expense",
      depth: 1,
      active: true,
    });

    await expect(repository.findCategoryByKey("owner-1", "expense")).resolves.toMatchObject({
      categoryId: "category-1",
    });
    await expect(repository.findCategoryByKey("owner-2", "expense")).resolves.toBeNull();
  });

  it("rejects an entity ID already owned by another owner", async () => {
    await repository.saveAccount({
      accountId: "shared-id",
      ownerId: "owner-1",
      name: "現金",
      type: "cash",
      currency: "TWD",
      active: true,
    });

    expect(() =>
      repository.saveAccount({
        accountId: "shared-id",
        ownerId: "owner-2",
        name: "現金",
        type: "cash",
        currency: "TWD",
        active: true,
      }),
    ).toThrow("reference ID belongs to another owner");
  });

  it("normalizes tags and upserts the same owner tag idempotently", async () => {
    const first = await repository.upsertTag({
      referenceId: "tag-1",
      ownerId: "owner-1",
      name: "  TRIP  ",
    });
    const second = await repository.upsertTag({
      referenceId: "tag-2",
      ownerId: "owner-1",
      name: "trip",
    });

    expect(second.tagId).toBe(first.tagId);
    expect(second.normalizedName).toBe("trip");
  });
});

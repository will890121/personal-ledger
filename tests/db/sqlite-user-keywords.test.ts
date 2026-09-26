import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { bootstrapReferenceData } from "../../src/db/bootstrap-reference-data.js";
import { openDatabase } from "../../src/db/database.js";
import { migrate } from "../../src/db/migrate.js";
import { SqliteReferenceRepository } from "../../src/db/sqlite-reference-repository.js";

describe("user category keywords", () => {
  let database: Database.Database;
  let repository: SqliteReferenceRepository;
  let diningId: string;
  let transportId: string;

  beforeEach(async () => {
    database = openDatabase(":memory:");
    migrate(database);
    repository = new SqliteReferenceRepository(database);
    await bootstrapReferenceData(repository, "owner-1");
    diningId = (await repository.findCategoryByKey("owner-1", "expense_dining"))?.categoryId ?? "";
    transportId =
      (await repository.findCategoryByKey("owner-1", "expense_transport"))?.categoryId ?? "";
  });

  afterEach(() => database.close());

  it("stores a keyword and lists it back", async () => {
    await repository.saveUserCategoryKeyword({
      ownerId: "owner-1",
      keyword: "牛排",
      categoryId: diningId,
    });

    await expect(repository.listUserCategoryKeywords("owner-1")).resolves.toEqual([
      { ownerId: "owner-1", keyword: "牛排", categoryId: diningId },
    ]);
  });

  it("re-teaching a keyword moves it to the new category instead of duplicating", async () => {
    await repository.saveUserCategoryKeyword({
      ownerId: "owner-1",
      keyword: "計程",
      categoryId: diningId,
    });

    await repository.saveUserCategoryKeyword({
      ownerId: "owner-1",
      keyword: "計程",
      categoryId: transportId,
    });

    await expect(repository.listUserCategoryKeywords("owner-1")).resolves.toEqual([
      { ownerId: "owner-1", keyword: "計程", categoryId: transportId },
    ]);
  });

  it("treats a keyword differing only by case or width as the same one", async () => {
    // 與 merchants／counterparties 同一套正規化：NFKC + 去空白 + 小寫。
    await repository.saveUserCategoryKeyword({
      ownerId: "owner-1",
      keyword: "ＫＴＶ ",
      categoryId: diningId,
    });

    await repository.saveUserCategoryKeyword({
      ownerId: "owner-1",
      keyword: "ktv",
      categoryId: transportId,
    });

    const stored = await repository.listUserCategoryKeywords("owner-1");
    expect(stored).toHaveLength(1);
    expect(stored[0]?.categoryId).toBe(transportId);
  });

  it("keeps each owner's keywords separate", async () => {
    await bootstrapReferenceData(repository, "owner-2");
    await repository.saveUserCategoryKeyword({
      ownerId: "owner-1",
      keyword: "牛排",
      categoryId: diningId,
    });

    await expect(repository.listUserCategoryKeywords("owner-2")).resolves.toEqual([]);
  });
});

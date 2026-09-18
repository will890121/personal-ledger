import { describe, expect, it } from "vitest";

import {
  AccountSchema,
  CategorySchema,
  CounterpartySchema,
  MerchantSchema,
  TagSchema,
} from "../../src/domain/reference-data.js";

describe("accounting reference data", () => {
  it("accepts a TWD account with a supported type", () => {
    expect(
      AccountSchema.parse({
        accountId: "account-1",
        ownerId: "owner-1",
        name: "國泰卡",
        type: "credit_card",
        currency: "TWD",
        active: true,
      }),
    ).toMatchObject({ type: "credit_card", currency: "TWD" });
  });

  it("rejects a non-TWD account", () => {
    expect(() =>
      AccountSchema.parse({
        accountId: "account-1",
        ownerId: "owner-1",
        name: "外幣帳戶",
        type: "bank",
        currency: "USD",
        active: true,
      }),
    ).toThrow();
  });

  it("accepts only first- and second-level categories", () => {
    expect(
      CategorySchema.parse({
        categoryId: "category-2",
        ownerId: "owner-1",
        key: "expense_dining_lunch",
        name: "午餐",
        kind: "expense",
        parentId: "category-1",
        depth: 2,
        active: true,
      }),
    ).toMatchObject({ depth: 2, parentId: "category-1" });

    expect(() =>
      CategorySchema.parse({
        categoryId: "category-3",
        ownerId: "owner-1",
        key: "expense_dining_lunch_weekday",
        name: "平日午餐",
        kind: "expense",
        parentId: "category-2",
        depth: 3,
        active: true,
      }),
    ).toThrow();
  });

  it("requires normalized tag names and owner-scoped named references", () => {
    expect(
      MerchantSchema.parse({
        merchantId: "merchant-1",
        ownerId: "owner-1",
        name: "Uber",
        active: true,
      }),
    ).toMatchObject({ name: "Uber" });
    expect(
      CounterpartySchema.parse({
        counterpartyId: "counterparty-1",
        ownerId: "owner-1",
        name: "朋友",
        active: true,
      }),
    ).toMatchObject({ name: "朋友" });
    expect(
      TagSchema.parse({
        tagId: "tag-1",
        ownerId: "owner-1",
        name: "日本旅行",
        normalizedName: "日本旅行",
        active: true,
      }),
    ).toMatchObject({ normalizedName: "日本旅行" });
  });
});

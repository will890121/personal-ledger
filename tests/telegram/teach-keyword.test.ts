import { describe, expect, it } from "vitest";

import {
  callbackUpdate,
  createHarness,
  firstDraftRef,
  getText,
  messageUpdate,
} from "../support/telegram-harness.js";
import type { FakeReferenceRepository } from "../support/fake-reference-repository.js";

function seedCategories(referenceRepository: FakeReferenceRepository): void {
  for (const [categoryId, key, name] of [
    ["category-dining", "expense_dining", "餐飲"],
    ["category-transport", "expense_transport", "交通"],
  ] as const) {
    referenceRepository.categories.push({
      categoryId,
      ownerId: "123",
      key,
      name,
      kind: "expense",
      parentId: "category-expense",
      depth: 2,
      active: true,
    });
  }
}

function harness() {
  const created = createHarness();
  seedCategories(created.referenceRepository);
  return created;
}

/** 走完「解不出分類 → 按下分類按鈕」，回傳該草稿的 ref 與這一輪的所有 API 呼叫。 */
async function answerCategory(text: string, categoryIndex = 0) {
  const created = harness();
  await created.bot.handleUpdate(messageUpdate({ updateId: 1, text }));
  const draftRef = firstDraftRef(created.repository);
  await created.bot.handleUpdate(
    callbackUpdate({ updateId: 2, data: `a:${draftRef}:cat:${String(categoryIndex)}` }),
  );
  return { ...created, draftRef };
}

describe("teaching a category keyword", () => {
  it("offers to remember the word after the category is answered", async () => {
    const { calls, draftRef } = await answerCategory("牛排 300");

    const offer = getText(calls.at(-1));
    expect(offer).toContain("還不認識「牛排」");
    expect(offer).toContain("餐飲");
    expect(JSON.stringify(calls.at(-1)?.payload)).toContain(`"k:${draftRef}:1"`);
    expect(JSON.stringify(calls.at(-1)?.payload)).toContain(`"k:${draftRef}:0"`);
  });

  it("remembers the word so the next message needs no follow-up", async () => {
    const { bot, calls, repository, referenceRepository, draftRef } =
      await answerCategory("牛排 300");

    await bot.handleUpdate(callbackUpdate({ updateId: 3, data: `k:${draftRef}:1` }));

    expect(referenceRepository.userCategoryKeywords).toEqual([
      { ownerId: "123", keyword: "牛排", categoryId: "category-dining" },
    ]);

    await bot.handleUpdate(messageUpdate({ updateId: 4, text: "牛排 500" }));
    const preview = getText(calls.at(-1));
    expect(preview).toContain("總金額：TWD 500");
    expect(preview).toContain("餐飲／牛排");
    expect(preview).not.toContain("待補分類");
    const second = [...repository.records.values()].at(-1);
    expect(second?.status).toBe("awaiting_confirmation");
  });

  it("stores nothing when the offer is declined", async () => {
    const { bot, calls, referenceRepository, draftRef } = await answerCategory("牛排 300");

    await bot.handleUpdate(callbackUpdate({ updateId: 3, data: `k:${draftRef}:0` }));

    expect(referenceRepository.userCategoryKeywords).toEqual([]);
    expect(getText(calls.at(-1))).toContain("這次不記");
  });

  it("does not offer when the sentence leaves no clean candidate", async () => {
    // 「國泰卡刷 1200」剝掉帳戶與金額只剩一個「刷」字，不該提議。
    const created = harness();
    created.referenceRepository.accounts.push({
      accountId: "account-card",
      ownerId: "123",
      name: "國泰卡",
      type: "credit_card",
      currency: "TWD",
      active: true,
    });
    await created.bot.handleUpdate(messageUpdate({ updateId: 1, text: "國泰卡刷 1200" }));
    const draftRef = firstDraftRef(created.repository);

    await created.bot.handleUpdate(callbackUpdate({ updateId: 2, data: `a:${draftRef}:cat:0` }));

    expect(getText(created.calls.at(-1))).not.toContain("還不認識");
  });
});

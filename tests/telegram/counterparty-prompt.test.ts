import { describe, expect, it } from "vitest";

import {
  callbackUpdate,
  createHarness,
  firstDraftRef,
  getText,
  messageUpdate,
  replyUpdate,
  sentMessages,
} from "../support/telegram-harness.js";
import type { FakeReferenceRepository } from "../support/fake-reference-repository.js";

function seedDiningCategory(referenceRepository: FakeReferenceRepository): void {
  referenceRepository.categories.push({
    categoryId: "category-lunch",
    ownerId: "123",
    key: "expense_dining_lunch",
    name: "餐飲",
    kind: "expense",
    parentId: "category-expense",
    depth: 2,
    active: true,
  });
}

describe("counterparty follow-up", () => {
  it("offers existing counterparties as buttons", async () => {
    const { bot, calls, referenceRepository } = createHarness();
    referenceRepository.counterparties.push({
      counterpartyId: "friend",
      ownerId: "123",
      name: "朋友",
      active: true,
    });
    seedDiningCategory(referenceRepository);

    await bot.handleUpdate(messageUpdate({ updateId: 1, text: "午餐 1260，小明欠一半" }));

    const prompt = getText(calls.at(-1));
    expect(prompt).toContain("待補交易對象");
    expect(JSON.stringify(calls.at(-1)?.payload)).toContain("朋友");
  });

  it("spells out the reply path when the ledger has no counterparty at all", async () => {
    const { bot, calls, referenceRepository } = createHarness();
    seedDiningCategory(referenceRepository);

    await bot.handleUpdate(messageUpdate({ updateId: 1, text: "午餐 999，三個人平分" }));

    const prompt = getText(calls.at(-1));
    expect(prompt).toContain("待補交易對象");
    // 新使用者的候選清單必定是空的（§5.4）：文案必須自己指出「回覆輸入新名稱」
    // 這條路，否則這則訊息完全沒有出路。
    expect(prompt).toContain("回覆這則訊息");
    expect(JSON.stringify(calls.at(-1)?.payload)).toContain('"inline_keyboard":[]');
  });

  it("asks to create an unknown counterparty typed as a reply", async () => {
    const { bot, calls, referenceRepository } = createHarness();
    seedDiningCategory(referenceRepository);
    await bot.handleUpdate(messageUpdate({ updateId: 1, text: "午餐 1260，小明欠一半" }));
    const promptId = sentMessages(calls).length;

    await bot.handleUpdate(replyUpdate({ updateId: 2, text: "小明", replyToMessageId: promptId }));

    expect(getText(calls.at(-1))).toContain("尚未建立「小明」");
    expect(JSON.stringify(calls.at(-1)?.payload)).toContain('"c:');
  });

  it("creates the counterparty and completes the draft", async () => {
    const { bot, calls, repository, referenceRepository } = createHarness();
    seedDiningCategory(referenceRepository);
    await bot.handleUpdate(messageUpdate({ updateId: 1, text: "午餐 1260，小明欠一半" }));
    const promptId = sentMessages(calls).length;
    await bot.handleUpdate(replyUpdate({ updateId: 2, text: "小明", replyToMessageId: promptId }));
    const draftRef = firstDraftRef(repository);

    await bot.handleUpdate(callbackUpdate({ updateId: 3, data: `c:${draftRef}` }));

    expect(referenceRepository.counterparties.map((item) => item.name)).toContain("小明");
    const record = await repository.getDraftRecord({ ownerId: "123", draftRef });
    expect(record?.status).toBe("awaiting_confirmation");
    expect(record?.draft?.allocations[1]?.counterpartyId).toBeDefined();
  });

  it("completes an uneven three-way split by asking for the share then each counterparty in turn", async () => {
    const { bot, calls, repository, referenceRepository } = createHarness();
    referenceRepository.counterparties.push(
      { counterpartyId: "friend", ownerId: "123", name: "朋友", active: true },
      { counterpartyId: "family", ownerId: "123", name: "家人", active: true },
    );
    seedDiningCategory(referenceRepository);

    await bot.handleUpdate(messageUpdate({ updateId: 1, text: "午餐 1000，三個人平分" }));
    const advanceSharePromptId = sentMessages(calls).length;

    await bot.handleUpdate(
      replyUpdate({ updateId: 2, text: "334", replyToMessageId: advanceSharePromptId }),
    );

    // 補完每人負擔金額後，應該接著追問交易對象（候選按鈕），而不是重複問一樣的金額。
    const counterpartyPrompt = getText(calls.at(-1));
    expect(counterpartyPrompt).toContain("待補交易對象");

    const draftRef = firstDraftRef(repository);
    // 兩次都點候選按鈕，但選不同的對象——第一筆代墊給「朋友」，第二筆給「家人」。
    await bot.handleUpdate(callbackUpdate({ updateId: 3, data: `a:${draftRef}:cpy:0` }));
    await bot.handleUpdate(callbackUpdate({ updateId: 4, data: `a:${draftRef}:cpy:1` }));

    const record = await repository.getDraftRecord({ ownerId: "123", draftRef });
    expect(record?.status).toBe("awaiting_confirmation");
    expect(record?.draft?.amount.amount).toBe("1000");
    const advanceAllocations = record?.draft?.allocations.filter(
      (item) => item.purpose === "advance",
    );
    expect(record?.draft?.allocations.map((item) => item.amount.amount)).toEqual([
      "332",
      "334",
      "334",
    ]);
    // 這條是本輪的重點：兩筆代墊的對象必須是不同的兩個人，不能被合併成同一個。
    expect(advanceAllocations?.map((item) => item.counterpartyId)).toEqual(["friend", "family"]);
  });
});

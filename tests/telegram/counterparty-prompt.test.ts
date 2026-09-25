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
    key: "expense_dining",
    name: "午餐",
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

  it("does not show round-progress text when only one advance needs a counterparty", async () => {
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
    // 單人分帳只有一筆代墊待指定，不該出現「第 N 位，共 M 位」這種對單人沒有意義的雜訊。
    expect(prompt).not.toMatch(/第\s*\d+\s*位/);
  });

  it("makes the two rounds of a multi-debtor follow-up visibly different", async () => {
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

    const firstRoundText = getText(calls.at(-1));
    // §缺陷 1：第一輪追問必須寫清楚「第幾位、共幾位」，否則第二輪重繪出一模一樣的
    // 文字時，Telegram 會判定訊息未變更而拒絕更新，使用者就會看起來「按了沒反應」。
    expect(firstRoundText).toContain("第 1 位，共 2 位");

    const draftRef = firstDraftRef(repository);
    await bot.handleUpdate(callbackUpdate({ updateId: 3, data: `a:${draftRef}:cpy:0` }));

    const secondRoundText = getText(calls.at(-1));
    expect(secondRoundText).toContain("第 2 位，共 2 位");
    // 兩輪文字本身就必須不同，這正是修法要保證的事：Telegram 不會再因為訊息
    // 「看起來沒變」而拒絕重繪。
    expect(secondRoundText).not.toBe(firstRoundText);
  });

  it("responds visibly to the first candidate tap instead of failing silently", async () => {
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
    const beforeTapCallCount = calls.length;
    const beforeTapText = getText(calls.at(-1));

    const draftRef = firstDraftRef(repository);
    await bot.handleUpdate(callbackUpdate({ updateId: 3, data: `a:${draftRef}:cpy:0` }));

    // 按下第一顆候選按鈕之後必須有看得見的結果：callback query 被回答，
    // 而且訊息內容確實往前推進了一輪，不能是使用者按了卻什麼都沒發生。
    expect(calls.length).toBeGreaterThan(beforeTapCallCount);
    expect(calls.some((call) => call.method === "answerCallbackQuery")).toBe(true);
    const afterTapText = getText(calls.at(-1));
    expect(afterTapText).not.toBe(beforeTapText);
    expect(afterTapText).toContain("第 2 位，共 2 位");
    // 也不能誤把這次成功的操作標成失敗提示。
    expect(calls.some((call) => getText(call) === "操作失敗，請稍後再試")).toBe(false);
  });

  it("shows each advance allocation's own counterparty name in the preview", async () => {
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
    const draftRef = firstDraftRef(repository);
    await bot.handleUpdate(callbackUpdate({ updateId: 3, data: `a:${draftRef}:cpy:0` }));
    await bot.handleUpdate(callbackUpdate({ updateId: 4, data: `a:${draftRef}:cpy:1` }));

    const preview = getText(calls.at(-1));
    expect(preview).toBeDefined();
    // 兩筆代墊各自欠款的對象必須都看得到、而且是不同的兩個人，
    // 使用者才能在確認前發現「指派給誰」有沒有選錯。
    expect(preview).toContain("朋友");
    expect(preview).toContain("家人");
    const friendIndex = preview?.indexOf("朋友") ?? -1;
    const familyIndex = preview?.indexOf("家人") ?? -1;
    expect(friendIndex).toBeGreaterThanOrEqual(0);
    expect(familyIndex).toBeGreaterThanOrEqual(0);
    expect(friendIndex).not.toBe(familyIndex);
  });
});

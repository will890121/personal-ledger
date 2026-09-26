import { describe, expect, it } from "vitest";

import {
  callbackUpdate,
  createHarness,
  getText,
  messageUpdate,
  replyUpdate,
  sentMessages,
  firstDraftRef,
} from "../support/telegram-harness.js";
import type { FakeReferenceRepository } from "../support/fake-reference-repository.js";

function seedCategories(referenceRepository: FakeReferenceRepository): void {
  referenceRepository.categories.push({
    categoryId: "category-lunch",
    ownerId: "123",
    key: "expense_dining",
    name: "餐飲",
    kind: "expense",
    parentId: "category-expense",
    depth: 2,
    active: true,
  });
}

function harness() {
  const created = createHarness();
  seedCategories(created.referenceRepository);
  return created;
}

describe("draft routing", () => {
  it("routes a reply to the draft that preview message belongs to", async () => {
    const { bot, calls, repository } = harness();
    await bot.handleUpdate(messageUpdate({ updateId: 1, text: "午餐" }));
    const promptMessageId = sentMessages(calls).length;

    await bot.handleUpdate(
      replyUpdate({ updateId: 2, text: "120", replyToMessageId: promptMessageId }),
    );

    const record = await repository.getDraftRecord({ draftId: "id-3" });
    expect(record?.status).toBe("awaiting_confirmation");
    expect(getText(calls.at(-1))).toContain("總金額：TWD 120");
  });

  it("offers the pending drafts when a bare amount arrives without a reply", async () => {
    const { bot, calls } = harness();
    await bot.handleUpdate(messageUpdate({ updateId: 1, text: "午餐" }));

    await bot.handleUpdate(messageUpdate({ updateId: 2, text: "120" }));

    const last = calls.at(-1);
    expect(getText(last)).toContain("要把 120 填到哪一筆");
    expect(JSON.stringify(last?.payload)).toContain('"v:');
  });

  it("applies the amount to the draft chosen from the candidate list", async () => {
    const { bot, calls, repository } = harness();
    await bot.handleUpdate(messageUpdate({ updateId: 1, text: "午餐" }));
    const draftRef = firstDraftRef(repository);
    await bot.handleUpdate(messageUpdate({ updateId: 2, text: "120" }));

    await bot.handleUpdate(callbackUpdate({ updateId: 3, data: `v:${draftRef}:120` }));

    const record = await repository.getDraftRecord({ ownerId: "123", draftRef });
    expect(record?.status).toBe("awaiting_confirmation");
    expect(getText(calls.at(-1))).toContain("總金額：TWD 120");
  });

  it("treats a parsable message as a new transaction even while drafts await input", async () => {
    const { bot, calls, repository } = harness();
    await bot.handleUpdate(messageUpdate({ updateId: 1, text: "午餐" }));

    await bot.handleUpdate(messageUpdate({ updateId: 2, text: "午餐 250" }));

    expect(getText(calls.at(-1))).toContain("總金額：TWD 250");
    expect(repository.records.size).toBe(2);
  });

  it("applies a candidate button answer to the referenced draft", async () => {
    const { bot, calls, repository } = harness();
    await bot.handleUpdate(messageUpdate({ updateId: 1, text: "雜支 60" }));
    const draftRef = firstDraftRef(repository);

    await bot.handleUpdate(callbackUpdate({ updateId: 2, data: `a:${draftRef}:cat:0` }));

    expect(calls.some((call) => call.method === "answerCallbackQuery")).toBe(true);
    const record = await repository.getDraftRecord({ ownerId: "123", draftRef });
    expect(record?.status).toBe("awaiting_confirmation");
    expect(record?.draft?.allocations[0]?.categoryId).toBe("category-lunch");
    expect(getText(calls.at(-1))).toContain("總金額：TWD 60");
  });

  it("replaces the prompt in place when answered with a candidate button", async () => {
    const { bot, calls, repository } = harness();
    await bot.handleUpdate(messageUpdate({ updateId: 1, text: "雜支 60" }));
    const draftRef = firstDraftRef(repository);
    const before = calls.filter((call) => call.method === "sendMessage").length;

    await bot.handleUpdate(callbackUpdate({ updateId: 2, data: `a:${draftRef}:cat:0` }));

    const after = calls.filter((call) => call.method === "sendMessage").length;
    expect(after).toBe(before);
    expect(calls.at(-1)?.method).toBe("editMessageText");
    expect(getText(calls.at(-1))).toContain("總金額：TWD 60");
  });

  it("rejects a non-numeric reply without changing the draft", async () => {
    const { bot, calls, repository } = harness();
    await bot.handleUpdate(messageUpdate({ updateId: 1, text: "午餐" }));
    const promptMessageId = sentMessages(calls).length;

    await bot.handleUpdate(
      replyUpdate({ updateId: 2, text: "一百二", replyToMessageId: promptMessageId }),
    );

    expect(getText(calls.at(-1))).toContain("金額格式");
    const record = await repository.getDraftRecord({ draftId: "id-3" });
    expect(record?.status).toBe("awaiting_input");
  });
  // 這個 bug 活在 parser 與版型之間的接縫上：parser 取葉分類名稱（「午餐」）當
  // category，又硬補一個同名 subcategory，預覽便印出「午餐／午餐」。單看 parser 或
  // 單看 formatPreview 都不會發現，只有走完整條鏈的斷言擋得住它回來。
  it("renders the lunch category once in the preview", async () => {
    const { bot, calls } = harness();

    await bot.handleUpdate(messageUpdate({ updateId: 1, text: "午餐 120" }));

    const text = getText(calls.at(-1));
    expect(text).toContain("└ 餐飲／午餐 · TWD 120");
    expect(text).not.toContain("午餐／午餐");
  });
  it("cancels the draft from the follow-up prompt's cancel button", async () => {
    // 分類追問只收按鈕，文字回覆會被當成金額退回；少了這條路草稿會一直停在
    // awaiting_input，使用者得另外開 /pending 才處理得掉。
    const { bot, calls, repository } = harness();
    await bot.handleUpdate(messageUpdate({ updateId: 1, text: "雜支 60" }));
    const draftRef = firstDraftRef(repository);

    await bot.handleUpdate(callbackUpdate({ updateId: 2, data: `x:${draftRef}` }));

    const record = await repository.getDraftRecord({ ownerId: "123", draftRef });
    // 未完成草稿的「放棄」在 M3a 就定義為封存（/pending 的封存鍵同一條路）；使用者看到
    // 的是「已取消」，重點是它不再出現在待處理清單裡。
    expect(record?.status).toBe("archived");
    expect(getText(calls.at(-1))).toBe("草稿已取消。");
    const pending = await repository.listPendingDrafts({
      ownerId: "123",
      status: "awaiting_input",
      limit: 10,
      offset: 0,
    });
    expect(pending.map((item) => item.draftRef)).not.toContain(draftRef);
  });
});

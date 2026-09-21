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
    key: "expense_dining_lunch",
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
    await bot.handleUpdate(messageUpdate({ updateId: 1, text: "咖啡 60" }));
    const draftRef = firstDraftRef(repository);

    await bot.handleUpdate(callbackUpdate({ updateId: 2, data: `a:${draftRef}:cat:0` }));

    expect(calls.some((call) => call.method === "answerCallbackQuery")).toBe(true);
    const record = await repository.getDraftRecord({ ownerId: "123", draftRef });
    expect(record?.status).toBe("awaiting_confirmation");
    expect(record?.draft?.allocations[0]?.categoryId).toBe("category-lunch");
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
});

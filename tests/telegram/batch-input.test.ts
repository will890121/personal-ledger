import { describe, expect, it } from "vitest";

import {
  createHarness,
  getText,
  messageUpdate,
  sentMessages,
  type ApiCall,
} from "../support/telegram-harness.js";
import type { FakeReferenceRepository } from "../support/fake-reference-repository.js";

function seedReferences(referenceRepository: FakeReferenceRepository): void {
  referenceRepository.merchants.push({
    merchantId: "merchant-uber",
    ownerId: "123",
    name: "Uber",
    active: true,
  });
  referenceRepository.categories.push(
    {
      categoryId: "category-lunch",
      ownerId: "123",
      key: "expense_dining_lunch",
      name: "餐飲",
      kind: "expense",
      parentId: "category-expense",
      depth: 2,
      active: true,
    },
    {
      categoryId: "category-transport",
      ownerId: "123",
      key: "expense_transport",
      name: "交通",
      kind: "expense",
      parentId: "category-expense",
      depth: 2,
      active: true,
    },
  );
}

function harness() {
  const created = createHarness();
  seedReferences(created.referenceRepository);
  return created;
}

function texts(calls: readonly ApiCall[]): (string | undefined)[] {
  return sentMessages(calls).map((call) => getText(call));
}

describe("batch input", () => {
  it("sends one preview per segment and a batch summary for AC-09", async () => {
    const { bot, calls, repository } = harness();

    await bot.handleUpdate(messageUpdate({ updateId: 1, text: "午餐 120，Uber 245" }));

    const sent = texts(calls);
    expect(sent).toHaveLength(3);
    expect(sent[0]).toContain("總金額：TWD 120");
    expect(sent[1]).toContain("總金額：TWD 245");
    expect(sent[2]).toBe("2 筆：2 筆待確認");
    expect(repository.batches.size).toBe(1);
    expect(repository.drafts.size).toBe(2);
  });

  it("previews the parsable segments and prompts for the incomplete one for AC-10", async () => {
    const { bot, calls, repository } = harness();

    await bot.handleUpdate(messageUpdate({ updateId: 1, text: "午餐 120，Uber 245，咖啡 90" }));

    const sent = texts(calls);
    expect(sent).toHaveLength(4);
    expect(sent[2]).toContain("待補分類");
    expect(sent[3]).toBe("3 筆：2 筆待確認、1 筆待補欄位");
    expect(repository.records.size).toBe(3);
    expect(repository.incompleteDrafts.size).toBe(1);
  });

  it("stores the preview message id so replies can find the draft", async () => {
    const { bot, repository } = harness();

    await bot.handleUpdate(messageUpdate({ updateId: 1, text: "午餐" }));

    const record = await repository.getDraftRecord({
      previewChatId: "123",
      previewMessageId: "1",
    });
    expect(record?.incomplete?.partial.rawSegment).toBe("午餐");
  });

  it("does not send a summary for a single segment", async () => {
    const { bot, calls } = harness();

    await bot.handleUpdate(messageUpdate({ updateId: 1, text: "午餐 120" }));

    expect(texts(calls)).toHaveLength(1);
  });

  it("rejects a message with more than ten segments without creating drafts", async () => {
    const { bot, calls, repository } = harness();
    const text = Array.from({ length: 11 }, () => "午餐 10").join("，");

    await bot.handleUpdate(messageUpdate({ updateId: 1, text }));

    expect(getText(calls[0])).toContain("一次最多 10 筆");
    expect(repository.records.size).toBe(0);
  });

  it("reports unparsable input without creating a draft", async () => {
    const { bot, calls, repository } = harness();

    await bot.handleUpdate(messageUpdate({ updateId: 1, text: "在嗎" }));

    expect(getText(calls[0])).toContain("無法解析");
    expect(repository.records.size).toBe(0);
  });
});

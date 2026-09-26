import { describe, expect, it } from "vitest";

import { ConfirmedTransactionSchema } from "../../src/domain/ledger.js";
import { createHarness, getText, messageUpdate } from "../support/telegram-harness.js";

const OWNER_ID = "123";

/**
 * 建立一份帶有未回收代墊的 harness：向「小明」代墊一筆 400，供回收文字入口測試使用。
 * 比照 tests/telegram/advances-command.test.ts 的 harnessWithAdvances 寫法。
 */
function harnessWithAdvances() {
  const harness = createHarness();
  const { repository, referenceRepository } = harness;

  referenceRepository.counterparties.push({
    counterpartyId: "xiaoming",
    ownerId: OWNER_ID,
    name: "小明",
    active: true,
  });
  referenceRepository.categories.push({
    categoryId: "category-income-other",
    ownerId: OWNER_ID,
    key: "income_other",
    name: "其他收入",
    kind: "income",
    depth: 1,
    active: true,
  });

  const tx1 = ConfirmedTransactionSchema.parse({
    requestId: "req-1",
    draftId: "draft-1",
    transactionId: "tx-1",
    ownerId: OWNER_ID,
    sourceEventId: "event-1",
    occurredDate: "2026-09-10",
    amount: { amount: "400", currency: "TWD" },
    status: "confirmed",
    confirmedAt: "2026-09-10T00:00:00.000Z",
    allocations: [
      {
        allocationId: "alloc-1",
        fundsEffect: "outflow",
        purpose: "advance",
        amount: { amount: "400", currency: "TWD" },
        counterpartyId: "xiaoming",
        category: "餐飲",
      },
    ],
  });
  repository.transactions.set("req-1", tx1);

  return harness;
}

describe("recovery typed as free text", () => {
  it("records a recovery typed as free text", async () => {
    const { bot, calls, repository } = harnessWithAdvances();

    await bot.handleUpdate(messageUpdate({ updateId: 10, text: "小明還 300" }));

    const text = getText(calls.at(-1));
    expect(text).toContain("總金額：TWD 300");
    expect(text).toContain("代墊收回");
    expect(repository.drafts.size).toBe(1);
  });

  it("records a recovery phrased with the 收到 prefix and no 還 keyword", async () => {
    const { bot, calls, repository } = harnessWithAdvances();

    await bot.handleUpdate(messageUpdate({ updateId: 10, text: "收到小明 300" }));

    const text = getText(calls.at(-1));
    expect(text).toContain("總金額：TWD 300");
    expect(text).toContain("代墊收回");
    expect(repository.drafts.size).toBe(1);
  });

  it("parses the name correctly when the sentence uses 還我", async () => {
    const { bot, calls, repository } = harnessWithAdvances();

    await bot.handleUpdate(messageUpdate({ updateId: 10, text: "小明還我 300" }));

    const text = getText(calls.at(-1));
    expect(text).toContain("總金額：TWD 300");
    expect(text).toContain("代墊收回");
    expect(repository.drafts.size).toBe(1);
  });

  it("ignores a repayment for a counterparty with nothing outstanding", async () => {
    const { bot, calls, referenceRepository } = createHarness();
    referenceRepository.counterparties.push({
      counterpartyId: "friend",
      ownerId: "123",
      name: "小明",
      active: true,
    });

    await bot.handleUpdate(messageUpdate({ updateId: 10, text: "小明還 300" }));

    expect(getText(calls.at(-1))).toContain("目前沒有未回收代墊");
  });

  it("treats an ordinary expense as a new transaction", async () => {
    const { bot, calls } = harnessWithAdvances();

    await bot.handleUpdate(messageUpdate({ updateId: 10, text: "午餐 120" }));

    expect(getText(calls.at(-1))).toContain("總金額：TWD 120");
  });

  it("does not mistake a narrative sentence for a repayment", async () => {
    const { bot, calls } = harnessWithAdvances();

    await bot.handleUpdate(messageUpdate({ updateId: 10, text: "小明還欠我錢" }));

    const text = getText(calls.at(-1));
    expect(text).not.toContain("代墊收回");
  });
});

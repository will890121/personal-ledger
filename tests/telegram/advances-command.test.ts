import { describe, expect, it } from "vitest";

import { ConfirmedTransactionSchema } from "../../src/domain/ledger.js";
import {
  callbackUpdate,
  createHarness,
  getText,
  messageUpdate,
  replyUpdate,
  sentMessages,
} from "../support/telegram-harness.js";
import { shortAdvanceRef } from "../../src/telegram/handlers/advances.js";

const OWNER_ID = "123";

/**
 * 建立一份帶有未回收代墊的 harness：向「小明」代墊兩筆，共 630（400 + 230）。
 * counterpartyRef / allocationRef 是 shortAdvanceRef 對相同 id 的確定性輸出，
 * 因此不必先跑一次 /advances 就能算出之後 callback 要用的短碼。
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
  const tx2 = ConfirmedTransactionSchema.parse({
    requestId: "req-2",
    draftId: "draft-2",
    transactionId: "tx-2",
    ownerId: OWNER_ID,
    sourceEventId: "event-2",
    occurredDate: "2026-09-11",
    amount: { amount: "230", currency: "TWD" },
    status: "confirmed",
    confirmedAt: "2026-09-11T00:00:00.000Z",
    allocations: [
      {
        allocationId: "alloc-2",
        fundsEffect: "outflow",
        purpose: "advance",
        amount: { amount: "230", currency: "TWD" },
        counterpartyId: "xiaoming",
        category: "餐飲",
      },
    ],
  });
  repository.transactions.set("req-1", tx1);
  repository.transactions.set("req-2", tx2);

  return {
    ...harness,
    counterpartyRef: shortAdvanceRef("xiaoming"),
    allocationRef: shortAdvanceRef("alloc-1"),
  };
}

describe("/advances", () => {
  it("lists outstanding advances grouped by counterparty", async () => {
    const { bot, calls } = harnessWithAdvances();

    await bot.handleUpdate(messageUpdate({ updateId: 10, text: "/advances" }));

    const text = getText(calls.at(-1));
    expect(text).toContain("小明");
    expect(text).toContain("未回收 630");
    expect(JSON.stringify(calls.at(-1)?.payload)).toContain("dismiss-advances");
  });

  it("says nothing is outstanding when every advance is recovered", async () => {
    const { bot, calls } = createHarness();

    await bot.handleUpdate(messageUpdate({ updateId: 10, text: "/advances" }));

    expect(getText(calls.at(-1))).toContain("目前沒有未回收代墊");
  });

  it("closes the previous list when a new one is requested", async () => {
    const { bot, calls } = harnessWithAdvances();
    await bot.handleUpdate(messageUpdate({ updateId: 10, text: "/advances" }));

    await bot.handleUpdate(messageUpdate({ updateId: 11, text: "/advances" }));

    const deletions = calls.filter((call) => call.method === "deleteMessage");
    expect(deletions).toHaveLength(1);
  });

  it("offers a close button that removes the list", async () => {
    const { bot, calls } = harnessWithAdvances();
    await bot.handleUpdate(messageUpdate({ updateId: 10, text: "/advances" }));

    await bot.handleUpdate(callbackUpdate({ updateId: 11, data: "dismiss-advances" }));

    expect(calls.at(-1)?.method).toBe("deleteMessage");
  });

  it("asks for the received amount when recording a recovery", async () => {
    const { bot, calls, counterpartyRef } = harnessWithAdvances();
    await bot.handleUpdate(messageUpdate({ updateId: 10, text: "/advances" }));

    await bot.handleUpdate(callbackUpdate({ updateId: 11, data: `ar:${counterpartyRef}` }));

    expect(getText(calls.at(-1))).toContain("收到多少");
  });

  it("rejects an advance-recover callback whose short code is unknown", async () => {
    const { bot, calls } = createHarness();

    await bot.handleUpdate(callbackUpdate({ updateId: 10, data: "ar:00000000" }));

    expect(JSON.stringify(calls.at(-1)?.payload)).toContain("操作已失效");
  });

  it("records a recovery and shows a confirmable preview when the reply is a plain number", async () => {
    const { bot, calls, counterpartyRef } = harnessWithAdvances();
    await bot.handleUpdate(messageUpdate({ updateId: 10, text: "/advances" }));
    await bot.handleUpdate(callbackUpdate({ updateId: 11, data: `ar:${counterpartyRef}` }));
    // sendMessage 回應的 message_id 由 harness 依序遞增，取得剛送出的那則訊息編號。
    const sentCount = sentMessages(calls).length;

    await bot.handleUpdate(replyUpdate({ updateId: 12, text: "300", replyToMessageId: sentCount }));

    const text = getText(calls.at(-1));
    expect(text).toContain("總金額：TWD 300");
    expect(JSON.stringify(calls.at(-1)?.payload)).toContain("確認");
  });

  it("tells the user to start over when the recovery amount is not a number", async () => {
    const { bot, calls, counterpartyRef } = harnessWithAdvances();
    await bot.handleUpdate(messageUpdate({ updateId: 10, text: "/advances" }));
    await bot.handleUpdate(callbackUpdate({ updateId: 11, data: `ar:${counterpartyRef}` }));
    const sentCount = sentMessages(calls).length;

    await bot.handleUpdate(
      replyUpdate({ updateId: 12, text: "三百", replyToMessageId: sentCount }),
    );

    // 待回收的鍵在驗格式之前就被清掉了，所以錯誤訊息不能邀請使用者「再輸入數字」：
    // 照著重試的數字會變成一筆全新的支出草稿。指引重新開始才是實話。
    const text = getText(calls.at(-1));
    expect(text).toContain("/advances");
    expect(text).not.toContain("請輸入數字");

    await bot.handleUpdate(replyUpdate({ updateId: 13, text: "300", replyToMessageId: sentCount }));

    expect(getText(calls.at(-1))).not.toContain("總金額：TWD 300");
  });

  it("does not let a stale recovery prompt hijack an unrelated plain-number reply", async () => {
    const { bot, calls, counterpartyRef } = harnessWithAdvances();
    await bot.handleUpdate(messageUpdate({ updateId: 10, text: "/advances" }));
    await bot.handleUpdate(callbackUpdate({ updateId: 11, data: `ar:${counterpartyRef}` }));
    const sentCount = sentMessages(calls).length;

    // 回覆到別的訊息，不是那則「收到多少？」的提問。
    await bot.handleUpdate(
      replyUpdate({ updateId: 12, text: "300", replyToMessageId: sentCount - 1 }),
    );

    expect(getText(calls.at(-1))).not.toContain("總金額");
  });

  it("does not let a plain-number amount answer for an unrelated draft steal a pending recovery reply", async () => {
    // 情境：既有一筆待補金額的草稿，也有一則待回覆的代墊回收詢問。
    // 純數字攔截若排在回收 reply 判斷之前，這裡的 300 會被拿去問「要填到哪一筆」。
    const { bot, calls, counterpartyRef } = harnessWithAdvances();
    await bot.handleUpdate(messageUpdate({ updateId: 1, text: "午餐" }));
    await bot.handleUpdate(messageUpdate({ updateId: 10, text: "/advances" }));
    await bot.handleUpdate(callbackUpdate({ updateId: 11, data: `ar:${counterpartyRef}` }));
    const sentCount = sentMessages(calls).length;

    await bot.handleUpdate(replyUpdate({ updateId: 12, text: "300", replyToMessageId: sentCount }));

    const text = getText(calls.at(-1));
    expect(text).not.toContain("要把 300 填到哪一筆");
    expect(text).toContain("總金額：TWD 300");
  });

  it("explains the surplus context when a recovery overpays the outstanding total", async () => {
    // 630 的未回收代墊（400 + 230，日期分別是 09-10、09-11），還 700 會多出 70。
    // 使用者只看到「待補分類」完全不知道 630 已經沖抵了哪幾筆、剩下的 70 才是
    // 要分類的對象，因此追問文案必須把沖抵金額、被沖抵代墊的日期、剩餘待分類
    // 金額都寫清楚，而不能只複誦輸入原文。
    const { bot, calls } = harnessWithAdvances();

    await bot.handleUpdate(messageUpdate({ updateId: 10, text: "小明還 700" }));

    const text = getText(calls.at(-1));
    expect(text).toContain("630");
    expect(text).toContain("70");
    expect(text).toContain("2026-09-10");
    expect(text).toContain("2026-09-11");
    expect(text).not.toContain("待補分類：小明還 700");
  });

  it("confirms before abandoning and reports the amount", async () => {
    const { bot, calls, allocationRef } = harnessWithAdvances();
    await bot.handleUpdate(messageUpdate({ updateId: 10, text: "/advances" }));

    await bot.handleUpdate(callbackUpdate({ updateId: 11, data: `aa:${allocationRef}` }));

    expect(getText(calls.at(-1))).toContain("放棄回收 400");
    expect(JSON.stringify(calls.at(-1)?.payload)).toContain("aa-confirm:");
  });

  it("only abandons after the second confirmation and refreshes the list", async () => {
    const { bot, calls, allocationRef } = harnessWithAdvances();
    await bot.handleUpdate(messageUpdate({ updateId: 10, text: "/advances" }));
    await bot.handleUpdate(callbackUpdate({ updateId: 11, data: `aa:${allocationRef}` }));

    await bot.handleUpdate(callbackUpdate({ updateId: 12, data: `aa-confirm:${allocationRef}` }));

    const edit = calls.at(-1);
    expect(edit?.method).toBe("editMessageText");
    expect(getText(edit)).toContain("未回收 230");
    expect(getText(edit)).not.toContain("400");
  });

  it("keeps the advance untouched when abandonment is cancelled", async () => {
    const { bot, calls, allocationRef } = harnessWithAdvances();
    await bot.handleUpdate(messageUpdate({ updateId: 10, text: "/advances" }));
    await bot.handleUpdate(callbackUpdate({ updateId: 11, data: `aa:${allocationRef}` }));

    await bot.handleUpdate(callbackUpdate({ updateId: 12, data: "cancel-abandon" }));

    expect(getText(calls.at(-1))).toContain("未回收 630");
  });
});

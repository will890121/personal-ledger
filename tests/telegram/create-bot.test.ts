import { describe, expect, it } from "vitest";

import { formatRecentPage } from "../../src/telegram/create-bot.js";
import {
  callbackUpdate as makeCallbackUpdate,
  createHarness,
  getText,
  messageUpdate,
} from "../support/telegram-harness.js";

function callbackUpdate(updateId: number, data: string) {
  return makeCallbackUpdate({ updateId, data });
}

describe("createLedgerBot", () => {
  it("formats recent transactions with numbered accounting and reference details", () => {
    expect(
      formatRecentPage(
        [
          {
            transactionId: "transaction-1",
            draftId: "draft-1",
            ownerId: "123",
            requestId: "request-1",
            sourceEventId: "event-1",
            occurredDate: "2026-09-19",
            amount: { amount: "1015", currency: "TWD" },
            accountFromId: "taishin",
            accountToId: "cathay",
            allocations: [
              {
                allocationId: "transfer",
                fundsEffect: "internal",
                purpose: "transfer",
                amount: { amount: "1000", currency: "TWD" },
                category: "轉帳",
              },
              {
                allocationId: "fee",
                fundsEffect: "outflow",
                purpose: "fee",
                amount: { amount: "15", currency: "TWD" },
                category: "金融費用",
              },
            ],
            confirmedAt: "2026-09-19T00:00:00.000Z",
            status: "confirmed",
          },
        ],
        {
          accounts: [
            {
              accountId: "taishin",
              ownerId: "123",
              name: "台新",
              type: "bank",
              currency: "TWD",
              active: true,
            },
            {
              accountId: "cathay",
              ownerId: "123",
              name: "國泰",
              type: "bank",
              currency: "TWD",
              active: true,
            },
          ],
        },
      ),
    ).toMatchObject({
      text: "交易 1 / 1\n日期：2026-09-19\n總金額：TWD 1015\n帳戶：台新 → 國泰\n配置 1：轉帳・轉帳 · TWD 1000\n配置 2：手續費・金融費用 · TWD 15",
      replyMarkup: {
        inline_keyboard: [
          [{ text: "刪除", callback_data: "delete:transaction-1" }],
          [{ text: "關閉清單", callback_data: "dismiss-recent" }],
        ],
      },
    });
  });

  it("ignores unauthorized and group messages", async () => {
    const { bot, repository } = createHarness();

    await bot.handleUpdate(messageUpdate({ updateId: 1, userId: 999, text: "午餐 120" }));
    await bot.handleUpdate(messageUpdate({ updateId: 2, chatType: "group", text: "午餐 120" }));

    expect(repository.inputEvents.size).toBe(0);
  });

  it("creates one preview when a valid update is redelivered", async () => {
    const { bot, calls, repository } = createHarness();
    const update = messageUpdate({ updateId: 1, text: "午餐 120" });

    await bot.handleUpdate(update);
    await bot.handleUpdate(update);

    expect(repository.drafts.size).toBe(1);
    expect(calls.filter((call) => call.method === "sendMessage")).toHaveLength(2);
    expect(getText(calls[0])).toContain("TWD 120");
  });

  it("confirms idempotently and cancels without creating another transaction", async () => {
    const { bot, repository } = createHarness();
    await bot.handleUpdate(messageUpdate({ updateId: 1, text: "午餐 120" }));
    const draftId = [...repository.drafts.keys()][0];
    expect(draftId).toBeDefined();

    await bot.handleUpdate(callbackUpdate(2, `confirm:${draftId ?? ""}`));
    await bot.handleUpdate(callbackUpdate(3, `confirm:${draftId ?? ""}`));

    expect(repository.transactions.size).toBe(1);

    const secondHarness = createHarness();
    await secondHarness.bot.handleUpdate(messageUpdate({ updateId: 4, text: "午餐 120" }));
    const cancellableId = [...secondHarness.repository.drafts.keys()][0];
    await secondHarness.bot.handleUpdate(callbackUpdate(5, `cancel:${cancellableId ?? ""}`));
    expect(secondHarness.repository.transactions.size).toBe(0);
  });

  it("reports an empty recent list", async () => {
    const { bot, calls } = createHarness();

    await bot.handleUpdate(messageUpdate({ updateId: 1, text: "/recent" }));

    expect(calls.map(getText)).toContain("尚無已確認交易。");
  });

  it("reports today and month summaries", async () => {
    const { bot, calls } = createHarness();
    await bot.handleUpdate(messageUpdate({ updateId: 1, text: "/today" }));
    await bot.handleUpdate(messageUpdate({ updateId: 2, text: "/month" }));
    expect(calls.map(getText)).toContainEqual(expect.stringContaining("今日摘要"));
    expect(calls.map(getText)).toContainEqual(expect.stringContaining("本月摘要"));
  });

  it("requires confirmation, then records a callback event and soft-deletes only once", async () => {
    const { bot, repository } = createHarness();
    await bot.handleUpdate(messageUpdate({ updateId: 1, text: "午餐 120" }));
    const draftId = [...repository.drafts.keys()][0] ?? "";
    await bot.handleUpdate(callbackUpdate(2, `confirm:${draftId}`));
    const transaction = [...repository.transactions.values()][0];
    expect(transaction).toBeDefined();
    await bot.handleUpdate(callbackUpdate(3, `delete:${transaction?.transactionId ?? ""}`));
    await expect(
      repository.getTransaction("123", transaction?.transactionId ?? ""),
    ).resolves.toMatchObject({ status: "confirmed" });
    await bot.handleUpdate(callbackUpdate(4, `delete-confirm:${transaction?.transactionId ?? ""}`));
    await bot.handleUpdate(callbackUpdate(4, `delete-confirm:${transaction?.transactionId ?? ""}`));
    await expect(
      repository.getTransaction("123", transaction?.transactionId ?? ""),
    ).resolves.toMatchObject({ status: "deleted" });
    expect(repository.inputEvents.size).toBe(2);
  });

  it("creates a confirmable refund draft from a recent transaction", async () => {
    const { bot, calls, repository } = createHarness();
    await bot.handleUpdate(messageUpdate({ updateId: 1, text: "午餐 120" }));
    const expenseDraftId = [...repository.drafts.keys()][0] ?? "";
    await bot.handleUpdate(callbackUpdate(2, `confirm:${expenseDraftId}`));
    const expense = [...repository.transactions.values()][0];
    expect(expense).toBeDefined();

    await bot.handleUpdate(messageUpdate({ updateId: 3, text: "/recent" }));
    await bot.handleUpdate(callbackUpdate(4, `refund:${expense?.transactionId ?? ""}`));

    const refundDraft = [...repository.drafts.values()].find(
      (item) => item.refundTargetTransactionId === expense?.transactionId,
    );
    expect(refundDraft).toMatchObject({
      amount: { amount: "120" },
      allocations: [{ fundsEffect: "inflow", purpose: "refund" }],
      status: "awaiting_confirmation",
    });
    expect(calls.map(getText)).toContainEqual(expect.stringContaining("退款原交易"));
  });
});

import type { Transformer } from "grammy";
import type { Update } from "grammy/types";
import { describe, expect, it } from "vitest";

import { createLedgerBot } from "../../src/telegram/create-bot.js";
import { summarizeAllocations } from "../../src/domain/ledger-summary.js";
import { FakeLedgerRepository } from "../support/fake-ledger-repository.js";
import { FakeReferenceRepository } from "../support/fake-reference-repository.js";

interface ApiCall {
  readonly method: string;
  readonly payload: unknown;
}

function getText(call: ApiCall | undefined): string | undefined {
  if (!call || typeof call.payload !== "object" || call.payload === null) return undefined;
  if (!("text" in call.payload) || typeof call.payload.text !== "string") return undefined;
  return call.payload.text;
}

function createHarness() {
  const repository = new FakeLedgerRepository();
  const calls: ApiCall[] = [];
  let nextId = 0;
  const bot = createLedgerBot({
    token: "123456:test-token",
    ownerId: "123",
    repository,
    referenceRepository: new FakeReferenceRepository(),
    summaryRepository: { summarize: () => Promise.resolve(summarizeAllocations([])) },
    generateId: () => `id-${String(++nextId)}`,
    now: () => new Date("2026-09-18T01:00:00.000Z"),
    today: () => "2026-09-18",
    botInfo: {
      id: 1,
      is_bot: true,
      first_name: "Ledger Bot",
      username: "ledger_bot",
      can_join_groups: false,
      can_read_all_group_messages: false,
      supports_inline_queries: false,
      can_connect_to_business: false,
      has_main_web_app: false,
      has_topics_enabled: false,
      allows_users_to_create_topics: false,
      can_manage_bots: false,
      supports_join_request_queries: false,
    },
  });
  const capture: Transformer = (_previous, method, payload) => {
    calls.push({ method, payload });
    return Promise.resolve({ ok: true, result: true } as never);
  };
  bot.api.config.use(capture);
  return { bot, calls, repository };
}

function messageUpdate(options: {
  updateId: number;
  userId?: number;
  chatType?: "private" | "group";
  text: string;
}): Update {
  const userId = options.userId ?? 123;
  const chatType = options.chatType ?? "private";
  const chat =
    chatType === "private"
      ? { id: userId, type: "private" as const, first_name: "Owner" }
      : { id: -100, type: "group" as const, title: "Ledger Test Group" };
  return {
    update_id: options.updateId,
    message: {
      message_id: options.updateId,
      date: 1_758_157_200,
      chat,
      from: { id: userId, is_bot: false as const, first_name: "Owner" },
      text: options.text,
      ...(options.text.startsWith("/")
        ? { entities: [{ type: "bot_command" as const, offset: 0, length: options.text.length }] }
        : {}),
    },
  };
}

function callbackUpdate(updateId: number, data: string): Update {
  return {
    update_id: updateId,
    callback_query: {
      id: `callback-${String(updateId)}`,
      chat_instance: "instance-1",
      from: { id: 123, is_bot: false as const, first_name: "Owner" },
      data,
      message: {
        message_id: 10,
        date: 1_758_157_200,
        chat: { id: 123, type: "private" as const, first_name: "Owner" },
        text: "preview",
      },
    },
  };
}

describe("createLedgerBot", () => {
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

  it("records a callback event and soft-deletes only once", async () => {
    const { bot, repository } = createHarness();
    await bot.handleUpdate(messageUpdate({ updateId: 1, text: "午餐 120" }));
    const draftId = [...repository.drafts.keys()][0] ?? "";
    await bot.handleUpdate(callbackUpdate(2, `confirm:${draftId}`));
    const transaction = [...repository.transactions.values()][0];
    expect(transaction).toBeDefined();
    await bot.handleUpdate(callbackUpdate(3, `delete:${transaction?.transactionId ?? ""}`));
    await bot.handleUpdate(callbackUpdate(3, `delete:${transaction?.transactionId ?? ""}`));
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

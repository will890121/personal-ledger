import type { Transformer } from "grammy";
import type { Update } from "grammy/types";
import { describe, expect, it } from "vitest";

import { createLedgerBot } from "../../src/telegram/create-bot.js";
import { FakeLedgerRepository } from "../support/fake-ledger-repository.js";

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
    generateId: () => `id-${String(++nextId)}`,
    now: () => new Date("2026-09-18T01:00:00.000Z"),
    today: () => "2026-09-18",
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
});

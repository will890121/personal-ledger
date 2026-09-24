import type { Transformer } from "grammy";
import type { Update } from "grammy/types";

import { createLedgerBot } from "../../src/telegram/create-bot.js";
import { summarizeAllocations } from "../../src/domain/ledger-summary.js";
import { FakeLedgerRepository } from "./fake-ledger-repository.js";
import { FakeReferenceRepository } from "./fake-reference-repository.js";

export interface ApiCall {
  readonly method: string;
  readonly payload: unknown;
}

export function getText(call: ApiCall | undefined): string | undefined {
  if (!call || typeof call.payload !== "object" || call.payload === null) return undefined;
  if (!("text" in call.payload) || typeof call.payload.text !== "string") return undefined;
  return call.payload.text;
}

export function sentMessages(calls: readonly ApiCall[]): ApiCall[] {
  return calls.filter((call) => call.method === "sendMessage");
}

export function lastSentMessageId(calls: readonly ApiCall[]): number {
  return sentMessages(calls).length;
}

export function firstDraftRef(repository: FakeLedgerRepository): string {
  const record = [...repository.records.values()][0];
  if (!record) throw new Error("no draft recorded");
  return record.draftRef;
}

export interface HarnessOptions {
  readonly today?: string;
  readonly now?: Date;
  /** 模擬 Telegram 拒絕刪除訊息（例如超過 48 小時）。 */
  readonly failDeleteMessage?: boolean;
}

export function createHarness(options: HarnessOptions = {}) {
  const repository = new FakeLedgerRepository();
  const referenceRepository = new FakeReferenceRepository();
  const calls: ApiCall[] = [];
  let nextId = 0;
  let nextMessageId = 0;
  const bot = createLedgerBot({
    token: "123456:test-token",
    ownerId: "123",
    repository,
    referenceRepository,
    summaryRepository: { summarize: () => Promise.resolve(summarizeAllocations([])) },
    generateId: () => `id-${String(++nextId)}`,
    now: () => options.now ?? new Date("2026-09-18T01:00:00.000Z"),
    today: () => options.today ?? "2026-09-18",
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
    if (method === "deleteMessage" && options.failDeleteMessage === true) {
      return Promise.reject(new Error("message can't be deleted"));
    }
    if (method === "sendMessage") {
      nextMessageId += 1;
      return Promise.resolve({
        ok: true,
        result: {
          message_id: nextMessageId,
          date: 1_758_157_200,
          chat: { id: 123, type: "private", first_name: "Owner" },
        },
      } as never);
    }
    return Promise.resolve({ ok: true, result: true } as never);
  };
  bot.api.config.use(capture);
  return { bot, calls, repository, referenceRepository };
}

export function messageUpdate(options: {
  updateId: number;
  userId?: number;
  chatType?: "private" | "group";
  text: string;
  replyToMessageId?: number;
}): Update {
  const userId = options.userId ?? 123;
  const chatType = options.chatType ?? "private";
  const chat =
    chatType === "private"
      ? { id: userId, type: "private" as const, first_name: "Owner" }
      : { id: -100, type: "group" as const, title: "Ledger Test Group" };
  // Telegram 的 reply_to_message 型別是遞迴的，測試替身不需要完整建模，
  // 因此在這裡做一次結構斷言。
  const update = {
    update_id: options.updateId,
    message: {
      message_id: options.updateId,
      date: 1_758_157_200,
      chat,
      from: { id: userId, is_bot: false as const, first_name: "Owner" },
      text: options.text,
      ...(options.replyToMessageId !== undefined
        ? {
            reply_to_message: {
              message_id: options.replyToMessageId,
              date: 1_758_157_200,
              chat,
            },
          }
        : {}),
      ...(options.text.startsWith("/")
        ? { entities: [{ type: "bot_command" as const, offset: 0, length: options.text.length }] }
        : {}),
    },
  };
  return update as unknown as Update;
}

export function replyUpdate(options: {
  updateId: number;
  text: string;
  replyToMessageId: number;
}): Update {
  return messageUpdate(options);
}

export function callbackUpdate(options: { updateId: number; data: string }): Update {
  return {
    update_id: options.updateId,
    callback_query: {
      id: `callback-${String(options.updateId)}`,
      chat_instance: "instance-1",
      from: { id: 123, is_bot: false as const, first_name: "Owner" },
      data: options.data,
      message: {
        message_id: 10,
        date: 1_758_157_200,
        chat: { id: 123, type: "private" as const, first_name: "Owner" },
        text: "preview",
      },
    },
  };
}

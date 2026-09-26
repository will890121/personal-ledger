import type { Bot } from "grammy";
import type { Update } from "grammy/types";
import { afterEach, describe, expect, it, vi } from "vitest";

import { callbackUpdate, createHarness, messageUpdate } from "../support/telegram-harness.js";

// 輪詢實際走的是 Bot#handleUpdates：handleUpdate 一律往外丟 BotError，
// 只有 handleUpdates 會把錯誤交給 bot.catch，並決定要不要停止輪詢。
// grammy 把它標為 private（僅型別層面），而這裡要驗證的正是輪詢行為，
// 因此用一個只露出該方法的窄介面轉型，不動到執行期行為。
interface PollingBot {
  handleUpdates(updates: readonly Update[]): Promise<void>;
}

function asPollingBot(bot: Bot): PollingBot {
  return bot as unknown as PollingBot;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("bot error handling", () => {
  it("keeps polling and answers the user when a handler throws", async () => {
    const { bot, calls, repository } = createHarness();
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const stop = vi.spyOn(bot, "stop");
    // 模擬需要資料庫的 callback 在真實環境失敗。
    repository.getSetting = () => Promise.reject(new Error("database is unavailable"));

    await expect(
      asPollingBot(bot).handleUpdates([callbackUpdate({ updateId: 1, data: "aa:0123abcd" })]),
    ).resolves.toBeUndefined();

    expect(stop).not.toHaveBeenCalled();
    // 使用者必須收到回應，Telegram 端才不會一直轉圈；不斷言文字內容。
    expect(calls.some((call) => call.method === "answerCallbackQuery")).toBe(true);
    expect(logged).toHaveBeenCalled();
    expect(logged.mock.calls.map((call) => JSON.stringify(call)).join("\n")).not.toContain(
      "No error handler was set!",
    );
  });

  it("keeps serving later updates after a failing one", async () => {
    const { bot, calls, repository } = createHarness();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const healthy = repository.getSetting.bind(repository);
    repository.getSetting = () => Promise.reject(new Error("database is unavailable"));

    await asPollingBot(bot).handleUpdates([callbackUpdate({ updateId: 1, data: "aa:0123abcd" })]);
    repository.getSetting = healthy;
    await asPollingBot(bot).handleUpdates([messageUpdate({ updateId: 2, text: "午餐 120" })]);

    expect(calls.some((call) => call.method === "sendMessage")).toBe(true);
  });

  it("never logs the bot token or the owner id", async () => {
    const { bot, repository } = createHarness();
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    repository.getSetting = () => Promise.reject(new Error("database is unavailable"));

    await asPollingBot(bot).handleUpdates([callbackUpdate({ updateId: 1, data: "aa:0123abcd" })]);

    const output = logged.mock.calls.map((call) => JSON.stringify(call)).join("\n");
    expect(output).not.toContain("test-token");
    expect(output).not.toMatch(/"(from|chat|ownerId)"/);
  });
});

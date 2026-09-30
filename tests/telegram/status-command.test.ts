import { describe, expect, it } from "vitest";

import type { FakeLedgerRepository } from "../support/fake-ledger-repository.js";
import {
  callbackUpdate,
  createHarness as harness,
  getText,
  messageUpdate,
} from "../support/telegram-harness.js";

// 放棄遞送的那一列：attempts=4（送了 5 次，最後 4 次都在重試），與
// format-status.ts 的「印 attempts 本身，不加一」對齊。text 內含真實交易內容
// （金額、"已入帳"），用來斷言錯誤行絕對不會外洩這些財務資料。
async function seedStuck(repository: FakeLedgerRepository): Promise<void> {
  repository.seedOutboxMessage({
    messageId: "stuck",
    ownerId: "123",
    cause: "transaction_confirmed",
    chatId: "123",
    text: "已入帳：午餐 120",
    nextAttemptAt: "2026-09-18T00:55:00.000Z",
    attempts: 4,
  });
  await repository.markOutboxNeedsAttention("stuck", "Bad Gateway", null);
}

// 已成功遞送的一列，deliveredAt 指定為呼叫端傳入的時刻——用來驗證 /status 是否
// 把它換算成設定時區的時分，而不是原樣印出 ISO 字串裡的 UTC 時分。
async function seedDelivered(repository: FakeLedgerRepository, deliveredAt: string): Promise<void> {
  repository.seedOutboxMessage({
    messageId: "delivered",
    ownerId: "123",
    cause: "transaction_confirmed",
    chatId: "123",
    text: "已入帳：午餐 120",
    nextAttemptAt: deliveredAt,
  });
  await repository.markOutboxDelivered("delivered", deliveredAt, null);
}

function pendingCount(repository: FakeLedgerRepository): Promise<number> {
  return Promise.resolve(
    [...repository.outboxMessages.values()].filter((row) => row.status === "pending").length,
  );
}

function deliveredCount(repository: FakeLedgerRepository): Promise<number> {
  return Promise.resolve(
    [...repository.outboxMessages.values()].filter((row) => row.status === "delivered").length,
  );
}

function attemptsOf(repository: FakeLedgerRepository, messageId: string): Promise<number> {
  const row = repository.outboxMessages.get(messageId);
  if (!row) throw new Error(`no such outbox message: ${messageId}`);
  return Promise.resolve(row.attempts);
}

describe("/status", () => {
  it("reports a healthy queue", async () => {
    const { bot, calls } = harness();

    await bot.handleUpdate(messageUpdate({ updateId: 1, text: "/status" }));

    const text = getText(calls.at(-1)) ?? "";
    expect(text).toContain("待送 0 筆");
    expect(text).toContain("schema 版本：8");
  });

  it("lists what is stuck and offers a way back", async () => {
    const { bot, calls, repository } = harness();
    await seedStuck(repository);

    await bot.handleUpdate(messageUpdate({ updateId: 1, text: "/status" }));

    const payload = JSON.stringify(calls.at(-1)?.payload);
    expect(getText(calls.at(-1))).toContain("待處理 1 筆");
    // 與其他五支清單指令一致。
    expect(payload).toContain('"text":"重試全部"');
    expect(payload).toContain('"text":"關閉清單"');
  });

  it("puts stuck messages back in the queue and drains them", async () => {
    // 少了這條，一次暫時性斷線耗盡重試之後那則訊息就永遠卡著。
    const { bot, repository } = harness();
    await seedStuck(repository);

    await bot.handleUpdate(messageUpdate({ updateId: 1, text: "/status" }));
    await bot.handleUpdate(callbackUpdate({ updateId: 2, data: "outbox-retry" }));

    await expect(pendingCount(repository)).resolves.toBe(0);
    await expect(deliveredCount(repository)).resolves.toBe(1);
    // attempts 必須歸零。既有的 sqlite-outbox 測試 seed 的列本來就是 0，分不出
    // 「重設為 0」與「原封不動」——審查時把 UPDATE 裡的 attempts = 0 拿掉，整套仍全綠。
    await expect(attemptsOf(repository, "stuck")).resolves.toBe(0);
  });

  it("answers the callback query before it starts draining", async () => {
    // m1：drain 最多是 10 次循序的 Telegram 呼叫，而「重試全部」存在的唯一理由就是
    // Telegram 半通不通。先 drain 再回答，很容易超過 callback 約 15 秒的回答窗口：
    // 按鈕一直轉圈，最後 grammY 拋 query is too old、使用者看到「操作失敗」，
    // 但重試其實已經做了。本分支另外四個會觸發 outbox 的 handler 都是先回答再 drain。
    const { bot, calls, repository } = harness();
    await seedStuck(repository);

    await bot.handleUpdate(callbackUpdate({ updateId: 1, data: "outbox-retry" }));

    const methods = calls.map((call) => call.method);
    const answeredAt = methods.indexOf("answerCallbackQuery");
    const firstDeliveryAt = methods.findIndex(
      (method) => method === "sendMessage" || method === "editMessageText",
    );
    expect(answeredAt).toBeGreaterThanOrEqual(0);
    expect(firstDeliveryAt).toBeGreaterThanOrEqual(0);
    expect(answeredAt).toBeLessThan(firstDeliveryAt);
  });

  it("prints the attempt count verbatim and nothing else on the error line", async () => {
    // 這兩條是本 task 著墨最多的語意，卻也最容易被一個字元改掉：attempts 印成 attempts+1，
    // 或在錯誤行後面接上訊息內容。審查時實測，兩種改法整套 446 條測試都不會紅。
    const { bot, calls, repository } = harness();
    await seedStuck(repository); // attempts: 4、text 內含「已入帳：午餐 120」

    await bot.handleUpdate(messageUpdate({ updateId: 1, text: "/status" }));

    const text = getText(calls.at(-1)) ?? "";
    expect(text).toContain("已重試 4 次");
    // 錯誤行只放 Telegram 自己的描述，不得夾帶金額、分類或原文。
    expect(text).not.toContain("已入帳");
    expect(text).not.toContain("120");
  });

  it("shows times in the configured timezone, not UTC", async () => {
    // /status 的用途是判斷遞送有沒有卡住；差八小時的時間戳會讓使用者以為卡住了。
    const { bot, calls, repository } = harness(); // 時區固定為 Asia/Taipei
    await seedDelivered(repository, "2026-09-30T06:32:00.000Z");

    await bot.handleUpdate(messageUpdate({ updateId: 1, text: "/status" }));

    expect(getText(calls.at(-1))).toContain("14:32");
  });

  it("hides the retry button when nothing is stuck", async () => {
    const { bot, calls } = harness();

    await bot.handleUpdate(messageUpdate({ updateId: 1, text: "/status" }));

    expect(JSON.stringify(calls.at(-1)?.payload)).not.toContain("重試全部");
  });
});

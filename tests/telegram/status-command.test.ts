import { describe, expect, it } from "vitest";

import type { FakeLedgerRepository } from "../support/fake-ledger-repository.js";
import {
  callbackUpdate,
  createHarness as harness,
  getText,
  messageUpdate,
} from "../support/telegram-harness.js";

// 放棄遞送的那一列：attempts=4（送了 5 次，最後 4 次都在重試），與
// format-status.ts 的「印 attempts 本身，不加一」對齊。
async function seedStuck(repository: FakeLedgerRepository): Promise<void> {
  repository.seedOutboxMessage({
    messageId: "stuck-1",
    ownerId: "123",
    cause: "transaction_confirmed",
    chatId: "123",
    text: "已入帳：午餐 120",
    nextAttemptAt: "2026-09-18T00:55:00.000Z",
    attempts: 4,
  });
  await repository.markOutboxNeedsAttention("stuck-1", "Bad Gateway");
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
  });

  it("hides the retry button when nothing is stuck", async () => {
    const { bot, calls } = harness();

    await bot.handleUpdate(messageUpdate({ updateId: 1, text: "/status" }));

    expect(JSON.stringify(calls.at(-1)?.payload)).not.toContain("重試全部");
  });
});

import { describe, expect, it } from "vitest";

import { completeLunchDraft } from "../fixtures/drafts.js";
import { callbackUpdate, createHarness, getText } from "../support/telegram-harness.js";
import type { FakeLedgerRepository } from "../support/fake-ledger-repository.js";

/**
 * 這個 harness 疊了一層在 createHarness 之上，只為了兩件事：
 * 1. 把時鐘做成可以推進的閉包——退避重試（backoffMs）是真的要看到時間往前走，
 *    固定的 now() 永遠等於「還沒到」，drainOnce() 撈不到那一列。
 * 2. 把 deliveryControl 換個名字叫 api，貼合這個檔案關心的問題：
 *    「Telegram 這條管道通不通」，跟 outbox runner 本身的重試邏輯無關。
 */
function harness(options: { failDelivery?: boolean } = {}) {
  let clock = new Date("2026-09-18T01:00:00.000Z");
  const created = createHarness({
    now: () => clock,
    ...(options.failDelivery !== undefined ? { failDelivery: options.failDelivery } : {}),
  });
  return {
    ...created,
    api: created.deliveryControl,
    advance: (ms: number): void => {
      clock = new Date(clock.getTime() + ms);
    },
  };
}

async function seedConfirmableDraft(
  repository: FakeLedgerRepository,
  draftId: string,
): Promise<void> {
  // completeLunchDraft 直接落成 awaiting_confirmation 狀態的草稿，略過整段
  // 建立草稿的訊息往返——這個檔案只關心「確認之後」，不是「怎麼問出這筆草稿」。
  await repository.saveDraft(
    completeLunchDraft({ draftId, ownerId: "123", requestId: `request-${draftId}` }),
  );
}

// 兩個都是同步查表；仍回傳 Promise 是為了讓呼叫端的 `await outboxStatus(...)`
// 讀起來像是在問 repository（之後若換成真的 SQLite repository 也不必改呼叫端）。
function outboxStatus(repository: FakeLedgerRepository): Promise<string | undefined> {
  return Promise.resolve([...repository.outboxMessages.values()][0]?.status);
}

function transactionCount(repository: FakeLedgerRepository): Promise<number> {
  return Promise.resolve(repository.transactions.size);
}

describe("confirming a draft", () => {
  it("still replies immediately when Telegram is healthy", async () => {
    const { bot, calls, repository } = harness();
    await seedConfirmableDraft(repository, "draft-1");

    await bot.handleUpdate(callbackUpdate({ updateId: 1, data: "confirm:draft-1" }));

    // 訊息只能有一個真相來源：如果 handler 自己又送了一次（例如重新長出一個
    // editMessageText），這裡要抓到，而不是只看最後一則訊息長什麼樣子。
    const deliveries = calls.filter(
      (call) => call.method === "sendMessage" || call.method === "editMessageText",
    );
    expect(deliveries).toHaveLength(1);
    expect(getText(calls.at(-1))).toContain("已入帳");
    expect(await outboxStatus(repository)).toBe("delivered");
  });

  it("keeps the transaction and queues the message when delivery throws", async () => {
    // AC-20：帳已經記了，訊息稍後補送。
    const { bot, repository } = harness({ failDelivery: true });
    await seedConfirmableDraft(repository, "draft-1");

    await bot.handleUpdate(callbackUpdate({ updateId: 1, data: "confirm:draft-1" }));

    expect(await transactionCount(repository)).toBe(1);
    expect(await outboxStatus(repository)).toBe("pending");
  });

  it("delivers the queued message on the next drain", async () => {
    const { bot, repository, runner, api, advance } = harness({ failDelivery: true });
    await seedConfirmableDraft(repository, "draft-1");

    await bot.handleUpdate(callbackUpdate({ updateId: 1, data: "confirm:draft-1" }));
    api.failing = false;
    // 第一次失敗已經把 nextAttemptAt 退避到 5 秒後（backoffMs(1)）；沒有真的
    // 推進時鐘，claimDueOutbox 永遠會覺得「還沒到」。
    advance(6_000);

    await runner.drainOnce();

    expect(await outboxStatus(repository)).toBe("delivered");
  });
});

import { describe, expect, it, vi, type Mock } from "vitest";

import type { OutboxMessage } from "../../src/domain/outbox.js";
import {
  createAttentionNotifier,
  type AttentionNotifierApi,
} from "../../src/telegram/notify-attention.js";
import { FakeLedgerRepository } from "../support/fake-ledger-repository.js";

const OWNER_ID = "55";
const CHAT_ID = "55";
const INITIAL_NOW = "2026-09-30T00:00:00.000Z";

type MockedApi = { sendMessage: Mock<AttentionNotifierApi["sendMessage"]> };

function harness(): {
  notify: (message: OutboxMessage) => Promise<void>;
  api: MockedApi;
  repository: FakeLedgerRepository;
  advance: (ms: number) => void;
} {
  const repository = new FakeLedgerRepository();
  let currentMs = Date.parse(INITIAL_NOW);
  const advance = (ms: number): void => {
    currentMs += ms;
  };

  const api: MockedApi = {
    sendMessage: vi.fn<AttentionNotifierApi["sendMessage"]>().mockResolvedValue(undefined),
  };

  const notify = createAttentionNotifier({
    repository,
    ownerId: OWNER_ID,
    api,
    now: () => new Date(currentMs),
  });

  return { notify, api, repository, advance };
}

// 放棄的那一列不需要完整還原——通知只用得到 chatId，內容特意保持與財務資料無關。
function stuckMessage(overrides: Partial<OutboxMessage> = {}): OutboxMessage {
  return {
    messageId: "m1",
    ownerId: OWNER_ID,
    cause: "transaction_confirmed",
    status: "needs_attention",
    chatId: CHAT_ID,
    text: "已入帳：午餐 120",
    attempts: 4,
    nextAttemptAt: INITIAL_NOW,
    lastError: "Bad Gateway",
    ...overrides,
  };
}

describe("attention notifier", () => {
  it("tells the owner once when a message gives up", async () => {
    const { notify, api } = harness();

    await notify(stuckMessage());

    expect(api.sendMessage).toHaveBeenCalledOnce();
    expect(api.sendMessage.mock.calls[0]?.[1]).toContain("有訊息送不出去");
  });

  it("stays quiet for ten minutes after the first alert", async () => {
    // 一次連環失敗不該洗版。
    const { notify, api, advance } = harness();
    await notify(stuckMessage());

    advance(9 * 60_000);
    await notify(stuckMessage());

    expect(api.sendMessage).toHaveBeenCalledOnce();
  });

  it("alerts again once the throttle window has passed", async () => {
    const { notify, api, advance } = harness();
    await notify(stuckMessage());

    advance(11 * 60_000);
    await notify(stuckMessage());

    expect(api.sendMessage).toHaveBeenCalledTimes(2);
  });

  it("swallows its own failure instead of throwing", async () => {
    // 正在壞掉的就是 Telegram 這條管道，通知本來就可能送不出去。丟例外會讓
    // drainOnce 整批中斷，後面的列連試都沒試到。
    const { notify, api } = harness();
    api.sendMessage.mockRejectedValue(new Error("network down"));

    await expect(notify(stuckMessage())).resolves.toBeUndefined();
  });
});

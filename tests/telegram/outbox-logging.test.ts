import { GrammyError } from "grammy";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";

import { MAX_ATTEMPTS, type OutboxCause, type OutboxStatus } from "../../src/domain/outbox.js";
import type { OutboxMessage } from "../../src/domain/outbox.js";
import { logger } from "../../src/logger.js";
import {
  createOutboxRunner,
  type OutboxApi,
  type OutboxRunnerDependencies,
} from "../../src/telegram/outbox-runner.js";
import {
  createAttentionNotifier,
  type AttentionNotifierApi,
} from "../../src/telegram/notify-attention.js";
import { FakeLedgerRepository } from "../support/fake-ledger-repository.js";

// 收掉 docs/todo/outbox-delivery-logging.md：這份 todo 的完成標準是「拔掉任何一行
// 新增的日誌，都要有測試變紅」——本檔案逐行釘住 outbox 這條管線新增的三個事件。

const OWNER_ID = "55";
const CHAT_ID = "55";
const INITIAL_NOW = "2026-09-30T00:00:00.000Z";

type MockedOutboxApi = {
  sendMessage: Mock<OutboxApi["sendMessage"]>;
  editMessageText: Mock<OutboxApi["editMessageText"]>;
};

function grammyError(
  errorCode: number,
  description: string,
  parameters: Record<string, unknown> = {},
): GrammyError {
  return new GrammyError(
    "Call to 'sendMessage' failed!",
    { ok: false, error_code: errorCode, description, parameters },
    "sendMessage",
    {},
  );
}

function runnerHarness(): {
  runner: ReturnType<typeof createOutboxRunner>;
  repository: FakeLedgerRepository;
  api: MockedOutboxApi;
} {
  const repository = new FakeLedgerRepository();
  const currentMs = Date.parse(INITIAL_NOW);

  const api: MockedOutboxApi = {
    sendMessage: vi.fn<OutboxApi["sendMessage"]>().mockResolvedValue({ message_id: 999 }),
    editMessageText: vi.fn<OutboxApi["editMessageText"]>().mockResolvedValue(undefined),
  };
  const onNeedsAttention = vi
    .fn<OutboxRunnerDependencies["onNeedsAttention"]>()
    .mockResolvedValue(undefined);

  const runner = createOutboxRunner({
    repository,
    ownerId: OWNER_ID,
    api,
    now: () => new Date(currentMs),
    onNeedsAttention,
  });

  return { runner, repository, api };
}

function enqueue(
  repository: FakeLedgerRepository,
  overrides: {
    messageId: string;
    attempts?: number;
    cause?: OutboxCause;
    status?: OutboxStatus;
  },
): void {
  repository.seedOutboxMessage({
    messageId: overrides.messageId,
    ownerId: OWNER_ID,
    cause: overrides.cause ?? "transaction_confirmed",
    chatId: CHAT_ID,
    text: "已入帳",
    nextAttemptAt: INITIAL_NOW,
    ...(overrides.attempts !== undefined ? { attempts: overrides.attempts } : {}),
  });
}

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

afterEach(() => {
  vi.restoreAllMocks();
});

describe("outbox runner logging", () => {
  it("logs an info line with messageId, attempts and delayMs when a send fails and backoff is scheduled", async () => {
    const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => undefined);
    const { runner, api, repository } = runnerHarness();
    api.sendMessage.mockRejectedValueOnce(grammyError(502, "Bad Gateway"));
    enqueue(repository, { messageId: "m1" });

    await runner.drainOnce();

    expect(infoSpy).toHaveBeenCalledWith(
      "outbox delivery failed; backoff scheduled",
      expect.objectContaining({
        messageId: "m1",
        attempts: 1,
        delayMs: expect.any(Number) as number,
      }),
    );
  });

  it("logs a warn line with messageId and attempts when the retry cap is exhausted", async () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const { runner, api, repository } = runnerHarness();
    api.sendMessage.mockRejectedValueOnce(grammyError(502, "Bad Gateway"));
    enqueue(repository, { messageId: "m1", attempts: MAX_ATTEMPTS - 1 });

    await runner.drainOnce();

    expect(warnSpy).toHaveBeenCalledWith(
      "outbox exhausted its retry cap; moved to needs_attention",
      expect.objectContaining({ messageId: "m1", attempts: MAX_ATTEMPTS }),
    );
  });

  it("logs a warn line when a delivery is abandoned outright (give-up), not just when the cap is exhausted", async () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const { runner, api, repository } = runnerHarness();
    api.sendMessage.mockRejectedValueOnce(
      grammyError(403, "Forbidden: bot was blocked by the user"),
    );
    enqueue(repository, { messageId: "m1" });

    await runner.drainOnce();

    expect(warnSpy).toHaveBeenCalledWith(
      "outbox delivery abandoned; moved to needs_attention",
      expect.objectContaining({ messageId: "m1" }),
    );
  });
});

describe("notify-attention logging", () => {
  it("logs a warn line when the alert itself fails to send", async () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const repository = new FakeLedgerRepository();
    const api: { sendMessage: Mock<AttentionNotifierApi["sendMessage"]> } = {
      sendMessage: vi
        .fn<AttentionNotifierApi["sendMessage"]>()
        .mockRejectedValue(new Error("network down")),
    };
    const notify = createAttentionNotifier({
      repository,
      ownerId: OWNER_ID,
      api,
      now: () => new Date(Date.parse(INITIAL_NOW)),
    });

    await notify(stuckMessage());

    expect(warnSpy).toHaveBeenCalledWith(
      "notify-attention failed to send its own alert",
      expect.objectContaining({ messageId: "m1", chatId: CHAT_ID }),
    );
  });

  it("never prints the raw chat id when the alert failure is actually logged (not mocked out)", async () => {
    // logger.warn 這次不 mock 掉——真的走到 console.warn，確認 chatId 這個鍵名
    // 真的會被 src/logger.ts 的 OWNER_IDENTIFYING_FIELDS 規則雜湊掉，而不是
    // 只在呼叫端的物件字面量裡看起來安全。
    const lines: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      lines.push(
        args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "),
      );
    });
    const repository = new FakeLedgerRepository();
    const api: { sendMessage: Mock<AttentionNotifierApi["sendMessage"]> } = {
      sendMessage: vi
        .fn<AttentionNotifierApi["sendMessage"]>()
        .mockRejectedValue(new Error("network down")),
    };
    const notify = createAttentionNotifier({
      repository,
      ownerId: OWNER_ID,
      api,
      now: () => new Date(Date.parse(INITIAL_NOW)),
    });

    await notify(stuckMessage({ chatId: "729367170" }));

    expect(lines.join("\n")).not.toContain("729367170");
  });
});

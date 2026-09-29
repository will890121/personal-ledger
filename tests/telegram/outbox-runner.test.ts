import { GrammyError } from "grammy";
import { describe, expect, it, vi, type Mock } from "vitest";

import type { OutboxCause, OutboxStatus } from "../../src/domain/outbox.js";
import {
  createOutboxRunner,
  type OutboxApi,
  type OutboxRunnerDependencies,
} from "../../src/telegram/outbox-runner.js";
import { FakeLedgerRepository } from "../support/fake-ledger-repository.js";

const OWNER_ID = "55";
const CHAT_ID = "55";
// 也是 leaseExpiresAt 那個測試案例裡「過期 lease」的時間戳——同一個常數，
// 代表 harness 的時鐘一開始就落在那個時間點上。
const INITIAL_NOW = "2026-09-30T00:00:00.000Z";

type MockedOutboxApi = {
  sendMessage: Mock<OutboxApi["sendMessage"]>;
  editMessageText: Mock<OutboxApi["editMessageText"]>;
};

// api 額外用一個模組層級變數保存，因為部分測試不透過 harness() 的回傳值
// 取用它，而是直接引用這個變數（每次呼叫 harness() 都會重新指派）。
let api: MockedOutboxApi;

function harness(): {
  runner: ReturnType<typeof createOutboxRunner>;
  repository: FakeLedgerRepository;
  api: MockedOutboxApi;
  onNeedsAttention: Mock<OutboxRunnerDependencies["onNeedsAttention"]>;
  clock: { getTime: () => number };
  advance: (ms: number) => void;
} {
  const repository = new FakeLedgerRepository();
  let currentMs = Date.parse(INITIAL_NOW);
  const clock = { getTime: () => currentMs };
  const advance = (ms: number): void => {
    currentMs += ms;
  };

  api = {
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

  return { runner, repository, api, onNeedsAttention, clock, advance };
}

function enqueue(
  repository: FakeLedgerRepository,
  overrides: {
    messageId: string;
    ownerId?: string;
    chatId?: string;
    cause?: OutboxCause;
    targetMessageId?: string;
    text?: string;
    replyMarkup?: string;
    attempts?: number;
    nextAttemptAt?: string;
    createdAt?: string;
    leaseExpiresAt?: string | null;
    status?: OutboxStatus;
  },
): void {
  repository.seedOutboxMessage({
    messageId: overrides.messageId,
    ownerId: overrides.ownerId ?? OWNER_ID,
    cause: overrides.cause ?? "transaction_confirmed",
    chatId: overrides.chatId ?? CHAT_ID,
    ...(overrides.targetMessageId !== undefined
      ? { targetMessageId: overrides.targetMessageId }
      : {}),
    text: overrides.text ?? "已入帳",
    ...(overrides.replyMarkup !== undefined ? { replyMarkup: overrides.replyMarkup } : {}),
    nextAttemptAt: overrides.nextAttemptAt ?? INITIAL_NOW,
    ...(overrides.attempts !== undefined ? { attempts: overrides.attempts } : {}),
    ...(overrides.createdAt !== undefined ? { createdAt: overrides.createdAt } : {}),
  });

  const row = repository.outboxMessages.get(overrides.messageId);
  if (!row) throw new Error(`enqueue: seeding "${overrides.messageId}" failed`);
  if (overrides.leaseExpiresAt !== undefined) row.leaseExpiresAt = overrides.leaseExpiresAt;
  if (overrides.status !== undefined) row.status = overrides.status;
}

// 這三個回傳 Promise，只是為了配合 brief 給的 `await status(...)` 呼叫方式；
// FakeLedgerRepository 本身是同步的，這裡沒有真的需要非同步。
function status(repository: FakeLedgerRepository, messageId: string): Promise<OutboxStatus> {
  const row = repository.outboxMessages.get(messageId);
  if (!row) throw new Error(`no such outbox message: ${messageId}`);
  return Promise.resolve(row.status);
}

function attempts(repository: FakeLedgerRepository, messageId: string): Promise<number> {
  const row = repository.outboxMessages.get(messageId);
  if (!row) throw new Error(`no such outbox message: ${messageId}`);
  return Promise.resolve(row.attempts);
}

function nextAttemptAt(repository: FakeLedgerRepository, messageId: string): Promise<string> {
  const row = repository.outboxMessages.get(messageId);
  if (!row) throw new Error(`no such outbox message: ${messageId}`);
  return Promise.resolve(row.nextAttemptAt);
}

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

describe("outbox runner", () => {
  it("edits the target message and marks the row delivered", async () => {
    const { runner, api, repository } = harness();
    enqueue(repository, { messageId: "m1", targetMessageId: "77" });

    await runner.drainOnce();

    expect(api.editMessageText).toHaveBeenCalledWith("55", 77, "已入帳", expect.anything());
    expect(await status(repository, "m1")).toBe("delivered");
  });

  it("sends a new message when there is no target", async () => {
    const { runner, api, repository } = harness();
    enqueue(repository, { messageId: "m1" });

    await runner.drainOnce();

    expect(api.sendMessage).toHaveBeenCalled();
    expect(await status(repository, "m1")).toBe("delivered");
  });

  it("falls back to a new message when the target is gone, without counting a failure", async () => {
    const { runner, api, repository } = harness();
    api.editMessageText.mockRejectedValueOnce(
      grammyError(400, "Bad Request: message to edit not found"),
    );
    enqueue(repository, { messageId: "m1", targetMessageId: "77" });

    await runner.drainOnce();

    expect(api.sendMessage).toHaveBeenCalled();
    expect(await status(repository, "m1")).toBe("delivered");
    expect(await attempts(repository, "m1")).toBe(0);
  });

  it("retries normally when the forced resend after a vanished target also fails transiently", async () => {
    // Fix round 1, Finding 1：resend-as-new 之後的第二次嘗試不是免費的——
    // 這裡故意讓它也失敗，確認失敗會照一般的 retry 規則計入 attempts。
    const { runner, api, repository } = harness();
    api.editMessageText.mockRejectedValueOnce(
      grammyError(400, "Bad Request: message to edit not found"),
    );
    api.sendMessage.mockRejectedValueOnce(grammyError(502, "Bad Gateway"));
    enqueue(repository, { messageId: "m1", targetMessageId: "77" });

    await runner.drainOnce();

    expect(api.sendMessage).toHaveBeenCalledOnce();
    expect(await status(repository, "m1")).toBe("pending");
    expect(await attempts(repository, "m1")).toBe(1);
  });

  it("gives up when the forced resend after a vanished target also fails permanently", async () => {
    // Fix round 1, Finding 1：同上，但第二次失敗是 give-up 類錯誤。
    const { runner, api, repository, onNeedsAttention } = harness();
    api.editMessageText.mockRejectedValueOnce(
      grammyError(400, "Bad Request: message to edit not found"),
    );
    api.sendMessage.mockRejectedValueOnce(
      grammyError(403, "Forbidden: bot was blocked by the user"),
    );
    enqueue(repository, { messageId: "m1", targetMessageId: "77" });

    await runner.drainOnce();

    expect(api.sendMessage).toHaveBeenCalledOnce();
    expect(await status(repository, "m1")).toBe("needs_attention");
    expect(onNeedsAttention).toHaveBeenCalledOnce();
  });

  it("treats an unchanged message as delivered", async () => {
    const { runner, repository } = harness();
    api.editMessageText.mockRejectedValueOnce(
      grammyError(400, "Bad Request: message is not modified"),
    );
    enqueue(repository, { messageId: "m1", targetMessageId: "77" });

    await runner.drainOnce();

    expect(await status(repository, "m1")).toBe("delivered");
  });

  it("schedules a retry with backoff after a transient failure", async () => {
    const { runner, api, repository, clock } = harness();
    api.sendMessage.mockRejectedValueOnce(grammyError(502, "Bad Gateway"));
    enqueue(repository, { messageId: "m1" });

    await runner.drainOnce();

    expect(await status(repository, "m1")).toBe("pending");
    expect(await attempts(repository, "m1")).toBe(1);
    // 第一次失敗退避 5 秒
    expect(await nextAttemptAt(repository, "m1")).toBe(
      new Date(clock.getTime() + 5_000).toISOString(),
    );
  });

  it("gives up immediately on an error retrying cannot fix", async () => {
    const { runner, api, repository, onNeedsAttention } = harness();
    api.sendMessage.mockRejectedValue(grammyError(403, "Forbidden: bot was blocked by the user"));
    enqueue(repository, { messageId: "m1" });

    await runner.drainOnce();

    expect(await status(repository, "m1")).toBe("needs_attention");
    expect(await attempts(repository, "m1")).toBe(0);
    expect(onNeedsAttention).toHaveBeenCalledOnce();
  });

  it("stops after the retry cap and asks for attention", async () => {
    // 註：brief 原本這裡寫 attempts === 5。但 markOutboxNeedsAttention（無論是
    // SqliteLedgerRepository 還是 FakeLedgerRepository）都不會寫 attempts 欄位，
    // 只有 markOutboxFailed 會把它加一——見 fake-ledger-repository.test.ts 直接釘死
    // 的那三個行為之一。放棄的那一次是呼叫 markOutboxNeedsAttention，不是
    // markOutboxFailed，所以 attempts 停在上一次 markOutboxFailed 寫入的值：
    // 第 1～4 次失敗各呼叫一次 markOutboxFailed（attempts 1→2→3→4），第 5 次判定
    // 達到上限直接放棄，不再呼叫 markOutboxFailed，attempts 維持 4。
    const { runner, api, repository, onNeedsAttention, advance } = harness();
    api.sendMessage.mockRejectedValue(grammyError(502, "Bad Gateway"));
    enqueue(repository, { messageId: "m1" });

    for (let round = 0; round < 6; round += 1) {
      await runner.drainOnce();
      advance(10 * 60_000);
    }

    expect(await status(repository, "m1")).toBe("needs_attention");
    expect(await attempts(repository, "m1")).toBe(4);
    expect(onNeedsAttention).toHaveBeenCalledOnce();
  });

  it("delivers a row left behind by a process that died mid-flight", async () => {
    // AC-20：死掉的行程留下過期 lease，迴圈照常規則就撈得到，沒有另一段開機邏輯。
    const { runner, repository, advance } = harness();
    enqueue(repository, { messageId: "m1", leaseExpiresAt: "2026-09-30T00:00:00.000Z" });
    advance(60_000);

    await runner.drainOnce();

    expect(await status(repository, "m1")).toBe("delivered");
  });

  it("re-sends when the process dies after sending but before marking delivered", async () => {
    // Review Focus 1。寧可重複也不要遺失：帳本只有一筆，使用者看到兩則訊息。
    // lease 讓它最多重複一次，不會無限重複。
    //
    // 註：brief 原本給的一行是
    //   repository.markOutboxDelivered = vi.fn().mockRejectedValueOnce(new Error("killed"));
    // 但這樣寫在第一次「拒絕」被消耗之後，mock 沒有任何後備實作，之後每次呼叫都只會
    // 回傳 undefined，永遠不會真的把那一列標成 delivered——不管 runner 怎麼實作，
    // 最後 status() 都不可能等於 "delivered"。這裡改成保留真正的實作當後備，
    // 讓「第一次死掉、第二次成功」這個情境真的能被驗證到。
    const { runner, api, repository, advance } = harness();
    const realMarkOutboxDelivered = repository.markOutboxDelivered.bind(repository);
    repository.markOutboxDelivered = vi
      .fn()
      .mockRejectedValueOnce(new Error("killed"))
      .mockImplementation(realMarkOutboxDelivered);
    enqueue(repository, { messageId: "m1" });

    await runner.drainOnce().catch(() => undefined);
    // Fix round 1, Finding 2：這裡要卡住的是「行程內立刻重試」這個突變——
    // 如果 markOutboxDelivered 失敗被吞掉、在同一個 drainOnce() 裡馬上重送，
    // 這行會在 lease 過期之前就看到第二次呼叫，測試就會抓到。
    expect(api.sendMessage).toHaveBeenCalledOnce();
    advance(60_000); // lease 過期
    await runner.drainOnce();

    expect(api.sendMessage).toHaveBeenCalledTimes(2);
    expect(await status(repository, "m1")).toBe("delivered");
  });

  it("does not resurrect needs_attention rows on its own", async () => {
    // 重啟看似代表連線回來了，但自動重送等於把「不無限重試」從後門繞過去，
    // 而且使用者可能早就用 /recent 確認過那筆交易。要重送就明確按「重試全部」。
    const { runner, api, repository, advance } = harness();
    enqueue(repository, { messageId: "m1", status: "needs_attention" });
    advance(60 * 60_000);

    await runner.drainOnce();

    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(await status(repository, "m1")).toBe("needs_attention");
  });

  it("does not deliver the same row twice when a drain overlaps the fast path", async () => {
    // lease 的用途：單一行程也可能有兩條路徑同時碰同一列。
    const { runner, api, repository } = harness();
    enqueue(repository, { messageId: "m1" });

    await Promise.all([runner.drainOnce(), runner.drainOnce()]);

    expect(api.sendMessage).toHaveBeenCalledOnce();
  });

  it("start() unrefs its interval so the process can exit on its own; stop() clears it", () => {
    // Fix round 1, Finding 3：這裡故意不用 vi.useFakeTimers()——那套機制不模擬
    // ref/unref 的實際行為，用它斷言 unref 會是一個永遠不會失敗的假斷言。改用真正的
    // setInterval/clearInterval（用 spy 攔截取得真正的 Timeout 控制代碼），直接檢查
    // Node Timeout 物件的 hasRef()，這是唯一誠實、能被突變測試打中的作法。
    const { runner } = harness();
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");

    try {
      runner.start();

      expect(setIntervalSpy).toHaveBeenCalledOnce();
      const timerResult = setIntervalSpy.mock.results[0];
      if (!timerResult || timerResult.type !== "return") {
        throw new Error("setInterval did not return synchronously");
      }
      const timer = timerResult.value;
      expect(timer.hasRef()).toBe(false);

      runner.stop();

      expect(clearIntervalSpy).toHaveBeenCalledWith(timer);
    } finally {
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
    }
  });
});

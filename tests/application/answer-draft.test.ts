import { describe, expect, it } from "vitest";

import { answerDraft } from "../../src/application/answer-draft.js";
import type { IncompleteDraft } from "../../src/domain/draft.js";
import { incompleteLunchDraft } from "../fixtures/drafts.js";
import { FakeLedgerRepository } from "../support/fake-ledger-repository.js";

// 代墊追問情境的預設形狀：個人支出配置持有完整總額，代墊配置只缺交易對象。
function incompleteAdvanceDraft(overrides: Partial<IncompleteDraft> = {}): IncompleteDraft {
  return incompleteLunchDraft({
    pendingFields: [{ field: "counterparty", candidateIds: [] }],
    partial: {
      occurredDate: "2026-09-21",
      rawSegment: "午餐 1260，小明欠一半",
      allocations: [
        {
          allocationId: "mine",
          fundsEffect: "outflow",
          purpose: "expense",
          amount: { amount: "630", currency: "TWD" },
          category: "餐飲",
        },
        {
          allocationId: "theirs",
          fundsEffect: "outflow",
          purpose: "advance",
          amount: { amount: "630", currency: "TWD" },
          category: "餐飲",
        },
      ],
    },
    ...overrides,
  });
}

async function seedIncompleteAdvanceDraft(overrides: Partial<IncompleteDraft> = {}) {
  const repository = new FakeLedgerRepository();
  await repository.recordInputEvent({
    eventId: "event-1",
    ownerId: "owner-1",
    telegramUpdateId: "1",
    sourceType: "telegram",
    sourceRef: "123:1",
    rawText: "午餐 1260，小明欠一半",
    receivedAt: "2026-09-21T01:00:00.000Z",
  });
  await repository.saveIncompleteDraft(incompleteAdvanceDraft(overrides), {
    batchId: "batch-1",
    batchIndex: 0,
    createdDate: "2026-09-21",
  });
  let counter = 0;
  return {
    repository,
    dependencies: { repository, generateId: () => `answer-${String(++counter)}` },
  };
}

async function seedIncompleteLunchDraft() {
  const repository = new FakeLedgerRepository();
  await repository.recordInputEvent({
    eventId: "event-1",
    ownerId: "owner-1",
    telegramUpdateId: "1",
    sourceType: "telegram",
    sourceRef: "123:1",
    rawText: "午餐",
    receivedAt: "2026-09-21T01:00:00.000Z",
  });
  await repository.saveIncompleteDraft(incompleteLunchDraft(), {
    batchId: "batch-1",
    batchIndex: 0,
    createdDate: "2026-09-21",
  });
  let counter = 0;
  return {
    repository,
    dependencies: { repository, generateId: () => `answer-${String(++counter)}` },
  };
}

const amountAnswer = {
  ownerId: "owner-1",
  draftId: "draft-1",
  field: "amount" as const,
  value: { kind: "amount" as const, text: "120" },
  telegramUpdateId: "2",
  sourceRef: "123:2",
  rawText: "120",
  receivedAt: "2026-09-21T02:00:00.000Z",
};

describe("answerDraft", () => {
  it("upgrades an incomplete draft when the amount answer arrives", async () => {
    const { repository, dependencies } = await seedIncompleteLunchDraft();

    const result = await answerDraft(amountAnswer, dependencies);

    expect(result.kind).toBe("draft");
    const record = await repository.getDraftRecord({ draftId: "draft-1" });
    expect(record?.status).toBe("awaiting_confirmation");
    expect(record?.draft?.amount.amount).toBe("120");
    expect(record?.incomplete).toBeNull();
  });

  it("records the answer as its own immutable input event", async () => {
    const { repository, dependencies } = await seedIncompleteLunchDraft();

    await answerDraft(amountAnswer, dependencies);

    expect(repository.inputEvents.size).toBe(2);
  });

  it("rejects a non-numeric amount without touching the draft", async () => {
    const { repository, dependencies } = await seedIncompleteLunchDraft();

    const result = await answerDraft(
      { ...amountAnswer, value: { kind: "amount", text: "一百二" }, rawText: "一百二" },
      dependencies,
    );

    expect(result).toEqual({ kind: "invalid", reason: "amount_not_numeric" });
    const record = await repository.getDraftRecord({ draftId: "draft-1" });
    expect(record?.status).toBe("awaiting_input");
    expect(repository.inputEvents.size).toBe(1);
  });

  it("rejects answering a field that is not pending", async () => {
    const { dependencies } = await seedIncompleteLunchDraft();

    const result = await answerDraft(
      {
        ...amountAnswer,
        field: "account",
        value: { kind: "reference", id: "account-1", label: "台新" },
        rawText: "台新",
      },
      dependencies,
    );

    expect(result).toEqual({ kind: "invalid", reason: "not_pending" });
  });

  it("rejects an unknown draft", async () => {
    const { dependencies } = await seedIncompleteLunchDraft();

    const result = await answerDraft({ ...amountAnswer, draftId: "missing" }, dependencies);

    expect(result).toEqual({ kind: "invalid", reason: "draft_not_found" });
  });

  it("routes a counterparty answer to the counterparty patch", async () => {
    const { repository, dependencies } = await seedIncompleteAdvanceDraft();

    const result = await answerDraft(
      {
        ...amountAnswer,
        field: "counterparty",
        value: { kind: "reference", id: "counterparty-1", label: "小明" },
        rawText: "小明",
      },
      dependencies,
    );

    expect(result.kind).toBe("draft");
    const record = await repository.getDraftRecord({ draftId: "draft-1" });
    expect(record?.draft?.allocations[1]?.counterpartyId).toBe("counterparty-1");
  });

  it("rejects a non-numeric advance share", async () => {
    const { dependencies } = await seedIncompleteAdvanceDraft({
      pendingFields: [{ field: "advanceShare", candidateIds: [] }],
      partial: {
        occurredDate: "2026-09-21",
        rawSegment: "聚餐 1000，三個人平分",
        allocations: [
          {
            allocationId: "mine",
            fundsEffect: "outflow",
            purpose: "expense",
            amount: { amount: "1000", currency: "TWD" },
            category: "餐飲",
          },
          {
            allocationId: "theirs",
            fundsEffect: "outflow",
            purpose: "advance",
            category: "餐飲",
            counterpartyId: "counterparty-1",
          },
        ],
      },
    });

    const result = await answerDraft(
      {
        ...amountAnswer,
        field: "advanceShare",
        value: { kind: "amount", text: "一半" },
        rawText: "一半",
      },
      dependencies,
    );

    expect(result).toEqual({ kind: "invalid", reason: "amount_not_numeric" });
  });
});

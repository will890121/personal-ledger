import { describe, expect, it } from "vitest";

import { answerDraft } from "../../src/application/answer-draft.js";
import { incompleteLunchDraft } from "../fixtures/drafts.js";
import { FakeLedgerRepository } from "../support/fake-ledger-repository.js";

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
});

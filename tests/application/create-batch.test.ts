import { describe, expect, it } from "vitest";

import { createBatch, MAX_SEGMENTS } from "../../src/application/create-batch.js";
import { FakeLedgerRepository } from "../support/fake-ledger-repository.js";
import { FakeReferenceRepository } from "../support/fake-reference-repository.js";

function setup() {
  const repository = new FakeLedgerRepository();
  const referenceRepository = new FakeReferenceRepository();
  referenceRepository.categories.push({
    categoryId: "category-lunch",
    ownerId: "owner-1",
    key: "expense_dining",
    name: "餐飲",
    kind: "expense",
    parentId: "category-expense",
    depth: 2,
    active: true,
  });
  let counter = 0;
  return {
    repository,
    referenceRepository,
    dependencies: {
      repository,
      referenceRepository,
      generateId: () => `id-${String(++counter)}`,
    },
  };
}

const baseCommand = {
  ownerId: "owner-1",
  telegramUpdateId: "1",
  sourceRef: "123:1",
  receivedAt: "2026-09-21T01:00:00.000Z",
  occurredDate: "2026-09-21",
};

describe("createBatch", () => {
  it("creates one draft per segment under a shared batch", async () => {
    const { dependencies, repository } = setup();

    const result = await createBatch({ ...baseCommand, text: "午餐 120，午餐 60" }, dependencies);

    expect(result.kind).toBe("batch");
    if (result.kind !== "batch") return;
    expect(result.items).toHaveLength(2);
    expect(result.items.every((item) => item.outcome.kind === "draft")).toBe(true);
    expect(repository.batches.size).toBe(1);
    const batch = [...repository.batches.values()][0];
    expect(batch?.itemCount).toBe(2);
    const drafts = [...repository.drafts.values()];
    expect(new Set(drafts.map((draft) => draft.draftId)).size).toBe(2);
    expect(drafts.map((draft) => draft.amount.amount).sort()).toEqual(["120", "60"]);
  });

  it("keeps successful segments while holding the incomplete one for follow-up", async () => {
    const { dependencies } = setup();

    // 缺欄位的段落必須自己帶金額才會獨立成段：不含金額的段落會依切分規則併回前一段。
    const result = await createBatch(
      { ...baseCommand, text: "午餐 120，午餐 60，雜支 90" },
      dependencies,
    );

    expect(result.kind).toBe("batch");
    if (result.kind !== "batch") return;
    expect(result.items.map((item) => item.outcome.kind)).toEqual(["draft", "draft", "incomplete"]);
    const third = result.items[2]?.outcome;
    if (third?.kind !== "incomplete") throw new Error("expected incomplete outcome");
    expect(third.draft.pendingFields.map((field) => field.field)).toEqual(["category"]);
    expect(third.draft.batchId).toBe(result.batchId);
    expect(third.draftRef).toMatch(/^[0-9a-f]{8}$/);
  });

  it("offers category candidates when the category cannot be resolved", async () => {
    const { dependencies } = setup();

    const result = await createBatch({ ...baseCommand, text: "雜支 60" }, dependencies);

    expect(result.kind).toBe("batch");
    if (result.kind !== "batch") return;
    const outcome = result.items[0]?.outcome;
    if (outcome?.kind !== "incomplete") throw new Error("expected incomplete outcome");
    expect(outcome.draft.pendingFields[0]).toEqual({
      field: "category",
      candidateIds: ["category-lunch"],
    });
  });

  it("does not create a draft for input it cannot interpret at all", async () => {
    const { dependencies, repository } = setup();

    const result = await createBatch({ ...baseCommand, text: "在嗎" }, dependencies);

    expect(result.kind).toBe("batch");
    if (result.kind !== "batch") return;
    expect(result.items[0]?.outcome.kind).toBe("unparsed");
    expect(repository.records.size).toBe(0);
  });

  it("rejects the whole message when it exceeds the segment limit", async () => {
    const { dependencies, repository } = setup();
    const text = Array.from(
      { length: MAX_SEGMENTS + 1 },
      (_, index) => `午餐 ${String(index + 1)}`,
    ).join("，");

    const result = await createBatch({ ...baseCommand, text }, dependencies);

    expect(result).toEqual({ kind: "too_many_segments", count: MAX_SEGMENTS + 1 });
    expect(repository.records.size).toBe(0);
    expect(repository.inputEvents.size).toBe(0);
  });

  it("returns duplicate for a replayed telegram update", async () => {
    const { dependencies } = setup();
    await createBatch({ ...baseCommand, text: "午餐 120" }, dependencies);

    const result = await createBatch({ ...baseCommand, text: "午餐 120" }, dependencies);

    expect(result.kind).toBe("duplicate");
  });
});

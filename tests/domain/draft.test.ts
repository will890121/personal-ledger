import { describe, expect, it } from "vitest";

import { completeDraft, IncompleteDraftSchema } from "../../src/domain/draft.js";
import { money } from "../../src/domain/money.js";
import { incompleteDraftWithPendingCategory, incompleteLunchDraft } from "../fixtures/drafts.js";

describe("completeDraft", () => {
  it("upgrades to a confirmable draft once the amount arrives", () => {
    const result = completeDraft(incompleteLunchDraft(), { amount: money("120", "TWD") });

    expect(result.kind).toBe("draft");
    if (result.kind !== "draft") return;
    expect(result.draft.status).toBe("awaiting_confirmation");
    expect(result.draft.amount.amount).toBe("120");
    expect(result.draft.allocations[0]?.amount.amount).toBe("120");
    expect(result.draft.draftId).toBe("draft-1");
  });

  it("keeps the draft incomplete while other fields are still pending", () => {
    const draft = IncompleteDraftSchema.parse({
      ...incompleteLunchDraft(),
      pendingFields: [
        { field: "amount", candidateIds: [] },
        { field: "category", candidateIds: ["category-a", "category-b"] },
      ],
      partial: {
        occurredDate: "2026-09-21",
        rawSegment: "咖啡",
        allocations: [],
      },
    });

    const result = completeDraft(draft, { amount: money("60", "TWD") });

    expect(result.kind).toBe("incomplete");
    if (result.kind !== "incomplete") return;
    expect(result.draft.pendingFields.map((item) => item.field)).toEqual(["category"]);
  });

  it("applies a category answer to the first allocation missing one", () => {
    const draft = incompleteDraftWithPendingCategory(["category-coffee"]);

    const result = completeDraft(draft, { categoryId: "category-coffee", category: "餐飲" });

    expect(result.kind).toBe("draft");
    if (result.kind !== "draft") return;
    expect(result.draft.allocations[0]?.categoryId).toBe("category-coffee");
    expect(result.draft.allocations[0]?.category).toBe("餐飲");
  });

  it("stays incomplete when the patched values cannot form a valid draft", () => {
    const draft = IncompleteDraftSchema.parse({
      ...incompleteLunchDraft(),
      partial: { occurredDate: "2026-09-21", rawSegment: "午餐", allocations: [] },
    });

    const result = completeDraft(draft, { amount: money("120", "TWD") });

    expect(result.kind).toBe("incomplete");
  });

  it("fills the counterparty into every advance allocation that lacks one", () => {
    const draft = IncompleteDraftSchema.parse({
      ...incompleteLunchDraft(),
      pendingFields: [{ field: "counterparty", candidateIds: [], proposedName: "小明" }],
      partial: {
        occurredDate: "2026-09-24",
        rawSegment: "聚餐 1260，小明欠一半",
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
    });

    const result = completeDraft(draft, { counterpartyId: "counterparty-1" });

    expect(result.kind).toBe("draft");
    if (result.kind !== "draft") return;
    expect(result.draft.allocations[1]?.counterpartyId).toBe("counterparty-1");
    expect(result.draft.allocations[0]?.counterpartyId).toBeUndefined();
  });

  it("sets the advance share and rebalances the personal share", () => {
    const draft = IncompleteDraftSchema.parse({
      ...incompleteLunchDraft(),
      pendingFields: [{ field: "advanceShare", candidateIds: [] }],
      partial: {
        occurredDate: "2026-09-24",
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

    const result = completeDraft(draft, { advanceShare: money("667", "TWD") });

    expect(result.kind).toBe("draft");
    if (result.kind !== "draft") return;
    expect(result.draft.amount.amount).toBe("1000");
    expect(result.draft.allocations[0]?.amount.amount).toBe("333");
    expect(result.draft.allocations[1]?.amount.amount).toBe("667");
  });
});

import { describe, expect, it } from "vitest";

import { listPending, PENDING_PAGE_SIZE } from "../../src/application/list-pending.js";
import { incompleteLunchDraft } from "../fixtures/drafts.js";
import { FakeLedgerRepository } from "../support/fake-ledger-repository.js";

async function seedPendingDrafts(count: number): Promise<FakeLedgerRepository> {
  const repository = new FakeLedgerRepository();
  for (let index = 0; index < count; index += 1) {
    await repository.saveIncompleteDraft(
      incompleteLunchDraft({
        draftId: `draft-${String(index)}`,
        requestId: `request-${String(index)}`,
      }),
      { batchId: "batch-1", batchIndex: index, createdDate: "2026-09-21" },
    );
  }
  return repository;
}

describe("listPending", () => {
  it("pages pending drafts ten at a time", async () => {
    const repository = await seedPendingDrafts(23);

    const page = await listPending(repository, "owner-1", "awaiting_input", 1);

    expect(page.items).toHaveLength(PENDING_PAGE_SIZE);
    expect(page.totalPages).toBe(3);
    expect(page.page).toBe(1);
  });

  it("returns an empty page when nothing is pending", async () => {
    const page = await listPending(new FakeLedgerRepository(), "owner-1", "awaiting_input", 0);

    expect(page.items).toEqual([]);
    expect(page.totalPages).toBe(0);
  });
});

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { migrate } from "../../src/db/migrate.js";
import { SqliteLedgerRepository } from "../../src/db/sqlite-ledger-repository.js";
import { completeLunchDraft, incompleteLunchDraft } from "../fixtures/drafts.js";

async function setup() {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  migrate(database);
  const repository = new SqliteLedgerRepository(database);
  await repository.recordInputEvent({
    eventId: "event-1",
    ownerId: "owner-1",
    telegramUpdateId: "1",
    sourceType: "telegram",
    sourceRef: "123:1",
    rawText: "午餐",
    receivedAt: "2026-09-21T01:00:00.000Z",
  });
  await repository.saveBatch({
    batchId: "batch-1",
    ownerId: "owner-1",
    sourceEventId: "event-1",
    itemCount: 1,
    createdAt: "2026-09-21T01:00:00.000Z",
  });
  return { database, repository };
}

const meta = { batchId: "batch-1", batchIndex: 0, createdDate: "2026-09-21" };

describe("SqliteLedgerRepository draft state", () => {
  it("persists an incomplete draft and reads it back by short reference", async () => {
    const { repository } = await setup();

    const draftRef = await repository.saveIncompleteDraft(incompleteLunchDraft(), meta);

    expect(draftRef).toMatch(/^[0-9a-f]{8}$/);
    const record = await repository.getDraftRecord({ ownerId: "owner-1", draftRef });
    expect(record?.draftId).toBe("draft-1");
    expect(record?.status).toBe("awaiting_input");
    expect(record?.createdDate).toBe("2026-09-21");
    expect(record?.batchId).toBe("batch-1");
    expect(record?.draft).toBeNull();
    expect(record?.incomplete?.pendingFields[0]?.field).toBe("amount");
  });

  it("finds a draft by the preview message it was sent as", async () => {
    const { repository } = await setup();
    await repository.saveIncompleteDraft(incompleteLunchDraft(), meta);

    await repository.setPreviewMessage("draft-1", "123", "456");

    const record = await repository.getDraftRecord({
      previewChatId: "123",
      previewMessageId: "456",
    });
    expect(record?.draftId).toBe("draft-1");
  });

  it("lists and counts pending drafts by status and archives them", async () => {
    const { repository } = await setup();
    await repository.saveIncompleteDraft(incompleteLunchDraft(), meta);

    const pending = await repository.listPendingDrafts({
      ownerId: "owner-1",
      status: "awaiting_input",
      limit: 10,
      offset: 0,
    });
    expect(pending).toHaveLength(1);
    expect(pending[0]?.rawSegment).toBe("午餐");
    expect(pending[0]?.amount).toBeNull();
    expect(await repository.countPendingDrafts("owner-1", "awaiting_input")).toBe(1);

    await repository.archiveDraft("draft-1");

    expect(await repository.countPendingDrafts("owner-1", "awaiting_input")).toBe(0);
    const archived = await repository.getDraftRecord({ draftId: "draft-1" });
    expect(archived?.status).toBe("archived");
  });

  it("replaces an incomplete draft with the upgraded complete draft", async () => {
    const { repository } = await setup();
    await repository.saveIncompleteDraft(incompleteLunchDraft(), meta);

    await repository.replaceDraft(
      "draft-1",
      completeLunchDraft({ draftId: "draft-1", requestId: "request-1" }),
    );

    const record = await repository.getDraftRecord({ draftId: "draft-1" });
    expect(record?.status).toBe("awaiting_confirmation");
    expect(record?.draft?.amount.amount).toBe("120");
    expect(record?.incomplete).toBeNull();
  });

  it("updates the created date when a stale draft is re-previewed", async () => {
    const { repository } = await setup();
    await repository.saveIncompleteDraft(incompleteLunchDraft(), {
      ...meta,
      createdDate: "2026-09-20",
    });

    await repository.touchDraftDate("draft-1", "2026-09-21");

    const record = await repository.getDraftRecord({ draftId: "draft-1" });
    expect(record?.createdDate).toBe("2026-09-21");
  });
});

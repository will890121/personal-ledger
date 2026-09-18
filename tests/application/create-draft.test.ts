import { describe, expect, it } from "vitest";

import { createDraft } from "../../src/application/create-draft.js";
import { FakeLedgerRepository } from "../support/fake-ledger-repository.js";

function idGenerator(...ids: string[]): () => string {
  return () => {
    const id = ids.shift();
    if (!id) throw new Error("test ID sequence exhausted");
    return id;
  };
}

describe("createDraft", () => {
  it("records the input event before saving an awaiting-confirmation draft", async () => {
    const repository = new FakeLedgerRepository();

    const result = await createDraft(
      {
        ownerId: "123",
        telegramUpdateId: "update-1",
        sourceRef: "message-1",
        text: "午餐 120",
        receivedAt: "2026-09-18T01:00:00.000Z",
        occurredDate: "2026-09-18",
      },
      { repository, generateId: idGenerator("event-1", "request-1", "draft-1", "allocation-1") },
    );

    expect(result).toMatchObject({ kind: "draft", draft: { status: "awaiting_confirmation" } });
    expect(repository.inputEvents.size).toBe(1);
    expect(repository.drafts.size).toBe(1);
  });

  it("does not create another draft when Telegram redelivers an update", async () => {
    const repository = new FakeLedgerRepository();
    const command = {
      ownerId: "123",
      telegramUpdateId: "update-1",
      sourceRef: "message-1",
      text: "午餐 120",
      receivedAt: "2026-09-18T01:00:00.000Z",
      occurredDate: "2026-09-18",
    };

    await createDraft(command, {
      repository,
      generateId: idGenerator("event-1", "request-1", "draft-1", "allocation-1"),
    });
    const duplicate = await createDraft(command, {
      repository,
      generateId: idGenerator("event-2"),
    });

    expect(duplicate).toEqual({ kind: "duplicate", eventId: "event-1" });
    expect(repository.inputEvents.size).toBe(1);
    expect(repository.drafts.size).toBe(1);
  });

  it("returns missing fields without saving a draft", async () => {
    const repository = new FakeLedgerRepository();

    const result = await createDraft(
      {
        ownerId: "123",
        telegramUpdateId: "update-1",
        sourceRef: "message-1",
        text: "午餐",
        receivedAt: "2026-09-18T01:00:00.000Z",
        occurredDate: "2026-09-18",
      },
      { repository, generateId: idGenerator("event-1", "request-1", "draft-1", "allocation-1") },
    );

    expect(result).toEqual({ kind: "missing_fields", fields: ["amount"] });
    expect(repository.inputEvents.size).toBe(1);
    expect(repository.drafts.size).toBe(0);
  });
});

import { describe, expect, it } from "vitest";

import { completeLunchDraft } from "../fixtures/drafts.js";
import {
  callbackUpdate,
  createHarness,
  getText,
  type ApiCall,
} from "../support/telegram-harness.js";
import type { FakeLedgerRepository } from "../support/fake-ledger-repository.js";

async function seedDraftCreatedOn(
  repository: FakeLedgerRepository,
  createdDate: string,
  draftId: string,
): Promise<void> {
  await repository.saveDraft(
    completeLunchDraft({ draftId, ownerId: "123", requestId: `request-${draftId}` }),
    { createdDate },
  );
}

function answerText(calls: readonly ApiCall[]): string {
  const answer = calls.find((call) => call.method === "answerCallbackQuery");
  return JSON.stringify(answer?.payload ?? {});
}

describe("stale drafts", () => {
  it("does not confirm a draft created on an earlier day", async () => {
    const { bot, calls, repository } = createHarness({ today: "2026-09-21" });
    await seedDraftCreatedOn(repository, "2026-09-20", "draft-1");

    await bot.handleUpdate(callbackUpdate({ updateId: 2, data: "confirm:draft-1" }));

    expect(repository.transactions.size).toBe(0);
    expect(answerText(calls)).toContain("請重新確認");
    expect(getText(calls.at(-1))).toContain("建立日期：2026-09-20");
  });

  it("confirms a draft created today", async () => {
    const { bot, repository } = createHarness({ today: "2026-09-21" });
    await seedDraftCreatedOn(repository, "2026-09-21", "draft-1");

    await bot.handleUpdate(callbackUpdate({ updateId: 2, data: "confirm:draft-1" }));

    expect(repository.transactions.size).toBe(1);
  });

  it("confirms on the second press after a re-preview", async () => {
    const { bot, repository } = createHarness({ today: "2026-09-21" });
    await seedDraftCreatedOn(repository, "2026-09-20", "draft-1");

    await bot.handleUpdate(callbackUpdate({ updateId: 2, data: "confirm:draft-1" }));
    await bot.handleUpdate(callbackUpdate({ updateId: 3, data: "confirm:draft-1" }));

    expect(repository.transactions.size).toBe(1);
  });

  it("still confirms drafts that carry no created date", async () => {
    const { bot, repository } = createHarness({ today: "2026-09-21" });
    await repository.saveDraft(
      completeLunchDraft({ draftId: "draft-2", ownerId: "123", requestId: "request-2" }),
    );

    await bot.handleUpdate(callbackUpdate({ updateId: 2, data: "confirm:draft-2" }));

    expect(repository.transactions.size).toBe(1);
  });
});

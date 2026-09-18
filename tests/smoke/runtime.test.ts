import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { TransactionDraft } from "../../src/domain/ledger.js";
import { composeRuntime } from "../../src/main.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("runtime composition", () => {
  it("migrates a temporary database and exposes a working repository", async () => {
    const directory = mkdtempSync(join(tmpdir(), "personal-ledger-runtime-"));
    temporaryDirectories.push(directory);

    const runtime = await composeRuntime({
      telegramBotToken: "test-token",
      ownerId: "123",
      databasePath: join(directory, "nested", "ledger.sqlite"),
      timezone: "Asia/Taipei",
      currency: "TWD",
    });

    try {
      await runtime.repository.recordInputEvent({
        eventId: "event-1",
        ownerId: "123",
        telegramUpdateId: "update-1",
        sourceType: "telegram",
        sourceRef: "chat:message",
        rawText: "test input",
        receivedAt: "2026-09-18T00:00:00.000Z",
      });

      const draft: TransactionDraft = {
        draftId: "draft-1",
        ownerId: "123",
        requestId: "request-1",
        sourceEventId: "event-1",
        occurredDate: "2026-09-18",
        amount: { amount: "120", currency: "TWD" },
        status: "awaiting_confirmation",
        allocations: [
          {
            allocationId: "allocation-1",
            fundsEffect: "outflow",
            purpose: "expense",
            amount: { amount: "120", currency: "TWD" },
            category: "food",
            subcategory: "meal",
          },
        ],
      };

      await runtime.repository.saveDraft(draft);

      await expect(runtime.repository.getDraft("draft-1")).resolves.toEqual(draft);
      await expect(
        runtime.referenceRepository.findCategoryByKey("123", "expense_dining_lunch"),
      ).resolves.toMatchObject({ name: "午餐" });
      await expect(
        runtime.referenceRepository.findAccountByName("123", "現金"),
      ).resolves.toHaveLength(1);
      expect(
        runtime.database.prepare("SELECT version FROM schema_migrations ORDER BY version").all(),
      ).toEqual([{ version: 1 }, { version: 2 }]);
    } finally {
      runtime.close();
    }
  });
});

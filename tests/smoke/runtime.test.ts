import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { TransactionDraft } from "../../src/domain/ledger.js";
import { composeRuntime } from "../../src/main.js";
import { openDatabase } from "../../src/db/database.js";
import { seedM1Ledger } from "../fixtures/m1-ledger.js";

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
      timezone: "Asia/Taipei" as const,
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
      ).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }]);
    } finally {
      runtime.close();
    }
  });

  it("upgrades an M1 database and exposes its transaction and summary", async () => {
    const directory = mkdtempSync(join(tmpdir(), "personal-ledger-m1-runtime-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "ledger.sqlite");
    const legacyDatabase = openDatabase(databasePath);
    seedM1Ledger(legacyDatabase);
    legacyDatabase.close();

    const config = {
      telegramBotToken: "test-token",
      ownerId: "owner-1",
      databasePath,
      timezone: "Asia/Taipei" as const,
      currency: "TWD" as const,
    };
    const runtime = await composeRuntime(config);
    let categoryCount = 0;
    try {
      await expect(
        runtime.repository.getTransaction("owner-1", "m1-transaction"),
      ).resolves.toMatchObject({
        amount: { amount: "120" },
        status: "confirmed",
      });
      await expect(
        runtime.summaryRepository.summarize("owner-1", { from: "2026-09-18", to: "2026-09-18" }),
      ).resolves.toMatchObject({
        actualOutflow: { amount: "120" },
        netPersonalExpense: { amount: "120" },
      });
      expect(
        runtime.database.prepare("SELECT version FROM schema_migrations ORDER BY version").all(),
      ).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }]);
      categoryCount = (
        runtime.database
          .prepare("SELECT COUNT(*) AS count FROM categories WHERE owner_id = ?")
          .get("owner-1") as { count: number }
      ).count;
    } finally {
      runtime.close();
    }

    const restarted = await composeRuntime(config);
    try {
      expect(
        restarted.database
          .prepare("SELECT COUNT(*) AS count FROM categories WHERE owner_id = ?")
          .get("owner-1"),
      ).toEqual({ count: categoryCount });
    } finally {
      restarted.close();
    }
  });
});

import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
      sheets: null,
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
        runtime.referenceRepository.findCategoryByKey("123", "expense_dining"),
      ).resolves.toMatchObject({ name: "餐飲" });
      await expect(
        runtime.referenceRepository.findAccountByName("123", "現金"),
      ).resolves.toHaveLength(1);
      expect(
        runtime.database.prepare("SELECT version FROM schema_migrations ORDER BY version").all(),
      ).toEqual([
        { version: 1 },
        { version: 2 },
        { version: 3 },
        { version: 4 },
        { version: 5 },
        { version: 6 },
        { version: 7 },
        { version: 8 },
        { version: 9 },
      ]);
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
      sheets: null,
    };
    const runtime = await composeRuntime(config);
    let categoryCount = 0;
    try {
      // AC-24：快照必須在 migration **之前**拍。把 main.ts 那三行搬到 migrate() 之後
      // 會讓 pendingMigrationVersions() 永遠回傳 []，從此再也不會有任何快照——
      // 所以先斷言檔案真的存在，再打開它確認裡面還是升級前的 schema 1，
      // 光看「有一個檔案」分不出拍照時機。
      const snapshots = readdirSync(join(directory, "pre-migration")).filter((file) =>
        file.endsWith(".sqlite"),
      );
      expect(snapshots).toHaveLength(1);
      const snapshotName = snapshots[0];
      if (snapshotName === undefined) throw new Error("no snapshot file");
      const snapshot = openDatabase(join(directory, "pre-migration", snapshotName));
      try {
        expect(
          snapshot.prepare("SELECT version FROM schema_migrations ORDER BY version").all(),
        ).toEqual([{ version: 1 }]);
      } finally {
        snapshot.close();
      }

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
      ).toEqual([
        { version: 1 },
        { version: 2 },
        { version: 3 },
        { version: 4 },
        { version: 5 },
        { version: 6 },
        { version: 7 },
        { version: 8 },
        { version: 9 },
      ]);
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

  it("refuses to start when the pre-migration snapshot cannot be taken", async () => {
    // AC-24 的另一半：拍不到照就不准啟動，否則服務會照樣跑 migration——正是
    // 「不以半升級狀態啟動」明文禁止的前一步。把 main.ts 的快照呼叫包成
    // try { } catch { } 吞掉失敗，這條測試必須紅。
    //
    // 不用 mock：在資料目錄裡放一個叫 pre-migration 的**檔案**，快照要建的目錄
    // 就建不起來了——真實的「磁碟滿／目錄不可寫」等價情境。
    const directory = mkdtempSync(join(tmpdir(), "personal-ledger-snapshot-fail-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "ledger.sqlite");
    const legacyDatabase = openDatabase(databasePath);
    seedM1Ledger(legacyDatabase);
    legacyDatabase.close();
    writeFileSync(join(directory, "pre-migration"), "not a directory");

    await expect(
      composeRuntime({
        telegramBotToken: "test-token",
        ownerId: "owner-1",
        databasePath,
        timezone: "Asia/Taipei" as const,
        currency: "TWD" as const,
        sheets: null,
      }),
    ).rejects.toThrow();

    // 而且 migration 不能已經跑掉：資料庫必須還停在升級前的版本。
    const database = openDatabase(databasePath);
    try {
      expect(
        database.prepare("SELECT version FROM schema_migrations ORDER BY version").all(),
      ).toEqual([{ version: 1 }]);
    } finally {
      database.close();
    }
  });
});

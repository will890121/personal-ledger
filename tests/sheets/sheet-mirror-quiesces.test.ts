import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { migrate } from "../../src/db/migrate.js";
import { SqliteSheetSyncRepository } from "../../src/db/sqlite-sheet-sync-repository.js";
import { SqliteSummaryRepository } from "../../src/db/sqlite-summary-repository.js";
import {
  ALLOCATIONS_HEADER,
  MONTHLY_SUMMARY_HEADER,
  TRANSACTIONS_HEADER,
} from "../../src/domain/sheet-rows.js";
import { createSheetMirror } from "../../src/sheets/sheet-mirror.js";
import { seedTransaction } from "../fixtures/sheet-sync-seed.js";
import { FakeSheetsClient } from "../support/fake-sheets-client.js";

const OWNER = "owner-1";
const NOW = new Date("2026-10-01T05:00:00.000Z");

/**
 * 端到端（真的 SQLite 倉儲、真的摘要倉儲、位置定址的 Sheets 模擬器）釘住
 * 「同步完就真的靜下來」。
 *
 * 這條性質原本沒有任何測試守著，而它壞掉的時候完全沒有訊號：游標語意若是 >=，
 * 邊界那一列每一輪都會被重撈，看起來一切正常，實際上每分鐘固定燒掉十幾次
 * Sheets 配額，而且 Sheet 的「上次編輯」永遠停在幾秒前。用單元測試的假倉儲
 * 是驗不到的——被驗的東西正是倉儲的游標查詢與引擎存回的游標這兩者的接縫。
 */
describe("sheet mirror quiesces", () => {
  it("returns idle and makes no further sheets call once everything is synced", async () => {
    const database = new Database(":memory:");
    migrate(database);
    // 同一個毫秒的兩筆：游標會停在 (該毫秒, "t2")，正好壓在 tie-break 上。
    seedTransaction(database, OWNER, { id: "t1", updatedAt: "2026-10-01T00:00:00.000Z" });
    seedTransaction(database, OWNER, { id: "t2", updatedAt: "2026-10-01T00:00:00.000Z" });

    const sheets = new FakeSheetsClient({
      Transactions: [[...TRANSACTIONS_HEADER]],
      Allocations: [[...ALLOCATIONS_HEADER]],
      MonthlySummary: [[...MONTHLY_SUMMARY_HEADER]],
    });
    const mirror = createSheetMirror({
      ownerId: OWNER,
      sheets,
      syncRepository: new SqliteSheetSyncRepository(database),
      summaryRepository: new SqliteSummaryRepository(database),
      now: () => NOW,
    });

    const first = await mirror.syncOnce();
    expect(first).toEqual({ kind: "synced", transactions: 2, months: 1 });
    const callsWhileWorking = sheets.callCount;
    expect(callsWhileWorking).toBeGreaterThan(0);

    for (let tick = 0; tick < 5; tick += 1) {
      expect((await mirror.syncOnce()).kind).toBe("idle");
    }

    expect(sheets.callCount).toBe(callsWhileWorking);
    expect(sheets.snapshot("Transactions").map((row) => row[0])).toEqual([
      TRANSACTIONS_HEADER[0],
      "t1",
      "t2",
    ]);

    database.close();
  });
});

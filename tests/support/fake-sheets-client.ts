import type { SheetCell } from "../../src/domain/sheet-rows.js";
import type { CellWrite, SheetsClient } from "../../src/ports/sheets-client.js";

const render = (cell: SheetCell): string => {
  switch (cell.kind) {
    case "string":
      return cell.value;
    case "number":
    case "date":
      return String(cell.value);
    case "empty":
      return "";
  }
};

/**
 * 位置定址的模擬器，不是樁。它真的維護一個二維字串陣列、真的用列索引定位、
 * 真的在寫到超出範圍時補空白列——因為「以 id 為鍵 upsert」的正確性完全建立在
 * 列索引算對了，樁式的替身會讓那件事在測試裡恆真。
 */
export class FakeSheetsClient implements SheetsClient {
  public callCount = 0;
  public failNextWith: Error | null = null;
  private readonly tabs: Map<string, string[][]>;

  public constructor(initial: Record<string, string[][]> = {}) {
    this.tabs = new Map(
      Object.entries(initial).map(([tab, rows]) => [tab, rows.map((r) => [...r])]),
    );
  }

  public readColumns(tab: string, columnCount: number): Promise<string[][]> {
    this.callCount += 1;
    if (this.failNextWith) {
      const error = this.failNextWith;
      this.failNextWith = null;
      return Promise.reject(error);
    }
    const rows = this.tabs.get(tab);
    if (!rows) return Promise.reject(new Error(`no such tab: ${tab}`));
    return Promise.resolve(
      rows.map((row) => Array.from({ length: columnCount }, (_, i) => row[i] ?? "")),
    );
  }

  public updateCells(writes: readonly CellWrite[]): Promise<void> {
    this.callCount += 1;
    if (this.failNextWith) {
      const error = this.failNextWith;
      this.failNextWith = null;
      return Promise.reject(error);
    }
    // 全有全無：先驗證每一筆，再套用。半套用會讓「失敗就重做」在髒狀態上重做。
    const seenRows = new Set<string>();
    for (const write of writes) {
      if (!this.tabs.has(write.tab)) return Promise.reject(new Error(`no such tab: ${write.tab}`));
      if (write.rowIndex < 1) return Promise.reject(new Error(`row index must be 1-based`));

      // 真實的 UpdateCellsRequest 只碰指定範圍內的儲存格，範圍外的欄位不會被清空。
      // 若 cells 的長度與標題列的欄數不一致，模擬器「整列取代」的行為就會跟真實
      // 的「只碰指定範圍」不一樣，而這個落差在測試裡永遠看不到——所以在套用前
      // 就大聲拋錯，逼引擎一次就把整列的欄位算對。
      const header = this.tabs.get(write.tab)?.[0];
      if (header !== undefined && write.cells.length !== header.length) {
        return Promise.reject(
          new Error(
            `column count mismatch on ${write.tab} row ${String(write.rowIndex)}: ` +
              `expected ${String(header.length)} cells (header width), got ${String(write.cells.length)}`,
          ),
        );
      }

      // 同一批裡兩筆寫到同一列，代表引擎的列號算錯了。真實情境下這種批次
      // 不合法——引擎本來就只寫完整的列，合法用法不會撞到這條規則。
      const rowKey = `${write.tab}:${String(write.rowIndex)}`;
      if (seenRows.has(rowKey)) {
        return Promise.reject(
          new Error(
            `duplicate write to ${write.tab} row ${String(write.rowIndex)} in the same batch`,
          ),
        );
      }
      seenRows.add(rowKey);
    }
    for (const write of writes) {
      const rows = this.tabs.get(write.tab) as string[][];
      while (rows.length < write.rowIndex) rows.push([]);
      rows[write.rowIndex - 1] = write.cells.map(render);
    }
    return Promise.resolve();
  }

  /** 測試輔助：直接看某個分頁目前的內容。 */
  public snapshot(tab: string): string[][] {
    return (this.tabs.get(tab) ?? []).map((row) => [...row]);
  }
}

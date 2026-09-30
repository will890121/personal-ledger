import type { SheetCell } from "../domain/sheet-rows.js";
import {
  ALLOCATIONS_HEADER,
  MONTHLY_SUMMARY_HEADER,
  TRANSACTIONS_HEADER,
} from "../domain/sheet-rows.js";
import type { CellWrite, SheetsClient } from "../ports/sheets-client.js";
import { ALLOCATIONS_TAB, MONTHLY_SUMMARY_TAB, TRANSACTIONS_TAB } from "./sheet-mirror.js";

/** 三張分頁與它們各自的標題列。順序只影響寫入順序，不影響結果。 */
const TAB_HEADERS: readonly (readonly [string, readonly string[]])[] = [
  [TRANSACTIONS_TAB, TRANSACTIONS_HEADER],
  [ALLOCATIONS_TAB, ALLOCATIONS_HEADER],
  [MONTHLY_SUMMARY_TAB, MONTHLY_SUMMARY_HEADER],
];

const headerRow = (header: readonly string[]): SheetCell[] =>
  header.map((title): SheetCell => ({ kind: "string", value: title }));

/**
 * 把「分頁第 1 列還空著就先寫標題」補進任何一個 `SheetsClient`。
 *
 * 為什麼需要它：引擎（`sheet-mirror.ts`）永遠從第 2 列開始寫資料——第 1 列是標題的
 * 位置，`locatorOf` 就是這樣算的。但 `src/` 裡原本沒有任何程式會去寫那一列，
 * 三個 header 常數只被用來算空白列的寬度。面對一張全新的試算表，使用者看到的
 * 會是一堆沒有欄位名稱的數字，而測試替身的「空標題豁免」剛好把這件事遮住。
 *
 * 為什麼包成 decorator 而不是寫進引擎：標題列是「這張試算表長什麼樣子」的事，
 * 不是同步邏輯的一部分；而且包在這一層，測試可以拿模擬器（FakeSheetsClient）
 * 真的跑一輪同步來驗證第 1 列，不必有 Google 憑證。
 *
 * 一個行程只檢查一次（`ensured`）：檢查要花三次讀取，而標題列寫過就不會再消失。
 * 只在整批寫入真的成功之後才把旗標立起來——失敗就代表標題可能也沒寫進去。
 * 標題列與資料列放在同一批送出，因為 `updateCells` 的契約是全有全無。
 */
export function withHeaderRows(inner: SheetsClient): SheetsClient {
  let ensured = false;

  async function missingHeaderWrites(): Promise<CellWrite[]> {
    const writes: CellWrite[] = [];
    for (const [tab, header] of TAB_HEADERS) {
      const rows = await inner.readColumns(tab, header.length);
      // 第 1 列只要有任何一格有字就當成「標題已經有人管了」——使用者可能改過
      // 欄位名稱（例如翻成自己看得懂的字），不該每次啟動都覆寫回我們的版本。
      if ((rows[0] ?? []).some((cell) => cell.trim() !== "")) continue;
      writes.push({ tab, rowIndex: 1, cells: headerRow(header) });
    }
    return writes;
  }

  return {
    readColumns: (tab, columnCount) => inner.readColumns(tab, columnCount),
    updateCells: async (writes) => {
      if (ensured) {
        await inner.updateCells(writes);
        return;
      }
      const headerWrites = await missingHeaderWrites();
      await inner.updateCells([...headerWrites, ...writes]);
      ensured = true;
    },
  };
}

import type { SheetCell } from "../domain/sheet-rows.js";

/** 一次寫入：把 `cells` 放到 `tab` 的第 `rowIndex` 列（1-based，第 1 列是標題）。 */
export interface CellWrite {
  readonly tab: string;
  readonly rowIndex: number;
  readonly cells: readonly SheetCell[];
}

/**
 * 刻意收窄的介面：鏡像只需要這兩個呼叫。窄介面讓測試不必假造整個 googleapis，
 * 也讓 domain 與 application 不可能碰到它。
 */
export interface SheetsClient {
  /** 讀 `tab` 的前 `columnCount` 欄（含標題列）。回傳的是原始字串，空格為空字串。 */
  readColumns(tab: string, columnCount: number): Promise<string[][]>;
  /** 批次寫入。實作必須是全有全無：任何一格失敗就整批拋錯。 */
  updateCells(writes: readonly CellWrite[]): Promise<void>;
}

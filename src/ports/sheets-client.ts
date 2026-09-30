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
  /**
   * 讀 `tab` 的前 `columnCount` 欄（含標題列）。回傳的是原始字串，空格為空字串。
   *
   * **日期欄回傳的必須是未格式化的序列值**（例如 `"46295"`），不是顯示用的
   * `"2026/9/28"`。實作端的責任：Google 的 `spreadsheets.values.get` 預設是
   * `valueRenderOption: "FORMATTED_VALUE"`，非得明寫 `UNFORMATTED_VALUE` 不可。
   * 引擎對日期欄做的是 `Number(raw)`——拿到格式化字串就是 NaN，於是舊日期被
   * 靜默丟棄、跨月搬移的舊月份摘要永遠不會被重算，而所有測試依然全綠（測試
   * 替身存的就是序列值）。這條是契約，不是實作細節。
   */
  readColumns(tab: string, columnCount: number): Promise<string[][]>;
  /** 批次寫入。實作必須是全有全無：任何一格失敗就整批拋錯。 */
  updateCells(writes: readonly CellWrite[]): Promise<void>;
}

// Google Sheets 的日期序列值以 1899-12-30 為 0。這個原點是歷史產物（Lotus 1-2-3 的
// 1900 閏年 bug），不是任何標準 epoch，所以硬編在這裡並用測試釘住。
const SHEETS_EPOCH_UTC_MS = Date.UTC(1899, 11, 30);
const MS_PER_DAY = 86_400_000;

/**
 * 把 `YYYY-MM-DD` 轉成 Sheets 的日期序列值。
 *
 * 刻意手動解析而不是 `new Date(iso)`：後者在不同主機時區下對純日期字串的解讀會差一天，
 * 而 occurred_date 本來就不帶時區。用 Date.UTC 組出當日午夜的 UTC 毫秒，兩端一致。
 */
export function toSheetSerialDate(isoDate: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) throw new Error(`not a YYYY-MM-DD date: ${isoDate}`);
  const [, year, month, day] = match;
  const utcMs = Date.UTC(Number(year), Number(month) - 1, Number(day));
  return Math.round((utcMs - SHEETS_EPOCH_UTC_MS) / MS_PER_DAY);
}

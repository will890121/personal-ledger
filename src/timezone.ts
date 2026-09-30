// 共用給 main.ts（組裝正式環境）與測試 harness：兩邊都需要「把一個時刻換算成某個
// 時區底下的日期／時分」，抽成一個模組才不會各自重寫一份、之後改了時區邏輯只改一處。
// 不含 grammY，domain/application 都用得到。

export function dateInTimezone(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const { year, month, day } = values;
  if (!year || !month || !day) {
    throw new Error(`Unable to format date in timezone: ${timezone}`);
  }

  return `${year}-${month}-${day}`;
}

/**
 * /status 顯示的「幾點幾分」用這個，不是 ISO 字串裡的 UTC 時分：使用者設定的是
 * Asia/Taipei，UTC 時刻與使用者的錶差八小時，剛送到的訊息會被讀成「八小時前」，
 * 讓人誤以為遞送卡住了——這正是 /status 存在的目的所要防止的誤判。
 */
export function timeOfDayInTimezone(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const { hour, minute } = values;
  if (!hour || !minute) {
    throw new Error(`Unable to format time in timezone: ${timezone}`);
  }

  return `${hour}:${minute}`;
}
